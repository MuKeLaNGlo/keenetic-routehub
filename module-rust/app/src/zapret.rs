use std::{
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tempfile::NamedTempFile;
use tokio::{process::Command, time::timeout};

use crate::runtime::Selected;

const TRIAL_BIT: u32 = 0x02000000;
#[cfg(target_os = "linux")]
const TEST_BIT: u32 = 0x00100000;

const STRATEGIES: [&str; 4] = ["custom", "variant-1", "variant-2", "variant-3"];
const SERVICES: [&str; 2] = ["youtube", "discord"];

pub const YOUTUBE_DOMAINS: &str =
    "youtube.com,youtu.be,youtube-nocookie.com,googlevideo.com,ytimg.com,youtubei.googleapis.com";
pub const DISCORD_DOMAINS: &str =
    "discord.com,discordapp.com,discordapp.net,discord.gg,discord.media";

pub struct Zapret {
    helper_dir: PathBuf,
    data_dir: PathBuf,
    probe_slot: tokio::sync::Semaphore,
}

impl Zapret {
    pub fn new(helper_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            helper_dir,
            data_dir,
            probe_slot: tokio::sync::Semaphore::new(1),
        }
    }

    pub fn strategy_known(id: &str) -> bool {
        STRATEGIES.contains(&id)
    }

    pub fn has_strategy(&self, service: &str, id: &str) -> bool {
        self.strategy(service, id).is_ok_and(|data| {
            if id == "custom" {
                data.lines().any(|line| line.starts_with("--lua-desync="))
            } else {
                parse_managed(&data).is_ok()
            }
        })
    }

    pub fn strategies(&self) -> Vec<Value> {
        STRATEGIES
            .into_iter()
            .filter_map(|id| {
                let services: Vec<_> = SERVICES
                    .into_iter()
                    .filter(|service| self.has_strategy(service, id))
                    .collect();
                if services.is_empty() {
                    return None;
                }
                let label = if let Some(number) = id.strip_prefix("variant-") {
                    format!("Конфигурация {number}")
                } else {
                    "Локальная конфигурация".into()
                };
                Some(json!({"id":id,"label":label,"services":services}))
            })
            .collect()
    }

    pub async fn capability(&self) -> bool {
        let response = timeout(
            Duration::from_millis(800),
            self.helper("capability").output(),
        )
        .await;
        matches!(response, Ok(Ok(output)) if output.status.success()
            && matches!(output.stdout.as_slice().trim_ascii(), b"connbytes" | b"userspace"))
    }

    pub fn validate(&self, selection: &Selected) -> Result<()> {
        self.args(selection, None).map(|_| ())
    }

    pub async fn select(&self, before: &Selected, after: &Selected) -> Result<()> {
        if !before.zapret_differs(after) {
            return Ok(());
        }
        if !after.zapret_active() {
            return self.run("stop", after, None).await;
        }
        self.run("check", after, None).await?;
        if before.zapret_active() {
            self.run("stop", before, None).await?;
        }
        if let Err(error) = self.run("start", after, None).await {
            if before.zapret_active() {
                self.run("start", before, None)
                    .await
                    .context("не удалось восстановить прежнюю стратегию Zapret")?;
            } else {
                let _ = self.run("stop", before, None).await;
            }
            return Err(error);
        }
        Ok(())
    }

    async fn run(
        &self,
        action: &str,
        selection: &Selected,
        trial: Option<(&str, &str)>,
    ) -> Result<()> {
        let mut command = self.helper(action);
        let args = if action == "stop" {
            Vec::new()
        } else {
            self.args(selection, trial)?
        };
        let mut file = None;
        if !args.is_empty() && action != "stop" {
            let mut staged = NamedTempFile::new()?;
            for arg in &args {
                writeln!(staged, "{arg}")?;
            }
            command
                .env("ROUTEHUB_ZAPRET_ARGS", staged.path())
                .env("ROUTEHUB_ZAPRET_MANAGED", "1");
            file = Some(staged);
        }
        let output = timeout(Duration::from_secs(8), command.output())
            .await
            .context("Zapret не ответил вовремя")??;
        drop(file);
        ensure!(
            output.status.success()
                && !(action == "check" && output.stdout.as_slice().trim_ascii() == b"disabled"),
            "Zapret не подтвердил готовность выбранной стратегии"
        );
        Ok(())
    }

    pub async fn check_ready(&self, choice: &Selected) -> Result<()> {
        self.run("check", choice, None).await
    }

    pub async fn test(&self, service: &str) -> Result<Value, ()> {
        let _permit = self.probe_slot.try_acquire().map_err(|_| ())?;
        Ok(self.test_marked(service, 0, Duration::from_secs(7)).await)
    }

    pub async fn auto(
        &self,
        selected: &Selected,
        service: &str,
    ) -> Result<(Vec<Value>, Option<String>)> {
        let _permit = self
            .probe_slot
            .try_acquire()
            .context("Дождитесь завершения текущей проверки Zapret")?;
        ensure!(
            !(selected.youtube && selected.youtube_strategy == "custom"
                || selected.discord && selected.discord_strategy == "custom"),
            "для проверки отдельных конфигураций отключите общий локальный профиль Zapret"
        );
        let started = std::time::Instant::now();
        let mut outcomes = Vec::new();
        let mut best = None;
        for id in STRATEGIES.into_iter().filter(|id| *id != "custom") {
            if started.elapsed() >= Duration::from_secs(23) {
                outcomes.push(json!({"id":id,"status":"canceled","message":"Проверка завершилась до запуска варианта."}));
                continue;
            }
            if !self.has_strategy(service, id) {
                outcomes.push(json!({"id":id,"status":"unavailable","message":"Файл стратегии не установлен."}));
                continue;
            }
            let trial = Some((service, id));
            if let Err(error) = self.run("check", selected, trial).await {
                outcomes.push(json!({"id":id,"status":"unavailable","message":error.to_string()}));
                continue;
            }
            if selected.zapret_active() {
                self.run("stop", selected, None).await?;
            }
            let mut outcome = if self.run("start", selected, trial).await.is_ok() {
                self.test_marked(service, TRIAL_BIT, Duration::from_secs(4))
                    .await
            } else {
                json!({"status":"unavailable","message":"Не удалось открыть пробную очередь Zapret."})
            };
            self.run("stop", selected, None)
                .await
                .context("не удалось снять временную конфигурацию Zapret")?;
            if selected.zapret_active() {
                self.run("start", selected, None)
                    .await
                    .context("не удалось восстановить прежнюю очередь Zapret")?;
            }
            let object = outcome.as_object_mut().expect("результат проверки Zapret");
            object.remove("service");
            object.remove("httpStatus");
            outcome["id"] = json!(id);
            if outcome["status"] == "verified"
                && let Some(ms) = outcome["latencyMs"].as_u64()
                && best.is_none_or(|(_, time)| ms < time)
            {
                best = Some((id, ms));
            }
            outcomes.push(outcome);
        }
        Ok((outcomes, best.map(|(id, _)| id.to_owned())))
    }

    async fn runtime_sample(&self) -> Option<(u16, u64)> {
        let output = timeout(Duration::from_secs(2), self.helper("diagnostic").output())
            .await
            .ok()?
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = std::str::from_utf8(&output.stdout).ok()?;
        let mut fields = text.split_whitespace();
        if fields.next() != Some("running") {
            return None;
        }
        let queue = fields.next()?.strip_prefix("queue=")?.parse().ok()?;
        let packets = fields.next()?.strip_prefix("packets=")?.parse().ok()?;
        fields.next().is_none().then_some((queue, packets))
    }

    async fn test_marked(&self, service: &str, extra_mark: u32, limit: Duration) -> Value {
        let unavailable = || {
            json!({"service":service,"status":"unavailable",
            "message":"Служба Zapret RouteHub не подтвердила готовность очереди."})
        };
        timeout(limit,async {
            let Some((queue,packets))=self.runtime_sample().await else { return unavailable(); };
            let before = queue_sample(queue);
            let started = std::time::Instant::now();
            let http=marked_https(service,extra_mark).await;
            let latency=started.elapsed().as_millis() as u64;
            let status=match http {
                Ok(status) if (200..300).contains(&status) => status,
                Ok(status) => return json!({"service":service,"status":"failed","latencyMs":latency,
                    "httpStatus":status,"message":"Проверочный адрес вернул ошибочный статус HTTP."}),
                Err(ProbeError::NoMark) => return json!({"service":service,"status":"unavailable","latencyMs":latency,
                    "message":"Не удалось открыть соединение с меткой Zapret."}),
                #[cfg(target_os="linux")]
                Err(ProbeError::Connection) => return json!({"service":service,"status":"failed","latencyMs":latency,
                    "message":"HTTPS-проверка с меткой Zapret завершилась ошибкой или истекло время ожидания."}),
            };
            let after = self.runtime_sample().await;
            let counters=before.zip(queue_sample(queue)).is_some_and(|((pid,seq),(after_pid,after_seq))|
                pid==after_pid && after_seq>seq);
            if counters && after.is_some_and(|(q,current)|q==queue && current>packets) {
                json!({"service":service,"status":"verified","httpStatus":status,"latencyMs":latency,
                    "message":"Проверочный HTTPS-запрос прошёл через диагностическое правило и очередь Zapret RouteHub."})
            } else {
                json!({"service":service,"status":"unverified","httpStatus":status,"latencyMs":latency,
                    "message":"HTTPS с меткой RouteHub ответил. Обработка этого соединения движком Zapret не подтверждена."})
            }
        }).await.unwrap_or_else(|_|json!({"service":service,"status":"failed",
            "message":"HTTPS-проверка с меткой Zapret завершилась ошибкой или истекло время ожидания."}))
    }

    fn helper(&self, action: &str) -> Command {
        let mut command = Command::new(self.helper_dir.join("routehub-zapret"));
        command
            .arg(action)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .env("ROUTEHUB_ZAPRET_ETC", &self.data_dir)
            .env("ROUTEHUB_ZAPRET_ARGS", "")
            .env("ROUTEHUB_ZAPRET_MANAGED", "0");
        command
    }

    fn strategy(&self, service: &str, id: &str) -> Result<String> {
        ensure!(
            SERVICES.contains(&service) && Self::strategy_known(id),
            "неизвестная стратегия Zapret"
        );
        let path = if id == "custom" {
            self.data_dir.join("zapret.args")
        } else {
            self.data_dir
                .join("zapret-strategies")
                .join(format!("{service}-{id}.args"))
        };
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .context("файл выбранной стратегии Zapret недоступен")?;
        let meta = file.metadata()?;
        ensure!(
            meta.is_file() && meta.permissions().mode() & 0o077 == 0 && meta.len() <= 32 << 10,
            "файл стратегии должен быть приватным и не больше 32 КиБ"
        );
        let mut data = String::new();
        file.take((32 << 10) + 1).read_to_string(&mut data)?;
        ensure!(data.len() <= 32 << 10, "файл стратегии превышает 32 КиБ");
        Ok(data)
    }

    fn args(&self, selection: &Selected, trial: Option<(&str, &str)>) -> Result<Vec<String>> {
        let active = [
            (
                selection.youtube,
                "youtube",
                selection.youtube_strategy.as_str(),
                YOUTUBE_DOMAINS,
            ),
            (
                selection.discord,
                "discord",
                selection.discord_strategy.as_str(),
                DISCORD_DOMAINS,
            ),
        ];
        let mut shared = Vec::new();
        let mut profiles = Vec::new();
        let mut active: Vec<_> = active
            .into_iter()
            .filter(|(enabled, _, _, _)| *enabled)
            .collect();
        if active.iter().any(|(_, _, id, _)| *id == "custom") {
            ensure!(
                active.iter().all(|(_, _, id, _)| *id == "custom") && trial.is_none(),
                "локальная конфигурация несовместима с отдельными вариантами"
            );
            ensure!(
                self.has_strategy("youtube", "custom"),
                "локальная конфигурация Zapret недоступна"
            );
            return Ok(Vec::new());
        }
        if let Some((service, id)) = trial {
            active.push((
                true,
                service,
                id,
                if service == "youtube" {
                    YOUTUBE_DOMAINS
                } else {
                    DISCORD_DOMAINS
                },
            ));
        }
        let trial_index = active.len().saturating_sub(1);
        for (index, (_, service, id, domains)) in active.into_iter().enumerate() {
            let data = self.strategy(service, id)?;
            let (init, recipe) = parse_managed(&data)?;
            for argument in init {
                let provisioned = ["zapret-lib.lua", "zapret-antidpi.lua"]
                    .iter()
                    .find(|name| {
                        argument == format!("--lua-init=@/opt/lib/routehub/zapret2/lua/{name}")
                    })
                    .map(|name| {
                        format!(
                            "--lua-init=@{}",
                            self.helper_dir.join("zapret2/lua").join(name).display()
                        )
                    })
                    .unwrap_or_else(|| argument.to_owned());
                if !shared.contains(&provisioned) {
                    shared.push(provisioned);
                }
            }
            if !profiles.is_empty() {
                profiles.push("--new".to_owned());
            }
            profiles.push(format!("--hostlist-domains={domains}"));
            if trial.is_some() {
                let value = if index == trial_index { TRIAL_BIT } else { 0 };
                profiles.push(format!("--filter-mark={value:#x}/{TRIAL_BIT:#x}"));
            }
            profiles.extend(recipe.into_iter().map(str::to_owned));
        }
        shared.extend(profiles);
        Ok(shared)
    }
}

fn queue_sample(queue: u16) -> Option<(u32, u32)> {
    let mut text = String::new();
    std::fs::File::open("/proc/net/netfilter/nfnetlink_queue")
        .ok()?
        .take(64 << 10)
        .read_to_string(&mut text)
        .ok()?;
    text.lines().find_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 9 || fields[0].parse::<u16>().ok()? != queue {
            return None;
        }
        let peer = fields[1].parse::<u32>().ok()?;
        (peer != 0).then_some((peer, fields[7].parse().ok()?))
    })
}

#[derive(Debug)]
enum ProbeError {
    NoMark,
    #[cfg(target_os = "linux")]
    Connection,
}

#[cfg(target_os = "linux")]
async fn marked_https(service: &str, extra: u32) -> Result<u16, ProbeError> {
    use std::{
        net::{Ipv4Addr, SocketAddr},
        os::fd::AsRawFd,
        sync::Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpSocket, lookup_host},
    };
    use tokio_rustls::{
        TlsConnector,
        rustls::{ClientConfig, RootCertStore, crypto::ring, pki_types::ServerName},
    };

    let (host, path) = match service {
        "youtube" => ("www.youtube.com", "/robots.txt"),
        "discord" => ("discord.com", "/api/v10/gateway"),
        _ => return Err(ProbeError::Connection),
    };
    let failed = |_: std::io::Error| ProbeError::Connection;
    let destination = lookup_host((host, 443))
        .await
        .map_err(failed)?
        .find(|addr| match addr {
            SocketAddr::V4(addr) => routehub_subscriptions::is_public_ipv4(*addr.ip()),
            SocketAddr::V6(_) => false,
        })
        .ok_or(ProbeError::Connection)?;
    let socket = TcpSocket::new_v4().map_err(failed)?;
    let mark = 0x51000 | TEST_BIT | extra;
    // SAFETY: mark is a live u32 and the fd belongs to the unconnected IPv4 socket.
    let result = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_MARK,
            (&mark as *const u32).cast(),
            std::mem::size_of::<u32>() as libc::socklen_t,
        )
    };
    if result != 0 {
        return Err(ProbeError::NoMark);
    }
    socket
        .bind((Ipv4Addr::UNSPECIFIED, 0).into())
        .map_err(failed)?;
    let stream = socket.connect(destination).await.map_err(failed)?;
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|_| ProbeError::Connection)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server = ServerName::try_from(host).map_err(|_| ProbeError::Connection)?;
    let mut tls = TlsConnector::from(Arc::new(config))
        .connect(server, stream)
        .await
        .map_err(failed)?;
    tls.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: RouteHub\r\nConnection: close\r\n\r\n").as_bytes())
        .await.map_err(failed)?;
    let mut line = [0u8; 512];
    let mut offset = 0;
    while offset < line.len() {
        let n = tls.read(&mut line[offset..]).await.map_err(failed)?;
        if n == 0 {
            break;
        }
        offset += n;
        if let Some(end) = line[..offset].iter().position(|byte| *byte == b'\n') {
            let text = std::str::from_utf8(&line[..end]).map_err(|_| ProbeError::Connection)?;
            let mut fields = text.split_whitespace();
            if !matches!(fields.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
                return Err(ProbeError::Connection);
            }
            return fields
                .next()
                .and_then(|word| word.parse().ok())
                .ok_or(ProbeError::Connection);
        }
    }
    Err(ProbeError::Connection)
}

#[cfg(not(target_os = "linux"))]
async fn marked_https(_: &str, _: u32) -> Result<u16, ProbeError> {
    Err(ProbeError::NoMark)
}

fn parse_managed(data: &str) -> Result<(Vec<&str>, Vec<&str>)> {
    let mut shared = Vec::new();
    let mut profile = Vec::new();
    let mut has_strategy = false;
    for line in data
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        ensure!(
            line.len() <= 1024 && !line.contains(['\0', '\r']),
            "некорректная строка стратегии Zapret"
        );
        let (name, value) = line
            .split_once('=')
            .context("укажите значение аргумента Zapret")?;
        ensure!(!value.is_empty(), "укажите значение аргумента Zapret");
        match name {
            "--lua-init" | "--blob" => shared.push(line),
            "--filter-l3" | "--filter-tcp" | "--filter-udp" | "--filter-l7" | "--payload"
            | "--in-range" | "--out-range" | "--lua-desync" => {
                profile.push(line);
                has_strategy |= name == "--lua-desync";
            }
            _ => bail!("неподдерживаемый аргумент стратегии Zapret"),
        }
    }
    ensure!(has_strategy, "стратегия Zapret не содержит lua-desync");
    Ok((shared, profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_policy_rejects_profile_overrides() {
        let (shared, profile) =
            parse_managed("--lua-init=@init\n--filter-tcp=443\n--lua-desync=fragment").unwrap();
        assert_eq!(shared, ["--lua-init=@init"]);
        assert_eq!(profile, ["--filter-tcp=443", "--lua-desync=fragment"]);
        assert!(
            parse_managed("--hostlist-domains=unrelated.example\n--lua-desync=fragment").is_err()
        );
    }
}
