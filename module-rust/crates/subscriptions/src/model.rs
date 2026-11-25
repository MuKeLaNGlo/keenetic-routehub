use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::source::validate_hostname_parts;

fn is_false(val: &bool) -> bool {
    !val
}

fn is_zero(val: &usize) -> bool {
    *val == 0
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub protocol: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub location: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub server: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outbound: Option<Value>,
    #[serde(rename = "xrayPool", skip_serializing_if = "Option::is_none")]
    pub xray_group: Option<XrayProfileGroup>,
    #[serde(rename = "xrayGroup", skip_serializing_if = "is_false")]
    pub is_xray_group: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub group_size: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub interface: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub awg_version: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub awg_config: String,
    #[serde(skip_serializing_if = "is_false")]
    pub awg_native: bool,
    #[serde(rename = "subscriptionId", skip_serializing_if = "String::is_empty")]
    pub subscription_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub upstream_key: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub upstream_name: String,
    #[serde(skip_serializing_if = "is_false")]
    pub subscription_missing: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub catalog_profile: bool,
}

impl Profile {
    pub fn public(&self) -> Self {
        Self {
            id: self.id.clone(),
            protocol: self.protocol.clone(),
            label: self.label.clone(),
            location: self.location.clone(),
            server: self.endpoint(),
            awg_version: self.awg_version.clone(),
            awg_native: !self.interface.is_empty(),
            subscription_id: self.subscription_id.clone(),
            upstream_key: self.upstream_key.clone(),
            upstream_name: self.upstream_name.clone(),
            subscription_missing: self.subscription_missing,
            is_xray_group: self.xray_group.is_some(),
            group_size: self.group_size(),
            ..Self::default()
        }
    }

    pub fn group_size(&self) -> usize {
        self.xray_group
            .as_ref()
            .map_or(0, |group| group.members.len())
    }

    pub fn endpoint(&self) -> String {
        if !self.uri.is_empty() {
            return validate_hostname_parts(&self.uri)
                .map(|parts| socket_address(&parts.host, parts.port.unwrap_or(443)))
                .unwrap_or_default();
        }
        if let Some(settings) = self
            .outbound
            .as_ref()
            .and_then(|outbound| outbound.get("settings"))
        {
            let address = ["vnext", "servers"]
                .iter()
                .find_map(|name| settings[*name].get(0))
                .unwrap_or(settings);
            if let (Some(host), Some(port)) =
                (address["address"].as_str(), address["port"].as_u64())
                && !host.is_empty()
                && (1..=65535).contains(&port)
            {
                return socket_address(host, port as u16);
            }
        }
        if self.protocol == "amneziawg" {
            for line in self.awg_config.lines() {
                if let Some((key, value)) = line.split_once('=')
                    && key.trim().eq_ignore_ascii_case("endpoint")
                {
                    return value
                        .split('#')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                }
            }
        }
        String::new()
    }
}

pub(crate) fn socket_address(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct XrayProfileGroup {
    pub strategy: String,
    pub members: Vec<XrayGroupMember>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<XrayGroupStrategySettings>,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct XrayGroupMember {
    pub protocol: String,
    pub outbound: Value,
    #[serde(skip_serializing_if = "is_false")]
    pub fallback_only: bool,
}

fn is_zero_int(val: &i32) -> bool {
    *val == 0
}
fn is_zero_float(val: &f64) -> bool {
    *val == 0.0
}

fn serialize_float<S>(value: &f64, writer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if value.fract() == 0.0 && (-9.0e18..=9.0e18).contains(value) {
        writer.serialize_i64(*value as i64)
    } else {
        writer.serialize_f64(*value)
    }
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct XrayGroupStrategySettings {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub baselines: Vec<String>,
    #[serde(skip_serializing_if = "is_zero_int")]
    pub expected: i32,
    #[serde(rename = "maxRTT", skip_serializing_if = "String::is_empty")]
    pub max_rtt: String,
    #[serde(
        skip_serializing_if = "is_zero_float",
        serialize_with = "serialize_float"
    )]
    pub tolerance: f64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub costs: Vec<XrayGroupCost>,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct XrayGroupCost {
    pub member: usize,
    #[serde(serialize_with = "serialize_float")]
    pub value: f64,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    #[serde(rename = "deviceId", skip_serializing_if = "String::is_empty")]
    pub device_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub user_agent: String,
    #[serde(rename = "hasDeviceId", skip_serializing_if = "is_false")]
    pub has_device_id: bool,
    pub interval_hours: i32,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success: Option<SubscriptionSuccess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt: Option<SubscriptionAttempt>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub etag: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_modified: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSuccess {
    pub at: DateTime<Utc>,
    pub revision: String,
    pub profiles: usize,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionAttempt {
    pub at: DateTime<Utc>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatus {
    #[serde(rename = "subscriptionId")]
    pub id: String,
    pub last_success: Option<SubscriptionSuccess>,
    pub last_attempt: Option<SubscriptionAttempt>,
    pub next_run: Option<DateTime<Utc>>,
}

impl Subscription {
    pub fn status(&self) -> SubscriptionStatus {
        SubscriptionStatus {
            id: self.id.clone(),
            last_success: self.last_success.clone(),
            last_attempt: self.last_attempt.clone(),
            next_run: self.enabled.then(|| {
                self.last_attempt
                    .as_ref()
                    .map(|attempt| attempt.at)
                    .or(self.added_at)
                    .unwrap_or(DateTime::UNIX_EPOCH)
                    + chrono::Duration::hours(self.interval_hours.into())
            }),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncompatibleSubscriptionRow {
    pub upstream_key: String,
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionParse {
    pub profiles: Vec<Profile>,
    pub incompatible: Vec<IncompatibleSubscriptionRow>,
}

#[derive(Debug)]
pub struct SubscriptionParseError {
    pub error: String,
    pub incompatible: Vec<IncompatibleSubscriptionRow>,
}

impl std::fmt::Display for SubscriptionParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.error)
    }
}

impl std::error::Error for SubscriptionParseError {}
