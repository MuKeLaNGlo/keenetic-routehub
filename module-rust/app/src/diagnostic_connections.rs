use std::{
    collections::HashMap,
    io,
    net::{Ipv4Addr, SocketAddrV4},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use axum::{
    Json,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use ipnet::Ipv4Net;
use routehub_policy::normalize_mac;
use serde::{Deserialize, Serialize};
use tokio::{
    fs::File,
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader},
    process::Command,
    time::{MissedTickBehavior, interval, timeout},
};

use crate::{auth::error, config::Plan, server::App};

const PROC_TABLES: [&str; 2] = ["/proc/net/nf_conntrack", "/proc/net/ip_conntrack"];
const SCAN_LIMIT: u64 = 2 << 20;
const FIELD_LINE_LIMIT: usize = 65_535;
const TRACKED_LIMIT: usize = 512;
const ROW_LIMIT: usize = 80;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct ObserveInput {
    seconds: i32,
    device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    rows: Vec<ObservationRow>,
    seconds: u32,
    finished_at: DateTime<Utc>,
    limited: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservationRow {
    id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    device_id: String,
    source_address: Ipv4Addr,
    dst: SocketAddrV4,
    proto: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    new: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    redirected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    game_match: Option<GameMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameMatch {
    preset_id: String,
    name: String,
    category: String,
}

#[derive(Hash, PartialEq, Eq)]
struct ConnectionKey {
    source: SocketAddrV4,
    destination: SocketAddrV4,
    protocol: &'static str,
    zone: String,
}

struct Connection {
    reply_source: SocketAddrV4,
    bytes: Option<u64>,
}

#[derive(Default)]
struct Tuple {
    source: Option<Ipv4Addr>,
    destination: Option<Ipv4Addr>,
    source_port: Option<u16>,
    destination_port: Option<u16>,
    bytes: Option<u64>,
}

fn tracked(line: &str) -> Option<(ConnectionKey, Connection)> {
    let mut fields = line.split_ascii_whitespace();
    let mut protocol = fields.next()?;
    if protocol == "ipv4" {
        fields.next()?;
        protocol = fields.next()?;
    }
    let protocol = match protocol {
        "tcp" => "tcp",
        "udp" => "udp",
        _ => return None,
    };
    let mut tuples = [Tuple::default(), Tuple::default()];
    let mut index = None;
    let mut zone = "";
    for field in fields {
        let Some((key, value)) = field.split_once('=') else {
            continue;
        };
        if key == "zone" {
            zone = value;
            continue;
        }
        if key == "src" {
            index = match index {
                None => Some(0),
                Some(_) => Some(1),
            };
        }
        let Some(tuple) = index.and_then(|position| tuples.get_mut(position)) else {
            continue;
        };
        match key {
            "src" if tuple.source.is_none() => tuple.source = value.parse().ok(),
            "dst" => tuple.destination = value.parse().ok(),
            "sport" | "dport" => {
                let port = value.parse::<u16>().ok().filter(|port| *port != 0)?;
                if key == "sport" {
                    tuple.source_port = Some(port);
                } else {
                    tuple.destination_port = Some(port);
                }
            }
            "bytes" => tuple.bytes = value.parse().ok(),
            _ => {}
        }
    }
    let [original, reply] = tuples;
    Some((
        ConnectionKey {
            source: SocketAddrV4::new(original.source?, original.source_port?),
            destination: SocketAddrV4::new(original.destination?, original.destination_port?),
            protocol,
            zone: zone.into(),
        },
        Connection {
            reply_source: SocketAddrV4::new(reply.source?, reply.source_port?),
            bytes: original.bytes.and_then(|tx| tx.checked_add(reply.bytes?)),
        },
    ))
}

#[derive(Default)]
struct Snapshot {
    connections: HashMap<ConnectionKey, Connection>,
    limited: bool,
}

fn unicast(ip: Ipv4Addr) -> bool {
    !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_multicast()
        && !ip.is_link_local()
        && !ip.is_broadcast()
}

async fn read_table(
    table: impl AsyncRead + Unpin,
    source: Ipv4Net,
    router: Option<Ipv4Addr>,
) -> io::Result<Snapshot> {
    let mut reader = BufReader::new(table.take(SCAN_LIMIT));
    let mut result = Snapshot::default();
    let mut line = Vec::new();
    while bounded_line(&mut reader, &mut line).await? {
        let record = std::str::from_utf8(&line).ok().and_then(tracked);
        line.clear();
        let Some((key, connection)) = record else {
            continue;
        };
        if !source.contains(key.source.ip())
            || Some(*key.source.ip()) == router
            || !unicast(*key.destination.ip())
        {
            continue;
        }
        if result.connections.len() == TRACKED_LIMIT {
            result.limited = true;
            break;
        }
        result.connections.insert(key, connection);
    }
    result.limited |= reader.get_ref().limit() == 0;
    Ok(result)
}

async fn bounded_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
) -> io::Result<bool> {
    loop {
        let next = reader.fill_buf().await?;
        if next.is_empty() {
            return Ok(!line.is_empty());
        }
        let newline = next.iter().position(|byte| *byte == b'\n');
        let end = newline.map_or(next.len(), |index| index + 1);
        if line.len() + end > FIELD_LINE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oversized conntrack entry",
            ));
        }
        line.extend_from_slice(&next[..end]);
        reader.consume(end);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

async fn read_snapshot(source: Ipv4Net, router: Option<Ipv4Addr>) -> io::Result<Snapshot> {
    for path in PROC_TABLES {
        if let Ok(file) = File::open(path).await
            && let Ok(result) = read_table(file, source, router).await
        {
            return Ok(result);
        }
    }
    timeout(Duration::from_millis(1200), async {
        let mut child = Command::new("conntrack")
            .args(["-L", "-f", "ipv4", "--orig-src"])
            .arg(source.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("no conntrack stdout"))?;
        let result = read_table(output, source, router).await?;
        if result.limited {
            let _ = child.kill().await;
        } else if !child.wait().await?.success() {
            return Err(io::Error::other("conntrack read failed"));
        }
        Ok(result)
    })
    .await?
}

struct Sample {
    last_bytes: Option<u64>,
    row: ObservationRow,
}

#[derive(Default)]
struct Samples {
    connections: HashMap<ConnectionKey, Sample>,
    limited: bool,
    baseline_complete: bool,
}

impl Samples {
    fn record(
        &mut self,
        snapshot: Snapshot,
        baseline: bool,
        listener: Option<SocketAddrV4>,
        devices: &HashMap<Ipv4Addr, String>,
    ) {
        if baseline {
            self.baseline_complete = !snapshot.limited;
        }
        self.limited |= snapshot.limited;
        for (key, connection) in snapshot.connections {
            if let Some(sample) = self.connections.get_mut(&key) {
                if let (Some(bytes), Some(last), Some(now)) =
                    (&mut sample.row.bytes, sample.last_bytes, connection.bytes)
                    && now >= last
                {
                    *bytes = bytes.saturating_add(now - last);
                }
                sample.last_bytes = connection.bytes;
                continue;
            }
            if self.connections.len() >= TRACKED_LIMIT {
                self.limited = true;
                continue;
            }
            let new = !baseline && self.baseline_complete && !self.limited;
            let source = *key.source.ip();
            let row = ObservationRow {
                id: format!(
                    "{}/{}/{}/{}",
                    key.protocol, key.source, key.destination, key.zone
                ),
                device_id: devices.get(&source).cloned().unwrap_or_default(),
                source_address: source,
                dst: key.destination,
                proto: key.protocol,
                bytes: connection.bytes.map(|count| if new { count } else { 0 }),
                new,
                redirected: key.protocol == "tcp"
                    && listener == Some(connection.reply_source)
                    && listener != Some(key.destination),
                game_match: None,
            };
            self.connections.insert(
                key,
                Sample {
                    row,
                    last_bytes: connection.bytes,
                },
            );
        }
    }

    fn finish(self, seconds: u32) -> Observation {
        let mut rows: Vec<_> = self
            .connections
            .into_values()
            .map(|sample| sample.row)
            .collect();
        rows.sort_unstable_by(|left, right| {
            right
                .bytes
                .unwrap_or(0)
                .cmp(&left.bytes.unwrap_or(0))
                .then_with(|| right.new.cmp(&left.new))
                .then_with(|| left.id.cmp(&right.id))
        });
        let limited = self.limited || rows.len() > ROW_LIMIT;
        rows.truncate(ROW_LIMIT);
        Observation {
            rows,
            seconds,
            finished_at: Utc::now(),
            limited,
        }
    }
}

fn source_network(plan: &Plan, capture_active: bool) -> Option<Ipv4Net> {
    if !capture_active {
        return None;
    }
    plan.transparent
        .as_ref()?
        .source
        .parse::<Ipv4Net>()
        .ok()
        .map(|network| network.trunc())
}

fn match_existing_game(plan: &Plan, row: &ObservationRow) -> Option<GameMatch> {
    if row.device_id.is_empty() {
        return None;
    }
    plan.games
        .iter()
        .rev()
        .filter(|preset| preset.enabled && preset.scope.device_ids.contains(&row.device_id))
        .find_map(|preset| {
            preset
                .signatures
                .iter()
                .find(|signature| {
                    signature.protocol == row.proto
                        && signature.port == row.dst.port()
                        && signature.destination.parse::<Ipv4Addr>().ok().as_ref()
                            == Some(row.dst.ip())
                })
                .map(|signature| GameMatch {
                    preset_id: preset.id.clone(),
                    name: preset.name.clone(),
                    category: signature.category.clone(),
                })
        })
}

pub(crate) fn observation_available(plan: &Plan, capture_active: bool) -> bool {
    source_network(plan, capture_active).is_some()
        && (PROC_TABLES
            .iter()
            .any(|path| std::fs::File::open(path).is_ok())
            || std::env::var_os("PATH").is_some_and(|path| {
                std::env::split_paths(&path).any(|dir| dir.join("conntrack").is_file())
            }))
}

pub(super) async fn observe(State(app): State<Arc<App>>, request: Request) -> Response {
    let input: ObserveInput = match super::diagnostic_request(&app, request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let seconds = match u32::try_from(input.seconds) {
        Ok(seconds @ 1..=10) => seconds,
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "Длительность наблюдения должна быть от 1 до 10 секунд",
            );
        }
    };
    let mac = if input.device_id.is_empty() {
        String::new()
    } else {
        match normalize_mac(&input.device_id) {
            Ok(mac) => mac,
            Err(_) => return error(StatusCode::BAD_REQUEST, "Укажите MAC-адрес устройства"),
        }
    };
    let snapshot = app.snapshot();
    let plan = &snapshot.plan;
    let Some(mut source) = source_network(plan, app.capture_active) else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Нет активной IPv4-подсети RouteHub",
        );
    };
    let Ok(_permit) = app.diagnostics.observation.try_acquire() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "Наблюдение уже идёт");
    };
    let mut devices = HashMap::<Ipv4Addr, String>::new();
    if let Ok(topology) = timeout(Duration::from_secs(1), app.topology.snapshot(plan, true)).await {
        for item in topology.neighbors() {
            if let Ok(address) = item.address.parse() {
                let entry = devices.entry(address).or_insert_with(|| item.mac.clone());
                if *entry != item.mac {
                    entry.clear();
                }
            }
        }
    }
    let router = plan.panel_host.parse::<Ipv4Addr>().ok();
    if !mac.is_empty() {
        let mut selected = devices.iter().filter(|(address, owner)| {
            **owner == mac && Some(**address) != router && source.contains(*address)
        });
        if let Some((&ip, _)) = selected.next()
            && selected.next().is_none()
        {
            source = Ipv4Net::new_assert(ip, 32);
        } else {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Не найден однозначный IPv4-адрес устройства в активной сети RouteHub",
            );
        }
    }
    let listener = router
        .filter(|_| app.diagnostics_status()["lanMode"] == "redirect-tcp")
        .zip(
            plan.transparent
                .as_ref()
                .map(|capture| capture.port)
                .filter(|port| *port != 0),
        )
        .map(|(ip, port)| SocketAddrV4::new(ip, port));
    let observation = timeout(Duration::from_secs(u64::from(seconds) + 4), async {
        let mut result = Samples::default();
        let mut tick = interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        for count in 0..=seconds {
            tick.tick().await;
            let current = read_snapshot(source, router).await?;
            result.record(current, count == 0, listener, &devices);
        }
        Ok::<_, io::Error>(result.finish(seconds))
    })
    .await;
    match observation {
        Ok(Ok(mut observation)) => {
            let current = app.snapshot();
            for row in &mut observation.rows {
                row.game_match = match_existing_game(&current.plan, row);
            }
            Json(observation).into_response()
        }
        _ => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Не удалось прочитать таблицу соединений Netfilter",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TCP: &str = "ipv4 2 tcp 6 431999 ESTABLISHED src=192.168.10.2 dst=203.0.113.1 sport=55354 dport=443 packets=1 bytes=130 src=192.168.10.1 dst=192.168.10.2 sport=15080 dport=55354 packets=1 bytes=100 [ASSURED] mark=0 use=1";
    const UDP: &str = "udp 17 26 src=192.168.10.7 dst=198.51.100.4 sport=42300 dport=443 src=198.51.100.4 dst=203.0.113.5 sport=443 dport=42300 mark=0 use=1";

    #[tokio::test]
    async fn conntrack_observation_counts_deltas_and_stays_inside_source_network() {
        let source = "192.168.10.0/24".parse().unwrap();
        let router = Some(Ipv4Addr::new(192, 168, 10, 1));
        let listener = Some("192.168.10.1:15080".parse().unwrap());
        let devices = HashMap::from([(Ipv4Addr::new(192, 168, 10, 2), "sample".into())]);
        let current = format!(
            "{}\n{UDP}\n{}\n{}\n",
            TCP.replacen("bytes=130", "bytes=210", 1),
            TCP.replacen("src=192.168.10.2", "src=172.16.0.9", 1),
            TCP.replacen("src=192.168.10.2", "src=192.168.10.1", 1),
        );
        let baseline = read_table(TCP.as_bytes(), source, router).await.unwrap();
        let latest = read_table(current.as_bytes(), source, router)
            .await
            .unwrap();
        let mut samples = Samples::default();
        samples.record(baseline, true, listener, &devices);
        samples.record(latest, false, listener, &devices);
        let report = serde_json::to_value(samples.finish(1)).unwrap();
        assert_eq!(
            report["rows"],
            serde_json::json!([
                {"id":"tcp/192.168.10.2:55354/203.0.113.1:443/","deviceId":"sample","sourceAddress":"192.168.10.2","dst":"203.0.113.1:443","proto":"tcp","bytes":80,"redirected":true},
                {"id":"udp/192.168.10.7:42300/198.51.100.4:443/","sourceAddress":"192.168.10.7","dst":"198.51.100.4:443","proto":"udp","new":true}
            ]),
        );
        assert_eq!(report["limited"], false);
    }
}
