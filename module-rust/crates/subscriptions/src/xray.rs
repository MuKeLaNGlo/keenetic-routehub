use std::collections::{BTreeMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};

use crate::model::{
    IncompatibleSubscriptionRow, Profile, SubscriptionParse, SubscriptionParseError, XrayGroupCost,
    XrayGroupMember, XrayGroupStrategySettings, XrayProfileGroup, socket_address,
};
use crate::source::{
    BLOCKED_DEVICE, MAX_SUBSCRIPTION_PROFILES, MAX_SUBSCRIPTION_ROWS, blocked_label, digest,
    is_public_ipv4, label, nonempty, normalize_host, parse_query, query_value, reject,
    valid_domain, valid_subscription_node_host, validate_hostname_parts,
};

pub fn profile_uri_outbound(entry: &Profile) -> Result<Value, String> {
    let invalid = || "некорректная ссылка профиля".to_owned();
    let uri = validate_hostname_parts(&entry.uri).map_err(|_| invalid())?;
    if uri.secret.is_empty() {
        return Err(invalid());
    }
    let host = normalize_host(&uri.host);
    if host.parse::<IpAddr>().is_err() && !valid_domain(&host) {
        return Err("некорректный адрес сервера".into());
    }
    let scheme = uri.scheme.to_ascii_lowercase();
    let scheme = if scheme == "hy2" {
        "hysteria2"
    } else {
        scheme.as_str()
    };
    if scheme != entry.protocol {
        return Err("протокол ссылки не совпадает с типом профиля".into());
    }
    let port = uri.port.unwrap_or(443);
    if port == 0 {
        return Err("некорректный порт сервера".into());
    }
    let query = parse_query(uri.query).map_err(|_| "некорректные параметры ссылки")?;
    let get = |key| query_value(&query, key);
    let mut secret = uri.secret;
    if let Some(password) = uri.password {
        if scheme == "vless" {
            return Err("VLESS ожидает идентификатор в ссылке".into());
        }
        secret.push(':');
        secret.push_str(&password);
    }
    let mut settings = json!({"address":host,"port":port});
    match scheme {
        "vless" => {
            settings["id"] = json!(secret);
            settings["encryption"] = json!(nonempty(get("encryption"), "none"));
            if !get("flow").is_empty() {
                settings["flow"] = json!(get("flow"));
            }
        }
        "trojan" => settings["password"] = json!(secret),
        "hysteria2" => settings["version"] = json!(2),
        _ => return Err(invalid()),
    }
    if ["insecure", "allowInsecure"]
        .iter()
        .any(|name| matches!(get(name), "1" | "true"))
    {
        return Err(
            "ссылка отключает проверку TLS, нужен проверяемый сертификат или SHA-256 pin".into(),
        );
    }
    let security = nonempty(
        get("security"),
        if scheme == "vless" { "none" } else { "tls" },
    );
    if (scheme == "hysteria2" && security != "tls") || (scheme == "trojan" && security == "none") {
        return Err("этот протокол требует защищённый транспорт".into());
    }
    let method = if scheme == "hysteria2" {
        "hysteria"
    } else {
        nonempty(get("type"), "raw")
    };
    let mut stream = json!({"security":security});
    let network = match method {
        "raw" | "tcp" => {
            if !matches!(get("headerType"), "" | "none") {
                return Err("для RAW c нестандартным заголовком используйте JSON outbound".into());
            }
            "raw"
        }
        "ws" | "websocket" => {
            stream["wsSettings"] = json!({"path":nonempty(get("path"), "/"), "host":get("host")});
            "websocket"
        }
        "grpc" => {
            let mut grpc =
                json!({"serviceName": get("serviceName"), "multiMode":get("mode") == "multi"});
            if !get("authority").is_empty() {
                grpc["authority"] = json!(get("authority"));
            }
            stream["grpcSettings"] = grpc;
            "grpc"
        }
        "xhttp" | "splithttp" => {
            stream["xhttpSettings"] = json!({"path": nonempty(get("path"), "/"), "host":get("host"), "mode":nonempty(get("mode"),"auto")});
            "xhttp"
        }
        "httpupgrade" => {
            stream["httpupgradeSettings"] =
                json!({"path":nonempty(get("path"), "/"),"host":get("host")});
            "httpupgrade"
        }
        "hysteria" if scheme == "hysteria2" => {
            stream["hysteriaSettings"] = json!({"version":2,"auth":secret});
            if !get("obfs").is_empty() {
                if get("obfs") != "salamander" || get("obfs-password").is_empty() {
                    return Err("поддерживается obfs=salamander с obfs-password".into());
                }
                stream["finalmask"] = json!({"udp":[{"type":"salamander","settings":{"password":get("obfs-password")}}]});
            }
            "hysteria"
        }
        "hysteria" => return Err("транспорт hysteria требует профиль Hysteria2".into()),
        _ => return Err("транспорт ссылки не поддерживается, используйте JSON outbound".into()),
    };
    stream["network"] = json!(network);
    match security {
        "none" => {}
        "tls" => {
            let mut tls = json!({"serverName":nonempty(get("sni"), &host)});
            if !get("alpn").is_empty() {
                tls["alpn"] = json!(get("alpn").split(',').collect::<Vec<_>>());
            }
            for (value, field) in [
                (get("fp"), "fingerprint"),
                (
                    nonempty(get("pinSHA256"), get("pcs")),
                    "pinnedPeerCertSha256",
                ),
                (get("vcn"), "verifyPeerCertByName"),
            ] {
                if !value.is_empty() {
                    tls[field] = json!(value);
                }
            }
            stream["tlsSettings"] = tls;
        }
        "reality" => {
            if get("pbk").is_empty()
                || get("sni").is_empty()
                || !matches!(network, "raw" | "grpc" | "xhttp")
            {
                return Err("REALITY требует pbk, sni и транспорт RAW, XHTTP или gRPC".into());
            }
            stream["realitySettings"] = json!({
                "password":get("pbk"),"serverName":get("sni"),"fingerprint":nonempty(get("fp"),"chrome"),
                "shortId":get("sid"),"spiderX":get("spx")
            });
        }
        _ => return Err("поддерживаемые варианты security: tls, reality, none".into()),
    };
    let protocol = if scheme == "hysteria2" {
        "hysteria"
    } else {
        scheme
    };
    Ok(json!({"tag":entry.id,"protocol":protocol,"settings":settings,"streamSettings":stream}))
}

pub fn clean_xray_comments(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut clean = data.to_vec();
    let mut i = 0;
    let mut quoted = false;
    while i < data.len() {
        if quoted {
            match data[i] {
                b'\\' => i += 1,
                b'"' => quoted = false,
                _ => {}
            }
            i += 1;
            continue;
        }
        if data[i] == b'"' {
            quoted = true;
            i += 1;
            continue;
        }
        let end = match data.get(i..i + 2) {
            Some(b"//") => data[i + 2..]
                .iter()
                .position(|b| matches!(b, b'\r' | b'\n'))
                .map_or(data.len(), |offset| i + 2 + offset),
            Some(b"/*") => data[i + 2..]
                .windows(2)
                .position(|pair| pair == b"*/")
                .map(|offset| i + 4 + offset)
                .ok_or("закройте комментарий в JSON Xray")?,
            _ => {
                i += 1;
                continue;
            }
        };
        for byte in &mut clean[i..end] {
            if !matches!(byte, b'\r' | b'\n') {
                *byte = b' ';
            }
        }
        i = end;
    }
    Ok(clean)
}

pub(crate) fn parse_xray_subscription(
    data: &[u8],
) -> Result<SubscriptionParse, SubscriptionParseError> {
    let clean = clean_xray_comments(data).map_err(|error| reject(error, Vec::new()))?;
    let clean = clean.trim_ascii();
    if clean.is_empty() {
        return Err(reject("пустая подписка Xray", Vec::new()));
    }
    let result_error = "в JSON-подписке нет совместимых профилей VLESS, Hysteria2 или групп Xray";
    let mut result = SubscriptionParse::default();
    let single;
    let rows: Vec<&RawValue> = if clean[0] == b'[' {
        serde_json::from_slice(clean)
            .map_err(|_| reject("некорректный массив профилей Xray", Vec::new()))?
    } else if let Ok(raw) = serde_json::from_slice::<&RawValue>(clean) {
        single = raw;
        vec![single]
    } else {
        return Err(reject(
            result_error,
            vec![IncompatibleSubscriptionRow {
                upstream_key: digest(clean),
                name: "Профиль Xray 1".to_owned(),
                reason: "Некорректный или слишком большой профиль Xray.".to_owned(),
            }],
        ));
    };
    if rows.len() > MAX_SUBSCRIPTION_ROWS {
        return Err(reject("в подписке слишком много объектов Xray", Vec::new()));
    }
    let mut seen = HashSet::new();
    let mut blocked = false;
    for (index, row) in rows.into_iter().enumerate() {
        match xray_row(row.get()) {
            Ok(profile) => {
                blocked |= blocked_label(&profile.label);
                if seen.insert(profile.upstream_key.clone()) {
                    result.profiles.push(profile);
                }
            }
            Err(reason) if result.incompatible.len() < 24 => {
                result.incompatible.push(IncompatibleSubscriptionRow {
                    upstream_key: digest(row.get()),
                    name: format!("Профиль Xray {}", index + 1),
                    reason,
                })
            }
            Err(_) => {}
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
        return Err(reject(result_error, result.incompatible));
    }
    Ok(result)
}

fn xray_row(raw: &str) -> Result<Profile, String> {
    let invalid = "Некорректный или слишком большой профиль Xray.";
    if raw.len() > 24 << 10 {
        return Err(invalid.into());
    }
    let envelope: BTreeMap<String, &RawValue> = serde_json::from_str(raw).map_err(|_| invalid)?;
    let Some(outbounds) = envelope.get("outbounds") else {
        return xray_node(raw, "");
    };
    if !json_raw_empty(envelope.get("reverse").copied()) {
        return Err("Конфигурация Xray использует обратное проксирование.".into());
    }
    let invalid_exits = "Проверьте количество выходов Xray.";
    let exits: Vec<&RawValue> = serde_json::from_str(outbounds.get()).map_err(|_| invalid_exits)?;
    if exits.is_empty() || exits.len() > 16 {
        return Err(invalid_exits.into());
    }
    let remarks = envelope
        .get("remarks")
        .and_then(|value| serde_json::from_str::<String>(value.get()).ok())
        .unwrap_or_default();
    let routing = envelope.get("routing").copied();
    if !json_raw_empty(routing) {
        let routing: Routing = serde_json::from_str(routing.expect("checked routing value").get())
            .map_err(|_| "Некорректный раздел маршрутизации Xray.")?;
        if let Some(balancer) = routing.balancers.first() {
            if routing.balancers.len() != 1 {
                return Err("Поддерживается один балансировщик на профиль Xray.".into());
            }
            return xray_group(&exits, balancer, &remarks);
        }
    }
    let mut profile = None;
    for raw in exits {
        let shape: Shape =
            serde_json::from_str(raw.get()).map_err(|_| "Некорректный выход Xray.")?;
        if matches!(shape.protocol.as_str(), "freedom" | "blackhole" | "dns") {
            continue;
        }
        if profile.is_some() {
            return Err("Несколько выходов Xray требуют одного явного балансировщика.".into());
        }
        profile = Some(xray_node(raw.get(), &remarks)?);
    }
    profile.ok_or_else(|| "В конфигурации Xray нет совместимого выхода VLESS или Hysteria2.".into())
}

fn json_raw_empty(raw: Option<&RawValue>) -> bool {
    matches!(
        raw.map(|value| value.get().trim()),
        None | Some("" | "null" | "{}" | "[]")
    )
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Shape {
    protocol: String,
    tag: String,
}

fn xray_node(raw: &str, remarks: &str) -> Result<Profile, String> {
    let shape: Shape = serde_json::from_str(raw).map_err(|_| "Некорректный выход Xray.")?;
    if shape.protocol == "hysteria" {
        return hysteria_node(raw, remarks);
    }
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|_| "Поддерживается VLESS с обычным транспортом и проверяемым TLS.")?;
    if !safe_vless_outbound(&value) {
        return Err("Поддерживается VLESS с обычным транспортом и проверяемым TLS.".into());
    }
    if !valid_vless_settings(&value) {
        return Err("Параметры VLESS не прошли проверку.".into());
    }
    let Some((server, id)) = json_server(&value) else {
        return Err("Для VLESS нужен публичный адрес сервера.".into());
    };
    if !valid_subscription_node_host(&server.address) {
        return Err("Для VLESS нужен публичный адрес сервера.".into());
    }
    let name = label(nonempty(remarks, &shape.tag));
    let name = if name.contains(id) { "" } else { name };
    let name = nonempty(name, "VLESS");
    value
        .as_object_mut()
        .expect("validated outbound")
        .remove("tag");
    let identity = go_json(&value);
    Ok(Profile {
        protocol: "vless".into(),
        label: name.into(),
        upstream_name: name.into(),
        outbound: Some(value),
        upstream_key: digest(identity),
        catalog_profile: true,
        ..Profile::default()
    })
}

fn is_empty(value: &Value) -> bool {
    value.is_null()
        || value.as_object().is_some_and(|v| v.is_empty())
        || value.as_array().is_some_and(|v| v.is_empty())
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn safe_vless_outbound(outbound: &Value) -> bool {
    safe_standard_outbound(outbound, "vless")
}

fn safe_standard_outbound(outbound: &Value, protocol: &str) -> bool {
    let Some(keys) = outbound.as_object() else {
        return false;
    };
    if text(&outbound["protocol"]) != protocol
        || keys.keys().any(|key| {
            !matches!(
                key.as_str(),
                "protocol" | "tag" | "settings" | "streamSettings" | "mux"
            )
        })
    {
        return false;
    }
    let stream = &outbound["streamSettings"];
    if is_empty(stream) {
        return true;
    }
    let Some(keys) = stream.as_object() else {
        return false;
    };
    if keys.keys().any(|key| {
        !matches!(
            key.as_str(),
            "network"
                | "security"
                | "rawSettings"
                | "tcpSettings"
                | "wsSettings"
                | "grpcSettings"
                | "xhttpSettings"
                | "splithttpSettings"
                | "httpupgradeSettings"
                | "tlsSettings"
                | "realitySettings"
        )
    }) || !matches!(
        text(&stream["network"]),
        "" | "raw" | "tcp" | "ws" | "websocket" | "grpc" | "xhttp" | "splithttp" | "httpupgrade"
    ) || !matches!(text(&stream["security"]), "" | "none" | "tls" | "reality")
    {
        return false;
    }
    for key in ["xhttpSettings", "splithttpSettings"] {
        let settings = &stream[key];
        if !is_empty(settings)
            && (!settings.is_object()
                || !is_empty(&settings["downloadSettings"])
                || !is_empty(&settings["extra"]))
        {
            return false;
        }
    }
    let tls = &stream["tlsSettings"];
    is_empty(tls)
        || tls.as_object().is_some_and(|keys| {
            keys.iter().all(|(key, value)| match key.as_str() {
                "serverName"
                | "verifyPeerCertByName"
                | "alpn"
                | "fingerprint"
                | "pinnedPeerCertSha256"
                | "minVersion"
                | "maxVersion"
                | "curvePreferences"
                | "enableSessionResumption"
                | "disableSystemRoot"
                | "useSystemCA" => true,
                "allowInsecure" => value.as_bool() == Some(false),
                _ => is_empty(value) || value.as_str() == Some(""),
            })
        })
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ImportedServer {
    address: String,
    port: u16,
    id: String,
    users: Vec<ImportedUser>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ImportedUser {
    id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ImportedSettings {
    #[serde(flatten)]
    server: ImportedServer,
    #[serde(rename = "vnext")]
    v_next: Vec<ImportedServer>,
    servers: Vec<ImportedServer>,
}

fn valid_imported_address(server: &ImportedServer) -> bool {
    server.port > 0
        && server.address.trim() == server.address
        && (server.address.parse::<IpAddr>().is_ok()
            || valid_domain(&normalize_host(&server.address)))
}

fn valid_vless_settings(outbound: &Value) -> bool {
    if !outbound["settings"].is_object() {
        return false;
    }
    let Ok(settings) = serde_json::from_value::<ImportedSettings>(outbound["settings"].clone())
    else {
        return false;
    };
    if settings.v_next.is_empty() {
        return valid_imported_address(&settings.server) && !settings.server.id.trim().is_empty();
    }
    settings.v_next.iter().all(|server| {
        valid_imported_address(server)
            && !server.users.is_empty()
            && server.users.iter().all(|user| !user.id.trim().is_empty())
    })
}

#[derive(Default)]
pub(crate) struct JsonServer {
    pub address: String,
    pub port: u16,
}

pub(crate) fn json_server(outbound: &Value) -> Option<(JsonServer, &str)> {
    let settings = &outbound["settings"];
    let direct = text(&settings["address"]);
    let vnext = settings["vnext"].as_array().map_or(&[][..], Vec::as_slice);
    let servers = settings["servers"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let (server, id) = if vnext.len() == 1
        && direct.is_empty()
        && servers.is_empty()
        && vnext[0]["users"].as_array().is_some_and(|v| v.len() == 1)
    {
        (&vnext[0], text(&vnext[0]["users"][0]["id"]))
    } else if !direct.is_empty() && vnext.is_empty() && servers.is_empty() {
        (settings, text(&settings["id"]))
    } else {
        return None;
    };
    if id.is_empty() {
        return None;
    }
    Some((
        JsonServer {
            address: server["address"].as_str()?.to_owned(),
            port: server["port"].as_u64()?.try_into().ok()?,
        },
        id,
    ))
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Routing {
    balancers: Vec<Balancer>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Balancer {
    tag: String,
    selector: Vec<String>,
    fallback_tag: String,
    strategy: Strategy,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Strategy {
    #[serde(rename = "type")]
    kind: String,
    settings: BalanceSettings,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct BalanceSettings {
    baselines: Vec<String>,
    expected: i32,
    #[serde(rename = "maxRTT")]
    max_rtt: String,
    tolerance: f64,
    costs: Vec<BalanceCost>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct BalanceCost {
    #[serde(rename = "match")]
    match_text: String,
    regexp: bool,
    value: f64,
}

fn xray_group(
    exits: &[&RawValue],
    balancer: &Balancer,
    mut remarks: &str,
) -> Result<Profile, String> {
    if balancer.tag.is_empty()
        || balancer.selector.is_empty()
        || balancer.selector.len() > 16
        || balancer.selector.iter().any(String::is_empty)
    {
        return Err("В балансировщике Xray нет явного списка выходов.".into());
    }
    let mut group = XrayProfileGroup {
        strategy: nonempty(&balancer.strategy.kind, "random").into(),
        ..XrayProfileGroup::default()
    };
    let mut tags = HashSet::new();
    let mut member_tags = Vec::new();
    let mut original_outbounds = Vec::new();
    for raw in exits {
        let shape: Shape = serde_json::from_str(raw.get())
            .map_err(|_| "Некорректные или повторяющиеся теги выходов Xray.")?;
        if !shape.tag.is_empty() && !tags.insert(shape.tag.clone()) {
            return Err("Некорректные или повторяющиеся теги выходов Xray.".into());
        }
        let selected = balancer
            .selector
            .iter()
            .any(|prefix| shape.tag.starts_with(prefix));
        let fallback = !shape.tag.is_empty() && shape.tag == balancer.fallback_tag;
        if (fallback && shape.protocol == "blackhole") || (!selected && !fallback) {
            continue;
        }
        let node = xray_node(raw.get(), remarks)
            .map_err(|_| "У группы Xray есть несовместимый выход или резервный маршрут.")?;
        if node.label == "VLESS" {
            remarks = "";
        }
        if fallback {
            group.fallback = Some(group.members.len());
        }
        group.members.push(XrayGroupMember {
            protocol: node.protocol,
            outbound: node
                .outbound
                .expect("JSON profile always contains outbound"),
            fallback_only: !selected,
        });
        member_tags.push(shape.tag);
        original_outbounds.push(*raw);
    }
    if !balancer.fallback_tag.is_empty() && !tags.contains(&balancer.fallback_tag) {
        return Err("Резервный выход Xray отсутствует в профиле.".into());
    }
    if group.strategy == "leastLoad" {
        let settings = &balancer.strategy.settings;
        let mut compiled = XrayGroupStrategySettings {
            baselines: settings.baselines.clone(),
            expected: settings.expected,
            tolerance: settings.tolerance,
            max_rtt: settings.max_rtt.clone(),
            ..Default::default()
        };
        for cost in &settings.costs {
            if cost.regexp || cost.match_text.is_empty() {
                return Err(
                    "Веса с регулярными выражениями в балансировщике Xray не поддерживаются."
                        .into(),
                );
            }
            for (index, tag) in member_tags.iter().enumerate() {
                if tag.contains(&cost.match_text)
                    && !compiled
                        .costs
                        .iter()
                        .any(|existing| existing.member == index)
                {
                    compiled.costs.push(XrayGroupCost {
                        member: index,
                        value: cost.value,
                    });
                }
            }
        }
        group.settings = Some(compiled);
    }
    validate_xray_profile_group(&group)?;
    let group_identity = group_identity(&group, &original_outbounds)?;
    let name = nonempty(label(remarks), "Группа Xray");
    Ok(Profile {
        protocol: "vless".into(),
        label: name.into(),
        upstream_name: name.into(),
        xray_group: Some(group),
        upstream_key: digest(format!("xray-group|{group_identity}")),
        catalog_profile: true,
        ..Default::default()
    })
}

fn valid_duration(mut time: &str) -> bool {
    // Go duration inputs may use compound units and decimal fractions.
    time = time.strip_prefix('+').unwrap_or(time);
    let mut total = 0.0;
    while !time.is_empty() {
        let end = time
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(time.len());
        let Ok(amount) = time[..end].parse::<f64>() else {
            return false;
        };
        let value = &time[end..];
        let Some((unit, seconds)) = [
            ("ns", 1e-9),
            ("us", 1e-6),
            ("µs", 1e-6),
            ("μs", 1e-6),
            ("ms", 1e-3),
            ("s", 1.0),
            ("m", 60.0),
            ("h", 3600.0),
        ]
        .into_iter()
        .find(|(unit, _)| value.starts_with(unit)) else {
            return false;
        };
        total += amount * seconds;
        time = &value[unit.len()..];
    }
    (1e-9..=60.0).contains(&total)
}

pub fn validate_xray_profile_group(group: &XrayProfileGroup) -> Result<(), String> {
    if !(2..=8).contains(&group.members.len()) {
        return Err("группа Xray должна содержать от 2 до 8 выходов".into());
    }
    if !matches!(
        group.strategy.as_str(),
        "leastPing" | "leastLoad" | "random" | "roundRobin"
    ) {
        return Err("неизвестная стратегия группы Xray".into());
    }
    if group
        .fallback
        .is_some_and(|index| index >= group.members.len())
    {
        return Err("резервный выход должен принадлежать группе Xray".into());
    }
    let mut selectable = 0;
    for (i, member) in group.members.iter().enumerate() {
        if member.fallback_only {
            if group.fallback != Some(i) {
                return Err("выход вне пула может использоваться только как резервный".into());
            }
        } else {
            selectable += 1;
        }
        if member.protocol != "vless"
            || !safe_vless_outbound(&member.outbound)
            || member.outbound.to_string().len() > 24 << 10
        {
            return Err(format!(
                "выход {} группы Xray должен быть самостоятельным VLESS",
                i + 1
            ));
        }
        if !matches!(
            text(&member.outbound["streamSettings"]["security"]),
            "tls" | "reality"
        ) {
            return Err(format!(
                "для выхода {} группы Xray требуется TLS или REALITY",
                i + 1
            ));
        }
        if !valid_vless_settings(&member.outbound) {
            return Err(format!(
                "некорректные параметры выхода {} группы Xray",
                i + 1
            ));
        }
        if !json_server(&member.outbound)
            .is_some_and(|(server, _)| valid_subscription_node_host(&server.address))
        {
            return Err(format!(
                "для выхода {} группы Xray нужен публичный IPv4 или домен",
                i + 1
            ));
        }
    }
    if selectable == 0 {
        return Err("выберите хотя бы один выход для балансировки".into());
    }
    if let Some(settings) = &group.settings {
        if group.strategy != "leastLoad"
            || !(0..=selectable).contains(&settings.expected)
            || !(0.0..=1.0).contains(&settings.tolerance)
            || settings.baselines.len() > 8
            || settings.costs.len() > group.members.len()
        {
            return Err("некорректные настройки leastLoad группы Xray".into());
        }
        if !settings.max_rtt.is_empty() && !valid_duration(&settings.max_rtt) {
            return Err("некорректный maxRTT группы Xray".into());
        }
        if settings.baselines.iter().any(|time| !valid_duration(time)) {
            return Err("некорректное время baseline группы Xray".into());
        }
        let mut seen = HashSet::new();
        if settings.costs.iter().any(|cost| {
            cost.member >= group.members.len()
                || !(0.0..=2e18).contains(&cost.value)
                || cost.value == 0.0
                || !seen.insert(cost.member)
        }) {
            return Err("некорректный вес выхода группы Xray".into());
        }
    }
    Ok(())
}

fn escape_go_string(value: &str) -> String {
    escape_go_html(&serde_json::to_string(value).expect("serializing a string cannot fail"))
}

fn escape_go_html(value: &str) -> String {
    value
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn go_number(number: f64) -> String {
    let absolute = number.abs();
    if absolute != 0.0 && !(1e-6..1e21).contains(&absolute) {
        let exponent = format!("{number:e}");
        let (coefficient, suffix) = exponent
            .split_once('e')
            .expect("finite number has exponent");
        if suffix.starts_with('-') {
            exponent
        } else {
            format!("{coefficient}e+{suffix}")
        }
    } else {
        number.to_string()
    }
}

fn go_json(value: &Value) -> String {
    match value {
        Value::String(s) => escape_go_string(s),
        Value::Number(n) => go_number(n.as_f64().expect("JSON numbers fit f64")),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(go_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .map(|(key, value)| format!("{}:{}", escape_go_string(key), go_json(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

fn compact_raw(value: &str) -> String {
    let mut escaped = false;
    let mut quoted = false;
    let mut result = String::with_capacity(value.len());
    for c in value.chars() {
        if quoted {
            result.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if !matches!(c, ' ' | '\t' | '\n' | '\r') {
            quoted = c == '"';
            result.push(c);
        }
    }
    escape_go_html(&result)
}

fn group_identity(
    group: &XrayProfileGroup,
    original_outbounds: &[&RawValue],
) -> Result<String, String> {
    let mut out = format!(
        "{{\"strategy\":{},\"members\":[",
        escape_go_string(&group.strategy)
    );
    for (index, (member, original)) in group.members.iter().zip(original_outbounds).enumerate() {
        if index != 0 {
            out.push(',');
        }
        let fields: BTreeMap<String, &RawValue> = serde_json::from_str(original.get())
            .map_err(|_| "Некорректные параметры группы Xray.")?;
        let outbound = fields
            .into_iter()
            .filter(|(key, _)| key != "tag")
            .map(|(key, value)| format!("{}:{}", escape_go_string(&key), compact_raw(value.get())))
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&format!(
            "{{\"protocol\":{},\"outbound\":{{{outbound}}}",
            escape_go_string(&member.protocol)
        ));
        if member.fallback_only {
            out.push_str(",\"fallbackOnly\":true");
        }
        out.push('}');
    }
    out.push(']');
    if let Some(fallback) = group.fallback {
        out.push_str(&format!(",\"fallback\":{fallback}"));
    }
    if let Some(settings) = &group.settings {
        let mut values = Vec::new();
        if !settings.baselines.is_empty() {
            values.push(format!(
                "\"baselines\":[{}]",
                settings
                    .baselines
                    .iter()
                    .map(|s| escape_go_string(s))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        if settings.expected != 0 {
            values.push(format!("\"expected\":{}", settings.expected));
        }
        if !settings.max_rtt.is_empty() {
            values.push(format!(
                "\"maxRTT\":{}",
                escape_go_string(&settings.max_rtt)
            ));
        }
        if settings.tolerance != 0.0 {
            values.push(format!("\"tolerance\":{}", go_number(settings.tolerance)));
        }
        if !settings.costs.is_empty() {
            values.push(format!(
                "\"costs\":[{}]",
                settings
                    .costs
                    .iter()
                    .map(|cost| {
                        format!(
                            "{{\"member\":{},\"value\":{}}}",
                            cost.member,
                            go_number(cost.value)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        out.push_str(&format!(",\"settings\":{{{}}}", values.join(",")));
    }
    out.push('}');
    Ok(out)
}

const INVALID_HYSTERIA: &str =
    "Поддерживается самостоятельный выход Hysteria2 с публичным адресом и проверяемым TLS.";

#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct HysteriaOutbound {
    protocol: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    tag: String,
    settings: HysteriaEndpoint,
    stream_settings: HysteriaStream,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct HysteriaEndpoint {
    address: String,
    port: u16,
    version: u8,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct HysteriaStream {
    network: String,
    security: String,
    hysteria_settings: HysteriaOptions,
    tls_settings: HysteriaTls,
    #[serde(skip_serializing_if = "Option::is_none")]
    finalmask: Option<HysteriaFinalMask>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct HysteriaOptions {
    version: u8,
    auth: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct HysteriaTls {
    #[serde(skip_serializing_if = "String::is_empty")]
    server_name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    alpn: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    fingerprint: String,
    #[serde(skip_serializing)]
    allow_insecure: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HysteriaFinalMask {
    quic_params: Option<HysteriaQuic>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct HysteriaQuic {
    congestion: String,
    #[serde(rename = "debug", skip_serializing)]
    _debug: bool,
}

fn valid_hysteria_host(host: &str) -> bool {
    let normalized = normalize_host(host);
    host == host.trim()
        && valid_subscription_node_host(host)
        && (host.parse::<IpAddr>().is_ok()
            || normalized
                .rsplit('.')
                .next()
                .and_then(|part| part.bytes().next())
                .is_some_and(|b| b.is_ascii_lowercase()))
}

fn read_hysteria(raw: &str) -> Result<HysteriaOutbound, String> {
    if raw.len() > 24 << 10 {
        return Err(INVALID_HYSTERIA.into());
    }
    let mut node: HysteriaOutbound = serde_json::from_str(raw).map_err(|_| INVALID_HYSTERIA)?;
    let stream = &mut node.stream_settings;
    let auth = &stream.hysteria_settings.auth;
    if node.protocol != "hysteria"
        || node.settings.version != 2
        || node.settings.port == 0
        || !valid_hysteria_host(&node.settings.address)
        || stream.network != "hysteria"
        || stream.security != "tls"
        || stream.hysteria_settings.version != 2
        || auth.trim().is_empty()
        || auth.len() > 1024
        || auth.chars().any(char::is_control)
    {
        return Err(INVALID_HYSTERIA.into());
    }
    let tls = &mut stream.tls_settings;
    if tls.allow_insecure
        || !tls.server_name.is_empty() && !valid_hysteria_host(&tls.server_name)
        || tls.alpn.len() > 1
        || tls.alpn.first().is_some_and(|p| p != "h3")
        || !matches!(
            tls.fingerprint.as_str(),
            "" | "chrome"
                | "firefox"
                | "safari"
                | "ios"
                | "android"
                | "edge"
                | "360"
                | "qq"
                | "random"
                | "randomized"
                | "unsafe"
        )
    {
        return Err(INVALID_HYSTERIA.into());
    }
    match stream
        .finalmask
        .as_ref()
        .and_then(|mask| mask.quic_params.as_ref())
        .map(|quic| quic.congestion.as_str())
    {
        Some("reno" | "bbr" | "brutal") => {}
        None | Some("") => stream.finalmask = None,
        _ => return Err(INVALID_HYSTERIA.into()),
    }
    node.settings.address = normalize_host(&node.settings.address);
    tls.server_name = normalize_host(&tls.server_name);
    Ok(node)
}

pub fn validate_subscription_hysteria_node(outbound: &Value) -> bool {
    read_hysteria(&outbound.to_string()).is_ok()
}

fn hysteria_node(raw: &str, remarks: &str) -> Result<Profile, String> {
    let mut node = read_hysteria(raw)?;
    let name = label(nonempty(remarks, &node.tag));
    let name = if name.contains(&node.stream_settings.hysteria_settings.auth) {
        ""
    } else {
        name
    };
    let name = nonempty(name, "Hysteria2").to_owned();
    node.tag.clear();
    let identity = escape_go_html(&serde_json::to_string(&node).map_err(|_| INVALID_HYSTERIA)?);
    Ok(Profile {
        protocol: "hysteria2".into(),
        label: name.clone(),
        upstream_name: name,
        upstream_key: digest(identity),
        outbound: Some(serde_json::to_value(node).map_err(|_| INVALID_HYSTERIA)?),
        catalog_profile: true,
        ..Default::default()
    })
}

pub fn pin_subscription_hysteria_node(
    profile: &Profile,
    address: Ipv4Addr,
) -> Result<Profile, String> {
    if profile.protocol != "hysteria2" || !profile.uri.is_empty() || !is_public_ipv4(address) {
        return Err(INVALID_HYSTERIA.into());
    }
    let mut node = read_hysteria(
        &profile
            .outbound
            .as_ref()
            .ok_or(INVALID_HYSTERIA)?
            .to_string(),
    )?;
    if node.stream_settings.tls_settings.server_name.is_empty() {
        node.stream_settings
            .tls_settings
            .server_name
            .clone_from(&node.settings.address);
    }
    node.settings.address = address.to_string();
    node.tag.clear();
    Ok(Profile {
        outbound: Some(serde_json::to_value(node).map_err(|_| INVALID_HYSTERIA)?),
        ..profile.clone()
    })
}

pub fn pin_subscription_vless_node(
    profile: &Profile,
    address: Ipv4Addr,
) -> Result<Profile, String> {
    let error = "проверка принимает только публичные IPv4 узлов VLESS";
    if profile.protocol != "vless" || !is_public_ipv4(address) {
        return Err(error.into());
    }
    let mut outbound = match &profile.outbound {
        Some(value) => value.clone(),
        None => profile_uri_outbound(profile)?,
    };
    if !safe_vless_outbound(&outbound) || !valid_vless_settings(&outbound) {
        return Err("проверка принимает только самостоятельный выход VLESS".into());
    }
    let (server, _) = json_server(&outbound).ok_or(error)?;
    if !valid_subscription_node_host(&server.address) {
        return Err(error.into());
    }
    let nested = outbound["settings"]["vnext"]
        .as_array()
        .is_some_and(|entries| !entries.is_empty());
    if nested {
        outbound["settings"]["vnext"][0]["address"] = json!(address.to_string());
    } else {
        outbound["settings"]["address"] = json!(address.to_string());
    }
    if let Some(stream) = outbound
        .get_mut("streamSettings")
        .filter(|stream| stream.is_object())
    {
        preserve_authority(stream, &server.address, server.port);
    }
    Ok(Profile {
        uri: String::new(),
        outbound: Some(outbound),
        ..profile.clone()
    })
}

/// Allow a raw Trojan profile into a diagnostic process only when it has one
/// known TLS endpoint and no mechanism to dial an auxiliary connection.
pub fn pin_trojan_outbound(profile: &Profile, address: Ipv4Addr) -> Result<Value, String> {
    let error = || "проверка принимает только самостоятельный выход Trojan с TLS".to_owned();
    let outbound = profile.outbound.as_ref().ok_or_else(error)?;
    if profile.protocol != "trojan"
        || !profile.uri.is_empty()
        || !is_public_ipv4(address)
        || !safe_standard_outbound(outbound, "trojan")
        || outbound.get("mux").is_some()
    {
        return Err(error());
    }
    let stream = &outbound["streamSettings"];
    if stream["security"] != "tls" || !safe_trojan_transport(stream) {
        return Err(error());
    }
    let settings = outbound["settings"].as_object().ok_or_else(error)?;
    let nested = settings.contains_key("servers");
    let server = if nested {
        let entries = settings["servers"].as_array().ok_or_else(error)?;
        if settings.len() != 1 || entries.len() != 1 {
            return Err(error());
        }
        entries[0].as_object().ok_or_else(error)?
    } else {
        settings
    };
    if server.keys().any(|key| {
        !matches!(
            key.as_str(),
            "address" | "port" | "password" | "email" | "level" | "flow"
        )
    }) || server
        .get("password")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(error());
    }
    let host = server
        .get("address")
        .and_then(Value::as_str)
        .filter(|host| valid_subscription_node_host(host))
        .ok_or_else(error)?;
    let port = server
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .ok_or_else(error)?;
    let mut pinned = outbound.clone();
    if nested {
        pinned["settings"]["servers"][0]["address"] = json!(address.to_string());
    } else {
        pinned["settings"]["address"] = json!(address.to_string());
    }
    preserve_authority(&mut pinned["streamSettings"], host, port);
    Ok(pinned)
}

fn safe_trojan_transport(stream: &Value) -> bool {
    let network = text(&stream["network"]);
    let (transport, fields): (&str, &[&str]) = match network {
        "" | "raw" | "tcp" => ("", &[]),
        "ws" | "websocket" => (
            "wsSettings",
            &["host", "path", "headers", "heartbeatPeriod"],
        ),
        "grpc" => (
            "grpcSettings",
            &[
                "authority",
                "serviceName",
                "multiMode",
                "idle_timeout",
                "health_check_timeout",
                "permit_without_stream",
                "initial_windows_size",
            ],
        ),
        "httpupgrade" => ("httpupgradeSettings", &["host", "path", "headers"]),
        _ => return false,
    };
    stream.as_object().is_some_and(|map| {
        map.keys().all(|key| {
            matches!(key.as_str(), "network" | "security" | "tlsSettings") || key == transport
        })
    }) && stream.get(transport).is_none_or(|settings| {
        settings
            .as_object()
            .is_some_and(|map| map.keys().all(|key| fields.contains(&key.as_str())))
    }) && stream["tlsSettings"].as_object().is_none_or(|tls| {
        tls.get("serverName").is_none_or(|name| {
            name.as_str()
                .is_some_and(|name| name.is_empty() || valid_subscription_node_host(name))
        })
    })
}

fn preserve_authority(stream: &mut Value, hostname: &str, port: u16) {
    let tls = stream["security"] == "tls";
    let reality = stream["security"] == "reality";
    let authority = stream["tlsSettings"]["serverName"]
        .as_str()
        .filter(|name| !name.is_empty())
        .unwrap_or(hostname)
        .to_owned();
    for key in [
        "wsSettings",
        "httpupgradeSettings",
        "xhttpSettings",
        "splithttpSettings",
    ] {
        if let Some(settings) = stream.get_mut(key).filter(|settings| settings.is_object())
            && text(&settings["host"]).is_empty()
            && !settings["headers"]
                .as_object()
                .is_some_and(|map| map.keys().any(|header| header.eq_ignore_ascii_case("host")))
        {
            settings["host"] = json!(authority);
        }
    }
    if let Some(settings) = stream
        .get_mut("grpcSettings")
        .filter(|settings| settings.is_object())
        && text(&settings["authority"]).is_empty()
    {
        settings["authority"] = if reality {
            json!(socket_address(hostname, port))
        } else {
            json!(authority)
        };
    }
    if tls && text(&stream["tlsSettings"]["serverName"]).is_empty() {
        if !stream["tlsSettings"].is_object() {
            stream["tlsSettings"] = json!({});
        }
        stream["tlsSettings"]["serverName"] = json!(hostname);
    }
}

/// Only standalone sharing URIs are accepted here. Raw subscription
/// outbounds use their protocol-specific validators and pinning functions.
pub fn pin_profile_uri(profile: &Profile, address: Ipv4Addr) -> Result<Value, String> {
    let error = "проверка принимает только публичные IPv4 узлов VPN";
    if !is_public_ipv4(address) {
        return Err(error.into());
    }
    let mut outbound = profile_uri_outbound(profile)?;
    let hostname = text(&outbound["settings"]["address"]).to_owned();
    let port = outbound["settings"]["port"]
        .as_u64()
        .and_then(|n| n.try_into().ok())
        .ok_or(error)?;
    if !valid_subscription_node_host(&hostname) {
        return Err(error.into());
    }
    outbound["settings"]["address"] = json!(address.to_string());
    preserve_authority(&mut outbound["streamSettings"], &hostname, port);
    Ok(outbound)
}

#[cfg(test)]
mod trojan_probe_tests {
    use super::*;

    fn node() -> Profile {
        Profile {
            protocol: "trojan".into(),
            outbound: Some(json!({
                "protocol":"trojan","settings":{"servers":[
                    {"address":"node.example.com","port":443,"password":"fixture"}
                ]},
                "streamSettings":{"security":"tls","network":"ws","wsSettings":{"path":"/t"}},
            })),
            ..Profile::default()
        }
    }

    #[test]
    fn trojan_pins_the_only_server_and_retains_tls_and_websocket_authority() {
        let pinned = pin_trojan_outbound(&node(), Ipv4Addr::new(8, 8, 8, 8)).unwrap();
        assert_eq!(pinned["settings"]["servers"][0]["address"], "8.8.8.8");
        assert_eq!(pinned["settings"]["servers"][0]["password"], "fixture");
        assert_eq!(
            pinned["streamSettings"]["tlsSettings"]["serverName"],
            "node.example.com"
        );
        assert_eq!(
            pinned["streamSettings"]["wsSettings"]["host"],
            "node.example.com"
        );
    }

    #[test]
    fn trojan_rejects_private_and_auxiliary_dials_and_insecure_tls() {
        let public = Ipv4Addr::new(8, 8, 8, 8);
        assert!(pin_trojan_outbound(&node(), Ipv4Addr::LOCALHOST).is_err());
        let mut profile = node();
        profile.outbound.as_mut().unwrap()["settings"]["servers"][0]["address"] =
            json!("192.168.1.1");
        assert!(pin_trojan_outbound(&profile, public).is_err());
        let mut profile = node();
        profile.outbound.as_mut().unwrap()["settings"]["servers"][0]["fallbacks"] =
            json!([{"dest":"localhost:6000"}]);
        assert!(pin_trojan_outbound(&profile, public).is_err());
        let mut profile = node();
        profile.outbound.as_mut().unwrap()["streamSettings"]["wsSettings"]["dialerProxy"] =
            json!("direct");
        assert!(pin_trojan_outbound(&profile, public).is_err());
        let mut profile = node();
        profile.outbound.as_mut().unwrap()["streamSettings"]["tlsSettings"] =
            json!({"allowInsecure":true});
        assert!(pin_trojan_outbound(&profile, public).is_err());
    }
}
