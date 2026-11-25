use std::{
    collections::HashMap,
    ffi::CStr,
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
    ptr,
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use routehub_policy::{
    DeviceStatus, KeeneticSegment, Neighbor, Plan as Policy, read_keenetic_inventory,
    read_keenetic_segments,
};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    config::{Plan, interface_name},
    telemetry::default_wan,
};

const CACHE_DURATION: Duration = Duration::from_secs(5);
const UNCAPTURED_REASON: &str = "Сегмент находится вне действующего перехвата RouteHub.";

#[derive(Default)]
pub struct TopologyCache {
    cached: Mutex<Option<CachedTopology>>,
}

struct CachedTopology {
    key: Capture,
    fetched: Instant,
    snapshot: Arc<TopologySnapshot>,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct Capture {
    host: String,
    network: Option<(String, String)>,
    active: bool,
}

impl TopologyCache {
    pub async fn snapshot(&self, plan: &Plan, capture_active: bool) -> Arc<TopologySnapshot> {
        let key = Capture {
            host: plan.panel_host.clone(),
            network: plan
                .transparent
                .as_ref()
                .map(|lan| (lan.interface.clone(), lan.source.clone())),
            active: capture_active,
        };
        let mut cached = self.cached.lock().await;
        if let Some(current) = cached
            .as_ref()
            .filter(|item| item.key == key && item.fetched.elapsed() < CACHE_DURATION)
        {
            return Arc::clone(&current.snapshot);
        }
        let Inventory {
            reported,
            kernel,
            neighbors,
        } = tokio::task::spawn_blocking(keenetic_snapshot)
            .await
            .unwrap_or_default();
        let fetched_at = Utc::now();
        let segments = network_segments(&key, reported, kernel);
        let devices = topology_devices(
            neighbors.as_deref().unwrap_or_default(),
            &segments,
            fetched_at,
        );
        let snapshot = Arc::new(TopologySnapshot {
            segments,
            ssids: [],
            devices,
            fetched_at,
            neighbors,
        });
        *cached = Some(CachedTopology {
            key,
            fetched: Instant::now(),
            snapshot: Arc::clone(&snapshot),
        });
        snapshot
    }

    pub async fn device_list(
        &self,
        plan: &Plan,
        policy: &Policy,
        allowed: IpNet,
        capture_active: bool,
    ) -> Result<DevicesSnapshot, &'static str> {
        let network = plan
            .transparent
            .as_ref()
            .and_then(|lan| lan.source.parse::<IpNet>().ok())
            .unwrap_or(allowed);
        let mut result = DevicesSnapshot {
            configured: policy.devices().to_vec(),
            neighbors: Vec::new(),
        };
        if !network.addr().is_loopback() {
            let inventory = self.snapshot(plan, capture_active).await;
            let neighbors = inventory
                .neighbors
                .as_deref()
                .ok_or("Список устройств Keenetic недоступен")?;
            result.neighbors = neighbors
                .iter()
                .filter(|neighbor| {
                    neighbor.address != plan.panel_host
                        && neighbor
                            .address
                            .parse::<IpAddr>()
                            .is_ok_and(|address| network.contains(&address))
                })
                .cloned()
                .collect();
        }
        Ok(result)
    }
}

#[derive(Default)]
struct Inventory {
    reported: Vec<KeeneticSegment>,
    kernel: Vec<Segment>,
    neighbors: Option<Vec<Neighbor>>,
}

fn keenetic_snapshot() -> Inventory {
    let (reported, kernel) = if Path::new("/bin/ndmc").is_file() {
        (
            read_keenetic_segments().unwrap_or_default(),
            kernel_networks(),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    Inventory {
        reported,
        kernel,
        neighbors: read_keenetic_inventory().ok(),
    }
}

#[derive(Serialize)]
pub struct DevicesSnapshot {
    configured: Vec<DeviceStatus>,
    neighbors: Vec<Neighbor>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologySnapshot {
    segments: Vec<Segment>,
    ssids: [(); 0],
    devices: Vec<TopologyDevice>,
    fetched_at: DateTime<Utc>,
    #[serde(skip)]
    neighbors: Option<Vec<Neighbor>>,
}

impl TopologySnapshot {
    pub fn neighbors(&self) -> &[Neighbor] {
        self.neighbors.as_deref().unwrap_or_default()
    }

    pub(crate) fn captured_device(&self, mac: &str, iface: &str, source: IpNet) -> bool {
        self.devices.iter().any(|device| {
            device.id == mac
                && device.segment_id == iface
                && device.addresses.iter().any(|address| {
                    address
                        .addr
                        .parse::<IpAddr>()
                        .is_ok_and(|ip| source.contains(&ip))
                })
        })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    id: String,
    name: String,
    iface: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    vlan: Option<i32>,
    #[serde(serialize_with = "prefixes")]
    v4: Vec<IpNet>,
    #[serde(serialize_with = "prefixes")]
    v6: Vec<IpNet>,
    ssid_ids: [(); 0],
    state: String,
    routable: Routable,
    isolation: String,
    #[serde(skip)]
    addresses: Vec<IpAddr>,
}

fn prefixes<S: serde::Serializer>(prefixes: &[IpNet], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(prefixes.iter().map(ToString::to_string))
}

#[derive(Clone, Serialize)]
struct Routable {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl Segment {
    fn new(iface: &str, kind: &str, state: &str) -> Self {
        Self {
            id: iface.into(),
            name: iface.into(),
            iface: iface.into(),
            kind: kind.into(),
            vlan: None,
            v4: Vec::new(),
            v6: Vec::new(),
            ssid_ids: [],
            state: state.into(),
            routable: Routable {
                available: false,
                reason: Some(UNCAPTURED_REASON),
            },
            isolation: "Изоляция по правилам KeeneticOS".into(),
            addresses: Vec::new(),
        }
    }

    fn add_address(&mut self, addr: IpAddr, net: IpNet) {
        self.addresses.push(addr);
        if addr.is_ipv4() {
            self.v4.push(net);
        } else {
            self.v6.push(net);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyDevice {
    id: String,
    mac: String,
    hostname: String,
    vendor: &'static str,
    kind: &'static str,
    segment_id: String,
    addresses: Vec<DeviceAddress>,
    binding: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding_note: Option<&'static str>,
    online: bool,
    connection_known: bool,
    last_seen: DateTime<Utc>,
}

#[derive(Serialize)]
struct DeviceAddress {
    addr: String,
    family: &'static str,
    source: &'static str,
    confirmed: bool,
}

fn network_segments(
    capture: &Capture,
    reported: Vec<KeeneticSegment>,
    kernel: Vec<Segment>,
) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::with_capacity(reported.len() + 1);
    for info in reported {
        let mut segment = kernel
            .iter()
            .find(|iface| {
                (!info.system_name.is_empty() && iface.iface == info.system_name)
                    || info
                        .address
                        .is_some_and(|addr| iface.addresses.contains(&addr))
            })
            .cloned()
            .unwrap_or_else(|| {
                let mut candidate = Segment::new(&info.id, &info.kind, &info.state);
                candidate.iface.clear();
                candidate
            });
        if info.kind == "l3" && segment.iface.is_empty() {
            continue;
        }
        segment.state = info.state;
        segment.kind = info.kind;
        if !info.name.is_empty() {
            segment.name = info.name;
        }
        if !info.security.is_empty() {
            segment.isolation = format!("Уровень доступа KeeneticOS: {}", info.security);
        }
        if let (Some(prefix @ IpNet::V4(_)), Some(addr)) = (info.prefix, info.address)
            && !segment.v4.contains(&prefix)
        {
            segment.add_address(addr, prefix);
        }
        if !segments.iter().any(|other| other.id == segment.id) {
            segments.push(segment);
        }
    }
    // An additional WAN VLAN need not own the default route. Keep kernel-only bridges.
    for iface in kernel {
        if iface.kind == "bridge"
            && !(iface.v4.is_empty() && iface.v6.is_empty())
            && !segments.iter().any(|segment| segment.id == iface.id)
        {
            segments.push(iface);
        }
    }
    if let Some((iface, source)) = &capture.network {
        let source = source.parse::<IpNet>().ok();
        let position = segments
            .iter()
            .position(|segment| segment.iface == *iface)
            .or_else(|| {
                segments.iter().position(|segment| {
                    segment.iface.is_empty() && source.is_some_and(|net| segment.v4.contains(&net))
                })
            })
            .unwrap_or_else(|| {
                let state = if capture.active { "up" } else { "down" };
                segments.push(Segment::new(iface, "l3", state));
                segments.len() - 1
            });
        let segment = &mut segments[position];
        segment.id.clone_from(iface);
        segment.iface.clone_from(iface);
        if let Some(net) = source
            && !segment.v4.contains(&net)
        {
            segment.v4.push(net);
        }
        if let Ok(address) = capture.host.parse() {
            segment.addresses.push(address);
        }
        if capture.active {
            segment.routable = Routable {
                available: true,
                reason: None,
            };
        }
        segments.swap(0, position);
    }
    segments
}

fn topology_devices(
    neighbors: &[Neighbor],
    segments: &[Segment],
    fetched_at: DateTime<Utc>,
) -> Vec<TopologyDevice> {
    let mut devices: Vec<TopologyDevice> = Vec::new();
    let mut positions = HashMap::new();
    for neighbor in neighbors {
        let Ok(address) = neighbor.address.parse::<IpAddr>() else {
            continue;
        };
        let Some(segment) = find_segment(address, segments) else {
            continue;
        };
        let index = *positions.entry(neighbor.mac.as_str()).or_insert_with(|| {
            let index = devices.len();
            devices.push(TopologyDevice {
                id: neighbor.mac.clone(),
                mac: neighbor.mac.clone(),
                hostname: if neighbor.label.is_empty() {
                    neighbor.mac.clone()
                } else {
                    neighbor.label.clone()
                },
                vendor: "",
                kind: "unknown",
                segment_id: segment.into(),
                addresses: Vec::new(),
                binding: "observed",
                binding_note: None,
                online: false,
                connection_known: false,
                last_seen: fetched_at,
            });
            index
        });
        let device = &mut devices[index];
        if segment != device.segment_id {
            device.segment_id.clear();
            device.binding = "ambiguous";
            device.binding_note = Some("В инвентаре есть записи одного MAC из разных сегментов.");
        }
        let source = if neighbor.fixed {
            if device.binding != "ambiguous" {
                device.binding = "confirmed";
            }
            "static"
        } else {
            "keenetic"
        };
        device.addresses.push(DeviceAddress {
            addr: neighbor.address.clone(),
            family: "v4",
            source,
            confirmed: neighbor.fixed,
        });
    }
    devices
}

fn find_segment(address: IpAddr, segments: &[Segment]) -> Option<&str> {
    if !address.is_ipv4()
        || segments
            .iter()
            .any(|segment| segment.addresses.contains(&address))
    {
        return None;
    }
    let mut selected = None;
    let mut best_bits = None;
    for segment in segments {
        for prefix in segment.v4.iter().filter(|prefix| prefix.contains(&address)) {
            let bits = prefix.prefix_len();
            if best_bits.is_none_or(|best| bits > best) {
                best_bits = Some(bits);
                selected = Some(segment.id.as_str());
            } else if best_bits == Some(bits) && selected != Some(segment.id.as_str()) {
                selected = None;
            }
        }
    }
    selected
}

fn kernel_networks() -> Vec<Segment> {
    let routes = fs::read_to_string("/proc/net/route").unwrap_or_default();
    let wan = default_wan(&routes);
    let Some(interfaces) = InterfaceList::load() else {
        return Vec::new();
    };
    let mut positions = HashMap::new();
    let mut segments: Vec<Segment> = Vec::new();
    let mut next = interfaces.0;
    while !next.is_null() {
        // SAFETY: the head and all next pointers come from a live getifaddrs list.
        let record = unsafe { &*next };
        next = record.ifa_next;
        if record.ifa_name.is_null() || record.ifa_flags & libc::IFF_LOOPBACK as u32 != 0 {
            continue;
        }
        // SAFETY: getifaddrs guarantees a NUL-terminated ifa_name for each entry.
        let Ok(name) = unsafe { CStr::from_ptr(record.ifa_name) }.to_str() else {
            continue;
        };
        if wan == Some(name) || !interface_name(name) {
            continue;
        }
        let position = positions.entry(name).or_insert_with(|| {
            let state = if record.ifa_flags & libc::IFF_UP as u32 != 0 {
                "up"
            } else {
                "down"
            };
            let segment = if Path::new("/sys/class/net")
                .join(name)
                .join("bridge")
                .exists()
            {
                Segment::new(name, "bridge", state)
            } else if let Ok(raw) = fs::read_to_string(Path::new("/proc/net/vlan").join(name)) {
                let mut segment = Segment::new(name, "l3", state);
                segment.vlan = vlan_id(&raw);
                segment
            } else {
                return None;
            };
            let index = segments.len();
            segments.push(segment);
            Some(index)
        });
        if let Some(position) = position
            && let Some((addr, prefix)) = interface_address(record)
            && global_unicast(addr)
        {
            segments[*position].add_address(addr, prefix);
        }
    }
    segments
}

fn vlan_id(raw: &str) -> Option<i32> {
    raw.split_once("VID:")?
        .1
        .split_whitespace()
        .next()?
        .parse::<i32>()
        .ok()
        .filter(|vid| *vid != 0)
}

// Owns the list allocated by libc until all borrowed interface records have been consumed.
struct InterfaceList(*mut libc::ifaddrs);

impl InterfaceList {
    fn load() -> Option<Self> {
        let mut head = ptr::null_mut();
        // SAFETY: libc receives a writable pointer to a suitably aligned list pointer.
        let result = unsafe { libc::getifaddrs(&mut head) };
        (result == 0).then(|| Self(head))
    }
}

impl Drop for InterfaceList {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this is the original head, and only its owner calls freeifaddrs.
            unsafe { libc::freeifaddrs(self.0) };
        }
    }
}

fn interface_address(record: &libc::ifaddrs) -> Option<(IpAddr, IpNet)> {
    if record.ifa_addr.is_null() || record.ifa_netmask.is_null() {
        return None;
    }
    // SAFETY: both non-null sockaddr pointers belong to the live getifaddrs record.
    let family = unsafe { (*record.ifa_addr).sa_family as i32 };
    // SAFETY: each family check determines the actual layout of the corresponding sockaddr.
    unsafe {
        let mask_family = (*record.ifa_netmask).sa_family as i32;
        if family != mask_family {
            return None;
        }
        match family {
            libc::AF_INET => {
                let address = &*record.ifa_addr.cast::<libc::sockaddr_in>();
                let mask = &*record.ifa_netmask.cast::<libc::sockaddr_in>();
                let address = Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes());
                let mask = Ipv4Addr::from(mask.sin_addr.s_addr.to_ne_bytes());
                Some((
                    address.into(),
                    Ipv4Net::with_netmask(address, mask).ok()?.trunc().into(),
                ))
            }
            libc::AF_INET6 => {
                let address = &*record.ifa_addr.cast::<libc::sockaddr_in6>();
                let mask = &*record.ifa_netmask.cast::<libc::sockaddr_in6>();
                let address = Ipv6Addr::from(address.sin6_addr.s6_addr);
                let mask = Ipv6Addr::from(mask.sin6_addr.s6_addr);
                Some((
                    address.into(),
                    Ipv6Net::with_netmask(address, mask).ok()?.trunc().into(),
                ))
            }
            _ => None,
        }
    }
}

fn global_unicast(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(addr) => {
            !addr.is_unspecified()
                && !addr.is_loopback()
                && !addr.is_multicast()
                && !addr.is_broadcast()
                && !addr.is_link_local()
        }
        IpAddr::V6(addr) => {
            !addr.is_unspecified()
                && !addr.is_loopback()
                && !addr.is_multicast()
                && !addr.is_unicast_link_local()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_segment(name: &str, prefix: &str) -> Segment {
        let mut segment = Segment::new(name, "bridge", "up");
        segment.v4.push(prefix.parse().unwrap());
        segment
    }

    fn test_neighbor(addr: &str, fixed: bool) -> Neighbor {
        Neighbor {
            address: addr.into(),
            mac: "02:00:00:00:00:01".into(),
            label: "PC".into(),
            fixed,
        }
    }

    #[test]
    fn capture_precedes_guest_topology_and_reports_real_routability() {
        let capture = Capture {
            host: "192.168.10.1".into(),
            network: Some(("bridge0".into(), "192.168.10.0/24".into())),
            active: true,
        };
        let kernel = vec![
            test_segment("guest", "192.168.20.0/24"),
            test_segment("bridge0", "192.168.10.0/24"),
        ];
        let segments = network_segments(&capture, vec![], kernel);
        assert_eq!(segments[0].id, "bridge0");
        assert!(segments[0].routable.available);
        assert!(!segments[1].routable.available);
        assert_eq!(
            find_segment("192.168.10.1".parse().unwrap(), &segments),
            None
        );
        let value = serde_json::to_value(&segments[0]).unwrap();
        assert_eq!(value["v4"], serde_json::json!(["192.168.10.0/24"]));
        assert_eq!(value["ssidIds"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn legacy_inventory_filters_to_capture_and_reports_unavailable() {
        let plan = Plan {
            panel_host: "192.168.20.1".into(),
            transparent: Some(crate::config::Transparent {
                interface: "bridge1".into(),
                source: "192.168.20.0/24".into(),
                mode: String::new(),
                port: 18954,
            }),
            ..Plan::default()
        };
        let allowed = "192.168.0.0/16".parse().unwrap();
        let policy = routehub_policy::compile(&Default::default(), &Default::default()).unwrap();
        let capture = Capture {
            host: plan.panel_host.clone(),
            network: Some(("bridge1".into(), "192.168.20.0/24".into())),
            active: true,
        };
        let build = |neighbors| CachedTopology {
            key: capture.clone(),
            fetched: Instant::now(),
            snapshot: Arc::new(TopologySnapshot {
                segments: Vec::new(),
                devices: Vec::new(),
                ssids: [],
                fetched_at: Utc::now(),
                neighbors,
            }),
        };
        let cache = TopologyCache {
            cached: Mutex::new(Some(build(Some(vec![
                test_neighbor("192.168.20.1", true),
                test_neighbor("192.168.20.2", false),
                test_neighbor("192.168.30.2", false),
            ])))),
        };
        let devices = cache
            .device_list(&plan, &policy, allowed, true)
            .await
            .unwrap();
        let value = serde_json::to_value(devices).unwrap();
        assert_eq!(value["configured"], serde_json::json!([]));
        assert_eq!(
            value["neighbors"],
            serde_json::json!([{
                "address":"192.168.20.2", "mac":"02:00:00:00:00:01", "label":"PC", "fixed":false
            }])
        );
        *cache.cached.lock().await = Some(build(None));
        assert_eq!(
            cache.device_list(&plan, &policy, allowed, true).await.err(),
            Some("Список устройств Keenetic недоступен")
        );
    }

    #[test]
    fn device_matches_most_specific_segment_and_conflicts_are_not_confirmed() {
        let segments = [
            test_segment("home", "192.168.0.0/16"),
            test_segment("guest", "192.168.10.0/24"),
        ];
        let now = Utc::now();
        let neighbors = [test_neighbor("192.168.10.5", true)];
        let devices = topology_devices(&neighbors, &segments, now);
        assert_eq!(devices[0].segment_id, "guest");
        assert_eq!(devices[0].binding, "confirmed");
        let neighbors = [
            test_neighbor("192.168.10.5", true),
            test_neighbor("192.168.20.5", false),
        ];
        let devices = topology_devices(&neighbors, &segments, now);
        assert_eq!(devices[0].segment_id, "");
        assert_eq!(devices[0].binding, "ambiguous");
        let ambiguous = [
            test_segment("home", "192.168.10.0/24"),
            test_segment("guest", "192.168.10.0/24"),
        ];
        assert!(topology_devices(&neighbors, &ambiguous, now).is_empty());
    }
}
