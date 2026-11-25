use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener},
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use routehub_subscriptions::{
    PROFILE_PROBE_URL, Profile, is_public_ipv4, lookup_public_ipv4, pin_profile_uri,
    pin_subscription_hysteria_node, pin_subscription_vless_node, pin_trojan_outbound,
    probe_active_socks_https, probe_socks_https, validate_xray_profile_group,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::{Child, Command},
    time::{sleep, timeout},
};

use crate::{
    config::{Plan, interface_name},
    xray,
};

const UNAVAILABLE: &str = "Не удалось запустить отдельную проверку туннеля.";
const TUNNEL_UNAVAILABLE: &str = "Туннель профиля недоступен для проверки.";
const CONTROL_FAILURE: &str = "Контрольный HTTPS-запрос через этот профиль не получил ответа.";
const CONTROL_UNVERIFIED: &str =
    "Контрольный HTTPS-запрос через профиль получил неожиданный ответ.";
const CONTROL_VERIFIED: &str = "Контрольный HTTPS-запрос прошёл через выбранный туннель.";
const PUBLIC_ONLY: &str = "Проверка принимает только публичный IPv4.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    profile: String,
    status: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u128>,
}

impl ProbeResult {
    fn unavailable(profile: String, message: &'static str) -> Self {
        Self {
            profile,
            status: "unavailable",
            message,
            latency_ms: None,
        }
    }

    fn from_https(profile: String, result: Option<(u16, u128)>) -> Self {
        let (status, message, latency_ms) = match result {
            Some((204, elapsed)) => ("verified", CONTROL_VERIFIED, Some(elapsed)),
            Some((_, _)) => ("unverified", CONTROL_UNVERIFIED, None),
            None => ("failed", CONTROL_FAILURE, None),
        };
        Self {
            profile,
            status,
            message,
            latency_ms,
        }
    }
}

pub(crate) async fn run_managed_awg(id: String, port: Option<u16>) -> ProbeResult {
    let Some(port) = port.filter(|port| *port != 0) else {
        return ProbeResult::unavailable(id, TUNNEL_UNAVAILABLE);
    };
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    ProbeResult::from_https(id, probe_active_socks_https(address, false).await)
}

pub(crate) async fn run(path: &Path, profile: Profile) -> ProbeResult {
    let id = profile.id.clone();
    timeout(Duration::from_secs(15), run_bounded(path, profile))
        .await
        .unwrap_or_else(|_| ProbeResult::unavailable(id, UNAVAILABLE))
}

async fn run_bounded(path: &Path, profile: Profile) -> ProbeResult {
    let id = profile.id.clone();
    let group = profile.xray_group.is_some();
    let pinned = match timeout(Duration::from_secs(3), compile_pinned(profile)).await {
        Ok(Ok(config)) => config,
        Ok(Err(message)) => return ProbeResult::unavailable(id, message),
        Err(_) => return ProbeResult::unavailable(id, "Резолвер роутера не вернул IPv4."),
    };
    let result = start(path, pinned, group).await;
    let Ok(result) = result else {
        return ProbeResult::unavailable(id, UNAVAILABLE);
    };
    ProbeResult::from_https(id, result)
}

async fn public_address(endpoint: &str) -> Result<Ipv4Addr, &'static str> {
    let (host, port) = endpoint.rsplit_once(':').ok_or(PUBLIC_ONLY)?;
    port.parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or(PUBLIC_ONLY)?;
    let literal = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = literal.parse::<IpAddr>() {
        let ipv4 = match address {
            IpAddr::V4(ipv4) => Some(ipv4),
            IpAddr::V6(ipv6) => ipv6.to_ipv4_mapped(),
        };
        return ipv4.filter(|ip| is_public_ipv4(*ip)).ok_or(PUBLIC_ONLY);
    }
    if host.is_empty() || host.contains(':') {
        return Err(PUBLIC_ONLY);
    }
    lookup_public_ipv4(host)
        .await
        .map_err(|_| "Резолвер роутера не вернул IPv4.")?
        .first()
        .copied()
        .ok_or("Публичный IPv4 среди DNS-ответов отсутствует.")
}

async fn compile_pinned(mut profile: Profile) -> Result<Value, &'static str> {
    if let Some(group) = &mut profile.xray_group {
        pin_group(group).await?;
        let (members, balancer, selectors) =
            xray::group_outbound(&profile.id, group).map_err(|_| UNAVAILABLE)?;
        let mut outbounds = vec![json!({"tag":"@block","protocol":"blackhole"})];
        outbounds.extend(members);
        return Ok(json!({
            "outbounds": outbounds,
            "routing": {
                "domainStrategy": "AsIs",
                "rules": [{
                    "type": "field", "inboundTag": ["routehub-probe"], "balancerTag": balancer["tag"],
                }],
                "balancers": [balancer],
            },
            "burstObservatory": {
                "subjectSelector": selectors,
                "pingConfig": {"destination":PROFILE_PROBE_URL,"interval":"45s","sampling":2,"timeout":"4s","httpMethod":"HEAD"},
            },
        }));
    }
    if profile.protocol == "amneziawg"
        && profile.awg_config.is_empty()
        && interface_name(&profile.interface)
    {
        return Ok(json!({"outbounds":[{
            "tag":profile.id,"protocol":"freedom","settings":{},
            "streamSettings":{"sockopt":{"interface":profile.interface}},
        }]}));
    }
    Ok(json!({"outbounds":[pin(&profile).await?]}))
}

async fn pin_group(
    group: &mut routehub_subscriptions::XrayProfileGroup,
) -> Result<(), &'static str> {
    validate_xray_profile_group(group).map_err(|_| UNAVAILABLE)?;
    let mut tasks = tokio::task::JoinSet::new();
    for (index, member) in group.members.iter_mut().enumerate() {
        let member_profile = Profile {
            protocol: "vless".into(),
            outbound: Some(std::mem::take(&mut member.outbound)),
            ..Default::default()
        };
        tasks.spawn(async move { (index, pin(&member_profile).await) });
    }
    while let Some(result) = tasks.join_next().await {
        let (index, outbound) = result.map_err(|_| UNAVAILABLE)?;
        group.members[index].outbound = outbound?;
    }
    Ok(())
}

/// Pin subscription-managed protocols with auxiliary transport settings
/// before starting Xray. The original subscription remains intact on disk.
pub(crate) async fn pin_catalog_profiles(plan: &mut Plan) -> Result<()> {
    let referenced: HashSet<&str> = std::iter::once(plan.default_target.as_str())
        .chain(
            plan.rules
                .iter()
                .filter(|r| !r.disabled)
                .map(|r| r.target.as_str()),
        )
        .chain(plan.devices.iter().flat_map(|device| {
            std::iter::once(device.default_target.as_str()).chain(
                device
                    .rules
                    .iter()
                    .filter(|r| !r.disabled)
                    .map(|r| r.target.as_str()),
            )
        }))
        .chain(Some(plan.health_target.as_str()))
        .collect();
    timeout(Duration::from_secs(5), async {
        for profile in &mut plan.profiles {
            if profile.catalog_profile && !referenced.contains(profile.id.as_str()) {
                continue;
            }
            let result = if let Some(group) = &mut profile.xray_group {
                pin_group(group).await
            } else if profile.catalog_profile && profile.protocol == "hysteria2" {
                pin(profile)
                    .await
                    .map(|outbound| profile.outbound = Some(outbound))
            } else {
                continue;
            };
            result.map_err(|detail| anyhow::anyhow!("профиль {:?}: {detail}", profile.id))?;
        }
        Ok(())
    })
    .await
    .context("не удалось подтвердить публичные IPv4 активных профилей")?
}

async fn pin(profile: &Profile) -> Result<Value, &'static str> {
    let address = public_address(&profile.endpoint()).await?;
    if !profile.uri.is_empty() {
        return pin_profile_uri(profile, address).map_err(|_| UNAVAILABLE);
    }
    if profile.protocol == "trojan" {
        return pin_trojan_outbound(profile, address).map_err(|_| UNAVAILABLE);
    }
    let pinned = match profile.protocol.as_str() {
        "vless" => pin_subscription_vless_node(profile, address),
        "hysteria2" => pin_subscription_hysteria_node(profile, address),
        _ => return Err(UNAVAILABLE),
    };
    pinned
        .ok()
        .and_then(|profile| profile.outbound)
        .ok_or(UNAVAILABLE)
}

struct ProbeEngine {
    address: SocketAddrV4,
    username: String,
    password: String,
    child: Child,
}

async fn start(path: &Path, config: Value, group: bool) -> Result<Option<(u16, u128)>> {
    let mut engine = start_engine(path, config).await?;
    let result = probe_socks_https(engine.address, &engine.username, &engine.password, group).await;
    let _ = engine.child.kill().await;
    Ok(result)
}

pub(crate) async fn connect_route(
    path: &Path,
    profile: Profile,
    destination: SocketAddrV4,
) -> Result<(TcpStream, Child)> {
    anyhow::ensure!(
        is_public_ipv4(*destination.ip()) && matches!(destination.port(), 80 | 443),
        "проверка принимает только публичный IPv4 и порт 80 или 443"
    );
    timeout(Duration::from_secs(15), async {
        let config = timeout(Duration::from_secs(3), compile_pinned(profile))
            .await?
            .map_err(anyhow::Error::msg)?;
        let engine = start_engine(path, config).await?;
        let mut socket = TcpStream::connect(engine.address).await?;
        anyhow::ensure!(
            authenticate_stream(&mut socket, &engine.username, &engine.password).await?,
            "не удалось авторизоваться в SOCKS ядра"
        );
        let mut request = [5, 1, 0, 1, 0, 0, 0, 0, 0, 0];
        request[4..8].copy_from_slice(&destination.ip().octets());
        request[8..].copy_from_slice(&destination.port().to_be_bytes());
        socket.write_all(&request).await?;
        let mut reply = [0u8; 4];
        socket.read_exact(&mut reply).await?;
        anyhow::ensure!(
            reply[..3] == [5, 0, 0],
            "SOCKS не подключился к адресу проверки"
        );
        let addr_length = match reply[3] {
            1 => 4,
            3 => usize::from(socket.read_u8().await?),
            4 => 16,
            _ => anyhow::bail!("некорректный адрес в ответе SOCKS"),
        };
        let mut address_port = [0u8; 257];
        socket
            .read_exact(&mut address_port[..addr_length + 2])
            .await?;
        Ok((socket, engine.child))
    })
    .await
    .context("превышено время ожидания VPN")?
}

async fn start_engine(path: &Path, mut config: Value) -> Result<ProbeEngine> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let SocketAddr::V4(address) = listener.local_addr()? else {
        anyhow::bail!("SOCKS-проверке нужен loopback IPv4");
    };
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| anyhow::anyhow!("нет случайного ключа проверки"))?;
    let username = hex::encode(&nonce[..8]);
    let password = hex::encode(&nonce[8..]);
    config["log"] = json!({"loglevel":"error"});
    config["inbounds"] = json!([{
        "tag":"routehub-probe", "listen":Ipv4Addr::LOCALHOST.to_string(), "port":address.port(),
        "protocol":"socks", "settings":{"auth":"password","accounts":[{"user":username,"pass":password}]},
    }]);
    let private = xray::private_config(&config)?;
    drop(config);
    xray::check(path, &private).await?;
    drop(listener);
    let mut child = Command::new(path)
        .kill_on_drop(true)
        .args(["run", "-c"])
        .arg(private.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    wait_for_socks(address, &username, &password, &mut child).await?;
    drop(private);
    Ok(ProbeEngine {
        address,
        username,
        password,
        child,
    })
}

async fn wait_for_socks(
    address: SocketAddrV4,
    username: &str,
    password: &str,
    child: &mut Child,
) -> Result<()> {
    let until = Instant::now() + Duration::from_secs(6);
    while Instant::now() < until {
        anyhow::ensure!(
            child.try_wait()?.is_none(),
            "ядро проверки профиля завершилось"
        );
        if matches!(
            timeout(
                Duration::from_millis(200),
                authenticate_socks(address, username, password)
            )
            .await,
            Ok(Ok(true))
        ) {
            return Ok(());
        }
        sleep(Duration::from_millis(60)).await;
    }
    anyhow::bail!("ядро проверки не открыло изолированный SOCKS")
}

async fn authenticate_socks(address: SocketAddrV4, username: &str, password: &str) -> Result<bool> {
    let mut socket = TcpStream::connect(address).await?;
    authenticate_stream(&mut socket, username, password).await
}

async fn authenticate_stream(
    socket: &mut TcpStream,
    username: &str,
    password: &str,
) -> Result<bool> {
    socket.write_all(&[5, 1, 2]).await?;
    let mut reply = [0u8; 2];
    socket.read_exact(&mut reply).await?;
    if reply != [5, 2] {
        return Ok(false);
    }
    let lengths = (u8::try_from(username.len())?, u8::try_from(password.len())?);
    let mut request = Vec::with_capacity(3 + username.len() + password.len());
    request.extend_from_slice(&[1, lengths.0]);
    request.extend_from_slice(username.as_bytes());
    request.push(lengths.1);
    request.extend_from_slice(password.as_bytes());
    socket.write_all(&request).await?;
    socket
        .read_exact(&mut reply)
        .await
        .context("проверка авторизации SOCKS")?;
    Ok(reply == [1, 0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use routehub_subscriptions::{XrayGroupMember, XrayProfileGroup};

    #[tokio::test]
    async fn grouped_probe_keeps_fail_closed_balancer_and_no_other_egress() {
        let member = |address| XrayGroupMember {
            protocol: "vless".into(),
            outbound: json!({
                "protocol":"vless", "settings":{"address":address,"port":443,"id":"test"},
                "streamSettings":{"security":"tls","network":"ws","wsSettings":{"path":"/"}},
            }),
            ..Default::default()
        };
        let profile = Profile {
            id: "test".into(),
            protocol: "vless".into(),
            xray_group: Some(XrayProfileGroup {
                strategy: "leastPing".into(),
                members: vec![member("1.1.1.1"), member("8.8.8.8")],
                ..Default::default()
            }),
            ..Default::default()
        };
        let config = compile_pinned(profile).await.unwrap();
        assert_eq!(config["outbounds"].as_array().unwrap().len(), 3);
        assert_eq!(config["outbounds"][0]["protocol"], "blackhole");
        assert_eq!(
            config["outbounds"][1]["streamSettings"]["tlsSettings"]["serverName"],
            "1.1.1.1"
        );
        assert_eq!(config["routing"]["balancers"][0]["fallbackTag"], "@block");
        assert_eq!(
            config["routing"]["rules"][0]["inboundTag"][0],
            "routehub-probe"
        );
        assert_eq!(
            config["burstObservatory"]["pingConfig"]["destination"],
            PROFILE_PROBE_URL
        );
    }

    #[tokio::test]
    async fn probe_rejects_local_egress_without_resolving() {
        for endpoint in [
            "127.0.0.1:443",
            "10.0.0.2:443",
            "[::1]:443",
            "192.168.1.1:443",
        ] {
            assert_eq!(public_address(endpoint).await, Err(PUBLIC_ONLY));
        }
    }

    #[tokio::test]
    async fn readiness_rejects_a_different_socks_process() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let SocketAddr::V4(address) = listener.local_addr().unwrap() else {
            panic!("IPv4 listener")
        };
        let server = async {
            let (mut client, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 3];
            client.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [5, 1, 2]);
            client.write_all(&[5, 0]).await.unwrap();
        };
        let (ready, ()) = tokio::join!(authenticate_socks(address, "test", "token"), server);
        assert!(!ready.unwrap());
    }

    #[tokio::test]
    async fn managed_awg_requires_a_prepared_local_socks_port() {
        let result = run_managed_awg("managed".into(), None).await;
        assert_eq!(result.profile, "managed");
        assert_eq!(result.status, "unavailable");
        assert_eq!(result.message, TUNNEL_UNAVAILABLE);
        assert_eq!(result.latency_ms, None);
    }

    #[tokio::test]
    async fn managed_awg_control_request_uses_the_local_proxy_and_reports_failure() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = async {
            let (mut client, _) = listener.accept().await.unwrap();
            assert_eq!(client.read_u8().await.unwrap(), 5);
            let count = client.read_u8().await.unwrap() as usize;
            let mut methods = vec![0; count];
            client.read_exact(&mut methods).await.unwrap();
            assert!(methods.contains(&0));
            client.write_all(&[5, 0]).await.unwrap();
            let mut request = [0; 4];
            client.read_exact(&mut request).await.unwrap();
            assert_eq!(request, [5, 1, 0, 3]);
            let length = client.read_u8().await.unwrap() as usize;
            let mut host = vec![0; length];
            client.read_exact(&mut host).await.unwrap();
            assert_eq!(host, b"www.gstatic.com");
            assert_eq!(client.read_u16().await.unwrap(), 443);
            client
                .write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
        };
        let (result, ()) = timeout(Duration::from_secs(2), async {
            tokio::join!(run_managed_awg("managed".into(), Some(port)), server)
        })
        .await
        .unwrap();
        assert_eq!(result.status, "failed");
        assert_eq!(result.latency_ms, None);
    }

    #[tokio::test]
    async fn external_awg_probe_binds_the_existing_interface() {
        let profile = Profile {
            id: "external".into(),
            protocol: "amneziawg".into(),
            interface: "Wireguard0".into(),
            ..Default::default()
        };
        let config = compile_pinned(profile).await.unwrap();
        assert_eq!(
            config["outbounds"][0]["streamSettings"]["sockopt"]["interface"],
            "Wireguard0"
        );
        assert_eq!(config["outbounds"].as_array().unwrap().len(), 1);
    }
}
