use crate::DomainSet;
use ipnet::IpNet;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

fn is_false(value: &bool) -> bool {
    !value
}

fn is_zero(value: &u16) -> bool {
    *value == 0
}

pub(crate) fn null_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer).map(Option::unwrap_or_default)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub domain: String,
    #[serde(skip_serializing_if = "is_false")]
    pub exact: bool,
    #[serde(rename = "match", skip_serializing_if = "String::is_empty")]
    pub match_kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cidr: String,
    #[serde(rename = "geoIP", skip_serializing_if = "String::is_empty")]
    pub geo_ip: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub geo_site: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub geo_source: String,
    #[serde(rename = "set", skip_serializing_if = "String::is_empty")]
    pub named_set: String,
    #[serde(skip_serializing_if = "is_false")]
    pub disabled: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub network: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub port: u16,
    pub target: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub mac: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_vec")]
    pub addresses: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mode: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub default_target: String,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_vec")]
    pub rules: Vec<Rule>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub default_target: String,
    #[serde(deserialize_with = "null_vec")]
    pub rules: Vec<Rule>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_vec")]
    pub devices: Vec<Device>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_vec")]
    pub named_sets: Vec<NamedSet>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NamedSet {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(deserialize_with = "null_vec")]
    pub entries: Vec<String>,
}

/// A fixed lease is verified against Keenetic's reservation. A current ARP or
/// dynamic DHCP observation can reveal a conflict but cannot activate policy.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Binding {
    pub mac: String,
    pub address: String,
    pub fixed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRoute {
    pub preset_id: String,
    pub name: String,
    pub destination: SocketAddr,
}

pub type GeoIpDatabase = HashMap<String, HashMap<String, Arc<[IpNet]>>>;
pub type GeoSiteDatabase = HashMap<String, HashMap<String, Arc<DomainSet>>>;

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub targets: HashMap<String, String>,
    pub lan: Option<IpNet>,
    pub router_ip: Option<IpAddr>,
    /// None trusts explicit administrator assignments. Some, including an empty
    /// snapshot, requires a confirmed unique owner for each address.
    pub inventory: Option<Vec<Binding>>,
    pub geo_sources: HashMap<String, bool>,
    pub geo_data: GeoIpDatabase,
    pub geo_sites: GeoSiteDatabase,
    pub game_routes: HashMap<String, Vec<GameRoute>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Destination {
    pub host: String,
    #[serde(
        rename = "targetIP",
        alias = "targetIp",
        skip_serializing_if = "String::is_empty"
    )]
    pub target_ip: String,
    pub network: String,
    pub port: u16,
    #[serde(
        rename = "clientIP",
        alias = "clientIp",
        skip_serializing_if = "String::is_empty"
    )]
    pub client_ip: String,
    #[serde(
        rename = "clientMAC",
        alias = "clientMac",
        skip_serializing_if = "String::is_empty"
    )]
    pub client_mac: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Decision {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub rule: String,
    pub target: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub protocol: String,
    pub scope: String,
    #[serde(rename = "deviceMAC", skip_serializing_if = "String::is_empty")]
    pub device_mac: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub game_preset_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DeviceStatus {
    pub mac: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_vec")]
    pub addresses: Vec<String>,
    pub mode: String,
    pub active: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(skip_serializing_if = "is_false")]
    pub game_route_eligible: bool,
}
