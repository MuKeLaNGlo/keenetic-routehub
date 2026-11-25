use std::{
    collections::{HashMap, HashSet},
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use chrono::{DateTime, Utc};
use ipnet::IpNet;
use routehub_policy::{Device, DomainSet, Options, Rule};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tokio::{
    io::{AsyncSeekExt, AsyncWriteExt},
    task::spawn_blocking,
    time::timeout,
};
use url::Url;

const MAX_PAYLOAD: u64 = 32 << 20;
const MAX_HEADER: u64 = 4096;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct GeoSource {
    pub id: String,
    pub name: String,
    pub repository: String,
    pub asset: String,
    pub frequency: u16,
    pub auto: bool,
}

#[derive(Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    repository: String,
    asset: String,
    version: String,
    updated_at: DateTime<Utc>,
    digest: String,
}

enum Data {
    Countries(HashMap<String, Arc<[IpNet]>>),
    Sites(HashMap<String, Arc<DomainSet>>),
}

struct Asset {
    manifest: Manifest,
    data: Data,
}

#[derive(Clone, Default)]
pub struct GeoCache {
    root: PathBuf,
    sources: Vec<GeoSource>,
    assets: HashMap<String, Arc<Asset>>,
}

impl GeoCache {
    pub fn load(data_dir: &Path, sources: &[Value]) -> Result<Self> {
        let sources = validate_sources(sources)?;
        let root = data_dir.join("geoip");
        let assets = sources
            .iter()
            .filter_map(|source| {
                let path = root.join(format!("{}.cache", source.id));
                load_asset(&path, source)
                    .ok()
                    .map(|asset| (source.id.clone(), Arc::new(asset)))
            })
            .collect();
        Ok(Self {
            root,
            sources,
            assets,
        })
    }

    pub fn apply_options(&self, options: &mut Options) {
        options
            .geo_sources
            .extend(self.sources.iter().map(|source| (source.id.clone(), true)));
        for (id, asset) in &self.assets {
            match &asset.data {
                Data::Countries(groups) => {
                    options.geo_data.insert(id.clone(), groups.clone());
                }
                Data::Sites(groups) => {
                    options.geo_sites.insert(id.clone(), groups.clone());
                }
            }
        }
    }

    pub fn status(&self) -> Vec<GeoStatus<'_>> {
        self.sources
            .iter()
            .map(|source| {
                let mut result = GeoStatus {
                    id: &source.id,
                    status: "missing",
                    version: None,
                    updated_at: None,
                    countries: Vec::new(),
                    sites: Vec::new(),
                };
                if let Some(asset) = self.assets.get(&source.id) {
                    result.status = "ready";
                    result.version = Some(&asset.manifest.version)
                        .filter(|version| !version.is_empty())
                        .map(String::as_str);
                    result.updated_at = Some(asset.manifest.updated_at);
                    match &asset.data {
                        Data::Countries(groups) => {
                            result.countries.extend(groups.keys().map(String::as_str));
                            result.countries.sort_unstable();
                        }
                        Data::Sites(groups) => {
                            result.sites.extend(groups.keys().map(String::as_str));
                            result.sites.sort_unstable();
                        }
                    }
                }
                result
            })
            .collect()
    }

    pub fn runtime_filename(&self, id: &str) -> String {
        if self.assets.contains_key(id) {
            format!("{id}.dat")
        } else {
            String::new()
        }
    }

    pub fn due_updates(&self, now: DateTime<Utc>) -> Vec<String> {
        self.sources
            .iter()
            .filter(|source| {
                source.auto
                    && self.assets.get(&source.id).is_none_or(|asset| {
                        now - asset.manifest.updated_at
                            >= chrono::TimeDelta::hours(i64::from(source.frequency))
                    })
            })
            .map(|source| source.id.clone())
            .collect()
    }

    pub async fn prepare_update(&self, id: &str) -> Result<GeoUpdate> {
        let source = self
            .sources
            .iter()
            .find(|source| source.id == id)
            .context("источник GeoIP не найден")?
            .clone();
        timeout(Duration::from_secs(35), download(&self.root, source))
            .await
            .context("истекло время загрузки базы GeoIP")?
    }

    pub fn runtime_versions(
        &self,
        filenames: &HashMap<String, String>,
    ) -> Result<Vec<(String, String)>> {
        let mut versions = filenames
            .keys()
            .map(|id| {
                let asset = self
                    .assets
                    .get(id)
                    .with_context(|| format!("база {id:?} недоступна"))?;
                Ok((id.clone(), asset.manifest.digest.clone()))
            })
            .collect::<Result<Vec<_>>>()?;
        versions.sort_unstable();
        Ok(versions)
    }

    /// Stage only the cache files referenced by the active Xray rules.
    pub fn stage_runtime(
        &self,
        directory: &Path,
        filenames: &HashMap<String, String>,
    ) -> Result<()> {
        if filenames.is_empty() {
            return Ok(());
        }
        DirBuilder::new().mode(0o700).create(directory)?;
        let result = filenames.iter().try_for_each(|(id, name)| {
            let asset = self
                .assets
                .get(id)
                .ok_or_else(|| anyhow!("база {id:?} недоступна"))?;
            ensure!(name == &format!("{id}.dat"), "некорректное имя файла GeoIP");
            let source = self.root.join(format!("{id}.cache"));
            let target = directory.join(name);
            copy_runtime_asset(&source, &target, &asset.manifest)
                .with_context(|| format!("не удалось подготовить базу {id:?} для Xray"))
        });
        if result.is_err() {
            let _ = fs::remove_dir_all(directory);
        }
        result
    }
}

pub struct GeoUpdate {
    source: GeoSource,
    asset: Arc<Asset>,
    staged: NamedTempFile,
}

impl GeoUpdate {
    pub fn candidate(&self, active: &GeoCache) -> Result<GeoCache> {
        self.check_source(active)?;
        let mut next = active.clone();
        next.assets
            .insert(self.source.id.clone(), Arc::clone(&self.asset));
        Ok(next)
    }

    pub fn needs_reload(&self, active: &GeoCache, rules: &[Rule], devices: &[Device]) -> bool {
        let changed = active
            .assets
            .get(&self.source.id)
            .is_none_or(|asset| asset.manifest.digest != self.asset.manifest.digest);
        let uses_source = |rule: &Rule| {
            !rule.disabled
                && (!rule.geo_ip.is_empty() || !rule.geo_site.is_empty())
                && rule.geo_source == self.source.id
        };
        changed
            && (rules.iter().any(uses_source)
                || devices.iter().any(|device| {
                    !matches!(device.mode.as_str(), "global" | "fixed")
                        && device.rules.iter().any(uses_source)
                }))
    }

    fn check_source(&self, active: &GeoCache) -> Result<()> {
        ensure!(
            active.sources.contains(&self.source)
                && self.staged.path().parent() == Some(&active.root),
            "источник GeoIP изменился. Запустите обновление снова"
        );
        Ok(())
    }

    pub fn install(self, active: &GeoCache) -> Result<InstalledGeo> {
        self.check_source(active)?;
        let path = active.root.join(format!("{}.cache", self.source.id));
        let backup_path = self.staged.path().with_extension("previous");
        let previous = match fs::hard_link(&path, &backup_path) {
            Ok(()) => Some(backup_path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error).context("не удалось сохранить предыдущую базу GeoIP"),
        };
        if let Err(error) = self.staged.persist(&path) {
            if let Some(previous) = previous {
                let _ = fs::remove_file(previous);
            }
            return Err(error).context("не удалось заменить базу GeoIP");
        }
        Ok(InstalledGeo {
            path,
            previous,
            complete: false,
        })
    }
}

pub struct InstalledGeo {
    path: PathBuf,
    previous: Option<PathBuf>,
    complete: bool,
}

impl InstalledGeo {
    pub fn commit(mut self) {
        self.complete = true;
    }

    pub fn rollback(mut self) -> Result<()> {
        self.restore()?;
        Ok(())
    }

    fn restore(&mut self) -> Result<()> {
        match &self.previous {
            Some(path) => fs::rename(path, &self.path),
            None => match fs::remove_file(&self.path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                result => result,
            },
        }
        .context("не удалось применить базу GeoIP и вернуть предыдущий файл")?;
        self.previous = None;
        self.complete = true;
        Ok(())
    }
}

impl Drop for InstalledGeo {
    fn drop(&mut self) {
        if !self.complete {
            let _ = self.restore();
        }
        if self.complete
            && let Some(previous) = &self.previous
        {
            let _ = fs::remove_file(previous);
        }
    }
}

#[derive(Deserialize)]
struct GitHubRelease {
    #[serde(rename = "tag_name")]
    version: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    size: u64,
    digest: Option<String>,
}

fn safe_release_url(target: &Url) -> bool {
    target.scheme() == "https"
        && target.port().is_none()
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
}

fn github_client() -> Result<reqwest::Client> {
    let redirect = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() <= 5 && safe_release_url(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("недопустимая переадресация файла GeoIP")
        }
    });
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(redirect)
        .user_agent("RouteHub-GeoIP")
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(25))
        .build()?)
}

async fn github_response(
    client: &reqwest::Client,
    target: Url,
    accept: &'static str,
    limit: u64,
) -> Result<reqwest::Response> {
    ensure!(
        safe_release_url(&target),
        "файл GeoIP должен загружаться с GitHub Releases"
    );
    let response = client
        .get(target)
        .header(reqwest::header::ACCEPT, accept)
        .send()
        .await
        .context("не удалось загрузить данные из GitHub Releases")?;
    ensure!(
        response.status() == reqwest::StatusCode::OK,
        "GitHub Releases ответил HTTP {}",
        response.status().as_u16()
    );
    ensure!(
        response.content_length().is_none_or(|size| size <= limit),
        "размер базы GeoIP превышает допустимый"
    );
    Ok(response)
}

async fn download(root: &Path, source: GeoSource) -> Result<GeoUpdate> {
    let github = github_client()?;
    let repository = source
        .repository
        .strip_prefix("https://github.com/")
        .context("проверьте адрес источника GeoIP")?;
    let metadata = Url::parse(&format!(
        "https://api.github.com/repos/{repository}/releases/latest"
    ))?;
    const METADATA_LIMIT: u64 = 2 << 20;
    let mut payload = Vec::new();
    {
        let mut response = github_response(
            &github,
            metadata,
            "application/vnd.github+json",
            METADATA_LIMIT,
        )
        .await?;
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                payload.len() + chunk.len() <= METADATA_LIMIT as usize,
                "размер сведений релиза превышает допустимый"
            );
            payload.extend_from_slice(&chunk);
        }
    }
    let GitHubRelease { version, assets } =
        serde_json::from_slice(&payload).context("GitHub не вернул сведения о последнем релизе")?;
    drop(payload);
    ensure!(
        !version.is_empty() && version.len() <= 128 && !matches!(version.as_str(), "." | ".."),
        "GitHub не вернул сведения о последнем релизе"
    );
    let record = assets
        .into_iter()
        .find(|asset| asset.name == source.asset)
        .context("в последнем релизе GitHub нет выбранного файла GeoIP")?;
    ensure!(
        (1..=MAX_PAYLOAD).contains(&record.size),
        "размер файла базы должен быть от 1 байта до 32 МиБ"
    );
    let mut path = Url::parse(&format!(
        "https://github.com/{repository}/releases/download"
    ))?;
    path.path_segments_mut()
        .map_err(|_| anyhow!("проверьте адрес источника GeoIP"))?
        .push(&version)
        .push(&source.asset);
    let mut response =
        github_response(&github, path, "application/octet-stream", record.size).await?;
    DirBuilder::new().recursive(true).mode(0o700).create(root)?;
    let staged = tempfile::Builder::new()
        .prefix(".geoip-next-")
        .tempfile_in(root)?;
    let mut output = tokio::fs::File::from_std(staged.reopen()?);
    let mut manifest = Manifest {
        repository: source.repository.clone(),
        asset: source.asset.clone(),
        version,
        updated_at: Utc::now(),
        digest: "0".repeat(64),
    };
    // Reserve the fixed-width digest field then stream directly to persistent storage.
    let mut header = serde_json::to_vec(&manifest)?;
    header.push(b'\n');
    output.write_all(&header).await?;
    let mut digest = Sha256::new();
    let mut size = 0;
    while let Some(chunk) = response.chunk().await? {
        size += chunk.len() as u64;
        ensure!(
            size <= record.size,
            "размер или SHA-256 базы не совпал с релизом GitHub"
        );
        digest.update(&chunk);
        output.write_all(&chunk).await?;
    }
    manifest.digest = hex::encode(digest.finalize());
    ensure!(
        size == record.size
            && record.digest.is_none_or(|digest| {
                digest.is_empty()
                    || digest.strip_prefix("sha256:") == Some(manifest.digest.as_str())
            }),
        "размер или SHA-256 базы не совпал с релизом GitHub"
    );
    let encoded = serde_json::to_vec(&manifest)?;
    ensure!(
        header.len() == encoded.len() + 1,
        "не удалось записать заголовок GeoIP"
    );
    output.seek(SeekFrom::Start(0)).await?;
    output.write_all(&encoded).await?;
    output.sync_all().await?;
    drop(output);
    spawn_blocking(move || {
        let asset = Arc::new(load_asset(staged.path(), &source)?);
        Ok(GeoUpdate {
            source,
            asset,
            staged,
        })
    })
    .await?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoStatus<'a> {
    id: &'a str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    countries: Vec<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    sites: Vec<&'a str>,
}

pub fn validate_sources(values: &[Value]) -> Result<Vec<GeoSource>> {
    let mut result = Vec::with_capacity(values.len());
    let mut ids = HashSet::new();
    for value in values {
        let mut source: GeoSource = GeoSource::deserialize(value)?;
        ensure!(
            source_id(&source.id) && ids.insert(source.id.clone()),
            "ID источников GeoIP должны быть уникальными"
        );
        let name = source.name.trim();
        ensure!(
            !name.is_empty() && name.chars().count() <= 100,
            "укажите название источника GeoIP до 100 символов"
        );
        source.name = name.to_owned();
        source.repository = github_url(&source.repository)?;
        ensure!(
            source
                .asset
                .strip_suffix(".dat")
                .is_some_and(|stem| asset_component(stem, 120)),
            "укажите имя файла базы GeoIP с расширением .dat"
        );
        if source.frequency == 0 {
            source.frequency = 24;
        }
        ensure!(
            matches!(source.frequency, 6 | 12 | 24 | 48 | 168),
            "интервал GeoIP доступен на 6, 12, 24, 48 или 168 часов"
        );
        result.push(source);
    }
    Ok(result)
}

fn source_id(value: &str) -> bool {
    (1..=63).contains(&value.len())
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn asset_component(value: &str, max: usize) -> bool {
    let mut bytes = value.bytes();
    value.len() <= max
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn github_url(value: &str) -> Result<String> {
    let error = || anyhow!("укажите репозиторий в формате https://github.com/owner/repo");
    let raw = value.trim();
    let (scheme, location) = raw.split_once("://").ok_or_else(error)?;
    ensure!(scheme.eq_ignore_ascii_case("https"), error());
    let path = location
        .strip_prefix("github.com/")
        .ok_or_else(error)?
        .trim_matches('/');
    let (owner, repository) = path.split_once('/').ok_or_else(error)?;
    ensure!(
        asset_component(owner, 100) && asset_component(repository, 100),
        error()
    );
    Ok(format!("https://github.com/{owner}/{repository}"))
}

struct CacheFile {
    size: u64,
    manifest: Manifest,
    reader: BufReader<File>,
}

fn open_cache(path: &Path) -> Result<CacheFile> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "база GeoIP должна быть обычным файлом");
    let mut reader = BufReader::with_capacity(MAX_HEADER as usize, file);
    let mut header = Vec::new();
    let header_size = reader
        .by_ref()
        .take(MAX_HEADER)
        .read_until(b'\n', &mut header)?;
    ensure!(
        header.ends_with(b"\n"),
        "не удалось прочитать заголовок базы GeoIP"
    );
    let manifest =
        serde_json::from_slice(&header).context("не удалось прочитать заголовок базы GeoIP")?;
    let size = metadata.len().saturating_sub(header_size as u64);
    ensure!(
        (1..=MAX_PAYLOAD).contains(&size),
        "не удалось прочитать файл GeoIP"
    );
    Ok(CacheFile {
        size,
        manifest,
        reader,
    })
}

fn load_asset(path: &Path, source: &GeoSource) -> Result<Asset> {
    let CacheFile {
        size,
        manifest,
        mut reader,
    } = open_cache(path)?;
    ensure!(
        manifest.repository == source.repository && manifest.asset == source.asset,
        "источник базы GeoIP изменился"
    );
    let data = {
        let mut buffer = vec![0; size as usize];
        reader
            .read_exact(&mut buffer)
            .context("не удалось прочитать файл GeoIP")?;
        ensure!(
            reader.fill_buf()?.is_empty(),
            "размер файла GeoIP изменился"
        );
        ensure!(
            matches_digest(Sha256::digest(&buffer), &manifest.digest),
            "не совпала контрольная сумма базы GeoIP"
        );
        parse_data(&manifest.asset, &buffer)?
    };
    Ok(Asset { manifest, data })
}

fn parse_data(filename: &str, data: &[u8]) -> Result<Data> {
    let filename = filename.to_ascii_lowercase();
    if filename == "geosite.dat" || filename.starts_with("geosite-") {
        let groups = routehub_imports::geo_site(data).map_err(anyhow::Error::msg)?;
        let mut sites = HashMap::with_capacity(groups.len());
        for (key, domains) in groups {
            let mut group = DomainSet::default();
            for domain in domains {
                group
                    .add(&domain.domain, &domain.match_kind)
                    .map_err(anyhow::Error::msg)?;
            }
            sites.insert(key, Arc::new(group));
        }
        return Ok(Data::Sites(sites));
    }
    let groups = routehub_imports::geo_ip(data).map_err(anyhow::Error::msg)?;
    Ok(Data::Countries(
        groups
            .into_iter()
            .map(|(code, data)| (code, Arc::from(data)))
            .collect(),
    ))
}

fn matches_digest(digest: impl AsRef<[u8]>, expected: &str) -> bool {
    hex::encode(digest) == expected
}

fn copy_runtime_asset(source: &Path, destination: &Path, expected: &Manifest) -> Result<()> {
    let CacheFile {
        size,
        manifest,
        reader,
    } = open_cache(source)?;
    ensure!(
        manifest.repository == expected.repository
            && manifest.asset == expected.asset
            && manifest.version == expected.version
            && manifest.digest == expected.digest,
        "версия файла базы изменилась"
    );
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)?;
    let mut writer = DigestWriter {
        file: &mut output,
        digest: Sha256::new(),
    };
    let written = io::copy(&mut reader.take(MAX_PAYLOAD + 1), &mut writer)?;
    ensure!(
        written == size && matches_digest(writer.digest.finalize(), &manifest.digest),
        "не совпала контрольная сумма или размер базы"
    );
    output.sync_all()?;
    Ok(())
}

struct DigestWriter<'a> {
    file: &'a mut File,
    digest: Sha256,
}

impl Write for DigestWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let n = self.file.write(bytes)?;
        self.digest.update(&bytes[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use routehub_policy::{Config, Destination, Rule};
    use serde_json::json;

    const PREFIX: &[u8] = b"\x0a\x0e\x0a\x02RU\x12\x08\x0a\x04\xcb\x00\x71\x00\x10\x18";

    #[test]
    fn go_cache_is_verified_and_staged_without_changing_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = json!({"id":"example","name":" Test ","repository":"https://github.com/example/db/","asset":"geoip.dat"});
        let legacy = directory.path().join("geoip");
        fs::create_dir(&legacy).unwrap();
        let path = legacy.join("example.cache");
        let manifest = json!({"repository":"https://github.com/example/db","asset":"geoip.dat","version":"2025","updatedAt":"2025-01-01T00:00:00Z","digest":hex::encode(Sha256::digest(PREFIX))});
        let mut bytes = serde_json::to_vec(&manifest).unwrap();
        bytes.push(b'\n');
        bytes.extend(PREFIX);
        fs::write(&path, &bytes).unwrap();

        let cache = GeoCache::load(directory.path(), &[source]).unwrap();
        let status = serde_json::to_value(cache.status()).unwrap();
        assert_eq!(status[0]["countries"], json!(["RU"]));
        assert_eq!(status[0]["version"], "2025");
        let mut options = Options::default();
        cache.apply_options(&mut options);
        let config = Config {
            rules: vec![Rule {
                name: "IPv4".into(),
                geo_ip: "ru".into(),
                geo_source: "example".into(),
                target: "@block".into(),
                ..Rule::default()
            }],
            ..Config::default()
        };
        let policy = routehub_policy::compile(&config, &options).unwrap();
        let destination = Destination {
            host: "203.0.113.4".into(),
            network: "tcp".into(),
            port: 443,
            ..Destination::default()
        };
        assert_eq!(policy.evaluate(&destination).unwrap().target, "@block");
        assert_eq!(
            policy.xray_rules_with_assets("", |id| cache.runtime_filename(id))[0]["ip"],
            json!(["ext:example.dat:RU"])
        );

        let plan = crate::config::Plan::default();
        let runtime =
            crate::xray::compile_runtime(&plan, false, &policy, &HashMap::new(), &cache).unwrap();
        assert_eq!(
            runtime.json["routing"]["rules"][0]["ip"],
            json!(["ext:example.dat:RU"])
        );
        let first = runtime.write(directory.path(), &cache, None).unwrap();
        let second = runtime
            .write(directory.path(), &cache, Some(&first))
            .unwrap();
        let files = || {
            fs::read_dir(directory.path())
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("xray-geo-"))
                .count()
        };
        assert_eq!(files(), 1);
        assert_eq!(first.fingerprint().unwrap(), second.fingerprint().unwrap());
        drop(first);
        assert_eq!(files(), 1);
        drop(second);
        assert_eq!(files(), 0);

        let assets = HashMap::from([("example".into(), "example.dat".into())]);
        let staged = directory.path().join("staged");
        cache.stage_runtime(&staged, &assets).unwrap();
        assert_eq!(fs::read(staged.join("example.dat")).unwrap(), PREFIX);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&path, &bytes).unwrap();
        let failed = directory.path().join("failed");
        assert!(cache.stage_runtime(&failed, &assets).is_err());
        assert!(!failed.exists());
    }

    fn image(source: &GeoSource, version: &str, bytes: &[u8]) -> Vec<u8> {
        let manifest = Manifest {
            repository: source.repository.clone(),
            asset: source.asset.clone(),
            version: version.into(),
            updated_at: DateTime::parse_from_rfc3339("2025-01-01T00:00:00Z")
                .unwrap()
                .to_utc(),
            digest: hex::encode(Sha256::digest(bytes)),
        };
        let mut result = serde_json::to_vec(&manifest).unwrap();
        result.push(b'\n');
        result.extend(bytes);
        result
    }

    #[test]
    fn upgraded_geo_cache_rolls_back_until_successful_runtime_commit() {
        let directory = tempfile::tempdir().unwrap();
        let values = [
            json!({"id":"example","name":"Test","repository":"https://github.com/example/db","asset":"geoip.dat","auto":true}),
        ];
        let source = validate_sources(&values).unwrap().remove(0);
        let base = directory.path().join("geoip");
        fs::create_dir(&base).unwrap();
        let active_path = base.join("example.cache");
        let original = image(&source, "old", PREFIX);
        fs::write(&active_path, &original).unwrap();
        let active = GeoCache::load(directory.path(), &values).unwrap();
        assert_eq!(active.due_updates(Utc::now()), vec!["example"]);
        let rule = Rule {
            name: "fixture".into(),
            geo_ip: "CN".into(),
            geo_source: "example".into(),
            target: "@block".into(),
            ..Rule::default()
        };
        let latest = image(
            &source,
            "new",
            &PREFIX
                .iter()
                .map(|&b| match b {
                    b'R' => b'C',
                    b'U' => b'N',
                    _ => b,
                })
                .collect::<Vec<_>>(),
        );
        let stage = || {
            let mut staged = NamedTempFile::new_in(&base).unwrap();
            staged.write_all(&latest).unwrap();
            let asset = Arc::new(load_asset(staged.path(), &source).unwrap());
            GeoUpdate {
                source: source.clone(),
                asset,
                staged,
            }
        };
        let prepared = stage();
        assert!(prepared.needs_reload(&active, &[rule], &[]));
        let candidate = prepared.candidate(&active).unwrap();
        assert_eq!(
            serde_json::to_value(candidate.status()).unwrap()[0]["version"],
            "new"
        );
        let installed = prepared.install(&active).unwrap();
        assert_eq!(fs::read(&active_path).unwrap(), latest);
        installed.rollback().unwrap();
        assert_eq!(fs::read(&active_path).unwrap(), original);
        {
            let _aborted = stage().install(&active).unwrap();
        }
        assert_eq!(fs::read(&active_path).unwrap(), original);
        stage().install(&active).unwrap().commit();
        assert_eq!(fs::read(&active_path).unwrap(), latest);
        assert_eq!(fs::read_dir(base).unwrap().count(), 1);
    }

    #[test]
    fn geo_download_redirect_stays_on_https_release_hosts() {
        for allowed in [
            "https://api.github.com/a",
            "https://github.com/a",
            "https://release-assets.githubusercontent.com/a",
            "https://objects.githubusercontent.com/a",
        ] {
            assert!(safe_release_url(&Url::parse(allowed).unwrap()));
        }
        for blocked in [
            "https://notgithub.com/a",
            "http://github.com/a",
            "https://user@github.com/a",
            "https://github.com:8443/a",
            "https://localhost/a",
        ] {
            assert!(!safe_release_url(&Url::parse(blocked).unwrap()));
        }
    }

    #[test]
    fn cache_rejects_cross_origin_and_invalid_asset_paths() {
        let source = json!({"id":"sample","name":"Sample","repository":"https://github.com/owner/repo","asset":"geoip.dat"});
        assert_eq!(
            validate_sources(std::slice::from_ref(&source)).unwrap()[0].frequency,
            24
        );
        for (field, invalid) in [
            ("id", "../example"),
            ("repository", "https://github.com@elsewhere.test/owner/repo"),
            ("repository", "https://github.com:443/owner/repo"),
            ("asset", "example/geoip.dat"),
        ] {
            let mut item = source.clone();
            item[field] = json!(invalid);
            assert!(validate_sources(&[item]).is_err());
        }
    }
}
