use std::collections::{BTreeMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use percent_encoding::percent_decode_str;
use sha2::{Digest, Sha256};
use url::Url;

use crate::model::{
    IncompatibleSubscriptionRow, Profile, Subscription, SubscriptionParse, SubscriptionParseError,
    socket_address,
};
use crate::xray::{parse_xray_subscription, profile_uri_outbound};

const MAX_SUBSCRIPTIONS: usize = 8;
const MAX_SUBSCRIPTION_URL: usize = 1536;
pub const MAX_SUBSCRIPTION_BODY: usize = 384 << 10;
pub(crate) const MAX_SUBSCRIPTION_ROWS: usize = 512;
pub(crate) const MAX_SUBSCRIPTION_PROFILES: usize = 128;
pub(crate) const MAX_CATALOG_PROFILES: usize = 256;
const OVERSIZE_REPLY: &str = "ответ подписки больше 384 КиБ";
pub const BLOCKED_DEVICE: &str = "провайдер заблокировал ключ для этого устройства. Добавьте подписку для роутера в личном кабинете провайдера";
pub(crate) const BLOCKED_DEVICE_LABEL: &str = "Ключ на устройстве заблокирован";
const HTTPS_REQUIRED: &str =
    "нужна HTTPS-ссылка подписки без пользовательского имени, фрагмента и нестандартного порта";

pub(crate) fn normalize_host(host: &str) -> String {
    let host = host.trim().to_lowercase();
    host.strip_suffix('.').unwrap_or(&host).to_owned()
}

pub(crate) fn valid_domain(host: &str) -> bool {
    !host.is_empty()
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

pub(crate) fn valid_metadata(input: &str) -> bool {
    input.chars().count() <= 100 && !input.chars().any(char::is_control)
}

pub(crate) fn label(input: &str) -> &str {
    let input = input.trim();
    if valid_metadata(input) && !input.contains("://") {
        input
    } else {
        ""
    }
}

pub(crate) fn nonempty<'a>(value: &'a str, default: &'a str) -> &'a str {
    if value.is_empty() { default } else { value }
}

pub fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_private()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !matches!(
            ip.octets(),
            [0 | 224..=255, ..]
                | [100, 64..=127, ..]
                | [192, 0, 0 | 2, _]
                | [198, 18 | 19, ..]
                | [198, 51, 100, _]
                | [203, 0, 113, _]
        )
}

pub(crate) fn public_node_ipv4(host: &str) -> Option<Ipv4Addr> {
    match host.parse::<IpAddr>().ok()? {
        IpAddr::V4(ip) => is_public_ipv4(ip).then_some(ip),
        IpAddr::V6(ip) => ip.to_ipv4_mapped().filter(|ip| is_public_ipv4(*ip)),
    }
}

fn named_subscription_host(host: &str) -> bool {
    valid_domain(host)
        && host.contains('.')
        && ![".local", ".localhost", ".home.arpa", ".internal"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

pub(crate) fn valid_subscription_node_host(value: &str) -> bool {
    if value.parse::<IpAddr>().is_ok() {
        return public_node_ipv4(value).is_some();
    }
    named_subscription_host(&normalize_host(value))
}

pub(crate) struct UriParts<'a> {
    pub scheme: &'a str,
    pub host: String,
    pub port: Option<u16>,
    pub path: &'a str,
    pub query: &'a str,
    pub secret: String,
    pub password: Option<String>,
}

pub(crate) fn validate_hostname_parts(input: &str) -> Result<UriParts<'_>, ()> {
    if input.bytes().any(|b| b.is_ascii_control()) {
        return Err(());
    }
    let (scheme, rest) = input.split_once("://").ok_or(())?;
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, rest) = rest.split_at(host_end);
    let (user, authority) = authority.rsplit_once('@').unwrap_or(("", authority));
    let (secret, password) = user
        .split_once(':')
        .map_or((user, None), |(user, pass)| (user, Some(pass)));
    let (host, port) = if let Some(ip) = authority.strip_prefix('[') {
        let (host, tail) = ip.split_once(']').ok_or(())?;
        let port = if tail.is_empty() {
            None
        } else {
            Some(tail.strip_prefix(':').ok_or(())?)
        };
        (host, port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if host.contains(':') {
            return Err(());
        }
        (host, Some(port))
    } else {
        (authority, None)
    };
    if host.is_empty() || host.contains([' ', '%', '\\', '[', ']', '@']) {
        return Err(());
    }
    let port = port
        .filter(|value| !value.is_empty())
        .map(|p| {
            if !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(());
            }
            p.parse::<u16>().map_err(|_| ())
        })
        .transpose()?;
    let (path, _) = rest.split_once('#').unwrap_or((rest, ""));
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let _ = decode_percent(path)?;
    Ok(UriParts {
        scheme,
        host: host.to_owned(),
        port,
        path,
        query,
        secret: decode_percent(secret)?,
        password: password.map(decode_percent).transpose()?,
    })
}

pub fn subscription_endpoint(value: &str) -> Result<Url, String> {
    let invalid = || HTTPS_REQUIRED.to_owned();
    if value.len() > MAX_SUBSCRIPTION_URL {
        return Err(invalid());
    }
    let raw = value.trim();
    let parts = validate_hostname_parts(raw).map_err(|_| invalid())?;
    if !parts.scheme.eq_ignore_ascii_case("https")
        || !parts.secret.is_empty()
        || parts.password.is_some()
        || raw.contains('\\')
        || raw.contains('#')
        || parts.port.is_some_and(|port| port != 443)
        || raw.split_once("://").is_some_and(|(_, rest)| {
            rest.split(['/', '?', '#'])
                .next()
                .is_some_and(|auth| auth.contains('@'))
        })
    {
        return Err(invalid());
    }
    let host = normalize_host(&parts.host);
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) if is_public_ipv4(addr) => {}
        Ok(_) => return Err("сервер подписки должен иметь публичный IPv4-адрес".into()),
        Err(_) if named_subscription_host(&host) => {}
        _ => return Err(invalid()),
    }
    let mut result = Url::parse(raw).map_err(|_| invalid())?;
    // WHATWG URLs normalize legacy numeric IP spellings. Require the original
    // host spelling to match its canonical host so validation covers the dial.
    if normalize_host(result.host_str().ok_or_else(invalid)?) != host {
        return Err(invalid());
    }
    result.set_host(Some(&host)).map_err(|_| invalid())?;
    Ok(result)
}

pub(crate) fn valid_user_agent(value: &str) -> bool {
    value.len() <= 128 && value.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

pub(crate) fn valid_device_id(value: &str) -> bool {
    (10..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'=' | b'-'))
}

pub(crate) fn safe_header(value: &str) -> &str {
    if value.len() > 256 || value.contains(['\r', '\n', '\0']) {
        ""
    } else {
        value
    }
}

pub fn validate_subscriptions(sources: &[Subscription]) -> Result<Vec<Subscription>, String> {
    if sources.len() > MAX_SUBSCRIPTIONS {
        return Err("поддерживается до восьми подписок".into());
    }
    let mut validated = Vec::with_capacity(sources.len());
    let mut used_ids = HashSet::new();
    let mut used_urls = HashSet::new();
    for source in sources {
        if !valid_domain(&source.id)
            || source.id.contains('.')
            || !used_ids.insert(source.id.as_str())
            || source.kind != "vless-list"
            || !(1..=168).contains(&source.interval_hours)
        {
            return Err(
                "проверьте идентификатор, тип и интервал обновления подписки от 1 до 168 часов"
                    .into(),
            );
        }
        let name = label(&source.name);
        if name.is_empty() {
            return Err("укажите название подписки".into());
        }
        let endpoint = subscription_endpoint(&source.url)?;
        if !source.device_id.is_empty() && !valid_device_id(&source.device_id) {
            return Err("ID устройства должен содержать от 10 до 64 латинских букв, цифр, дефисов или знаков =".into());
        }
        let user_agent = source.user_agent.trim();
        if !valid_user_agent(user_agent) {
            return Err("User-Agent должен содержать не более 128 печатных символов ASCII".into());
        }
        // Go net/url omits the implicit slash when no path was supplied.
        let mut url = endpoint.to_string();
        let has_path = source
            .url
            .trim()
            .split_once("://")
            .is_some_and(|(_, rest)| {
                rest.find(['/', '?', '#'])
                    .and_then(|i| rest.as_bytes().get(i))
                    == Some(&b'/')
            });
        if !has_path && endpoint.path() == "/" {
            let position = url
                .find("://")
                .and_then(|i| url[i + 3..].find('/').map(|next| i + 3 + next));
            if let Some(position) = position {
                url.remove(position);
            }
        }
        if !used_urls.insert(url.clone()) {
            return Err("эта ссылка подписки уже добавлена".into());
        }
        validated.push(Subscription {
            name: name.into(),
            url,
            has_device_id: false,
            user_agent: user_agent.into(),
            etag: safe_header(&source.etag).into(),
            last_modified: safe_header(&source.last_modified).into(),
            ..source.clone()
        });
    }
    Ok(validated)
}

pub fn public_subscriptions(sources: &[Subscription]) -> Vec<Subscription> {
    sources
        .iter()
        .map(|source| Subscription {
            id: source.id.clone(),
            name: source.name.clone(),
            kind: source.kind.clone(),
            url: subscription_endpoint(&source.url)
                .ok()
                .and_then(|url| url.host_str().map(|host| format!("https://{host}/••••")))
                .unwrap_or_else(|| "••••".into()),
            user_agent: source.user_agent.clone(),
            has_device_id: !source.device_id.is_empty(),
            enabled: source.enabled,
            interval_hours: source.interval_hours,
            ..Subscription::default()
        })
        .collect()
}

pub fn digest(input: impl AsRef<[u8]>) -> String {
    let bytes = Sha256::digest(input.as_ref());
    hex::encode(&bytes[..16])
}

pub(crate) fn trim(input: &[u8]) -> &[u8] {
    let input = input.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(input);
    if let Ok(value) = std::str::from_utf8(input) {
        return value.trim().as_bytes();
    }
    input.trim_ascii()
}

pub(crate) fn reject(
    message: impl Into<String>,
    incompatible: Vec<IncompatibleSubscriptionRow>,
) -> SubscriptionParseError {
    SubscriptionParseError {
        error: message.into(),
        incompatible,
    }
}

pub(crate) fn blocked_label(value: &str) -> bool {
    value.to_lowercase() == BLOCKED_DEVICE_LABEL.to_lowercase()
}

pub fn parse_subscription(data: &[u8]) -> Result<SubscriptionParse, SubscriptionParseError> {
    if data.len() > MAX_SUBSCRIPTION_BODY {
        return Err(reject(OVERSIZE_REPLY, Vec::new()));
    }
    let mut data = trim(data);
    let mut buffer = Vec::new();
    let is_json = |data: &[u8]| matches!(data.first(), Some(b'{' | b'['));
    if !is_json(data) && !data.windows(3).any(|window| window == b"://") {
        let compact: Vec<_> = data
            .iter()
            .copied()
            .filter(|b| !matches!(b, b'\r' | b'\n' | b'\t' | b' '))
            .collect();
        for format in [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD] {
            if format.decode_vec(&compact, &mut buffer).is_ok() {
                data = trim(&buffer);
                break;
            }
            buffer.clear();
        }
    }
    if is_json(data) {
        return parse_xray_subscription(data);
    }
    let text_error = || {
        reject(
            "подписка должна содержать текстовый список VLESS или Base64",
            Vec::new(),
        )
    };
    let text = std::str::from_utf8(data).map_err(|_| text_error())?;
    if text.contains('\0') {
        return Err(text_error());
    }
    if text.bytes().filter(|&b| b == b'\n').count() >= MAX_SUBSCRIPTION_ROWS {
        return Err(reject("подписка содержит слишком много строк", Vec::new()));
    }
    let mut result = SubscriptionParse::default();
    let mut unique = HashSet::new();
    let mut blocked = false;
    for (index, line) in text.split('\n').enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(entry) = subscription_row(line) else {
            if result.incompatible.len() < 24 {
                result.incompatible.push(IncompatibleSubscriptionRow {
                    upstream_key: digest(line),
                    name: format!("Строка {}", index + 1),
                    reason: "нужен совместимый профиль VLESS".into(),
                });
            }
            continue;
        };
        blocked |= blocked_label(&entry.label);
        if unique.insert(entry.upstream_key.clone()) {
            result.profiles.push(entry);
        }
        if result.profiles.len() > MAX_SUBSCRIPTION_PROFILES {
            return Err(reject(
                "подписка содержит более 128 совместимых профилей",
                result.incompatible,
            ));
        }
    }
    if blocked && result.profiles.len() == 1 {
        return Err(reject(BLOCKED_DEVICE, result.incompatible));
    }
    if result.profiles.is_empty() {
        return Err(reject(
            "в подписке нет совместимых профилей VLESS",
            result.incompatible,
        ));
    }
    Ok(result)
}

fn subscription_row(line: &str) -> Option<Profile> {
    if line.len() > 6000 {
        return None;
    }
    let (raw, fragment) = line.split_once('#').unwrap_or((line, ""));
    let parts = validate_hostname_parts(raw).ok()?;
    if !parts.scheme.eq_ignore_ascii_case("vless") || !valid_subscription_node_host(&parts.host) {
        return None;
    }
    let mut profile = Profile {
        protocol: "vless".into(),
        uri: raw.trim().into(),
        catalog_profile: true,
        ..Profile::default()
    };
    profile_uri_outbound(&profile).ok()?;
    let fragment = decode_percent(fragment).unwrap_or_default();
    let label = label(&fragment);
    let label = if label.contains(&parts.secret) {
        ""
    } else {
        label
    };
    profile.label = nonempty(label, "VLESS").to_owned();
    profile.upstream_name = profile.label.clone();
    let query = parse_query(parts.query).ok()?;
    let ordered: Vec<String> = query
        .iter()
        .flat_map(|(key, values)| {
            values.iter().map(move |value| {
                format!(
                    "{}={}",
                    encode_go(key, UrlPart::Query),
                    encode_go(value, UrlPart::Query)
                )
            })
        })
        .collect();
    profile.upstream_key = digest(format!(
        "{}@{}?{}",
        encode_go(&parts.secret, UrlPart::User),
        node_location(&parts),
        ordered.join("&")
    ));
    Some(profile)
}

pub(crate) fn node_location(parts: &UriParts<'_>) -> String {
    let path = if parts
        .path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-_.~/!$&'()*+,;=:@[]%".contains(&b))
    {
        parts.path.to_owned()
    } else {
        encode_go(
            &decode_percent(parts.path).unwrap_or_default(),
            UrlPart::Path,
        )
    };
    format!(
        "{}{}",
        socket_address(&normalize_host(&parts.host), parts.port.unwrap_or(443)),
        path
    )
}

pub(crate) fn decode_percent(input: &str) -> Result<String, ()> {
    let mut bytes = input.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%'
            && (!bytes.next().is_some_and(|c| c.is_ascii_hexdigit())
                || !bytes.next().is_some_and(|c| c.is_ascii_hexdigit()))
        {
            return Err(());
        }
    }
    percent_decode_str(input)
        .decode_utf8()
        .map(|text| text.into_owned())
        .map_err(|_| ())
}

pub(crate) type Query = BTreeMap<String, Vec<String>>;

pub(crate) fn parse_query(input: &str) -> Result<Query, ()> {
    let mut values = Query::new();
    for pair in input.split('&').filter(|p| !p.is_empty()) {
        if pair.contains(';') {
            return Err(());
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        values
            .entry(decode_percent(&key.replace('+', " "))?)
            .or_default()
            .push(decode_percent(&value.replace('+', " "))?);
    }
    Ok(values)
}

pub(crate) fn query_value<'a>(query: &'a Query, key: &str) -> &'a str {
    query
        .get(key)
        .and_then(|values| values.first())
        .map_or("", String::as_str)
}

enum UrlPart {
    Query,
    User,
    Path,
}

fn encode_go(input: &str, part: UrlPart) -> String {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric()
            || b"-_.~".contains(&b)
            || matches!(part, UrlPart::User) && b"$&+,;=".contains(&b)
            || matches!(part, UrlPart::Path) && b"$&+,;=:@/".contains(&b)
        {
            encoded.push(b.into());
        } else if b == b' ' && matches!(part, UrlPart::Query) {
            encoded.push('+');
        } else {
            encoded.push('%');
            encoded.push(HEX[(b >> 4) as usize].into());
            encoded.push(HEX[(b & 15) as usize].into());
        }
    }
    encoded
}
