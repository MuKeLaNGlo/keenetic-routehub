use chrono::Utc;
use serde::Serialize;
use std::{
    ffi::CString,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const LIMIT: usize = 256 << 10;
pub const FILES: usize = 3;
pub const RESERVE: u64 = 8 << 20;

#[derive(Clone, Serialize)]
pub struct Capacity {
    pub used: u64,
    pub total: u64,
    pub available: u64,
}

#[cfg(target_os = "linux")]
pub fn disk(path: &Path) -> Option<Capacity> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: path is NUL-terminated and stats points to writable statfs storage.
    if unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: a successful statfs populated the structure.
    let stats = unsafe { stats.assume_init() };
    if stats.f_bsize <= 0
        || stats.f_blocks == 0
        || stats.f_bavail > stats.f_bfree
        || stats.f_bfree > stats.f_blocks
    {
        return None;
    }
    let block = stats.f_bsize as u64;
    Some(Capacity {
        used: (stats.f_blocks - stats.f_bfree) as u64 * block,
        total: stats.f_blocks as u64 * block,
        available: stats.f_bavail as u64 * block,
    })
}

#[cfg(not(target_os = "linux"))]
pub fn disk(path: &Path) -> Option<Capacity> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and stats points to writable statvfs storage.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: a successful statvfs populated the structure.
    let stats = unsafe { stats.assume_init() };
    let block = stats.f_bsize;
    Some(Capacity {
        used: (stats.f_blocks - stats.f_bfree) as u64 * block,
        total: stats.f_blocks as u64 * block,
        available: stats.f_bavail as u64 * block,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStorage {
    state: &'static str,
    bytes: u64,
    files: usize,
    max_file_bytes: usize,
    max_files: usize,
    reserve_bytes: u64,
}

impl LogStorage {
    pub fn disabled() -> Self {
        Self {
            state: "disabled",
            bytes: 0,
            files: 0,
            max_file_bytes: 0,
            max_files: 0,
            reserve_bytes: 0,
        }
    }
}

pub struct Log {
    path: PathBuf,
    error: Mutex<bool>,
}

impl Log {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            error: Mutex::new(false),
        }
    }

    fn file(&self, index: usize) -> PathBuf {
        let mut path = self.path.as_os_str().to_owned();
        if index != 0 {
            path.push(format!(".{index}"));
        }
        path.into()
    }

    fn lengths(&self) -> std::io::Result<[Option<u64>; FILES]> {
        let mut lengths = [None; FILES];
        for (index, result) in lengths.iter_mut().enumerate() {
            match fs::symlink_metadata(self.file(index)) {
                Ok(info) if info.is_file() => *result = Some(info.len()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
                _ => {
                    return Err(std::io::Error::other(
                        "путь журнала не является обычным файлом",
                    ));
                }
            }
        }
        Ok(lengths)
    }

    fn free(&self, length: usize) -> bool {
        disk(self.path.parent().unwrap_or(Path::new(".")))
            .is_some_and(|s| s.available >= RESERVE + length as u64)
    }

    pub fn status(&self) -> LogStorage {
        let guard = self.error.lock();
        let failed = guard.as_ref().map_or(true, |x| **x);
        let lengths = self.lengths();
        let state = if failed || lengths.is_err() {
            "error"
        } else if !self.free(0) {
            "paused"
        } else {
            "active"
        };
        let lengths = lengths.unwrap_or_default();
        LogStorage {
            state,
            bytes: lengths.into_iter().flatten().sum(),
            files: lengths.iter().flatten().count(),
            max_file_bytes: LIMIT,
            max_files: FILES,
            reserve_bytes: RESERVE,
        }
    }

    pub fn append(&self, message: &str) -> std::io::Result<()> {
        let mut error = self
            .error
            .lock()
            .map_err(|_| std::io::Error::other("журнал заблокирован"))?;
        let result = self.write(message);
        *error = result.is_err();
        result
    }

    fn write(&self, message: &str) -> std::io::Result<()> {
        let line = format!("{} {}\n", Utc::now().to_rfc3339(), message);
        let line = line.as_bytes();
        let line = &line[line.len().saturating_sub(LIMIT)..];
        let mut lengths = self.lengths()?;
        for (index, length) in lengths.iter_mut().enumerate() {
            if let Some(size) = *length
                && size > LIMIT as u64
            {
                let mut file = File::options()
                    .read(true)
                    .write(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(self.file(index))?;
                let mut recent = vec![0; LIMIT];
                file.seek(SeekFrom::Start(size - LIMIT as u64))?;
                file.read_exact(&mut recent)?;
                file.seek(SeekFrom::Start(0))?;
                file.write_all(&recent)?;
                file.set_len(LIMIT as u64)?;
                *length = Some(LIMIT as u64);
            }
        }
        if !self.free(line.len()) {
            return Ok(());
        }
        if lengths[0].is_some_and(|size| size + line.len() as u64 > LIMIT as u64) {
            for index in (0..FILES - 1).rev() {
                if lengths[index].is_some() {
                    fs::rename(self.file(index), self.file(index + 1))?;
                }
            }
        }
        File::options()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.path)?
            .write_all(line)
    }
}

pub fn read_proc_kib(data: &str, key: &str) -> Option<u64> {
    let value = data.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (key == name).then_some(value)
    })?;
    let mut words = value.split_whitespace();
    let number = words.next()?.parse::<u64>().ok()?;
    (words.next()? == "kB").then_some(number.checked_mul(1024)?)
}
