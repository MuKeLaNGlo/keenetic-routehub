use std::{collections::BTreeMap, net::IpAddr, sync::LazyLock};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use ipnet::IpNet;
use regex::Regex;

use crate::{
    ParseResult,
    profiles::{fallback, host_port, net_host, split_host_port},
};

pub struct ManagedAwg {
    pub version: String,
    pub endpoint: String,
    pub addresses: Vec<IpAddr>,
    pub dns: Vec<IpAddr>,
    pub mtu: u16,
    pub parameters: String,
}

fn awg_key(value: &str) -> Option<String> {
    let bytes = STANDARD.decode(value).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Default)]
struct AwgLines {
    interface: BTreeMap<String, String>,
    peer: BTreeMap<String, String>,
    version: String,
}

fn awg_lines(text: &str) -> ParseResult<AwgLines> {
    if text.len() > 128 << 10 {
        return Err("файл AmneziaWG превышает 128 КиБ".into());
    }
    let mut result = AwgLines::default();
    let mut part = 0;
    for (index, raw) in text.split('\n').enumerate() {
        let line = raw.trim();
        if let Some(header) = line.strip_prefix(['#', ';']) {
            let header = header.to_lowercase();
            if header.contains("amneziawg") || header.contains("version") {
                for version in ["2.0", "3.1"] {
                    if header.contains(version) {
                        result.version = version.into();
                    }
                }
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }
        let error = || {
            format!(
                "проверьте строку {} файла AmneziaWG. Поддерживается один интерфейс и один peer",
                index + 1
            )
        };
        match line.to_ascii_lowercase().as_str() {
            "[interface]" if part == 0 => {
                part = 1;
                continue;
            }
            "[peer]" if part == 1 && result.interface.contains_key("privatekey") => {
                part = 2;
                continue;
            }
            _ => {}
        }
        let (name, value) = line.split_once('=').ok_or_else(error)?;
        let key = name.trim().to_lowercase();
        let value = value.trim();
        let map = match part {
            1 => &mut result.interface,
            2 => &mut result.peer,
            _ => return Err(error()),
        };
        if key.is_empty()
            || value.is_empty()
            || value.contains(['\r', '\n', '\0'])
            || map.contains_key(&key)
        {
            return Err(error());
        }
        map.insert(key, value.into());
    }
    Ok(result)
}

fn kernel_key(key: &str) -> Option<&str> {
    match key {
        "jc" | "jmin" | "jmax" | "s1" | "s2" | "s3" | "s4" | "h1" | "h2" | "h3" | "h4" | "i1"
        | "i2" | "i3" | "i4" | "i5" => Some(key),
        "headerprotectionkey" => Some("header_protection_key"),
        "contentpaddingaddition" => Some("content_padding_addition"),
        "rekeyaftertime" => Some("rekey_after_time"),
        "rekeytimeout" => Some("rekey_timeout"),
        "rejectaftertime" => Some("reject_after_time"),
        "keepalivetimeout" => Some("keepalive_timeout"),
        "maxhandshakeattempts" => Some("max_handshake_attempts"),
        "randomtrailers" => Some("random_trailers"),
        "disablecookies" => Some("disable_cookies"),
        _ => None,
    }
}

static AWG_RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+(-[0-9]+)?$").unwrap());

pub fn parse_managed_awg(text: &str, version: &str) -> ParseResult<ManagedAwg> {
    let lines = awg_lines(text)?;
    let version = fallback(version, fallback(&lines.version, "3.1"));
    if !matches!(version, "2.0" | "3.1") || !lines.version.is_empty() && lines.version != version {
        return Err("проверьте версию AmneziaWG (2.0 или 3.1)".into());
    }
    let read = |section: &BTreeMap<String, String>, key: &str| {
        section.get(key).cloned().unwrap_or_default()
    };
    let private = awg_key(&read(&lines.interface, "privatekey"));
    let public = awg_key(&read(&lines.peer, "publickey"));
    let (Some(private), Some(public)) = (private, public) else {
        return Err("AmneziaWG требует PrivateKey и PublicKey из 32 байт".into());
    };
    let mut parameters = format!("private_key={private}\n");
    for (key, value) in &lines.interface {
        if matches!(key.as_str(), "privatekey" | "address" | "dns" | "mtu") {
            continue;
        }
        let kernel = kernel_key(key)
            .ok_or("в [Interface] есть неизвестный параметр либо команда запуска")?;
        let value = match key.as_str() {
            "headerprotectionkey" => awg_key(value),
            "disablecookies" => {
                let value = value.to_lowercase();
                matches!(value.as_str(), "true" | "false").then_some(value)
            }
            key if key.len() == 2 && key.starts_with('i') => {
                (value.len() <= 8192 && value.starts_with('<') && value.ends_with('>'))
                    .then(|| value.clone())
            }
            _ => AWG_RANGE.is_match(value).then(|| value.clone()),
        }
        .ok_or("некорректное значение параметра AmneziaWG")?;
        parameters.push_str(&format!("{kernel}={value}\n"));
    }
    let addresses = read(&lines.interface, "address")
        .split(',')
        .map(|value| {
            value
                .trim()
                .parse::<IpNet>()
                .ok()
                .map(|net| net.addr())
                .filter(|ip| !ip.is_unspecified() && !ip.is_multicast())
                .ok_or("укажите адрес интерфейса AmneziaWG в формате CIDR")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let dns = read(&lines.interface, "dns");
    let dns = if dns.is_empty() {
        vec![IpAddr::from([1, 1, 1, 1])]
    } else {
        dns.split(',')
            .map(|value| {
                value
                    .trim()
                    .parse::<IpAddr>()
                    .ok()
                    .filter(|ip| !ip.is_unspecified() && !ip.is_multicast())
                    .map(|ip| ip.to_canonical())
                    .ok_or("используйте IP-адреса в параметре DNS AmneziaWG")
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let mtu = read(&lines.interface, "mtu");
    let mtu = if mtu.is_empty() {
        1280
    } else {
        mtu.parse::<u16>()
            .ok()
            .filter(|n| (576..=1500).contains(n))
            .ok_or("укажите MTU AmneziaWG в пределах 576–1500")?
    };
    if addresses.len() > 8 || dns.len() > 4 {
        return Err("слишком много адресов интерфейса или DNS".into());
    }
    let endpoint = read(&lines.peer, "endpoint");
    let (host, port) =
        split_host_port(&endpoint).ok_or("укажите Endpoint AmneziaWG в формате сервер:порт")?;
    if !port.bytes().all(|b| b.is_ascii_digit())
        || !port.parse::<u16>().is_ok_and(|n| n != 0)
        || !net_host(host)
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified())
    {
        return Err("укажите Endpoint AmneziaWG в формате сервер:порт".into());
    }
    let endpoint = host_port(host, port);
    parameters.push_str(&format!("public_key={public}\nreplace_allowed_ips=true\n"));
    for (key, value) in &lines.peer {
        match key.as_str() {
            "publickey" | "endpoint" | "allowedips" => {}
            "presharedkey" => {
                let psk = awg_key(value).ok_or("проверьте PresharedKey в [Peer]")?;
                parameters.push_str(&format!("preshared_key={psk}\n"));
            }
            "persistentkeepalive" => {
                if !AWG_RANGE.is_match(value) {
                    return Err("проверьте PersistentKeepalive в [Peer]".into());
                }
                parameters.push_str(&format!("persistent_keepalive_interval={value}\n"));
            }
            _ => return Err("в [Peer] есть неизвестный параметр".into()),
        }
    }
    let allowed = read(&lines.peer, "allowedips");
    if allowed.split(',').count() > 128 {
        return Err("допустимо до 128 сетей AllowedIPs".into());
    }
    for route in allowed.split(',') {
        let net = route
            .trim()
            .parse::<IpNet>()
            .map_err(|_| "укажите AllowedIPs в формате CIDR")?;
        parameters.push_str(&format!("allowed_ip={}\n", net.trunc()));
    }
    Ok(ManagedAwg {
        version: version.into(),
        endpoint,
        addresses,
        dns,
        mtu,
        parameters,
    })
}
