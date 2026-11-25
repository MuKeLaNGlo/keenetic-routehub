use crate::address::{client_ip, normalize_mac};
use ipnet::{IpNet, Ipv4Net};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::net::IpAddr;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const HOTSPOT: &str = "show ip hotspot";
const RESERVATIONS: &str = r#"show running-config | grep "^ip dhcp host ""#;
const BINDINGS: &str = "show ip dhcp bindings";
const ARP: &str = "/proc/net/arp";
const OUTPUT_LIMIT: u64 = 2 << 20;
const LINE_LIMIT: usize = 65_535;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Neighbor {
    pub mac: String,
    pub address: String,
    pub label: String,
    pub fixed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeeneticSegment {
    pub id: String,
    pub name: String,
    pub system_name: String,
    pub kind: String,
    pub address: Option<IpAddr>,
    pub prefix: Option<IpNet>,
    pub state: String,
    pub security: String,
}

/// Combine read-only Keenetic CLI queries and the ARP cache. Only an infinite
/// lease with a matching static reservation can become a fixed address.
pub fn read_keenetic_inventory() -> Result<Vec<Neighbor>, String> {
    inventory_with(
        ndm_command,
        read_arp_file,
        Instant::now() + Duration::from_secs(3),
    )
}

pub fn read_keenetic_segments() -> Result<Vec<KeeneticSegment>, String> {
    let raw = ndm_command("show interface", Instant::now() + Duration::from_secs(2))
        .map_err(|err| err.to_string())?;
    Ok(parse_keenetic_segments(&raw))
}

fn inventory_with<C, R>(command: C, arp_file: R, deadline: Instant) -> Result<Vec<Neighbor>, String>
where
    C: Fn(&str, Instant) -> io::Result<Vec<u8>>,
    R: Fn() -> io::Result<Vec<u8>>,
{
    let configured = command(RESERVATIONS, deadline);
    let hosts = command(HOTSPOT, deadline);
    let bindings = command(BINDINGS, deadline);
    let arp = arp_file();
    if Instant::now() >= deadline {
        return Err("context deadline exceeded".into());
    }
    if hosts.is_err() && bindings.is_err() && arp.is_err() {
        return Err("инвентарь клиентов Keenetic недоступен".into());
    }
    let reservations = configured
        .as_deref()
        .map_or_else(|_| Vec::new(), parse_reservations);
    let hosts = hosts
        .as_deref()
        .map_or_else(|_| Vec::new(), |raw| parse_ndm_clients(raw, "host"));
    let leases = bindings
        .as_deref()
        .map_or_else(|_| Vec::new(), |raw| parse_ndm_clients(raw, "lease"));
    let neighbors = arp.as_deref().map_or_else(|_| Vec::new(), parse_arp);
    Ok(merge_neighbors([
        confirmed_leases(&reservations, leases),
        hosts,
        neighbors,
    ]))
}

fn read_limited(input: impl Read) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    input.take(OUTPUT_LIMIT + 1).read_to_end(&mut output)?;
    if output.len() as u64 > OUTPUT_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "инвентарь превышает лимит 2 МиБ",
        ));
    }
    Ok(output)
}

fn read_arp_file() -> io::Result<Vec<u8>> {
    read_limited(File::open(ARP)?)
}

fn timeout() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "context deadline exceeded")
}

fn ndm_command(query: &str, deadline: Instant) -> io::Result<Vec<u8>> {
    if deadline <= Instant::now() {
        return Err(timeout());
    }
    let mut child = Command::new("/bin/ndmc")
        .args(["-c", query])
        .env_clear()
        .env("PATH", "/bin:/sbin:/usr/bin:/usr/sbin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("вывод ndmc недоступен"));
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let reader = thread::Builder::new()
        .name("routehub-ndm".into())
        .stack_size(64 << 10)
        .spawn(move || {
            let _ = sender.send(read_limited(stdout));
        });
    if let Err(err) = reader {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }
    let output = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    let output = match output {
        Ok(Ok(output)) => output,
        other => {
            let _ = child.kill();
            let _ = child.wait();
            return match other {
                Ok(Err(err)) => Err(err),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(timeout()),
                _ => Err(io::Error::other("вывод ndmc недоступен")),
            };
        }
    };
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(output),
            Ok(Some(status)) => return Err(io::Error::other(status.to_string())),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            other => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(other.err().unwrap_or_else(timeout));
            }
        }
    }
}

fn lines(raw: &[u8]) -> impl Iterator<Item = Cow<'_, str>> {
    raw.split(|byte| *byte == b'\n')
        .take_while(|line| line.len() <= LINE_LIMIT)
        .map(|line| String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line)))
}

fn normalize_neighbor(mac: &str, address: &str, label: String, fixed: bool) -> Option<Neighbor> {
    Some(Neighbor {
        mac: normalize_mac(mac).ok()?,
        address: client_ip(address).ok()?.to_string(),
        label,
        fixed,
    })
}

fn clean_label(value: &str) -> String {
    // Go trims whitespace after removing control characters.
    let clean: String = value.chars().filter(|c| !c.is_control()).collect();
    clean.trim().chars().take(128).collect()
}

pub fn parse_ndm_clients(raw: &[u8], group: &str) -> Vec<Neighbor> {
    #[derive(Default)]
    struct RawClient {
        mac: String,
        ip: String,
        name: String,
        hostname: String,
        expires: String,
    }
    impl RawClient {
        fn into_neighbor(self, group: &str) -> Option<Neighbor> {
            let mut label = clean_label(&self.name);
            if label.is_empty() {
                label = clean_label(&self.hostname);
            }
            normalize_neighbor(
                &self.mac,
                &self.ip,
                label,
                group == "lease" && self.expires == "infinity",
            )
        }
    }
    let mut rows = Vec::new();
    let mut client = RawClient::default();
    let mut field_column = None;
    for line in lines(raw) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let column = key.len();
        let (key, value) = (key.trim(), value.trim());
        if key == group && value.is_empty() {
            rows.extend(std::mem::take(&mut client).into_neighbor(group));
            field_column = Some(column + 4);
            continue;
        }
        if field_column != Some(column) {
            continue;
        }
        let field = match key {
            "mac" => &mut client.mac,
            "ip" => &mut client.ip,
            "name" => &mut client.name,
            "hostname" => &mut client.hostname,
            "expires" => &mut client.expires,
            _ => continue,
        };
        value.clone_into(field);
    }
    rows.extend(client.into_neighbor(group));
    rows
}

pub fn parse_reservations(raw: &[u8]) -> Vec<Neighbor> {
    lines(raw)
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let ("ip", "dhcp", "host", mac, address, None) = (
                columns.next()?,
                columns.next()?,
                columns.next()?,
                columns.next()?,
                columns.next()?,
                columns.next(),
            ) else {
                return None;
            };
            normalize_neighbor(mac, address, String::new(), false)
        })
        .collect()
}

fn confirmed_leases(reservations: &[Neighbor], mut leases: Vec<Neighbor>) -> Vec<Neighbor> {
    let configured: HashSet<_> = reservations
        .iter()
        .map(|value| (value.mac.as_str(), value.address.as_str()))
        .collect();
    for lease in &mut leases {
        lease.fixed &= configured.contains(&(lease.mac.as_str(), lease.address.as_str()));
    }
    leases
}

fn parse_flag(value: &str) -> Option<u8> {
    let (base, digits) = if let Some(rest) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        (16, rest)
    } else if let Some(rest) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        (2, rest)
    } else if let Some(rest) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        (8, rest)
    } else if let Some(rest) = value.strip_prefix('0')
        && !rest.is_empty()
    {
        (8, rest)
    } else {
        (10, value)
    };
    if digits.starts_with(['+', '-']) {
        return None;
    }
    u8::from_str_radix(&digits.replace('_', ""), base).ok()
}

pub fn parse_arp(raw: &[u8]) -> Vec<Neighbor> {
    lines(raw)
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let (address, "0x1", flags, mac, _, _, None) = (
                columns.next()?,
                columns.next()?,
                columns.next()?,
                columns.next()?,
                columns.next()?,
                columns.next()?,
                columns.next(),
            ) else {
                return None;
            };
            if parse_flag(flags)? & 0x02 == 0 {
                return None;
            }
            normalize_neighbor(mac, address, String::new(), false)
        })
        .collect()
}

fn merge_neighbors(lists: impl IntoIterator<Item = Vec<Neighbor>>) -> Vec<Neighbor> {
    let mut unique: BTreeMap<(String, String), Neighbor> = BTreeMap::new();
    let mut labels = HashMap::new();
    for mut row in lists.into_iter().flatten() {
        let key = (row.mac.clone(), row.address.clone());
        if let Some(previous) = unique.get(&key) {
            row.fixed |= previous.fixed;
            if row.label.is_empty() {
                row.label.clone_from(&previous.label);
            }
        }
        if !row.label.is_empty() {
            labels.insert(row.mac.clone(), row.label.clone());
        }
        unique.insert(key, row);
    }
    unique
        .into_values()
        .map(|mut row| {
            if row.label.is_empty()
                && let Some(label) = labels.get(&row.mac)
            {
                row.label.clone_from(label);
            }
            row
        })
        .collect()
}

pub fn parse_keenetic_segments(raw: &[u8]) -> Vec<KeeneticSegment> {
    let mut segments = Vec::new();
    let mut current = None;
    for line in lines(raw) {
        let line = line.trim();
        if line.to_ascii_lowercase().starts_with("interface, name =") {
            if let Some(fields) = current.take() {
                segments.extend(segment_from(&fields));
            }
            current = Some(HashMap::new());
            continue;
        }
        if let (Some(fields), Some((key, value))) = (&mut current, line.split_once(':'))
            && matches!(
                key,
                "id" | "type"
                    | "interface-name"
                    | "description"
                    | "system-name"
                    | "address"
                    | "mask"
                    | "state"
                    | "link"
                    | "security-level"
                    | "global"
            )
            && !fields.contains_key(key)
        {
            fields.insert(key.to_owned(), value.trim().to_owned());
        }
    }
    if let Some(fields) = current {
        segments.extend(segment_from(&fields));
    }
    segments
}

fn segment_from(fields: &HashMap<String, String>) -> Option<KeeneticSegment> {
    let field = |key| fields.get(key).map_or("", String::as_str);
    if field("id").is_empty() {
        return None;
    }
    let level = field("security-level");
    let kind = match field("type").to_ascii_lowercase().as_str() {
        "bridge" => "bridge",
        "vlan" | "gigabitethernetvlan" | "fastethernetvlan"
            if field("global") == "no" && matches!(level, "private" | "protected") =>
        {
            "l3"
        }
        _ => return None,
    };
    let mut name = clean_label(field("description"));
    if name.is_empty() {
        name = clean_label(field("interface-name"));
    }
    let address = field("address").parse::<IpAddr>().ok();
    let mask = field("mask")
        .parse::<IpAddr>()
        .ok()
        .and_then(|address| match address {
            IpAddr::V4(mask) => Some(mask),
            IpAddr::V6(mask) => mask.to_ipv4_mapped(),
        });
    let prefix = match (address, mask) {
        (Some(IpAddr::V4(address)), Some(mask)) => Ipv4Net::with_netmask(address, mask)
            .ok()
            .filter(|prefix| prefix.prefix_len() > 0)
            .map(|prefix| IpNet::V4(prefix.trunc())),
        _ => None,
    };
    let state = if field("state") == "up" && field("link") != "down" {
        "up"
    } else {
        "down"
    };
    Some(KeeneticSegment {
        id: clean_label(field("id")),
        name,
        system_name: field("system-name").into(),
        kind: kind.into(),
        address,
        prefix,
        state: state.into(),
        security: if matches!(level, "public" | "private" | "protected") {
            level.into()
        } else {
            String::new()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(group: &str, blocks: &[&[(&str, &str)]]) -> Vec<u8> {
        let mut output = String::new();
        for block in blocks {
            output.push_str(&format!("{group:>17}: \r\n"));
            for (key, value) in *block {
                let column = if *key == "foreign" { 25 } else { 21 };
                output.push_str(&format!("{key:>column$}: {value}\r\n"));
            }
        }
        output.into_bytes()
    }

    #[test]
    fn reservations_need_infinite_leases_and_keep_conflicting_arp() {
        let output = HashMap::from([
            (
                HOTSPOT,
                records(
                    "host",
                    &[
                        &[
                            ("mac", "02:00:00:00:00:AA"),
                            ("ip", "192.168.10.20"),
                            ("name", " Ноутбук "),
                            ("foreign", "Home"),
                        ],
                        &[
                            ("mac", "02:00:00:00:00:bb"),
                            ("ip", "192.168.10.21"),
                            ("hostname", "phone\x07"),
                        ],
                        &[("mac", "ff:ff:ff:ff:ff:ff"), ("ip", "0.0.0.0")],
                    ],
                ),
            ),
            (
                RESERVATIONS,
                b"configuration:\n\
                ip dhcp host 02-00-00-00-00-AA 192.168.10.20\n\
                ip dhcp host 02:00:00:00:00:cc 192.168.10.22\n\
                ip dhcp host 02:00:00:00:00:dd 192.168.10.23\n\
                ip dhcp host 02:00:00:00:00:ee 192.168.10.26\n\
                ip dhcp host 02:00:00:00:00:dd 192.168.10.24 extra\n\
                not-a-dhcp-record 02:00:00:00:00:ee 192.168.10.24\n!"
                    .to_vec(),
            ),
            (
                BINDINGS,
                records(
                    "lease",
                    &[
                        &[
                            ("mac", "02:00:00:00:00:aa"),
                            ("ip", "192.168.10.20"),
                            ("expires", "infinity"),
                        ],
                        &[
                            ("mac", "02:00:00:00:00:cc"),
                            ("ip", "192.168.10.22"),
                            ("expires", "infinity"),
                        ],
                        &[
                            ("mac", "02:00:00:00:00:dd"),
                            ("ip", "192.168.10.23"),
                            ("expires", "2400"),
                        ],
                        &[
                            ("mac", "02:00:00:00:00:ee"),
                            ("ip", "192.168.10.27"),
                            ("expires", "infinity"),
                        ],
                    ],
                ),
            ),
        ]);
        let result = inventory_with(
            |query, _| Ok(output[query].clone()),
            || Ok(b"IP address       HW type     Flags       HW address            Mask     Device\n\
                192.168.10.20    0x1         0x2         02:00:00:00:00:bb     *        br0\n\
                192.168.10.21    0x1         0x2         02:00:00:00:00:bb     *        br0\n\
                192.168.10.25    0x1         0x6         02:00:00:00:00:ff     *        br0\n\
                192.168.10.30    0x1         0x0         02:00:00:00:00:ee     *        br0\n".to_vec()),
            Instant::now() + Duration::from_secs(1),
        ).unwrap();
        let actual: Vec<_> = result
            .iter()
            .map(|row| {
                (
                    row.mac.as_str(),
                    row.address.as_str(),
                    row.label.as_str(),
                    row.fixed,
                )
            })
            .collect();
        assert_eq!(
            actual,
            [
                ("02:00:00:00:00:aa", "192.168.10.20", "Ноутбук", true),
                ("02:00:00:00:00:bb", "192.168.10.20", "phone", false),
                ("02:00:00:00:00:bb", "192.168.10.21", "phone", false),
                ("02:00:00:00:00:cc", "192.168.10.22", "", true),
                ("02:00:00:00:00:dd", "192.168.10.23", "", false),
                ("02:00:00:00:00:ee", "192.168.10.27", "", false),
                ("02:00:00:00:00:ff", "192.168.10.25", "", false),
            ]
        );
    }

    #[test]
    fn partial_inventory_and_output_caps() {
        let arp = || Ok(b"192.168.10.20 0x1 0x6 02:00:00:00:00:aa * br0\n".to_vec());
        let fail = |_: &str, _| Err(io::Error::other("unavailable"));
        let future = Instant::now() + Duration::from_secs(1);
        let fallback = inventory_with(fail, arp, future).unwrap();
        assert_eq!(fallback.len(), 1);
        assert!(!fallback[0].fixed);
        let missing = inventory_with(fail, || Err(io::Error::other("unavailable")), future);
        assert_eq!(
            missing.unwrap_err(),
            "инвентарь клиентов Keenetic недоступен"
        );
        let canceled = inventory_with(fail, arp, Instant::now());
        assert_eq!(canceled.unwrap_err(), "context deadline exceeded");
        let over = read_limited(io::repeat(0).take(OUTPUT_LIMIT + 1));
        assert_eq!(over.unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn bridge_and_internal_vlan_exclude_uplink() {
        let input = b"interface, name = Bridge0\n\
            id: Bridge0\n\
            type: Bridge\n\
            description: Guest network\n\
            interface-name: guest\n\
            system-name: br0\n\
            address: 192.168.1.1\n\
            mask: 255.255.255.0\n\
            state: up\n\
            link: up\n\
            security-level: private\n\
            interface, name = ISP\n\
            id: GigabitEthernet1/Vlan2\n\
            type: Vlan\n\
            global: yes\n\
            security-level: public\n\
            interface, name = LANVlan\n\
            id: GigabitEthernet1/Vlan3\n\
            type: GigabitEthernetVlan\n\
            global: no\n\
            security-level: protected\n\
            interface-name: segment\n\
            address: 192.168.63.33\n\
            mask: 255.255.255.240\n\
            state: up\n\
            link: down";
        let rows = parse_keenetic_segments(input);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "Guest network");
        assert_eq!(rows[0].kind, "bridge");
        assert_eq!(rows[0].state, "up");
        assert_eq!(rows[0].system_name, "br0");
        assert_eq!(rows[0].prefix.unwrap().to_string(), "192.168.1.0/24");
        assert_eq!(rows[1].name, "segment");
        assert_eq!(rows[1].kind, "l3");
        assert_eq!(rows[1].state, "down");
        assert_eq!(rows[1].prefix.unwrap().to_string(), "192.168.63.32/28");
    }
}
