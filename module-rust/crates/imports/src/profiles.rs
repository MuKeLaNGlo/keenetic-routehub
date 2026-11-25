use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::IpAddr,
};

use percent_encoding::percent_decode_str;
use routehub_subscriptions::profile_uri_outbound;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;
use yaml_rust2::parser::{Event, EventReceiver, Parser};

use crate::{BOM, ParseResult, parse_managed_awg};

pub use routehub_subscriptions::Profile as ImportedProfile;

const MAX_PROFILE_FILE_BYTES: usize = 512 << 10;
type Object = Map<String, Value>;

#[derive(Clone, Serialize, Deserialize)]
pub struct ProfilePreview {
    pub profiles: Vec<ImportedProfile>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl ProfilePreview {
    fn new(profiles: Vec<ImportedProfile>) -> Self {
        Self {
            profiles,
            note: String::new(),
        }
    }

    fn with_note(entry: ImportedProfile, note: &str) -> Self {
        Self {
            profiles: vec![entry],
            note: note.into(),
        }
    }
}

pub(crate) fn fallback<'a>(value: &'a str, alt: &'a str) -> &'a str {
    if value.is_empty() { alt } else { value }
}

pub(crate) fn split_host_port(raw: &str) -> Option<(&str, &str)> {
    if let Some(value) = raw.strip_prefix('[') {
        let (host, separator) = value.split_once(']')?;
        Some((host, separator.strip_prefix(':')?))
    } else {
        let (host, port) = raw.rsplit_once(':')?;
        if host.contains(':') {
            return None;
        }
        Some((host, port))
    }
}

pub(crate) fn host_port(host: &str, port: &str) -> String {
    let host = host.trim_matches(['[', ']']);
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

pub(crate) fn net_host(input: &str) -> bool {
    let host = input.trim().to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    host.parse::<IpAddr>().is_ok()
        || !host.is_empty()
            && host.len() <= 253
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
}

fn interface_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 15
        && !name.starts_with(['-', '.'])
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn imported_label(label: &str) -> String {
    let label = label.trim();
    if label.chars().count() > 100 || label.chars().any(char::is_control) || label.contains("://") {
        String::new()
    } else {
        label.into()
    }
}

pub fn profile_server(profile: &ImportedProfile) -> String {
    if !profile.uri.is_empty() {
        if let Ok(url) = Url::parse(&profile.uri)
            && let Some(host) = url.host_str()
        {
            return host_port(host, &url.port().unwrap_or(443).to_string());
        }
    } else if let Some(outbound) = &profile.outbound {
        let settings = &outbound["settings"];
        let server = settings["vnext"]
            .as_array()
            .and_then(|a| a.first())
            .or_else(|| settings["servers"].as_array().and_then(|a| a.first()))
            .unwrap_or(settings);
        if let Some(host) = server["address"].as_str()
            && let Some(port) = server["port"].as_u64()
            && !host.is_empty()
            && port != 0
        {
            return host_port(host, &port.to_string());
        }
    } else if !profile.awg_config.is_empty()
        && let Ok(config) = parse_managed_awg(&profile.awg_config, &profile.awg_version)
    {
        return config.endpoint;
    }
    String::new()
}

struct Line<'a> {
    value: &'a str,
    number: usize,
}

pub fn parse_profile_upload(
    data: &[u8],
    interface: &str,
    awg_version: &str,
    existing: &HashSet<String>,
) -> ParseResult<ProfilePreview> {
    if data.len() > MAX_PROFILE_FILE_BYTES {
        return Err("размер файла профилей не должен превышать 512 КиБ".into());
    }
    let data = std::str::from_utf8(data.strip_prefix(BOM).unwrap_or(data))
        .ok()
        .filter(|s| !s.contains('\0'))
        .ok_or("выберите текстовый файл в кодировке UTF-8")?;
    let lines_text = data.replace("\r\n", "\n").replace('\r', "\n");
    let lines = lines_text
        .split('\n')
        .enumerate()
        .filter_map(|(index, value)| {
            let value = value.trim();
            (!value.is_empty() && !value.starts_with(['#', ';'])).then_some(Line {
                value,
                number: index + 1,
            })
        })
        .collect::<Vec<_>>();
    let first = lines
        .first()
        .map_or_else(String::new, |first| first.value.to_lowercase());
    let mut preview = if first.is_empty() && !interface.is_empty() {
        if !awg_version.is_empty() || !interface_name(interface) {
            return Err("укажите имя уже настроенного интерфейса WireGuard ASC".into());
        }
        ProfilePreview::with_note(
            ImportedProfile {
                protocol: "amneziawg".into(),
                interface: interface.into(),
                ..ImportedProfile::default()
            },
            "Интерфейс WireGuard ASC будет проверен при применении.",
        )
    } else if first.is_empty() {
        return Err("в файле нет профилей".into());
    } else if first.starts_with("[interface]") || first.starts_with("[peer]") {
        if interface.is_empty() {
            let config = parse_managed_awg(data, awg_version)?;
            ProfilePreview::new(vec![ImportedProfile {
                protocol: "amneziawg".into(),
                awg_version: config.version,
                awg_config: data.into(),
                ..ImportedProfile::default()
            }])
        } else {
            parse_awg_profile(&lines, interface)?
        }
    } else if !interface.is_empty() || !awg_version.is_empty() {
        return Err("параметры WireGuard указываются для файла AmneziaWG".into());
    } else if first == "[internetshortcut]" {
        let link = lines[1..]
            .iter()
            .find_map(|row| {
                let (key, data) = row.value.split_once('=')?;
                key.trim().eq_ignore_ascii_case("url").then_some(Line {
                    value: data.trim(),
                    number: row.number,
                })
            })
            .ok_or("в файле URL нет ссылки VPN")?;
        parse_links(&[link])?
    } else if first.starts_with(['{', '[']) || first.starts_with("//") || first.starts_with("/*") {
        parse_xray_profiles(data)?
    } else if first
        .split_once("://")
        .is_some_and(|(prefix, _)| !prefix.contains(':'))
        || first.starts_with("url=")
    {
        parse_links(&lines)?
    } else if first.contains(':') || first.starts_with("- ") || first.starts_with("---") {
        parse_yaml_profiles(data)?
    } else {
        return Err(
            "выберите ссылки VLESS, Hysteria2 или Trojan, JSON, YAML либо файл AmneziaWG .conf"
                .into(),
        );
    };
    let mut used = existing.clone();
    let mut serial = HashMap::<String, usize>::new();
    for entry in &mut preview.profiles {
        let counter = serial.entry(entry.protocol.clone()).or_default();
        loop {
            *counter += 1;
            let id = format!("{}-{counter}", entry.protocol);
            if used.insert(id.clone()) {
                entry.id = id;
                break;
            }
        }
        entry.server = profile_server(entry);
    }
    Ok(preview)
}

fn parse_links(lines: &[Line<'_>]) -> ParseResult<ProfilePreview> {
    let mut entries = Vec::new();
    for row in lines {
        let value = match row.value.split_once('=') {
            Some((key, value)) if key.trim().eq_ignore_ascii_case("URL") => value.trim(),
            _ => row.value,
        };
        let (uri, fragment) = value.split_once('#').unwrap_or((value, ""));
        let uri = uri.trim();
        let (scheme, _) = uri
            .split_once("://")
            .ok_or_else(|| format!("проверьте ссылку в строке {}", row.number))?;
        let folded = scheme.to_ascii_lowercase();
        let protocol = match folded.as_str() {
            "hy2" => "hysteria2",
            "vless" | "hysteria2" | "trojan" => &folded,
            "vpn" => return Err("для AmneziaWG экспортируйте файл .conf из AmneziaVPN".into()),
            _ => {
                return Err(format!(
                    "в строке {} поддерживаются ссылки VLESS, Hysteria2 и Trojan",
                    row.number
                ));
            }
        };
        let label = if valid_percent(fragment) {
            percent_decode_str(fragment).decode_utf8().ok()
        } else {
            None
        };
        let entry = ImportedProfile {
            protocol: protocol.into(),
            uri: uri.into(),
            label: imported_label(label.as_deref().unwrap_or("")),
            ..ImportedProfile::default()
        };
        profile_uri_outbound(&entry).map_err(|_| format!(
            "проверьте адрес, порт и транспорт ссылки в строке {}. Для нестандартного транспорта загрузите JSON Xray", row.number
        ))?;
        entries.push(entry);
    }
    Ok(ProfilePreview::new(entries))
}

fn valid_percent(input: &str) -> bool {
    let input = input.as_bytes();
    input.iter().enumerate().all(|(i, byte)| {
        *byte != b'%'
            || input.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                && input.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
    })
}

fn parse_awg_profile(lines: &[Line<'_>], interface: &str) -> ParseResult<ProfilePreview> {
    let mut section = 0;
    let mut private_key = false;
    let mut peer_key = false;
    let mut obfuscation = false;
    let mut peer_line = 0;
    for line in lines {
        let text = line.value.split(['#', ';']).next().unwrap_or("").trim();
        match text.to_ascii_lowercase().as_str() {
            "[interface]" => {
                if section != 0 {
                    return Err(format!(
                        "в файле AmneziaWG нужна одна секция [Interface], повтор в строке {}",
                        line.number
                    ));
                }
                section = 1;
                continue;
            }
            "[peer]" => {
                if section == 0 {
                    return Err("начните конфигурацию AmneziaWG с секции [Interface]".into());
                }
                if peer_line != 0 && !peer_key {
                    return Err(format!(
                        "добавьте PublicKey в секцию [Peer] со строки {peer_line}"
                    ));
                }
                section = 2;
                peer_line = line.number;
                peer_key = false;
                continue;
            }
            _ => {}
        }
        let (key, field) = text.split_once('=').unwrap_or(("", ""));
        let key = key.trim().to_lowercase();
        if section == 0 || key.is_empty() || field.trim().is_empty() {
            return Err(format!("проверьте запись .conf в строке {}", line.number));
        }
        if section == 1 {
            private_key |= key == "privatekey";
            obfuscation |= matches!(
                key.as_str(),
                "jc" | "jmin"
                    | "jmax"
                    | "s1"
                    | "s2"
                    | "s3"
                    | "s4"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "i1"
                    | "i2"
                    | "i3"
                    | "i4"
                    | "i5"
            );
        } else {
            peer_key |= key == "publickey";
        }
    }
    if !obfuscation {
        return Err("найден WireGuard. Для AmneziaWG нужен файл .conf с параметрами обфускации в секции [Interface]".into());
    }
    if !private_key || peer_line == 0 || !peer_key {
        return Err("проверьте PrivateKey в [Interface] и PublicKey в каждой секции [Peer]".into());
    }
    if !interface_name(interface) || interface == "lo" {
        return Err("укажите имя интерфейса WireGuard ASC на Keenetic".into());
    }
    Ok(ProfilePreview::with_note(
        ImportedProfile {
            protocol: "amneziawg".into(),
            interface: interface.into(),
            ..ImportedProfile::default()
        },
        "В RouteHub указывается имя уже настроенного интерфейса WireGuard ASC. Импортируйте файл AmneziaWG в KeeneticOS перед применением профиля.",
    ))
}

pub(crate) fn strip_xray_comments(source: &str) -> ParseResult<String> {
    let data = source.as_bytes();
    let mut output = data.to_vec();
    let mut quoted = false;
    let mut index = 0;
    while index < data.len() {
        let head = data[index];
        if quoted {
            match head {
                b'\\' => index += 1,
                b'"' => quoted = false,
                _ => {}
            }
        } else if head == b'"' {
            quoted = true;
        } else if head == b'/' && index + 1 < data.len() {
            let rest = &data[index + 2..];
            let end = match data[index + 1] {
                b'/' => {
                    index
                        + 2
                        + rest
                            .iter()
                            .position(|&c| matches!(c, b'\r' | b'\n'))
                            .unwrap_or(rest.len())
                }
                b'*' => {
                    index
                        + 4
                        + rest
                            .windows(2)
                            .position(|c| c == b"*/")
                            .ok_or("закройте комментарий в JSON Xray")?
                }
                _ => {
                    index += 1;
                    continue;
                }
            };
            for byte in &mut output[index..end] {
                if !matches!(byte, b'\n' | b'\r') {
                    *byte = b' ';
                }
            }
            index = end;
            continue;
        }
        index += 1;
    }
    String::from_utf8(output).map_err(|_| "выберите текстовый файл в кодировке UTF-8".into())
}

fn parse_xray_profiles(data: &str) -> ParseResult<ProfilePreview> {
    let data = strip_xray_comments(data)?;
    let data = data.trim();
    if data.is_empty() {
        return Err("в файле нет профилей Xray".into());
    }
    let is_object = data.starts_with('{');
    let raw = serde_json::from_str::<Value>(data).map_err(|_| {
        if is_object {
            "проверьте синтаксис JSON Xray"
        } else {
            "проверьте синтаксис массива outbounds Xray"
        }
    })?;
    let entries = if is_object {
        let fields = raw.as_object().expect("JSON object");
        if let Some(proxies) = fields.get("proxies") {
            return parse_external_profiles(proxies);
        }
        if let Some(outbounds) = fields.get("outbounds") {
            outbounds
                .as_array()
                .ok_or("поле outbounds в JSON Xray должно быть массивом")?
                .as_slice()
        } else if fields.contains_key("server")
            || fields.contains_key("type") && !fields.contains_key("protocol")
        {
            return parse_external_profiles(&raw);
        } else {
            std::slice::from_ref(&raw)
        }
    } else {
        raw.as_array()
            .ok_or("проверьте синтаксис массива outbounds Xray")?
            .as_slice()
    };
    let mut profiles = Vec::with_capacity(entries.len());
    let mut note = "";
    for (i, entry) in entries.iter().enumerate() {
        if let Some(profile) = parse_xray_outbound(entry, i + 1)? {
            profiles.push(profile);
        } else {
            note = "В предпросмотр включены VPN-профили. Служебные выходы Xray для прямого доступа, блокировки и DNS пропущены.";
        }
    }
    if profiles.is_empty() {
        return Err("в JSON Xray нет выходов VLESS, Hysteria2 или Trojan".into());
    }
    Ok(ProfilePreview {
        profiles,
        note: note.into(),
    })
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Server {
    address: String,
    port: u16,
    id: String,
    password: String,
    users: Vec<User>,
}

#[derive(Deserialize)]
struct User {
    #[serde(default)]
    id: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Settings {
    #[serde(flatten)]
    basic: Server,
    version: u8,
    vnext: Vec<Server>,
    servers: Vec<Server>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct XrayShape {
    protocol: String,
    #[serde(rename = "type")]
    kind: String,
    tag: String,
    settings: Value,
    proxy_settings: ProxySettings,
    stream_settings: StreamSettings,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ProxySettings {
    tag: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StreamSettings {
    network: String,
    sockopt: SocketOptions,
    hysteria_settings: HysteriaSettings,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SocketOptions {
    dialer_proxy: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct HysteriaSettings {
    version: u8,
}

fn valid_server(server: &Server) -> bool {
    server.port > 0 && server.address == server.address.trim() && net_host(&server.address)
}

fn valid_settings(protocol: &str, settings: &Settings) -> bool {
    match protocol {
        "vless" if settings.vnext.is_empty() => {
            valid_server(&settings.basic) && !settings.basic.id.trim().is_empty()
        }
        "vless" => settings.vnext.iter().all(|server| {
            valid_server(server)
                && !server.users.is_empty()
                && server.users.iter().all(|user| !user.id.trim().is_empty())
        }),
        "trojan" if settings.servers.is_empty() => {
            valid_server(&settings.basic) && !settings.basic.password.is_empty()
        }
        "trojan" => settings
            .servers
            .iter()
            .all(|server| valid_server(server) && !server.password.is_empty()),
        _ => valid_server(&settings.basic),
    }
}

fn parse_xray_outbound(raw: &Value, index: usize) -> ParseResult<Option<ImportedProfile>> {
    let error = || format!("проверьте объект outbound {index} в JSON Xray");
    let mut fields = raw.as_object().ok_or_else(error)?.clone();
    // Go treats JSON null for struct fields as a missing value.
    let mut shape_input = fields.clone();
    shape_input.retain(|_, v| !v.is_null());
    let shape = XrayShape::deserialize(Value::Object(shape_input)).map_err(|_| error())?;
    if shape.protocol.is_empty() && !shape.kind.is_empty() {
        return parse_external_outbound(raw, index);
    }
    let protocol = match shape.protocol.as_str() {
        "freedom" | "blackhole" | "dns" => return Ok(None),
        "vless" | "trojan" => &shape.protocol,
        "hysteria" => "hysteria2",
        _ => {
            return Err(format!(
                "для outbound {index} поддерживаются протоколы Xray VLESS, Hysteria2 и Trojan"
            ));
        }
    };
    if !shape.proxy_settings.tag.is_empty()
        || !shape.stream_settings.sockopt.dialer_proxy.is_empty()
    {
        return Err(format!(
            "outbound {index} ссылается на другой выход. Экспортируйте самостоятельный VPN-профиль"
        ));
    }
    let err_settings =
        || format!("проверьте адрес, порт и данные подключения в settings для outbound {index}");
    let settings = Settings::deserialize(shape.settings).map_err(|_| err_settings())?;
    if !valid_settings(protocol, &settings) {
        return Err(err_settings());
    }
    if protocol == "hysteria2"
        && (settings.version != 2
            || shape.stream_settings.network != "hysteria"
            || shape.stream_settings.hysteria_settings.version != 2)
    {
        return Err(format!(
            "для Hysteria2 в outbound {index} укажите версию 2 и параметры транспорта hysteria"
        ));
    }
    fields.remove("tag");
    Ok(Some(ImportedProfile {
        protocol: protocol.into(),
        label: imported_label(&shape.tag),
        outbound: Some(Value::Object(fields)),
        ..ImportedProfile::default()
    }))
}

#[derive(Default)]
struct YamlShape {
    depth: usize,
    nodes: usize,
    documents: usize,
    valid: bool,
}

impl EventReceiver for YamlShape {
    fn on_event(&mut self, event: Event) {
        match event {
            Event::DocumentStart => self.documents += 1,
            Event::Alias(_) => self.valid = false,
            Event::MappingStart(..) | Event::SequenceStart(..) => {
                self.nodes += 1;
                self.depth += 1;
            }
            Event::MappingEnd | Event::SequenceEnd => self.depth = self.depth.saturating_sub(1),
            Event::Scalar(..) => self.nodes += 1,
            _ => {}
        }
        if self.nodes > 32_000 || self.depth >= 64 {
            self.valid = false;
        }
    }
}

fn parse_yaml_profiles(data: &str) -> ParseResult<ProfilePreview> {
    let mut shape = YamlShape {
        valid: true,
        ..YamlShape::default()
    };
    if Parser::new_from_str(data).load(&mut shape, true).is_err()
        || shape.documents != 1
        || !shape.valid
    {
        return Err("загрузите один документ YAML без ссылок и циклов".into());
    }
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(data).map_err(|_| "проверьте синтаксис профилей YAML")?;
    let json = serde_json::to_string(&yaml).map_err(|_| "проверьте структуру YAML")?;
    parse_xray_profiles(&json)
}

fn parse_external_profiles(value: &Value) -> ParseResult<ProfilePreview> {
    let entries = value
        .as_array()
        .map_or_else(|| std::slice::from_ref(value), |entries| entries.as_slice());
    let mut profiles = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        if let Some(profile) = parse_external_outbound(entry, index + 1)? {
            profiles.push(profile);
        }
    }
    if profiles.is_empty() {
        return Err("в файле нет поддерживаемых VPN-профилей".into());
    }
    Ok(ProfilePreview::new(profiles))
}

fn external_text<'a>(fields: Option<&'a Object>, names: &[&str]) -> &'a str {
    fields
        .and_then(|fields| {
            names.iter().find_map(|name| {
                fields
                    .get(*name)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
        })
        .unwrap_or("")
}

fn external_section<'a>(fields: Option<&'a Object>, name: &str) -> Option<&'a Object> {
    fields?.get(name)?.as_object()
}

fn external_flag(fields: Option<&Object>, name: &str) -> bool {
    fields
        .and_then(|fields| fields.get(name))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn external_port(fields: &Object) -> String {
    for key in ["server_port", "port"] {
        match fields.get(key) {
            Some(Value::String(port)) => return port.clone(),
            Some(Value::Number(port)) => return port.to_string(),
            _ => {}
        }
    }
    String::new()
}

fn url_escape(raw: &str, user: bool) -> String {
    let mut output = String::new();
    const HEX: &[u8] = b"0123456789ABCDEF";
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric()
            || b"-._~".contains(&byte)
            || user && b"!$&'()*+,;=".contains(&byte)
        {
            output.push(byte.into());
        } else if !user && byte == b' ' {
            output.push('+');
        } else {
            output.push('%');
            output.push(HEX[(byte >> 4) as usize].into());
            output.push(HEX[(byte & 0xf) as usize].into());
        }
    }
    output
}

fn build_link(
    protocol: &str,
    secret: &str,
    endpoint: &str,
    query: &BTreeMap<&str, String>,
) -> String {
    let mut link = String::new();
    link.push_str(protocol);
    link.push_str("://");
    link.push_str(&url_escape(secret, true));
    link.push('@');
    link.push_str(endpoint);
    for (index, (key, value)) in query.iter().enumerate() {
        link.push(if index == 0 { '?' } else { '&' });
        link.push_str(&url_escape(key, false));
        link.push('=');
        link.push_str(&url_escape(value, false));
    }
    link
}

fn parse_external_outbound(value: &Value, index: usize) -> ParseResult<Option<ImportedProfile>> {
    let Some(fields) = value.as_object() else {
        return Err(format!("проверьте конфиг профиля №{index}"));
    };
    let root = Some(fields);
    let mut protocol = external_text(root, &["type", "protocol"]).to_lowercase();
    if protocol.is_empty()
        && fields.get("server").is_some_and(|v| !v.is_null())
        && fields.get("auth").is_some_and(|v| !v.is_null())
    {
        protocol = "hysteria2".into();
    }
    let protocol = match protocol.as_str() {
        "direct" | "block" | "dns" | "selector" | "urltest" => return Ok(None),
        "hy2" => "hysteria2",
        "vless" | "trojan" | "hysteria2" => &protocol,
        _ => {
            return Err(format!(
                "в профиле №{index} нужен VLESS, Hysteria2 или Trojan"
            ));
        }
    };
    if !external_text(root, &["detour", "dialer-proxy", "bind_interface"]).is_empty()
        || ["wireguard", "server_ports", "realm"]
            .iter()
            .any(|key| fields.get(*key).is_some_and(|v| !v.is_null()))
    {
        return Err(format!(
            "профиль №{index} требует самостоятельного выхода или экспорта в Xray"
        ));
    }
    let mut host = external_text(root, &["server", "address"]);
    let given_port = external_port(fields);
    let mut port = given_port.as_str();
    if let Some((address, embedded)) = split_host_port(host) {
        host = address;
        port = fallback(port, embedded);
    }
    host = host.trim_matches(['[', ']']);
    let port = fallback(port, "443");
    if host.is_empty()
        || !port.bytes().all(|b| b.is_ascii_digit())
        || !port.parse::<u16>().is_ok_and(|port| port > 0)
    {
        return Err(format!("проверьте адрес и порт профиля №{index}"));
    }
    let secret = if protocol == "vless" {
        external_text(root, &["uuid", "id"])
    } else {
        external_text(root, &["password", "auth"])
    };
    let tls = external_section(root, "tls");
    let tls_sni = fallback(
        external_text(tls, &["server_name", "sni"]),
        external_text(root, &["servername", "sni"]),
    );
    let fingerprint = fallback(
        external_text(external_section(tls, "utls"), &["fingerprint"]),
        external_text(root, &["client-fingerprint"]),
    );
    let reality =
        external_section(tls, "reality").or_else(|| external_section(root, "reality-opts"));
    let alpn = tls
        .and_then(|tls| tls.get("alpn"))
        .and_then(Value::as_array)
        .or_else(|| fields.get("alpn").and_then(Value::as_array));
    let alpn = alpn
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let mut query = BTreeMap::new();
    let mut put = |key, value: &str| {
        if !value.is_empty() {
            query.insert(key, value.to_string());
        }
    };
    if protocol != "vless" || external_flag(root, "tls") || external_flag(tls, "enabled") {
        put("security", "tls");
    }
    put("sni", tls_sni);
    put("fp", fingerprint);
    put("flow", external_text(root, &["flow"]));
    put("encryption", external_text(root, &["encryption"]));
    put("pinSHA256", external_text(tls, &["pinSHA256"]));
    if external_flag(tls, "insecure") || external_flag(root, "skip-cert-verify") {
        put("insecure", "true");
    }
    let key = external_text(reality, &["public_key", "public-key"]);
    if !key.is_empty() {
        put("security", "reality");
        put("pbk", key);
        put("sid", external_text(reality, &["short_id", "short-id"]));
    }
    put("alpn", &alpn);
    if protocol == "hysteria2" {
        let obfs = external_section(root, "obfs");
        let kind = fallback(
            external_text(obfs, &["type"]),
            external_text(root, &["obfs"]),
        );
        let nested_pass = external_text(external_section(obfs, kind), &["password"]);
        put("obfs", kind);
        put(
            "obfs-password",
            fallback(
                external_text(obfs, &["password"]),
                fallback(nested_pass, external_text(root, &["obfs-password"])),
            ),
        );
    } else {
        let transport = external_section(root, "transport");
        let method = fallback(
            external_text(transport, &["type"]),
            external_text(root, &["network"]),
        );
        let transport = transport.or_else(|| external_section(root, &format!("{method}-opts")));
        put("type", method);
        put("path", external_text(transport, &["path"]));
        put(
            "host",
            fallback(
                external_text(transport, &["host"]),
                external_text(external_section(transport, "headers"), &["Host", "host"]),
            ),
        );
        put(
            "serviceName",
            external_text(transport, &["service_name", "grpc-service-name"]),
        );
    }
    let uri = build_link(protocol, secret, &host_port(host, port), &query);
    let label = imported_label(external_text(root, &["tag", "name", "remarks"]));
    let entry = ImportedProfile {
        protocol: protocol.into(),
        uri,
        label,
        ..ImportedProfile::default()
    };
    profile_uri_outbound(&entry)
        .map_err(|err| format!("проверьте данные и транспорт профиля №{index}: {err}"))?;
    Ok(Some(entry))
}
