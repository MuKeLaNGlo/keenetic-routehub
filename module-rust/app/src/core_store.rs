use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use flate2::{Compression, bufread::GzDecoder, write::GzEncoder};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::{Builder, NamedTempFile};

const STORE_NAME: &str = "xray-managed.gz";
const MAX_ARCHIVE: u64 = 25 << 20;
const MAX_BINARY: u64 = 60 << 20;
const DISK_RESERVE: u64 = 6 << 20;
const MEMORY_RESERVE_KIB: u64 = 28 << 10;
const BUFFER: usize = 64 << 10;
const RELEASE_API: &str = "https://api.github.com/repos/XTLS/Xray-core/releases/latest";
const ARM64_ASSET: &str = "Xray-linux-arm64-v8a.zip";

pub(crate) struct ManagedCore {
    executable: NamedTempFile,
    version: String,
}

impl ManagedCore {
    pub(crate) fn path(&self) -> &Path {
        self.executable.path()
    }

    pub(crate) fn version(&self) -> &str {
        &self.version
    }
}

pub(crate) struct PendingCore {
    compressed: NamedTempFile,
    target: PathBuf,
}

impl PendingCore {
    pub(crate) fn commit(self) -> Result<()> {
        self.compressed
            .persist(&self.target)
            .map_err(|error| error.error)
            .context("не удалось сохранить ядро Xray")?;
        Ok(())
    }
}

fn managed_supported() -> bool {
    cfg!(all(target_os = "linux", target_arch = "aarch64"))
}

/// Load the existing Go installation's private compressed core when it is
/// newer than the configured executable and can start with this configuration.
pub(crate) async fn restore(
    config_path: &Path,
    runtime_dir: &Path,
    base_core: &Path,
    xray_config: &crate::xray::ConfigFile,
) -> Result<Option<ManagedCore>> {
    if !managed_supported() {
        return Ok(None);
    }
    let store = config_path.with_file_name(STORE_NAME);
    let runtime_dir = runtime_dir.to_owned();
    let Some(executable) = tokio::task::spawn_blocking(move || {
        let Some(compressed) = open_store(&store)? else {
            return Ok::<_, anyhow::Error>(None);
        };
        Ok(Some(restore_stream(compressed, &runtime_dir)?))
    })
    .await??
    else {
        return Ok(None);
    };
    let base = core_version(base_core).await;
    let version = core_version(executable.path()).await;
    if !version_is_newer(&version, &base) {
        return Ok(None);
    }
    crate::xray::check(executable.path(), xray_config).await?;
    Ok(Some(ManagedCore {
        executable,
        version,
    }))
}

fn open_store(path: &Path) -> Result<Option<File>> {
    let opened = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path);
    let file = match opened {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("сохранённое ядро Xray недоступно"),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.permissions().mode() & 0o077 == 0
            && (18..=MAX_ARCHIVE).contains(&metadata.len()),
        "сохранённое ядро Xray недоступно"
    );
    Ok(Some(file))
}

fn restore_stream(mut compressed: File, runtime_dir: &Path) -> Result<NamedTempFile> {
    let mut trailer = [0; 4];
    compressed.seek(SeekFrom::End(-4))?;
    compressed.read_exact(&mut trailer)?;
    compressed.rewind()?;
    let expected = u64::from(u32::from_le_bytes(trailer));
    check_executable_space(runtime_dir, expected)?;
    let mut decoder = GzDecoder::new(BufReader::with_capacity(BUFFER, compressed));
    let executable = write_executable(&mut decoder, runtime_dir, expected)?;
    ensure!(
        decoder.into_inner().fill_buf()?.is_empty(),
        "лишние данные в сохранённом ядре Xray"
    );
    Ok(executable)
}

fn write_executable(source: &mut impl Read, dir: &Path, size: u64) -> Result<NamedTempFile> {
    ensure!(
        (64..=MAX_BINARY).contains(&size),
        "некорректный размер ядра Xray"
    );
    let mut executable = Builder::new().prefix("routehub-xray-").tempfile_in(dir)?;
    // Read at most one byte beyond the announced length and consume the
    // stream terminator, so gzip and ZIP readers validate their checksum.
    let written = copy_stream(source.take(size + 1), executable.as_file_mut())?;
    ensure!(written == size, "размер ядра Xray не совпадает с указанным");
    executable.as_file_mut().rewind()?;
    check_aarch64(executable.as_file_mut())?;
    executable
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o700))?;
    // Close the writable handle before exec to avoid ETXTBSY on Linux.
    let (file, path) = executable.into_parts();
    drop(file);
    let file = File::open(&path)?;
    Ok(NamedTempFile::from_parts(file, path))
}

fn check_aarch64(source: &mut impl Read) -> Result<()> {
    let mut header = [0; 64];
    source.read_exact(&mut header)?;
    ensure!(
        &header[..7] == b"\x7fELF\x02\x01\x01"
            && matches!(u16::from_le_bytes([header[16], header[17]]), 2 | 3)
            && u16::from_le_bytes([header[18], header[19]]) == 183
            && u32::from_le_bytes(header[20..24].try_into().unwrap()) == 1
            && u16::from_le_bytes([header[52], header[53]]) == 64,
        "исполняемый файл Xray не соответствует Linux ARM64"
    );
    Ok(())
}

fn copy_stream(mut reader: impl Read, mut writer: impl Write) -> io::Result<u64> {
    let mut buffer = vec![0; BUFFER];
    let mut written = 0;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(written);
        }
        writer.write_all(&buffer[..count])?;
        written += count as u64;
    }
}

fn check_executable_space(dir: &Path, expected: u64) -> Result<()> {
    ensure!(
        (64..=MAX_BINARY).contains(&expected),
        "некорректный размер ядра Xray"
    );
    check_disk(dir, expected.saturating_add(DISK_RESERVE))?;
    if let Ok(info) = fs::read_to_string("/proc/meminfo") {
        let available = info
            .lines()
            .find_map(|line| line.strip_prefix("MemAvailable:"))
            .and_then(|line| line.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        ensure!(
            available >= expected.div_ceil(1024) + MEMORY_RESERVE_KIB,
            "не хватает свободной памяти для распаковки и проверки Xray"
        );
    }
    Ok(())
}

fn check_disk(dir: &Path, required: u64) -> Result<()> {
    ensure!(
        free_disk(dir)? >= required,
        "не хватает свободного места для Xray"
    );
    Ok(())
}

fn free_disk(dir: &Path) -> Result<u64> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};

    let path = CString::new(dir.as_os_str().as_bytes())?;
    let mut stats = MaybeUninit::uninit();
    // SAFETY: path is NUL-terminated and the output pointer is writable.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error()).context("не удалось проверить место для Xray");
    }
    // SAFETY: statvfs initialized the output on success.
    let stats = unsafe { stats.assume_init() };
    let available = u128::from(stats.f_bavail) * u128::from(stats.f_frsize);
    Ok(available.try_into().unwrap_or(u64::MAX))
}

fn version_parts(value: &str) -> Option<[u32; 3]> {
    let version = value.strip_prefix('v').unwrap_or(value);
    let mut fields = version.split('.');
    let mut parts = [0; 3];
    for (part, max) in parts.iter_mut().zip([4, 3, 3]) {
        let field = fields.next()?;
        if field.is_empty() || field.len() > max || !field.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        *part = field.parse().ok()?;
    }
    fields.next().is_none().then_some(parts)
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    version_parts(candidate)
        .zip(version_parts(current))
        .is_some_and(|(new, old)| new > old)
}

async fn core_version(path: &Path) -> String {
    use std::{process::Stdio, time::Duration};
    use tokio::{io::AsyncReadExt, process::Command, time::timeout};

    let version = timeout(Duration::from_secs(4), async {
        let mut probe = Command::new(path)
            .arg("version")
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdout = probe.stdout.take().context("нет вывода Xray")?;
        let mut output = Vec::new();
        stdout.take(1025).read_to_end(&mut output).await?;
        ensure!(
            output.len() <= 1024 && probe.wait().await?.success(),
            "не удалось распознать вывод Xray"
        );
        let mut fields = std::str::from_utf8(&output)?.split_whitespace();
        ensure!(fields.next() == Some("Xray"), "не распознана версия Xray");
        let value = fields.next().context("не распознана версия Xray")?;
        ensure!(version_parts(value).is_some(), "не распознана версия Xray");
        Ok(value.strip_prefix('v').unwrap_or(value).to_owned())
    })
    .await;
    version.ok().and_then(Result::ok).unwrap_or_default()
}

pub(crate) fn stage_compressed_core(
    candidate: &ManagedCore,
    config_path: &Path,
) -> Result<PendingCore> {
    let target = config_path.with_file_name(STORE_NAME);
    let dir = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let budget = free_disk(dir)?
        .saturating_sub(DISK_RESERVE)
        .min(MAX_ARCHIVE);
    ensure!(
        budget > 0,
        "не хватает свободного места для сохранения ядра Xray"
    );
    let file = File::open(candidate.path())?;
    let size = file.metadata()?.len();
    ensure!(
        (64..=MAX_BINARY).contains(&size),
        "некорректный размер ядра Xray"
    );
    let mut compressed = Builder::new().prefix(".xray-pending-").tempfile_in(dir)?;
    let mut writer = GzEncoder::new(
        BoundedWriter {
            target: compressed.as_file_mut(),
            remaining: budget,
        },
        Compression::fast(),
    );
    let copied = copy_stream(file.take(size + 1), &mut writer)?;
    ensure!(copied == size, "размер ядра Xray изменился");
    writer.finish()?;
    compressed.as_file().sync_all()?;
    Ok(PendingCore { compressed, target })
}

struct BoundedWriter<W> {
    target: W,
    remaining: u64,
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(io::Error::other(
                "сжатое ядро Xray превышает доступный размер",
            ));
        }
        let count = self.target.write(bytes)?;
        self.remaining -= count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.target.flush()
    }
}

struct Release {
    version: String,
    size: u64,
    sha256: [u8; 32],
}

#[derive(Deserialize)]
struct ReleaseResponse {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<AssetResponse>,
}

#[derive(Deserialize)]
struct AssetResponse {
    name: String,
    digest: Option<String>,
    size: u64,
}

fn parse_release(body: &[u8]) -> Result<Release> {
    let parsed: ReleaseResponse =
        serde_json::from_slice(body).context("GitHub не вернул описание релиза Xray")?;
    let version = parsed
        .tag_name
        .strip_prefix('v')
        .filter(|version| !version.starts_with('v') && version_parts(version).is_some())
        .filter(|_| !parsed.draft && !parsed.prerelease)
        .context("GitHub не вернул стабильный релиз Xray")?;
    parsed
        .assets
        .into_iter()
        .find_map(|asset| {
            if asset.name != ARM64_ASSET || !(1..=MAX_ARCHIVE).contains(&asset.size) {
                return None;
            }
            let encoded = asset.digest.as_deref()?.strip_prefix("sha256:")?;
            let mut sha256 = [0; 32];
            hex::decode_to_slice(encoded, &mut sha256).ok()?;
            Some(Release {
                version: version.to_owned(),
                size: asset.size,
                sha256,
            })
        })
        .context("в релизе нет ARM64-архива с SHA-256")
}

pub(crate) enum UpdateCheck {
    Current { latest: String },
    Available(ManagedCore),
}

pub(crate) async fn prepare_update(
    runtime_dir: &Path,
    state_dir: &Path,
    current: &str,
) -> Result<UpdateCheck> {
    ensure!(
        managed_supported() && version_parts(current).is_some(),
        "обновление поддерживается для установленного Xray на Linux ARM64"
    );
    let client = release_client()?;
    let release = read_release(&client).await?;
    if !version_is_newer(&release.version, current) {
        return Ok(UpdateCheck::Current {
            latest: release.version,
        });
    }
    let archive = download_release(&client, state_dir, &release).await?;
    let runtime_dir = runtime_dir.to_owned();
    let executable =
        tokio::task::spawn_blocking(move || unpack_release(archive, &runtime_dir)).await??;
    ensure!(
        core_version(executable.path()).await == release.version,
        "бинарник Xray не соответствует версии релиза"
    );
    Ok(UpdateCheck::Available(ManagedCore {
        version: release.version,
        executable,
    }))
}

fn release_client() -> Result<reqwest::Client> {
    use std::time::Duration;

    Ok(reqwest::Client::builder()
        .no_proxy()
        .https_only(true)
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .user_agent("RouteHub")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(75))
        .pool_max_idle_per_host(0)
        .redirect(reqwest::redirect::Policy::custom(|redirect| {
            let target = redirect.url();
            if redirect.previous().len() <= 4
                && target.scheme() == "https"
                && target.port_or_known_default() == Some(443)
                && target.username().is_empty()
                && target.password().is_none()
                && matches!(
                    target.host_str(),
                    Some(
                        "github.com"
                            | "api.github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                redirect.follow()
            } else {
                redirect.error("неподдерживаемое перенаправление GitHub Releases")
            }
        }))
        .build()?)
}

async fn read_release(client: &reqwest::Client) -> Result<Release> {
    const LIMIT: usize = 1 << 20;
    let mut response = client
        .get(RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .context("не удалось проверить релиз Xray")?
        .error_for_status()
        .context("GitHub не вернул релиз Xray")?;
    ensure!(
        response
            .content_length()
            .is_none_or(|bytes| bytes <= LIMIT as u64),
        "описание релиза Xray превышает 1 МиБ"
    );
    let mut data = Vec::new();
    while let Some(piece) = response
        .chunk()
        .await
        .context("не удалось загрузить описание релиза Xray")?
    {
        ensure!(
            data.len() + piece.len() <= LIMIT,
            "описание релиза Xray превышает 1 МиБ"
        );
        data.extend_from_slice(&piece);
    }
    parse_release(&data)
}

async fn download_release(
    client: &reqwest::Client,
    state_dir: &Path,
    release: &Release,
) -> Result<File> {
    use tokio::io::AsyncWriteExt;

    check_disk(state_dir, release.size + DISK_RESERVE)?;
    let archive = tempfile::tempfile_in(state_dir)?;
    let address = format!(
        "https://github.com/XTLS/Xray-core/releases/download/v{}/{ARM64_ASSET}",
        release.version
    );
    let mut response = client
        .get(address)
        .send()
        .await
        .context("не удалось скачать архив Xray из GitHub Releases")?;
    ensure!(
        response.status() == reqwest::StatusCode::OK
            && response
                .content_length()
                .is_none_or(|bytes| bytes == release.size),
        "GitHub вернул неожиданный ответ при загрузке Xray"
    );
    let mut output = tokio::fs::File::from_std(archive.try_clone()?);
    let mut size = 0;
    let mut hash = Sha256::new();
    while let Some(piece) = response
        .chunk()
        .await
        .context("загрузка архива Xray прервалась")?
    {
        size += piece.len() as u64;
        ensure!(
            size <= release.size,
            "архив Xray больше размера из описания релиза"
        );
        hash.update(&piece);
        output.write_all(&piece).await?;
    }
    output.flush().await?;
    let calculated: [u8; 32] = hash.finalize().into();
    ensure!(
        size == release.size && calculated == release.sha256,
        "архив не совпадает с размером или SHA-256 в GitHub Releases"
    );
    Ok(archive)
}

fn unpack_release(mut source: File, runtime_dir: &Path) -> Result<NamedTempFile> {
    validate_zip_directory(&mut source)?;
    let mut zip = zip::ZipArchive::new(source).context("не удалось открыть архив Xray")?;
    let mut entry = zip
        .by_name("xray")
        .context("в архиве нет исполняемого файла Xray")?;
    ensure!(
        entry.is_file()
            && entry
                .unix_mode()
                .is_none_or(|mode| matches!(mode & 0o170000, 0 | 0o100000)),
        "в архиве нет обычного исполняемого файла Xray"
    );
    let size = entry.size();
    check_executable_space(runtime_dir, size)?;
    write_executable(&mut entry, runtime_dir, size)
}

fn validate_zip_directory(source: &mut File) -> Result<()> {
    let length = source.metadata()?.len();
    ensure!(
        (22..=MAX_ARCHIVE).contains(&length),
        "некорректный размер ZIP-архива Xray"
    );
    // Limit allocation inside the ZIP reader to a small central directory.
    // The supported release archive is a single-disk ZIP well below ZIP64 limits.
    let scan = length.min(65535 + 22);
    let mut tail = vec![0; scan as usize];
    source.seek(SeekFrom::End(-(scan as i64)))?;
    source.read_exact(&mut tail)?;
    let index = (0..=tail.len() - 22)
        .rev()
        .find(|index| {
            let footer = &tail[*index..];
            footer.starts_with(b"PK\x05\x06")
                && usize::from(u16::from_le_bytes([footer[20], footer[21]])) + 22 == footer.len()
        })
        .context("архив Xray не содержит каталога ZIP")?;
    let footer = &tail[index..];
    let fields = |i: usize| u16::from_le_bytes([footer[i], footer[i + 1]]);
    let directory_size = u32::from_le_bytes(footer[12..16].try_into().unwrap());
    let directory_start = u32::from_le_bytes(footer[16..20].try_into().unwrap());
    let directory_end = u64::from(directory_start) + u64::from(directory_size);
    ensure!(
        fields(4) == 0
            && fields(6) == 0
            && fields(8) == fields(10)
            && (1..=256).contains(&fields(10))
            && directory_size <= (1 << 20)
            && directory_end == length - scan + index as u64,
        "неподдерживаемый каталог ZIP-архива Xray"
    );
    source.rewind()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::symlink;

    fn fixture_executable() -> [u8; 128] {
        let mut header = [0; 128];
        header[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        header[16..18].copy_from_slice(&2u16.to_le_bytes());
        header[18..20].copy_from_slice(&183u16.to_le_bytes());
        header[20..24].copy_from_slice(&1u32.to_le_bytes());
        header[52..54].copy_from_slice(&64u16.to_le_bytes());
        header
    }

    #[test]
    fn private_gzip_store_roundtrips_single_executable_and_commits_atomically() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let config = dir.join("config.json");
        let fixture = fixture_executable();
        let executable =
            write_executable(&mut fixture.as_slice(), dir, fixture.len() as u64).unwrap();
        let candidate = ManagedCore {
            executable,
            version: "1.11.2".into(),
        };
        assert_eq!(candidate.version(), "1.11.2");
        let existing = dir.join(STORE_NAME);
        fs::write(&existing, b"old core").unwrap();
        let prepared = stage_compressed_core(&candidate, &config).unwrap();
        assert_eq!(fs::read(&existing).unwrap(), b"old core");
        prepared.commit().unwrap();
        let restored = restore_stream(open_store(&existing).unwrap().unwrap(), dir).unwrap();
        assert_eq!(fs::read(restored.path()).unwrap(), fixture);
        assert_eq!(
            restored.as_file().metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&existing).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(restored);
        drop(candidate);
        assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
    }

    #[test]
    fn unsafe_corrupt_and_wrong_architecture_cache_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STORE_NAME);
        let other = dir.path().join("other");
        fs::write(&other, [0; 64]).unwrap();
        symlink(&other, &path).unwrap();
        assert!(open_store(&path).is_err());
        fs::remove_file(&path).unwrap();
        let file = File::options()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        let mut gzip = GzEncoder::new(file, Compression::fast());
        gzip.write_all(&[0; 128]).unwrap();
        drop(gzip.finish().unwrap());
        assert!(restore_stream(open_store(&path).unwrap().unwrap(), dir.path()).is_err());

        let file = File::options()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        let mut gzip = GzEncoder::new(file, Compression::fast());
        gzip.write_all(&fixture_executable()).unwrap();
        drop(gzip.finish().unwrap());
        let mut data = fs::read(&path).unwrap();
        let crc_start = data.len() - 8;
        data[crc_start] ^= 1;
        fs::write(&path, data).unwrap();
        assert!(restore_stream(open_store(&path).unwrap().unwrap(), dir.path()).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn bounded_zip_extracts_only_the_core() {
        let dir = tempfile::tempdir().unwrap();
        let archive = tempfile::tempfile_in(dir.path()).unwrap();
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut zip = zip::ZipWriter::new(archive);
        zip.start_file("xray", opts).unwrap();
        let fixture = fixture_executable();
        zip.write_all(&fixture).unwrap();
        zip.start_file("geoip.dat", opts).unwrap();
        zip.write_all(b"not required").unwrap();
        let archive = zip.finish().unwrap();
        let binary = unpack_release(archive, dir.path()).unwrap();
        assert_eq!(fs::read(binary.path()).unwrap(), fixture);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn release_requires_newer_stable_version_and_published_arm64_sha256() {
        let digest = "34".repeat(32);
        let mut document = json!({
            "tag_name":"v26.10.3", "draft":false, "prerelease":false,
            "assets":[{"name":ARM64_ASSET,"digest":format!("sha256:{digest}"),"size":12345678}],
        });
        let read = |value: &serde_json::Value| parse_release(value.to_string().as_bytes());
        let release = read(&document).unwrap();
        assert_eq!(release.version, "26.10.3");
        assert_eq!(release.size, 12345678);
        assert_eq!(release.sha256, [0x34; 32]);
        assert!(version_is_newer(&release.version, "v26.9.21"));
        assert!(!version_is_newer(&release.version, "26.10.3"));
        assert!(!version_is_newer("v26.10.3-beta", "26.9.21"));
        document["prerelease"] = json!(true);
        assert!(read(&document).is_err());
        document["prerelease"] = json!(false);
        document["assets"][0]["digest"] = json!(null);
        assert!(read(&document).is_err());
    }
}
