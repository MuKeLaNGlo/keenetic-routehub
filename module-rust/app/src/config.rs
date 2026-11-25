use crate::geo_cache::GeoCache;
use anyhow::{Context, Result, bail, ensure};
use ipnet::IpNet;
use routehub_policy::{
    Binding, Config as PolicyConfig, Device, GameRoute, NamedSet, Options, Plan as Compiled, Rule,
};
use routehub_subscriptions::{Profile, Subscription};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
};

const MAX_PLAN_BYTES: u64 = 4 << 20;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Plan {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub panel_host: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub panel_network: String,
    pub panel_port: u16,
    #[serde(rename = "socksPort")]
    pub socks_port: u16,
    pub zapret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transparent: Option<Transparent>,
    pub profiles: Vec<Profile>,
    pub rules: Vec<Rule>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub default_target: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<Device>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zapret_services: Option<ZapretServices>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub geo_sources: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub named_sets: Vec<NamedSet>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub games: Vec<GamePreset>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub saved_checks: Vec<crate::saved_checks::SavedCheck>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subscriptions: Vec<Subscription>,
    #[serde(skip)]
    pub health_target: String,
}

impl Default for Plan {
    fn default() -> Self {
        Self {
            panel_host: "127.0.0.1".into(),
            panel_network: String::new(),
            panel_port: 18952,
            socks_port: 18953,
            zapret: false,
            transparent: None,
            profiles: Vec::new(),
            rules: Vec::new(),
            default_target: "direct".into(),
            devices: Vec::new(),
            zapret_services: None,
            geo_sources: Vec::new(),
            named_sets: Vec::new(),
            games: Vec::new(),
            saved_checks: Vec::new(),
            subscriptions: Vec::new(),
            health_target: String::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Transparent {
    pub interface: String,
    pub source: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ZapretServices {
    pub youtube: bool,
    pub discord: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GamePreset {
    pub id: String,
    pub name: String,
    pub signature_sources: Vec<String>,
    pub version: String,
    pub confidence: String,
    pub families: Vec<String>,
    pub scenarios: Vec<String>,
    pub exclusions: Vec<String>,
    pub enabled: bool,
    pub scope: GameScope,
    pub route_action: GameAction,
    pub priority: String,
    pub signatures: Vec<GameSignature>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GameScope {
    pub segment_ids: Vec<String>,
    pub device_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GameAction {
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub uplink_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GameSignature {
    pub destination: String,
    pub protocol: String,
    pub port: u16,
    pub category: String,
}

pub fn valid_domain(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

pub fn interface_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 15
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

impl Plan {
    pub fn load(path: &Path) -> Result<(Self, GeoCache)> {
        let file = File::open(path)?;
        let meta = file.metadata()?;
        ensure!(
            meta.is_file() && meta.len() <= MAX_PLAN_BYTES,
            "план должен быть обычным файлом размером не более 4 МиБ"
        );
        let mut plan = serde_json::from_reader::<_, Self>(file.take(MAX_PLAN_BYTES + 1))?;
        let geo = GeoCache::load(path.parent().unwrap_or(Path::new(".")), &plan.geo_sources)?;
        plan.normalize(&geo)?;
        Ok((plan, geo))
    }

    pub fn normalize(&mut self, geo: &GeoCache) -> Result<()> {
        if self.panel_host.is_empty() {
            self.panel_host = "127.0.0.1".into();
        }
        if self.default_target.is_empty() {
            self.default_target = "direct".into();
        }
        ensure!(
            self.panel_port != 0 && self.socks_port != 0 && self.panel_port != self.socks_port,
            "панели и SOCKS нужны разные ненулевые порты"
        );
        let host = self
            .panel_host
            .parse::<Ipv4Addr>()
            .ok()
            .filter(|h| h.is_loopback() || h.is_private())
            .context("panelHost должен быть loopback или частным адресом IPv4")?;
        let panel_net = if host.is_private() {
            let network = self
                .panel_network
                .parse::<ipnet::Ipv4Net>()
                .ok()
                .filter(|n| {
                    n.addr() == n.network()
                        && n.addr().is_private()
                        && n.prefix_len() >= 8
                        && n.contains(&host)
                })
                .context("для LAN-панели укажите её частную подсеть panelNetwork")?;
            Some(network)
        } else {
            None
        };
        if let Some(lan) = &self.transparent {
            let network = lan
                .source
                .parse::<ipnet::Ipv4Net>()
                .ok()
                .filter(|n| n.addr() == n.network() && n.prefix_len() >= 8);
            ensure!(
                network.is_some()
                    && interface_name(&lan.interface)
                    && lan.port != 0
                    && lan.port != self.panel_port
                    && lan.port != self.socks_port,
                "transparent требует интерфейс LAN, IPv4 CIDR и отдельный порт"
            );
            match (lan.mode.as_str(), network, panel_net) {
                ("" | "tproxy", _, _) => {}
                ("redirect-tcp", Some(n), Some(p))
                    if p.contains(&n.addr())
                        && n.prefix_len() >= p.prefix_len()
                        && lan.port != 53 => {}
                ("redirect-tcp", _, _) => bail!(
                    "redirect-tcp требует частный адрес панели, источник в её подсети и порт, отличный от DNS"
                ),
                _ => bail!("поддерживаются режимы transparent tproxy и redirect-tcp"),
            }
        }
        let mut ids = HashSet::from(["direct".to_owned(), "zapret".to_owned()]);
        for profile in &mut self.profiles {
            ensure!(
                valid_domain(&profile.id)
                    && !profile.id.contains('.')
                    && ids.insert(profile.id.clone()),
                "недопустимый или повторный ID профиля {:?}",
                profile.id
            );
            for name in [&mut profile.label, &mut profile.location] {
                *name = name.trim().to_owned();
                ensure!(
                    name.chars().count() <= 100 && !name.chars().any(char::is_control),
                    "название и локация профиля должны содержать не более 100 символов без управляющих знаков"
                );
            }
            profile.server.clear();
            profile.is_xray_group = false;
            profile.group_size = 0;
            if let Some(group) = &profile.xray_group {
                ensure!(
                    profile.protocol == "vless"
                        && profile.uri.is_empty()
                        && profile.outbound.is_none()
                        && profile.awg_config.is_empty()
                        && profile.interface.is_empty()
                        && profile.awg_version.is_empty(),
                    "проверьте параметры группы Xray {:?}",
                    profile.id
                );
                routehub_subscriptions::validate_xray_profile_group(group)
                    .map_err(anyhow::Error::msg)?;
                continue;
            }
            match profile.protocol.as_str() {
                "vless" | "hysteria2" | "trojan" => ensure!(
                    profile.uri.is_empty() == profile.outbound.is_some()
                        && profile.interface.is_empty()
                        && profile.awg_config.is_empty()
                        && profile.awg_version.is_empty(),
                    "профиль {:?} требует одно из uri или outbound",
                    profile.id
                ),
                "amneziawg" => {
                    ensure!(
                        profile.uri.is_empty()
                            && profile.outbound.is_none()
                            && profile.interface.is_empty() != profile.awg_config.is_empty()
                            && (profile.interface.is_empty() || interface_name(&profile.interface)),
                        "профиль {:?} требует файл AmneziaWG или интерфейс WireGuard ASC",
                        profile.id
                    );
                    if !profile.awg_config.is_empty() {
                        let parsed = routehub_imports::parse_managed_awg(
                            &profile.awg_config,
                            &profile.awg_version,
                        )
                        .map_err(anyhow::Error::msg)?;
                        profile.awg_version = parsed.version;
                    }
                }
                _ => bail!("неизвестный протокол {:?}", profile.protocol),
            }
        }
        self.subscriptions = routehub_subscriptions::validate_subscriptions(&self.subscriptions)
            .map_err(anyhow::Error::msg)?;
        crate::saved_checks::normalize(&mut self.saved_checks)?;
        self.policy(true, None, geo)?;
        Ok(())
    }

    pub fn panel(&self) -> Result<SocketAddr> {
        Ok(SocketAddr::new(self.panel_host.parse()?, self.panel_port))
    }

    pub fn socks(&self) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.socks_port)
    }

    pub fn policy(
        &self,
        lan: bool,
        inventory: Option<Vec<Binding>>,
        geo: &GeoCache,
    ) -> Result<Compiled> {
        let mut options = Options {
            inventory,
            ..Default::default()
        };
        options.targets.insert("@vpn".into(), String::new());
        options.targets.extend(
            self.profiles
                .iter()
                .map(|p| (p.id.clone(), p.protocol.clone())),
        );
        geo.apply_options(&mut options);
        if let Some(capture) = self.transparent.as_ref().filter(|_| lan) {
            options.lan = capture.source.parse::<IpNet>().ok();
            options.router_ip = self.panel_host.parse().ok();
            options.game_routes = self.game_routes()?;
        }
        let mut rules = Vec::new();
        if let Some(services) = &self.zapret_services {
            for (enabled, title, hosts) in [
                (services.youtube, "YouTube", crate::zapret::YOUTUBE_DOMAINS),
                (services.discord, "Discord", crate::zapret::DISCORD_DOMAINS),
            ] {
                if enabled {
                    for domain in hosts.split(',') {
                        rules.push(Rule {
                            name: format!("Zapret {title} · {domain}"),
                            domain: domain.into(),
                            target: "zapret".into(),
                            ..Default::default()
                        });
                    }
                }
            }
        }
        rules.extend(self.rules.iter().cloned());
        routehub_policy::compile(
            &PolicyConfig {
                default_target: self.default_target.clone(),
                rules,
                devices: self.devices.clone(),
                named_sets: self.named_sets.clone(),
            },
            &options,
        )
        .map_err(anyhow::Error::msg)
    }

    fn game_routes(&self) -> Result<HashMap<String, Vec<GameRoute>>> {
        let mut routes: HashMap<String, Vec<GameRoute>> = HashMap::new();
        for preset in self
            .games
            .iter()
            .filter(|p| p.enabled && p.route_action.kind == "direct")
        {
            for signature in preset.signatures.iter().filter(|s| s.protocol == "tcp") {
                let destination = SocketAddr::new(signature.destination.parse()?, signature.port);
                for mac in &preset.scope.device_ids {
                    routes.entry(mac.clone()).or_default().push(GameRoute {
                        preset_id: preset.id.clone(),
                        name: preset.name.clone(),
                        destination,
                    });
                }
            }
        }
        Ok(routes)
    }
}
