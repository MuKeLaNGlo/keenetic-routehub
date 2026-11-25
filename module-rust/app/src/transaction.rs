use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    fs,
    io::{self, BufWriter, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tempfile::{Builder, NamedTempFile};

const MAX_PLAN_BYTES: u64 = 4 << 20;
const MAX_REVISIONS: usize = 6;

pub fn stage(path: &Path, value: &impl Serialize) -> Result<NamedTempFile> {
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let available = crate::storage::disk(dir)
        .context("не удалось проверить свободное место")?
        .available;
    let budget = available
        .saturating_sub(crate::storage::RESERVE)
        .min(MAX_PLAN_BYTES);
    ensure!(
        budget > 0,
        "не хватает свободного места для сохранения RouteHub"
    );
    let mut temp = Builder::new().prefix(".routehub-plan-").tempfile_in(dir)?;
    {
        let mut limited = BoundedWrite {
            output: BufWriter::new(temp.as_file_mut()),
            remaining: budget,
        };
        serde_json::to_writer(&mut limited, value)?;
        limited.write_all(b"\n")?;
        limited.flush()?;
    }
    temp.as_file().sync_all()?;
    Ok(temp)
}

struct BoundedWrite<W> {
    output: W,
    remaining: u64,
}

impl<W: Write> Write for BoundedWrite<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(io::Error::other(
                "не хватает свободного места или превышен размер конфигурации",
            ));
        }
        let written = self.output.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

pub fn revision_path(dir: &Path, id: &str) -> Result<PathBuf> {
    ensure!(
        id.len() == 32
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "некорректная ревизия"
    );
    Ok(dir.join(format!("{id}.json")))
}

pub fn read_revision(path: &Path) -> Result<Option<crate::config::Plan>> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path);
    let Ok(file) = file else {
        return Ok(None);
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.permissions().mode() & 0o077 != 0 || meta.len() > MAX_PLAN_BYTES {
        return Ok(None);
    }
    Ok(Some(serde_json::from_reader(
        file.take(MAX_PLAN_BYTES + 1),
    )?))
}

pub fn archive(dir: &Path, id: &str, current: &impl Serialize) -> Result<PathBuf> {
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    if let Err(err) = builder.create(dir)
        && err.kind() != std::io::ErrorKind::AlreadyExists
    {
        return Err(err.into());
    }
    let meta = fs::symlink_metadata(dir)?;
    ensure!(
        meta.is_dir() && meta.permissions().mode() & 0o077 == 0,
        "некорректный каталог ревизий"
    );
    let path = revision_path(dir, id)?;
    stage(&path, current)?
        .persist_noclobber(&path)
        .context("не удалось сохранить предыдущую ревизию")?;
    Ok(path)
}

pub fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut revisions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        if path.extension().and_then(|v| v.to_str()) != Some("json")
            || revision_path(dir, id).is_err()
        {
            continue;
        }
        if let Ok(meta) = entry.metadata()
            && meta.is_file()
            && meta.permissions().mode() & 0o077 == 0
            && let Ok(time) = meta.modified()
        {
            revisions.push((time, path, meta.len()));
        }
    }
    revisions.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut total = 0_u64;
    for (index, (_, path, length)) in revisions.into_iter().enumerate() {
        total = total.saturating_add(length);
        if index >= MAX_REVISIONS || total > MAX_PLAN_BYTES * 2 {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_file_preserves_old_data_until_commit() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.json");
        fs::write(&config, b"before").unwrap();
        {
            let pending = stage(&config, &[1, 2]).unwrap();
            assert_eq!(
                pending.as_file().metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(fs::read(&config).unwrap(), b"before");
        }
        assert_eq!(fs::read(&config).unwrap(), b"before");
        stage(&config, &[1, 2]).unwrap().persist(&config).unwrap();
        assert_eq!(fs::read(&config).unwrap(), b"[1,2]\n");
    }
}
