use ipnet::IpNet;
use routehub_policy::{Binding, Config, Destination, DomainSet, GameRoute, Options, compile};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WireOptions {
    lan: Option<String>,
    router_ip: Option<IpAddr>,
    targets: HashMap<String, String>,
    inventory: Option<Vec<Binding>>,
    geo_sources: HashMap<String, bool>,
    geo_data: HashMap<String, HashMap<String, Vec<String>>>,
    geo_sites: HashMap<String, HashMap<String, Vec<[String; 2]>>>,
    game_routes: HashMap<String, Vec<GameRoute>>,
}

impl WireOptions {
    fn compile(self) -> Options {
        let geo_data = self
            .geo_data
            .into_iter()
            .map(|(id, categories)| {
                let categories = categories
                    .into_iter()
                    .map(|(tag, values)| {
                        let prefixes = values
                            .into_iter()
                            .map(|value| value.parse::<IpNet>().expect("valid fixture prefix"))
                            .collect::<Vec<_>>();
                        (tag, Arc::from(prefixes))
                    })
                    .collect();
                (id, categories)
            })
            .collect();
        let geo_sites = self
            .geo_sites
            .into_iter()
            .map(|(id, categories)| {
                let categories = categories
                    .into_iter()
                    .map(|(tag, rows)| {
                        let mut domains = DomainSet::default();
                        for [domain, mode] in rows {
                            domains.add(&domain, &mode).expect("valid GeoSite fixture");
                        }
                        (tag, Arc::new(domains))
                    })
                    .collect();
                (id, categories)
            })
            .collect();
        Options {
            lan: self.lan.map(|lan| lan.parse().expect("valid fixture LAN")),
            router_ip: self.router_ip,
            targets: self.targets,
            inventory: self.inventory,
            geo_sources: self.geo_sources,
            geo_data,
            geo_sites,
            game_routes: self.game_routes,
        }
    }
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    config: Config,
    options: WireOptions,
    checks: Vec<Destination>,
    assets: HashMap<String, String>,
}

#[test]
fn replays_original_go_policy() {
    let scenarios: Vec<Scenario> =
        serde_json::from_str(include_str!("fixtures/scenarios.json")).unwrap();
    let expected: HashMap<String, Value> =
        serde_json::from_str(include_str!("fixtures/expected.json")).unwrap();
    assert_eq!(scenarios.len(), expected.len());
    for scenario in scenarios {
        let options = scenario.options.compile();
        let actual = match compile(&scenario.config, &options) {
            Err(error) => json!({ "error": error }),
            Ok(plan) => {
                let checks: Vec<_> = scenario
                    .checks
                    .iter()
                    .map(|query| match plan.evaluate(query) {
                        Ok(decision) => json!(decision),
                        Err(error) => json!({"error": error}),
                    })
                    .collect();
                let assets = plan.xray_rules_with_assets("lan", |id| {
                    scenario.assets.get(id).cloned().unwrap_or_default()
                });
                json!({
                    "devices": plan.devices(),
                    "checks": checks,
                    "globalRules": plan.xray_rules(""),
                    "lanRules": plan.xray_rules("lan"),
                    "assetRules": assets,
                })
            }
        };
        assert_eq!(actual, expected[&scenario.name], "{}", scenario.name);
    }
}
