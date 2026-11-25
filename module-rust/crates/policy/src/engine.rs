use crate::address::{
    client_ip, lan_host, normalize_host, normalize_mac, parse_prefix, unmap, valid_domain,
};
use crate::matcher::{DomainMatch, Group, compile_named_sets, domain_match, geo_tag};
use crate::{Config, Decision, Destination, DeviceStatus, Options, Rule};
use ipnet::{IpNet, Ipv4Net};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

#[derive(Clone, Debug)]
struct Scope {
    mac: Arc<str>,
    addresses: Arc<[Ipv4Addr]>,
}

#[derive(Clone, Debug)]
enum Matcher {
    Any,
    Domain(DomainMatch),
    Prefix {
        network: IpNet,
        original: Option<Box<str>>,
    },
    Group(Group, Option<ExternalGroup>),
}

#[derive(Clone, Debug)]
struct ExternalGroup {
    source: String,
    tag: String,
}

#[derive(Clone, Debug)]
struct PlannedRule {
    name: String,
    target: String,
    matcher: Matcher,
    network: String,
    port: u16,
    scope: Option<Scope>,
    game_preset_id: String,
}

impl PlannedRule {
    fn fallback(target: &str, scope: Option<Scope>) -> Self {
        Self {
            name: String::new(),
            target: target.into(),
            matcher: Matcher::Any,
            network: String::new(),
            port: 0,
            scope,
            game_preset_id: String::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Plan {
    rules: Vec<PlannedRule>,
    targets: HashMap<String, String>,
    devices: Vec<DeviceStatus>,
    sources: HashMap<Ipv4Addr, Arc<str>>,
    equipped: HashSet<Arc<str>>,
}

type Inventory = HashMap<Ipv4Addr, HashMap<String, bool>>;

/// Compile the order shared by diagnostics and Xray: device rules and
/// overrides, global explicit rules, eligible game exceptions, global default.
pub fn compile(config: &Config, options: &Options) -> Result<Plan, String> {
    let mut targets = HashMap::from([
        ("direct".into(), String::new()),
        ("zapret".into(), String::new()),
        ("@block".into(), String::new()),
    ]);
    targets.extend(options.targets.clone());
    let lan = match options.lan {
        None => None,
        Some(IpNet::V4(network)) if network.addr() == network.network() => Some(network),
        _ => return Err("для правил устройств нужна каноническая IPv4-подсеть LAN".into()),
    };
    let default = if config.default_target.is_empty() {
        "direct"
    } else {
        &config.default_target
    };
    if !targets.contains_key(default) {
        return Err(format!("неизвестный маршрут сети по умолчанию {default:?}"));
    }
    let inventory = inventory_owners(options)?;
    let sets = compile_named_sets(&config.named_sets)?;
    let mut plan = Plan {
        rules: Vec::with_capacity(config.rules.len() + 1),
        targets,
        devices: Vec::with_capacity(config.devices.len()),
        sources: HashMap::new(),
        equipped: HashSet::new(),
    };
    let mut macs = HashSet::new();
    let mut assigned = HashMap::new();
    let mut game_rules = Vec::new();
    for device in &config.devices {
        let mac: Arc<str> = normalize_mac(&device.mac)?.into();
        if !macs.insert(Arc::clone(&mac)) {
            return Err(format!("повторный MAC устройства {mac:?}"));
        }
        let mode = if device.mode.is_empty() {
            "inherit"
        } else {
            &device.mode
        };
        match mode {
            "global" | "inherit" if !device.default_target.is_empty() => {
                return Err(format!(
                    "устройство {mac} в режиме {mode} наследует маршрут по умолчанию"
                ));
            }
            "override" | "fixed"
                if device.default_target.is_empty()
                    || !plan.targets.contains_key(&device.default_target) =>
            {
                return Err(format!(
                    "устройство {mac} в режиме {mode} требует известный маршрут по умолчанию"
                ));
            }
            "global" | "inherit" | "override" | "fixed" => {}
            _ => return Err(format!("неизвестный режим устройства {mode:?}")),
        }
        let addresses = checked_addresses(
            &device.addresses,
            &mac,
            &mut assigned,
            lan,
            options.router_ip,
        )?;
        let reason = if mode == "global" {
            "global-only"
        } else if lan.is_none() {
            "lan-disabled"
        } else if addresses.is_empty() {
            "missing-address"
        } else if inventory
            .as_ref()
            .is_some_and(|snapshot| !all_verified(snapshot, &mac, &addresses))
        {
            "unverified-address"
        } else {
            ""
        };
        let active = reason.is_empty();
        // An omitted mode inherits global rules, but historically only an
        // explicit "inherit" enables the opt-in game exceptions.
        let game_route_eligible = active && device.mode == "inherit" && inventory.is_some();
        plan.devices.push(DeviceStatus {
            mac: mac.to_string(),
            label: device.label.clone(),
            addresses: addresses.iter().map(ToString::to_string).collect(),
            mode: mode.into(),
            active,
            reason: reason.into(),
            game_route_eligible,
        });
        let scope = Scope {
            mac: Arc::clone(&mac),
            addresses: addresses.into(),
        };
        let mut device_rules = plan
            .compile_rules(
                &device.rules,
                options,
                &sets,
                active && mode != "fixed",
                Some(&scope),
            )
            .map_err(|err| format!("устройство {mac}: {err}"))?;
        if !active {
            continue;
        }
        for address in &*scope.addresses {
            plan.sources.insert(*address, Arc::clone(&mac));
        }
        plan.equipped.insert(Arc::clone(&mac));
        if matches!(mode, "override" | "fixed") {
            device_rules.push(PlannedRule::fallback(
                &device.default_target,
                Some(scope.clone()),
            ));
        }
        plan.rules.extend(device_rules);
        if game_route_eligible {
            for game in options.game_routes.get(mac.as_ref()).into_iter().flatten() {
                let address = game.destination.ip();
                let port = game.destination.port();
                if !address.is_ipv4() || port == 0 {
                    return Err(format!("некорректное игровое назначение {:?}", game.name));
                }
                game_rules.push(PlannedRule {
                    name: format!("Игра · {}", game.name),
                    target: "direct".into(),
                    matcher: Matcher::Prefix {
                        network: IpNet::from(address),
                        original: None,
                    },
                    scope: Some(scope.clone()),
                    network: "tcp".into(),
                    port,
                    game_preset_id: game.preset_id.clone(),
                });
            }
        }
    }
    let global = plan.compile_rules(&config.rules, options, &sets, true, None)?;
    plan.rules.extend(global);
    plan.rules.extend(game_rules);
    plan.rules.push(PlannedRule::fallback(default, None));
    Ok(plan)
}

fn inventory_owners(options: &Options) -> Result<Option<Inventory>, String> {
    let Some(rows) = &options.inventory else {
        return Ok(None);
    };
    let mut owners = Inventory::new();
    for row in rows {
        let mac = normalize_mac(&row.mac).map_err(|err| format!("инвентарь: {err}"))?;
        let address = client_ip(&row.address).map_err(|err| format!("инвентарь: {err}"))?;
        let current = owners.entry(address).or_default().entry(mac).or_default();
        *current |= row.fixed;
    }
    Ok(Some(owners))
}

fn all_verified(inventory: &Inventory, mac: &str, addresses: &[Ipv4Addr]) -> bool {
    addresses.iter().all(|address| {
        inventory
            .get(address)
            .is_some_and(|owners| owners.len() == 1 && owners.get(mac).copied().unwrap_or(false))
    })
}

fn checked_addresses(
    configured: &[String],
    mac: &Arc<str>,
    assigned: &mut HashMap<Ipv4Addr, Arc<str>>,
    lan: Option<Ipv4Net>,
    router_ip: Option<IpAddr>,
) -> Result<Vec<Ipv4Addr>, String> {
    let mut addresses = Vec::with_capacity(configured.len());
    for value in configured {
        let valid = client_ip(value).ok().filter(|address| {
            Some(IpAddr::V4(*address)) != router_ip
                && lan.is_none_or(|network| lan_host(network, *address))
        });
        let address =
            valid.ok_or_else(|| format!("некорректный адрес LAN {value:?} устройства {mac}"))?;
        if let Some(other) = assigned.insert(address, Arc::clone(mac)) {
            return Err(format!(
                "адрес {address} повторно назначен устройствам {other} и {mac}"
            ));
        }
        addresses.push(address);
    }
    Ok(addresses)
}

fn usable_network(network: &str) -> bool {
    matches!(network, "tcp" | "udp")
}

impl Plan {
    fn compile_rules(
        &self,
        rules: &[Rule],
        options: &Options,
        sets: &HashMap<&str, Group>,
        active: bool,
        scope: Option<&Scope>,
    ) -> Result<Vec<PlannedRule>, String> {
        let mut compiled = Vec::with_capacity(if active { rules.len() } else { 0 });
        let mut names = HashSet::new();
        for rule in rules {
            let name = rule.name.trim();
            if name.is_empty() || !names.insert(name) {
                return Err(
                    "имена правил должны быть заполнены и уникальны в своей области".into(),
                );
            }
            let count = [
                &rule.domain,
                &rule.cidr,
                &rule.geo_ip,
                &rule.geo_site,
                &rule.named_set,
            ]
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .count();
            if !self.targets.contains_key(&rule.target) || count != 1 {
                return Err(format!(
                    "правило {name:?} требует одно назначение и известный маршрут"
                ));
            }
            if (rule.exact || !rule.match_kind.is_empty()) && rule.domain.is_empty() {
                return Err(format!("тип совпадения в правиле {name:?} требует домен"));
            }
            if rule.geo_ip.is_empty() && rule.geo_site.is_empty() && !rule.geo_source.is_empty() {
                return Err(format!(
                    "источник базы в правиле {name:?} требует тег GeoIP или GeoSite"
                ));
            }
            if !rule.network.is_empty() && !usable_network(&rule.network) {
                return Err(format!("неизвестный транспорт в правиле {name:?}"));
            }
            let enabled = active && !rule.disabled;
            let matcher = if !rule.domain.trim().is_empty() {
                Matcher::Domain(
                    domain_match(rule).map_err(|err| format!("правило {name:?}: {err}"))?,
                )
            } else if !rule.geo_ip.is_empty() || !rule.geo_site.is_empty() {
                compile_geo(rule, options, enabled)
                    .map_err(|err| format!("правило {name:?}: {err}"))?
            } else if !rule.named_set.is_empty() {
                let group = sets
                    .get(rule.named_set.as_str())
                    .ok_or_else(|| format!("правило {name:?} ссылается на отсутствующий набор"))?;
                if group.is_empty() {
                    return Err(format!("правило {name:?} ссылается на пустой набор"));
                }
                Matcher::Group(group.clone(), None)
            } else {
                let network = parse_prefix(&rule.cidr)
                    .ok_or_else(|| format!("некорректный CIDR в правиле {name:?}"))?;
                Matcher::Prefix {
                    network,
                    original: matches!(network, IpNet::V6(_)).then(|| rule.cidr.as_str().into()),
                }
            };
            if enabled {
                compiled.push(PlannedRule {
                    name: name.into(),
                    target: rule.target.clone(),
                    matcher,
                    network: rule.network.clone(),
                    port: rule.port,
                    scope: scope.cloned(),
                    game_preset_id: String::new(),
                });
            }
        }
        Ok(compiled)
    }

    pub fn devices(&self) -> &[DeviceStatus] {
        &self.devices
    }

    /// Same first-match order as Xray. A MAC alone uses an active device
    /// binding, and a diagnostic cannot combine a MAC and another device's IP.
    pub fn evaluate(&self, input: &Destination) -> Result<Decision, String> {
        let host = normalize_host(&input.host);
        let host_ip = host.parse::<IpAddr>().ok();
        if (host_ip.is_none() && !valid_domain(&host))
            || !usable_network(&input.network)
            || input.port == 0
        {
            return Err("укажите домен или IP, протокол TCP или UDP и порт от 1 до 65535".into());
        }
        let mut address = host_ip.map(unmap);
        if !input.target_ip.is_empty() {
            let target = input.target_ip.parse::<IpAddr>().ok().map(unmap);
            if target.is_none() || address.is_some_and(|current| Some(current) != target) {
                return Err("неверный или не совпадающий с назначением targetIP".into());
            }
            address = target;
        }
        let mac = self.client_mac(&input.client_mac, &input.client_ip)?;
        for rule in &self.rules {
            if rule
                .scope
                .as_ref()
                .is_some_and(|scope| Some(scope.mac.as_ref()) != mac.as_deref())
                || (!rule.network.is_empty() && rule.network != input.network)
                || (rule.port != 0 && rule.port != input.port)
            {
                continue;
            }
            let matched = match &rule.matcher {
                Matcher::Any => true,
                Matcher::Prefix { network, .. } => address.is_some_and(|ip| network.contains(&ip)),
                Matcher::Domain(domain) => host_ip.is_none() && domain.kind.matches(&host),
                Matcher::Group(Group::Ip(prefixes), _) => {
                    address.is_some_and(|ip| prefixes.iter().any(|prefix| prefix.contains(&ip)))
                }
                Matcher::Group(Group::Domains(domains), _) => {
                    host_ip.is_none() && domains.matches(&host)
                }
            };
            if matched {
                return Ok(Decision {
                    rule: rule.name.clone(),
                    target: rule.target.clone(),
                    protocol: self.targets.get(&rule.target).cloned().unwrap_or_default(),
                    scope: if rule.scope.is_some() {
                        "device".into()
                    } else {
                        "global".into()
                    },
                    device_mac: mac.as_deref().unwrap_or_default().into(),
                    game_preset_id: rule.game_preset_id.clone(),
                });
            }
        }
        Err("план маршрутизации ещё не загружен".into())
    }

    fn client_mac(&self, mac: &str, ip: &str) -> Result<Option<Arc<str>>, String> {
        let requested = if mac.is_empty() {
            None
        } else {
            Some(normalize_mac(mac)?)
        };
        let active = requested
            .as_deref()
            .and_then(|value| self.equipped.get(value));
        if ip.is_empty() {
            return Ok(active.cloned());
        }
        let address = client_ip(ip)?;
        let owner = self.sources.get(&address);
        if requested.is_some()
            && owner.map(AsRef::as_ref) != requested.as_deref()
            && (owner.is_some() || active.is_some())
        {
            return Err("указанные MAC и IP не принадлежат одному активному устройству".into());
        }
        Ok(owner.cloned())
    }

    pub fn xray_rules(&self, lan_inbound_tag: &str) -> Vec<Value> {
        self.xray_rules_with_assets(lan_inbound_tag, |_| String::new())
    }

    pub fn xray_rules_with_assets<F>(&self, lan_inbound_tag: &str, mut asset_file: F) -> Vec<Value>
    where
        F: FnMut(&str) -> String,
    {
        self.rules
            .iter()
            .filter_map(|entry| {
                let mut rule = json!({"type": "field", "outboundTag": entry.target});
                if let Some(scope) = &entry.scope {
                    if lan_inbound_tag.is_empty() {
                        return None;
                    }
                    let sources: Vec<_> = scope
                        .addresses
                        .iter()
                        .map(|ip| format!("{ip}/32"))
                        .collect();
                    rule["sourceIP"] = json!(sources);
                    rule["inboundTag"] = json!([lan_inbound_tag]);
                }
                match &entry.matcher {
                    Matcher::Any => {}
                    Matcher::Domain(domain) => rule["domain"] = json!([domain.token]),
                    Matcher::Prefix { network, original } => {
                        rule["ip"] = if let Some(original) = original {
                            json!([original])
                        } else {
                            json!([network.to_string()])
                        };
                    }
                    Matcher::Group(group, external) => {
                        let label = external.as_ref().and_then(|ext| {
                            let file = asset_file(&ext.source);
                            (!file.is_empty()).then(|| format!("ext:{file}:{}", ext.tag))
                        });
                        match group {
                            Group::Ip(prefixes) => {
                                rule["ip"] = if let Some(label) = label {
                                    json!([label])
                                } else {
                                    json!(
                                        prefixes
                                            .iter()
                                            .map(ToString::to_string)
                                            .collect::<Vec<_>>()
                                    )
                                };
                            }
                            Group::Domains(domains) => {
                                rule["domain"] = if let Some(label) = label {
                                    json!([label])
                                } else {
                                    json!(domains.tokens())
                                };
                            }
                        }
                    }
                }
                if entry.name.is_empty() {
                    rule["network"] = json!("tcp,udp");
                } else if !entry.network.is_empty() {
                    rule["network"] = json!(entry.network);
                }
                if entry.port != 0 {
                    rule["port"] = json!(entry.port.to_string());
                }
                Some(rule)
            })
            .collect()
    }
}

fn compile_geo(rule: &Rule, options: &Options, active: bool) -> Result<Matcher, String> {
    let source = &rule.geo_source;
    if !options.geo_sources.get(source).copied().unwrap_or(false) {
        return Err("выберите сохранённый источник GeoIP или GeoSite".into());
    }
    let (tag, group) = if !rule.geo_site.is_empty() {
        let tag = geo_tag(&rule.geo_site).ok_or("укажите допустимый тег GeoSite")?;
        let domains = options
            .geo_sites
            .get(source)
            .and_then(|groups| groups.get(&tag))
            .cloned();
        if active && domains.as_ref().is_none_or(|list| list.is_empty()) {
            return Err("обновите базу GeoSite и выберите доступный тег".into());
        }
        (tag, domains.map(Group::Domains))
    } else {
        let tag = geo_tag(&rule.geo_ip).ok_or("укажите допустимый тег GeoIP")?;
        let prefixes = options
            .geo_data
            .get(source)
            .and_then(|groups| groups.get(&tag))
            .cloned();
        if active && prefixes.as_ref().is_none_or(|list| list.is_empty()) {
            return Err("обновите базу GeoIP и выберите доступный тег".into());
        }
        (tag, prefixes.map(Group::Ip))
    };
    Ok(group.map_or(Matcher::Any, |group| {
        Matcher::Group(
            group,
            Some(ExternalGroup {
                source: source.clone(),
                tag,
            }),
        )
    }))
}
