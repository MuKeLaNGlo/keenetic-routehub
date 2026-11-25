use std::os::unix::fs::PermissionsExt;
use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, path::Path};
#[cfg(target_os = "linux")]
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::PathBuf,
};

use anyhow::Result;
use tempfile::{Builder, TempDir};

const PREFIX: &str = "routehub-rust-";
const OWNER_FILE: &str = ".routehub-owner";

pub fn create() -> Result<TempDir> {
    let root = std::env::temp_dir();
    cleanup_stopped(&root);
    let work = private_dir(&root)?;
    if let Some(stamp) = process_start(std::process::id()) {
        let owner = work.path().join(OWNER_FILE);
        let mut marker = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(owner)?;
        writeln!(marker, "routehub-rust-v1 {} {stamp}", std::process::id())?;
    }
    Ok(work)
}

fn private_dir(root: &Path) -> std::io::Result<TempDir> {
    Builder::new()
        .prefix(PREFIX)
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(root)
}

#[cfg(target_os = "linux")]
fn process_start(pid: u32) -> Option<u64> {
    let mut status = String::new();
    File::open(format!("/proc/{pid}/stat"))
        .ok()?
        .take(4096)
        .read_to_string(&mut status)
        .ok()?;
    let (_, fields) = status.rsplit_once(") ")?;
    // The command can contain whitespace or parentheses. Start time is field 22.
    let mut fields = fields.split_whitespace();
    if fields.next()? == "Z" {
        return None;
    }
    fields.nth(18)?.parse().ok()
}

#[cfg(not(target_os = "linux"))]
fn process_start(_: u32) -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn cleanup_stopped(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    // SAFETY: geteuid has no input and returns the effective user of this process.
    let uid = unsafe { libc::geteuid() };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(PREFIX))
        {
            continue;
        }
        let path = entry.path();
        let Ok(directory) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !directory.is_dir() || directory.uid() != uid || directory.mode() & 0o777 != 0o700 {
            continue;
        }
        let Some((pid, started)) = read_owner(path.join(OWNER_FILE), uid) else {
            continue;
        };
        if process_start(pid) != Some(started) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn cleanup_stopped(_: &Path) {}

#[cfg(target_os = "linux")]
fn read_owner(path: PathBuf, uid: u32) -> Option<(u32, u64)> {
    let marker = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = marker.metadata().ok()?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 128
    {
        return None;
    }
    let mut text = String::new();
    marker.take(129).read_to_string(&mut text).ok()?;
    let mut fields = text.split_whitespace();
    if fields.next()? != "routehub-rust-v1" {
        return None;
    }
    let pid = fields.next()?.parse().ok()?;
    let stamp = fields.next()?.parse().ok()?;
    (pid != 0 && stamp != 0 && fields.next().is_none()).then_some((pid, stamp))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn cleans_only_exited_process_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let valid = private_dir(root.path()).unwrap();
        let old = private_dir(root.path()).unwrap();
        let unrelated = private_dir(root.path()).unwrap();
        let pid = std::process::id();
        let stamp = process_start(pid).unwrap();
        let mark = |directory: &Path, stamp| {
            let mut marker = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(directory.join(OWNER_FILE))
                .unwrap();
            writeln!(marker, "routehub-rust-v1 {pid} {stamp}").unwrap();
        };
        mark(valid.path(), stamp);
        mark(old.path(), stamp + 1);
        cleanup_stopped(root.path());
        assert!(valid.path().is_dir());
        assert!(!old.path().exists());
        assert!(unrelated.path().is_dir());
    }
}
