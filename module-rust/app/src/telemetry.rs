use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::time::{MissedTickBehavior, interval};

use crate::{
    config::interface_name,
    storage::{Capacity, disk, read_proc_kib},
};

const RESOURCE_INTERVAL: Duration = Duration::from_secs(2);
const RESOURCE_WINDOW: Duration = Duration::from_secs(60);
const RESOURCE_LIMIT: usize = 31;
const TRAFFIC_INTERVAL: Duration = Duration::from_secs(5);
const TRAFFIC_WINDOW: Duration = Duration::from_secs(3600);
const TRAFFIC_LIMIT: usize = 721;

pub struct Telemetry {
    data_dir: PathBuf,
    xray_pid: AtomicU32,
    resources: Mutex<Option<ResourceSnapshot>>,
    traffic: Mutex<TrafficState>,
}

impl Telemetry {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            xray_pid: AtomicU32::new(0),
            resources: Mutex::new(None),
            traffic: Mutex::new(TrafficState::default()),
        }
    }

    pub fn set_xray_pid(&self, pid: Option<u32>) {
        self.xray_pid
            .store(pid.unwrap_or_default(), Ordering::Relaxed);
    }

    pub fn resources(&self) -> Option<ResourceSnapshot> {
        self.resources
            .lock()
            .expect("resource sampler lock")
            .clone()
    }

    pub fn traffic(&self) -> TrafficSnapshot {
        self.traffic
            .lock()
            .expect("traffic sampler lock")
            .snapshot
            .clone()
    }

    pub async fn run(self: Arc<Self>) {
        let mut resources = interval(RESOURCE_INTERVAL);
        let mut traffic = interval(TRAFFIC_INTERVAL);
        resources.set_missed_tick_behavior(MissedTickBehavior::Skip);
        traffic.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut previous_cpu = None;
        loop {
            tokio::select! {
                _ = resources.tick() => {
                    self.record_resources(&mut previous_cpu);
                }
                _ = traffic.tick() => {
                    let next = read_wan();
                    self.traffic.lock().expect("traffic sampler lock")
                        .record(Instant::now(), Utc::now(), next);
                }
            }
        }
    }

    fn record_resources(&self, previous_cpu: &mut Option<CpuTotals>) {
        let at = Utc::now();
        let next_cpu = fs::read_to_string("/proc/stat")
            .ok()
            .and_then(|data| cpu_totals(&data));
        let cpu = cpu_percent(*previous_cpu, next_cpu);
        *previous_cpu = next_cpu;
        let (ram, shared_ram) =
            ram_capacity(&fs::read_to_string("/proc/meminfo").unwrap_or_default());
        let disk = disk(&self.data_dir);
        let route_hub_rss = process_rss(Path::new("/proc/self/status"));
        let pid = self.xray_pid.load(Ordering::Relaxed);
        let xray_rss = (pid > 0)
            .then(|| process_rss(&Path::new("/proc").join(pid.to_string()).join("status")))
            .flatten()
            .filter(|_| self.xray_pid.load(Ordering::Relaxed) == pid);
        let sample = ResourceSample {
            at,
            cpu,
            ram: ram
                .as_ref()
                .map(|ram| ram.used as f64 / ram.total as f64 * 100.0),
        };
        let mut snapshot = self.resources.lock().expect("resource sampler lock");
        let mut samples = snapshot.take().map(|old| old.samples).unwrap_or_default();
        push_bounded(&mut samples, RESOURCE_LIMIT, sample, |sample| {
            (at - sample.at) > chrono::TimeDelta::seconds(RESOURCE_WINDOW.as_secs() as i64)
        });
        *snapshot = Some(ResourceSnapshot {
            at,
            window_sec: RESOURCE_WINDOW.as_secs(),
            interval_sec: RESOURCE_INTERVAL.as_secs(),
            cpu,
            ram,
            shared_ram,
            disk,
            route_hub_rss,
            xray_rss,
            samples,
        });
    }
}

fn process_rss(path: &Path) -> Option<u64> {
    read_proc_kib(&fs::read_to_string(path).ok()?, "VmRSS")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    at: DateTime<Utc>,
    window_sec: u64,
    interval_sec: u64,
    cpu: Option<f64>,
    ram: Option<Capacity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shared_ram: Option<u64>,
    disk: Option<Capacity>,
    route_hub_rss: Option<u64>,
    xray_rss: Option<u64>,
    samples: VecDeque<ResourceSample>,
}

#[derive(Clone, Serialize)]
struct ResourceSample {
    at: DateTime<Utc>,
    cpu: Option<f64>,
    ram: Option<f64>,
}

#[derive(Clone, Copy)]
struct CpuTotals {
    busy: u64,
    idle: u64,
}

fn cpu_totals(data: &str) -> Option<CpuTotals> {
    let mut fields = data.lines().next()?.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let mut result = CpuTotals { busy: 0, idle: 0 };
    // Linux already includes guest CPU in user/nice.
    for index in 0..8 {
        let value = fields.next()?.parse().ok()?;
        let total = if matches!(index, 3 | 4) {
            &mut result.idle
        } else {
            &mut result.busy
        };
        *total = total.checked_add(value)?;
    }
    Some(result)
}

fn cpu_percent(previous: Option<CpuTotals>, next: Option<CpuTotals>) -> Option<f64> {
    let (previous, next) = (previous?, next?);
    let busy = next.busy.checked_sub(previous.busy)?;
    let idle = next.idle.checked_sub(previous.idle)?;
    let total = busy as f64 + idle as f64;
    (total > 0.0).then(|| busy as f64 / total * 100.0)
}

fn ram_capacity(data: &str) -> (Option<Capacity>, Option<u64>) {
    let (Some(total), Some(available)) = (
        read_proc_kib(data, "MemTotal"),
        read_proc_kib(data, "MemAvailable"),
    ) else {
        return (None, None);
    };
    if total == 0 || available > total {
        return (None, None);
    }
    (
        Some(Capacity {
            used: total - available,
            total,
            available,
        }),
        read_proc_kib(data, "Shmem"),
    )
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    interface: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_mbit: Option<u32>,
    samples: VecDeque<TrafficSample>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrafficSample {
    at: DateTime<Utc>,
    receive_mbit: f64,
    send_mbit: f64,
}

#[derive(Default)]
struct TrafficState {
    previous: Option<(Instant, WanCounters)>,
    snapshot: TrafficSnapshot,
}

struct WanCounters {
    interface: String,
    receive: u64,
    send: u64,
    link: Option<u32>,
}

impl TrafficState {
    fn record(&mut self, now: Instant, at: DateTime<Utc>, next: Option<WanCounters>) {
        let Some(next) = next else {
            self.previous = None;
            self.snapshot = TrafficSnapshot::default();
            return;
        };
        let previous = self.previous.as_ref().filter(|(_, previous)| {
            next.interface == previous.interface
                && next.receive >= previous.receive
                && next.send >= previous.send
        });
        if let Some((last, previous)) = previous {
            let elapsed = now.saturating_duration_since(*last).as_secs_f64();
            if elapsed > 0.0 {
                let scale = 8.0 / (elapsed * 1_000_000.0);
                let sample = TrafficSample {
                    at,
                    receive_mbit: (next.receive - previous.receive) as f64 * scale,
                    send_mbit: (next.send - previous.send) as f64 * scale,
                };
                push_bounded(
                    &mut self.snapshot.samples,
                    TRAFFIC_LIMIT,
                    sample,
                    |sample| {
                        (at - sample.at)
                            > chrono::TimeDelta::seconds(TRAFFIC_WINDOW.as_secs() as i64)
                    },
                );
            }
        } else {
            self.snapshot.samples.clear();
            self.snapshot.interface = Some(next.interface.clone());
            self.snapshot.started_at = Some(at);
        }
        self.snapshot.link_mbit = next.link;
        self.previous = Some((now, next));
    }
}

fn push_bounded<T>(
    samples: &mut VecDeque<T>,
    limit: usize,
    value: T,
    mut expired: impl FnMut(&T) -> bool,
) {
    while samples.len() >= limit || samples.front().is_some_and(&mut expired) {
        samples.pop_front();
    }
    samples.push_back(value);
}

pub fn default_wan(data: &str) -> Option<&str> {
    let mut selected = None;
    let mut best = u32::MAX;
    for line in data.lines() {
        let mut fields = line.split_whitespace();
        let (
            Some(name),
            Some(dest),
            Some(_),
            Some(flags),
            Some(_),
            Some(_),
            Some(metric),
            Some(mask),
        ) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        )
        else {
            continue;
        };
        if dest != "00000000" || mask != "00000000" || name == "lo" || !interface_name(name) {
            continue;
        }
        let (Ok(flags), Ok(metric)) = (u16::from_str_radix(flags, 16), metric.parse::<u32>())
        else {
            continue;
        };
        if flags & 0x201 == 1 && (selected.is_none() || metric < best) {
            selected = Some(name);
            best = metric;
        }
    }
    selected
}

fn interface_counters(data: &str, interface: &str) -> Option<(u64, u64)> {
    let raw = data
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, raw)| (name.trim() == interface).then_some(raw))?;
    let mut fields = raw.split_whitespace();
    let receive = fields.next()?.parse().ok()?;
    let send = fields.nth(7)?.parse().ok()?;
    fields.nth(6)?;
    Some((receive, send))
}

fn read_wan() -> Option<WanCounters> {
    let routes = fs::read_to_string("/proc/net/route").ok()?;
    let interface = default_wan(&routes)?;
    let (receive, send) =
        interface_counters(&fs::read_to_string("/proc/net/dev").ok()?, interface)?;
    let link = fs::read_to_string(Path::new("/sys/class/net").join(interface).join("speed"))
        .ok()
        .and_then(|data| data.trim().parse().ok())
        .filter(|speed| *speed > 0);
    Some(WanCounters {
        interface: interface.into(),
        receive,
        send,
        link,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_guest_time_is_already_in_totals() {
        let before = cpu_totals("cpu 100 5 10 900 10 0 0 0 100 100");
        let after = cpu_totals("cpu 110 5 10 930 10 0 0 0 1100 100");
        assert_eq!(cpu_percent(before, after), Some(25.0));
        assert_eq!(cpu_percent(after, before), None);
        assert_eq!(cpu_percent(after, after), None);
        let (ram, shared) = ram_capacity("MemTotal: 1000 kB\nMemAvailable: 500 kB\nShmem: 75 kB");
        assert_eq!(ram.unwrap().used, 500 * 1024);
        assert_eq!(shared, Some(75 * 1024));
    }

    #[test]
    fn wan_selection_and_counter_rollover() {
        let routes = "wan0 00000000 XXXXXXXX 0003 0 0 100 00000000\nwan1 00000000 XXXXXXXX 0001 0 0 5 00000000\nwan2 00000000 XXXXXXXX 0201 0 0 1 00000000";
        assert_eq!(default_wan(routes), Some("wan1"));
        assert_eq!(
            interface_counters(" w: 1 2 2 2 2 2 2 2 9 2 2 2 2 2 2 2\n", "w"),
            Some((1, 9))
        );
        assert_eq!(interface_counters(" w: 1 2 2 2 2 2 2 2 9\n", "w"), None);

        let mut state = TrafficState::default();
        let now = Instant::now();
        let at = Utc::now();
        let counters = |receive, send| {
            Some(WanCounters {
                interface: "wan1".into(),
                receive,
                send,
                link: Some(1000),
            })
        };
        state.record(now, at, counters(1000, 1000));
        state.record(
            now + Duration::from_secs(5),
            at,
            counters(626_000, 1_251_000),
        );
        assert_eq!(state.snapshot.samples[0].receive_mbit, 1.0);
        assert_eq!(state.snapshot.samples[0].send_mbit, 2.0);
        state.record(now + Duration::from_secs(10), at, counters(1, 1));
        assert!(state.snapshot.samples.is_empty());
        state.record(now + Duration::from_secs(15), at, None);
        assert_eq!(
            serde_json::to_value(state.snapshot).unwrap(),
            serde_json::json!({"samples":[]})
        );
    }
}
