mod resolver;
mod settings;

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use anyhow::{Context, Result, ensure};
use hickory_proto::op::{Message, ResponseCode};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream, UdpSocket},
    process::Command,
    sync::{Mutex, Semaphore},
    task::{JoinHandle, JoinSet, spawn_blocking},
    time::timeout,
};

pub use self::settings::{SETTINGS_LIMIT, Settings};
use self::{
    resolver::{
        Exchange, Resolver, error_reply, has_answer, read_frame, test_query, udp_wire, write_frame,
    },
    settings::{BLOCKLIST_LIMIT, Blocklist, asset},
};

pub const PROBE_LIMIT: usize = 3072;
const UPSTREAM_LISTS: [&str; 2] = [
    "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/",
    "https://hagezi-mirror.dnsbunker.org/wildcard/",
];
const QUERY_LIMIT: usize = 32;
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const BOOT_SETTING_ERROR: &str =
    "Сохранённые настройки DNS не загружены. Проверьте конфигурацию и список фильтрации.";
const LIST_ERROR: &str =
    "список HaGeZi не загружен. Проверьте доступ к источникам списка и повторите";
const LAN_UNAVAILABLE: &str = "перенаправление DNS для LAN недоступно в этом запуске RouteHub";
const LAN_STATUS_ERROR: &str = "Маршрут DNS для LAN недоступен. Проверьте интерфейс и firewall.";
const LAN_START_ERROR: &str =
    "Перенаправление DNS не запустилось. Keenetic использует штатный DNS.";
const LISTENER_ERROR: &str = "Сокет DNS занят или недоступен. Проверьте адрес резолвера.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    #[serde(flatten)]
    settings: Settings,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    listen: Option<SocketAddr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lan_listen: Option<SocketAddr>,
    lan_available: bool,
    lan_active: bool,
    blocklist_entries: usize,
    sample_blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProbeInput {
    pub protocol: String,
    pub primary: String,
    pub secondary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    role: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u64>,
    message: &'static str,
}

#[derive(Debug)]
pub struct DnsError {
    pub status: u16,
    pub message: String,
}

impl DnsError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

pub struct LanDns {
    helper: PathBuf,
    listen: SocketAddr,
    source: IpNet,
    interface: String,
}

impl LanDns {
    pub fn new(
        helper_dir: &Path,
        interface: &str,
        source: IpNet,
        panel_ip: Ipv4Addr,
        listen_port: u16,
        allowed: IpNet,
    ) -> Option<Self> {
        let helper = helper_dir.join("routehub-dns");
        let meta = helper.metadata().ok()?;
        if !meta.is_file()
            || meta.permissions().mode() & 0o100 == 0
            || !crate::config::interface_name(interface)
            || !panel_ip.is_private()
            || !source.contains(&IpAddr::V4(panel_ip))
            || !allowed.contains(&source.addr())
            || source.prefix_len() < allowed.prefix_len()
            || matches!(listen_port, 0 | 53)
        {
            return None;
        }
        Some(Self {
            helper,
            listen: SocketAddr::from((panel_ip, listen_port)),
            source,
            interface: interface.into(),
        })
    }

    fn native(&self) -> SocketAddr {
        SocketAddr::new(self.listen.ip(), 53)
    }

    async fn apply(&self, enabled: bool) -> Result<()> {
        let mut command = Command::new(&self.helper);
        command
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if enabled {
            command
                .arg("start")
                .arg(&self.interface)
                .arg(self.source.to_string())
                .arg(self.listen.ip().to_string())
                .arg(self.listen.port().to_string())
                .arg(std::process::id().to_string());
        } else {
            command.arg("stop");
        }
        let status = timeout(Duration::from_secs(5), command.status()).await??;
        ensure!(status.success(), "DNS helper returned {status}");
        Ok(())
    }

    async fn active(&self) -> bool {
        let mut command = Command::new(&self.helper);
        command
            .kill_on_drop(true)
            .arg("status")
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        timeout(Duration::from_secs(2), command.output())
            .await
            .is_ok_and(|result| {
                result.is_ok_and(|output| {
                    output.status.success() && output.stdout.trim_ascii() == b"active"
                })
            })
    }
}

struct Core {
    resolver: RwLock<Arc<Resolver>>,
    exchange: Exchange,
}

impl Core {
    fn resolver(&self) -> Arc<Resolver> {
        Arc::clone(&self.resolver.read().expect("DNS resolver"))
    }

    async fn resolve(&self, query: &Message) -> Message {
        let resolver = self.resolver();
        timeout(QUERY_TIMEOUT, resolver.resolve(&self.exchange, query))
            .await
            .unwrap_or_else(|_| error_reply(query, ResponseCode::ServFail))
    }
}

pub struct DnsControl {
    path: PathBuf,
    core: Arc<Core>,
    listen: Option<SocketAddr>,
    listener_error: bool,
    lan: Option<LanDns>,
    lan_active: AtomicBool,
    initial: RwLock<Option<&'static str>>,
    updates: Mutex<()>,
    probes: Semaphore,
    listeners: Vec<JoinHandle<()>>,
}

impl DnsControl {
    pub async fn start(
        data_dir: PathBuf,
        listen: Option<SocketAddr>,
        allowed: IpNet,
        lan: Option<LanDns>,
    ) -> Result<Self> {
        let path = data_dir.join("dns.json");
        let (settings, blocklist, initial) = spawn_blocking({
            let path = path.clone();
            move || bootstrap(&path)
        })
        .await?;
        let enable_lan = settings.lan;
        let core = Arc::new(Core {
            resolver: RwLock::new(Arc::new(Resolver::new(settings, blocklist, None))),
            exchange: Exchange::new()?,
        });
        let mut control = Self {
            path,
            core,
            listen,
            listener_error: false,
            lan: None,
            lan_active: AtomicBool::new(false),
            initial: RwLock::new(initial),
            updates: Mutex::new(()),
            probes: Semaphore::new(2),
            listeners: Vec::new(),
        };
        if let Some(listen) = listen {
            match control.bind(listen, allowed).await {
                Ok(actual) => control.listen = Some(actual),
                Err(_) => control.listener_error = true,
            }
        }
        if let Some(lan) = lan.filter(|_| control.listen.is_some() && !control.listener_error)
            && (control.listen == Some(lan.listen)
                || control.bind(lan.listen, lan.source).await.is_ok())
        {
            let previous = control.core.resolver();
            *control.core.resolver.write().expect("DNS resolver") = Arc::new(Resolver::new(
                previous.settings.clone(),
                Arc::clone(&previous.blocklist),
                Some(lan.native()),
            ));
            control.lan = Some(lan);
            if enable_lan
                && (!control.has_upstream(&previous.settings).await
                    || control.apply_lan(true).await.is_err())
            {
                *control.initial.write().expect("DNS status") = Some(LAN_START_ERROR);
            }
        }
        Ok(control)
    }

    async fn bind(&mut self, listen: SocketAddr, allowed: IpNet) -> Result<SocketAddr> {
        ensure!(
            matches!(listen.ip(), IpAddr::V4(ip) if ip.is_loopback() || ip.is_private()),
            "DNS должен слушать IPv4 LAN или loopback"
        );
        let tcp = TcpListener::bind(listen).await?;
        let actual = tcp.local_addr()?;
        let udp = UdpSocket::bind(actual).await?;
        let permits = Arc::new(Semaphore::new(QUERY_LIMIT));
        self.listeners.push(tokio::spawn(serve_udp(
            udp,
            allowed,
            Arc::clone(&self.core),
            Arc::clone(&permits),
        )));
        self.listeners.push(tokio::spawn(serve_tcp(
            tcp,
            allowed,
            Arc::clone(&self.core),
            permits,
        )));
        Ok(actual)
    }

    pub async fn snapshot(&self) -> Overview {
        let resolver = self.core.resolver();
        let requested = self.lan_active.load(Ordering::Acquire);
        let lan_active = if let Some(lan) = self.lan.as_ref().filter(|_| requested) {
            lan.active().await
        } else {
            false
        };
        let error = if self.listener_error {
            Some(LISTENER_ERROR)
        } else if requested && !lan_active {
            Some(LAN_STATUS_ERROR)
        } else {
            *self.initial.read().expect("DNS status")
        };
        Overview {
            settings: resolver.settings.clone(),
            enabled: self.listen.is_some() && !self.listener_error,
            listen: self.listen,
            lan_listen: self.lan.as_ref().map(|lan| lan.listen),
            lan_available: self.lan.is_some(),
            lan_active,
            blocklist_entries: resolver.blocklist.len(),
            sample_blocked: resolver.blocked("doubleclick.net"),
            error,
        }
    }

    async fn apply_lan(&self, enabled: bool) -> Result<(), DnsError> {
        if let Some(lan) = &self.lan {
            lan.apply(enabled).await.map_err(|_| DnsError::new(422, if enabled {
                "Keenetic не подтвердил перенаправление DNS, проверьте интерфейс и состояние firewall"
            } else {
                "не удалось отключить перенаправление DNS"
            }))?;
        } else if enabled {
            return Err(DnsError::new(422, LAN_UNAVAILABLE));
        }
        self.lan_active.store(enabled, Ordering::Release);
        Ok(())
    }

    async fn has_upstream(&self, settings: &Settings) -> bool {
        let Ok(question) = test_query() else {
            return false;
        };
        let resolver = Resolver::new(settings.clone(), Arc::default(), None);
        has_answer(&resolver.resolve(&self.core.exchange, &question).await)
    }

    pub async fn apply(&self, settings: Settings) -> Result<Overview, DnsError> {
        let next = settings
            .validate()
            .map_err(|error| DnsError::new(400, error.to_string()))?;
        let _guard = self.updates.lock().await;
        let current = self.core.resolver();
        let previous = &current.settings;
        let was_lan = self.lan_active.load(Ordering::Acquire);
        if next.lan && self.lan.is_none() {
            return Err(DnsError::new(422, LAN_UNAVAILABLE));
        }
        if (next.protocol != previous.protocol
            || next.primary != previous.primary
            || next.secondary != previous.secondary
            || next.lan && !was_lan)
            && !self.has_upstream(&next).await
        {
            return Err(DnsError::new(
                422,
                "ни один DNS-сервер не ответил на проверку. Сохранены действующие настройки",
            ));
        }
        let blocklist = if !next.adblock {
            Arc::default()
        } else if previous.adblock && next.lists == previous.lists {
            Arc::clone(&current.blocklist)
        } else {
            self.load_blocklist(&next.lists[0])
                .await
                .map_err(|_| DnsError::new(422, LIST_ERROR))?
        };
        let mut pending = tempfile::Builder::new()
            .prefix(".dns-plan-")
            .tempfile_in(self.path.parent().unwrap_or(Path::new(".")))
            .map_err(|_| DnsError::new(422, "не удалось записать настройки DNS"))?;
        serde_json::to_writer(pending.as_file_mut(), &next)
            .map_err(|_| DnsError::new(422, "не удалось записать настройки DNS"))?;
        pending
            .as_file()
            .sync_all()
            .map_err(|_| DnsError::new(422, "не удалось записать настройки DNS"))?;
        let mut live_lan = false;
        if next.lan
            && was_lan
            && let Some(lan) = &self.lan
        {
            live_lan = lan.active().await;
        }
        if next.lan != was_lan || next.lan && !live_lan {
            self.apply_lan(next.lan).await?;
        }
        if pending.persist(&self.path).is_err() {
            if next.lan != was_lan {
                let _ = self.apply_lan(was_lan).await;
            }
            return Err(DnsError::new(422, "не удалось применить настройки DNS"));
        }
        *self.initial.write().expect("DNS status") = None;
        *self.core.resolver.write().expect("DNS resolver") =
            Arc::new(Resolver::new(next, blocklist, current.native));
        Ok(self.snapshot().await)
    }

    pub async fn test(&self, input: ProbeInput) -> Result<Vec<Probe>, DnsError> {
        let _permit = self
            .probes
            .try_acquire()
            .map_err(|_| DnsError::new(429, "Дождитесь текущей проверки DNS"))?;
        let settings = Settings {
            protocol: input.protocol,
            primary: input.primary,
            secondary: input.secondary,
            ..Settings::default()
        }
        .validate()
        .map_err(|error| DnsError::new(400, error.to_string()))?;
        let primary = self.probe("primary", &settings.protocol, &settings.primary);
        if settings.secondary.is_empty() {
            return Ok(vec![primary.await]);
        }
        let (one, two) = tokio::join!(
            primary,
            self.probe("secondary", &settings.protocol, &settings.secondary)
        );
        Ok(vec![one, two])
    }

    async fn probe(&self, role: &'static str, protocol: &str, endpoint: &str) -> Probe {
        let started = Instant::now();
        let success = if let Ok(question) = test_query() {
            timeout(
                Duration::from_secs(3),
                self.core.exchange.send(protocol, endpoint, &question),
            )
            .await
            .is_ok_and(|result| result.is_ok_and(|message| has_answer(&message)))
        } else {
            false
        };
        if success {
            return Probe {
                role,
                status: "ok",
                latency_ms: Some(started.elapsed().as_millis() as u64),
                message: "DNS-сервер ответил на запрос",
            };
        }
        Probe {
            role,
            status: "failed",
            latency_ms: None,
            message: "Нет подтверждённого ответа DNS",
        }
    }

    async fn load_blocklist(&self, id: &str) -> Result<Arc<Blocklist>> {
        let path = self.path.with_file_name(format!("dns-hagezi-{id}.txt"));
        let fresh = path
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|created| {
                SystemTime::now()
                    .duration_since(created)
                    .unwrap_or_default()
                    < Duration::from_secs(86_400)
            });
        if fresh && let Ok(list) = read_list(path.clone()).await {
            return Ok(list);
        }
        let name = asset(id).context("неизвестный список DNS")?;
        for source in UPSTREAM_LISTS {
            let download = timeout(
                Duration::from_secs(8),
                self.download_list(path.clone(), &format!("{source}{name}")),
            )
            .await;
            if let Ok(Ok(list)) = download {
                return Ok(list);
            }
        }
        read_list(path).await
    }

    async fn download_list(&self, path: PathBuf, url: &str) -> Result<Arc<Blocklist>> {
        let mut response = self.core.exchange.http.get(url).send().await?;
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "не удалось загрузить выбранный список HaGeZi"
        );
        ensure!(
            response
                .content_length()
                .is_none_or(|size| size <= BLOCKLIST_LIMIT),
            "некорректный файл HaGeZi"
        );
        let pending = tempfile::Builder::new()
            .prefix(".dns-list-")
            .tempfile_in(path.parent().unwrap_or(Path::new(".")))?;
        let mut file = tokio::fs::File::from_std(pending.reopen()?);
        let mut size = 0;
        while let Some(chunk) = response.chunk().await? {
            size += chunk.len() as u64;
            ensure!(size <= BLOCKLIST_LIMIT, "некорректный файл HaGeZi");
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        drop(file);
        spawn_blocking(move || {
            let list = Blocklist::read(pending.path())?;
            pending.persist(path)?;
            Ok(Arc::new(list))
        })
        .await?
    }

    pub async fn shutdown(&self) {
        let _guard = self.updates.lock().await;
        if self.lan_active.load(Ordering::Acquire) {
            let _ = self.apply_lan(false).await;
        }
        for listener in &self.listeners {
            listener.abort();
        }
    }
}

impl Drop for DnsControl {
    fn drop(&mut self) {
        for listener in &self.listeners {
            listener.abort();
        }
    }
}

fn bootstrap(path: &Path) -> (Settings, Arc<Blocklist>, Option<&'static str>) {
    let current = Settings::from_file(path).and_then(|settings| {
        let list = if settings.adblock {
            let name = format!("dns-hagezi-{}.txt", settings.lists[0]);
            Blocklist::read(&path.with_file_name(name))?
        } else {
            Blocklist::default()
        };
        Ok((settings, Arc::new(list), None))
    });
    current.unwrap_or_else(|_| {
        (
            Settings::fallback(),
            Arc::default(),
            Some(BOOT_SETTING_ERROR),
        )
    })
}

async fn read_list(path: PathBuf) -> Result<Arc<Blocklist>> {
    spawn_blocking(move || Blocklist::read(&path).map(Arc::new)).await?
}

fn allowed_client(source: SocketAddr, allowed: IpNet, listen: SocketAddr) -> bool {
    // A service bound to loopback is for router-originated traffic.
    if listen.ip().is_loopback() {
        source.ip().is_loopback()
    } else {
        allowed.contains(&source.ip().to_canonical())
    }
}

async fn serve_udp(socket: UdpSocket, allowed: IpNet, core: Arc<Core>, permits: Arc<Semaphore>) {
    let Ok(listen) = socket.local_addr() else {
        return;
    };
    let socket = Arc::new(socket);
    let mut packet = [0u8; 4096];
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            _ = tasks.join_next(), if !tasks.is_empty() => {}
            incoming = socket.recv_from(&mut packet) => {
                let Ok((n, source)) = incoming else { return };
                if !allowed_client(source, allowed, listen) { continue; }
                let Ok(query) = Message::from_vec(&packet[..n]) else { continue };
                if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
                    let socket = Arc::clone(&socket);
                    let core = Arc::clone(&core);
                    tasks.spawn(async move {
                        let _permit = permit;
                        let answer = core.resolve(&query).await;
                        if let Ok(wire) = udp_wire(&answer, &query) {
                            let _ = socket.send_to(&wire, source).await;
                        }
                    });
                } else {
                    let answer = error_reply(&query, ResponseCode::ServFail);
                    if let Ok(wire) = udp_wire(&answer, &query) {
                        let _ = socket.send_to(&wire, source).await;
                    }
                }
            }
        }
    }
}

async fn serve_tcp(
    listener: TcpListener,
    allowed: IpNet,
    core: Arc<Core>,
    permits: Arc<Semaphore>,
) {
    let Ok(listen) = listener.local_addr() else {
        return;
    };
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            _ = tasks.join_next(), if !tasks.is_empty() => {}
            incoming = listener.accept() => {
                let Ok((stream, source)) = incoming else { return };
                if !allowed_client(source, allowed, listen) { continue; }
                if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
                    let core = Arc::clone(&core);
                    tasks.spawn(async move {
                        let _permit = permit;
                        let _ = tcp_queries(stream, core).await;
                    });
                }
            }
        }
    }
}

async fn tcp_queries(mut stream: TcpStream, core: Arc<Core>) -> Result<()> {
    loop {
        let packet = timeout(Duration::from_secs(4), read_frame(&mut stream)).await??;
        let query = Message::from_vec(&packet)?;
        let answer = core.resolve(&query).await;
        timeout(QUERY_TIMEOUT, write_frame(&mut stream, &answer.to_vec()?)).await??;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_proto::op::Query;
    use hickory_proto::rr::{Name, RecordType};
    use std::fs;

    #[tokio::test]
    async fn serves_loopback_udp_and_tcp_from_saved_blocklist() {
        let directory = tempfile::tempdir().unwrap();
        let blocklist = (0..1000)
            .map(|i| format!("ad{i}.example\n"))
            .collect::<String>();
        fs::write(directory.path().join("dns-hagezi-normal.txt"), blocklist).unwrap();
        let config = Settings {
            adblock: true,
            ..Settings::fallback()
        };
        let mut output = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        serde_json::to_writer(&mut output, &config).unwrap();
        output.persist(directory.path().join("dns.json")).unwrap();
        let control = DnsControl::start(
            directory.path().into(),
            Some("127.0.0.1:0".parse().unwrap()),
            "127.0.0.0/8".parse().unwrap(),
            None,
        )
        .await
        .unwrap();
        let status = control.snapshot().await;
        assert!(status.enabled);
        assert_eq!(status.blocklist_entries, 1000);
        let endpoint = status.listen.unwrap();
        let mut request = test_query().unwrap();
        request.queries[0] = Query::query(
            Name::from_ascii("sub.ad30.example.").unwrap(),
            RecordType::A,
        );
        let query = request.to_vec().unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        udp.connect(endpoint).await.unwrap();
        udp.send(&query).await.unwrap();
        let mut packet = [0; 512];
        let size = timeout(Duration::from_secs(2), udp.recv(&mut packet))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            Message::from_vec(&packet[..size])
                .unwrap()
                .metadata
                .response_code,
            ResponseCode::NXDomain
        );
        let mut tcp = TcpStream::connect(endpoint).await.unwrap();
        write_frame(&mut tcp, &query).await.unwrap();
        let response = timeout(Duration::from_secs(2), read_frame(&mut tcp))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            Message::from_vec(&response).unwrap().metadata.response_code,
            ResponseCode::NXDomain
        );
        control.shutdown().await;
    }

    #[tokio::test]
    async fn invalid_dns_setting_and_unavailable_lan_preserve_saved_state() {
        let directory = tempfile::tempdir().unwrap();
        let control = DnsControl::start(
            directory.path().into(),
            None,
            "127.0.0.0/8".parse().unwrap(),
            None,
        )
        .await
        .unwrap();
        let next = Settings {
            lan: true,
            ..Settings::fallback()
        };
        let result = control.apply(next).await.err().unwrap();
        assert_eq!(result.status, 422);
        assert!(!directory.path().join("dns.json").exists());
        assert!(!control.snapshot().await.settings.lan);
    }
}
