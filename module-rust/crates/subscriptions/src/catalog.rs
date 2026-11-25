use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{IncompatibleSubscriptionRow, Profile, Subscription, socket_address};
use crate::source::{
    MAX_CATALOG_PROFILES, digest, label, node_location, nonempty, normalize_host, parse_query,
    query_value, validate_hostname_parts,
};
use crate::xray::json_server;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPreview {
    #[serde(rename = "subscriptionId")]
    pub id: String,
    pub fetched_at: DateTime<Utc>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
    pub added: Vec<AddedSubscriptionProfile>,
    pub changed: Vec<ChangedSubscriptionProfile>,
    pub missing: Vec<MissingSubscriptionProfile>,
    pub incompatible: Vec<IncompatibleSubscriptionRow>,
    pub ambiguous: Vec<AmbiguousSubscriptionProfile>,
}

impl SubscriptionPreview {
    pub fn new(id: impl Into<String>, fetched_at: DateTime<Utc>) -> Self {
        Self {
            id: id.into(),
            fetched_at,
            ok: false,
            error: String::new(),
            token: String::new(),
            added: Vec::new(),
            changed: Vec::new(),
            missing: Vec::new(),
            incompatible: Vec::new(),
            ambiguous: Vec::new(),
        }
    }
}

fn is_false(value: &bool) -> bool {
    !value
}
fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedSubscriptionProfile {
    pub upstream_key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub xray_group: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub group_size: usize,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedSubscriptionProfile {
    pub profile_id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingSubscriptionProfile {
    pub profile_id: String,
    pub name: String,
    pub used_by: Vec<String>,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbiguousSubscriptionProfile {
    pub profile_id: String,
    pub candidates: Vec<String>,
}

#[derive(Clone, Default)]
pub struct CatalogReferences<'a> {
    pub default_target: &'a str,
    pub global_targets: &'a [String],
    pub device_targets: &'a [String],
}

impl CatalogReferences<'_> {
    fn for_profile(&self, id: &str) -> Vec<String> {
        let mut refs = Vec::new();
        if self.default_target == id {
            refs.push("Маршрут по умолчанию".into());
        }
        if self.global_targets.iter().any(|target| target == id) {
            refs.push("Общее правило".into());
        }
        if self.device_targets.iter().any(|target| target == id) {
            refs.push("Правила устройств".into());
        }
        refs
    }
}

pub fn validate_subscription_profiles(
    profiles: &[Profile],
    sources: &[Subscription],
) -> Result<(), String> {
    let sources: HashSet<_> = sources.iter().map(|source| source.id.as_str()).collect();
    let mut keys = HashSet::new();
    let mut count = 0;
    for entry in profiles {
        count += usize::from(entry.catalog_profile);
        if entry.subscription_id.is_empty() {
            if !entry.upstream_key.is_empty()
                || !entry.upstream_name.is_empty()
                || entry.subscription_missing
            {
                return Err("метаданные профиля требуют существующую подписку".into());
            }
            continue;
        }
        if !sources.contains(entry.subscription_id.as_str())
            || !entry.catalog_profile
            || !matches!(entry.protocol.as_str(), "vless" | "hysteria2")
            || entry.uri.is_empty() && entry.outbound.is_none() && entry.xray_group.is_none()
            || entry.upstream_key.len() != 32
            || !entry
                .upstream_key
                .bytes()
                .all(|n| matches!(n,b'0'..=b'9'|b'a'..=b'f'))
            || entry.upstream_name.is_empty()
            || label(&entry.upstream_name) != entry.upstream_name
            || !keys.insert((entry.subscription_id.as_str(), entry.upstream_key.as_str()))
        {
            return Err("проверьте происхождение профилей из подписок".into());
        }
    }
    if count > MAX_CATALOG_PROFILES {
        return Err(format!(
            "в каталоге подписок может быть до {MAX_CATALOG_PROFILES} профилей"
        ));
    }
    Ok(())
}

type IndexGroups = HashMap<String, (usize, usize)>;

fn group_rows(
    entries: &[Profile],
    indexes: impl Iterator<Item = usize>,
    key: impl Fn(&Profile) -> String,
) -> IndexGroups {
    let mut groups = IndexGroups::new();
    for index in indexes {
        let value = key(&entries[index]);
        if !value.is_empty() {
            let item = groups.entry(value).or_insert((index, 0));
            item.1 += 1;
        }
    }
    groups
}

pub fn merge_subscription_profiles(
    base: &[Profile],
    source: &Subscription,
    incoming: &[Profile],
    references: &CatalogReferences<'_>,
    preview: &mut SubscriptionPreview,
) -> Result<Vec<Profile>, String> {
    let changes = subscription_profile_changes(base, source, incoming, references, preview)?;
    let mut next = base.to_vec();
    changes.apply(&mut next);
    Ok(next)
}

/// A reviewed subscription update retains only affected profiles. Apply the
/// changes to the exact catalog revision the review used.
#[derive(Default)]
pub struct ProfileDelta {
    replacement: BTreeMap<usize, Profile>,
    added: Vec<Profile>,
}

impl ProfileDelta {
    pub fn profiles<'a>(&'a self, base: &'a [Profile]) -> impl Iterator<Item = &'a Profile> {
        base.iter()
            .enumerate()
            .map(|(index, original)| self.replacement.get(&index).unwrap_or(original))
            .chain(self.added.iter())
    }

    pub fn unchanged(&self) -> bool {
        self.replacement.is_empty() && self.added.is_empty()
    }

    pub fn apply(self, base: &mut Vec<Profile>) {
        for (index, profile) in self.replacement {
            base[index] = profile;
        }
        base.extend(self.added);
    }
}

pub fn subscription_profile_changes(
    base: &[Profile],
    source: &Subscription,
    incoming: &[Profile],
    references: &CatalogReferences<'_>,
    preview: &mut SubscriptionPreview,
) -> Result<ProfileDelta, String> {
    let mut delta = ProfileDelta::default();
    let mut old_by_key = HashMap::new();
    let mut used_ids = HashSet::new();
    for (i, entry) in base.iter().enumerate() {
        used_ids.insert(entry.id.clone());
        if entry.subscription_id == source.id {
            old_by_key.insert(entry.upstream_key.as_str(), i);
        }
    }
    let mut matched = HashSet::new();
    let mut next_to_old = HashMap::new();
    for (n, candidate) in incoming.iter().enumerate() {
        if let Some(&old) = old_by_key.get(candidate.upstream_key.as_str()) {
            matched.insert(old);
            next_to_old.insert(n, old);
        }
    }
    let by_endpoint_and_name = |entry: &Profile| {
        let endpoint = subscription_endpoint_key(entry);
        if endpoint.is_empty() {
            String::new()
        } else {
            format!("{endpoint}|{}", entry.upstream_name)
        }
    };
    for key in [
        by_endpoint_and_name as fn(&Profile) -> String,
        subscription_endpoint_key,
    ] {
        let old = group_rows(
            base,
            old_by_key
                .values()
                .copied()
                .filter(|i| !matched.contains(i)),
            key,
        );
        let new = group_rows(
            incoming,
            (0..incoming.len()).filter(|i| !next_to_old.contains_key(i)),
            key,
        );
        for (value, (old, count)) in old {
            if count == 1
                && let Some(&(new, 1)) = new.get(&value)
            {
                matched.insert(old);
                next_to_old.insert(new, old);
            }
        }
    }
    for (new_index, candidate) in incoming.iter().enumerate() {
        if let Some(&old) = next_to_old.get(&new_index) {
            let prior = &base[old];
            let renamed = prior.upstream_name != candidate.upstream_name;
            let updated = prior.upstream_key != candidate.upstream_key;
            let fill_label = prior.label.is_empty() && !candidate.upstream_name.is_empty();
            if !updated && !renamed && !prior.subscription_missing && !fill_label {
                continue;
            }
            let mut update = prior.clone();
            let kind = if updated {
                update.uri.clone_from(&candidate.uri);
                update.upstream_key.clone_from(&candidate.upstream_key);
                update.protocol.clone_from(&candidate.protocol);
                update.outbound.clone_from(&candidate.outbound);
                update.xray_group.clone_from(&candidate.xray_group);
                "params"
            } else if renamed {
                "renamed"
            } else if prior.subscription_missing {
                "params"
            } else {
                ""
            };
            update.subscription_missing = false;
            update.upstream_name.clone_from(&candidate.upstream_name);
            if prior.label == prior.upstream_name || prior.label.is_empty() {
                update.label.clone_from(&candidate.upstream_name);
            }
            delta.replacement.insert(old, update);
            if !kind.is_empty() {
                preview.changed.push(ChangedSubscriptionProfile {
                    profile_id: prior.id.clone(),
                    from: prior.upstream_name.clone(),
                    to: candidate.upstream_name.clone(),
                    kind: kind.into(),
                });
            }
            continue;
        }
        let prefix = format!(
            "sub-{}",
            &digest(format!("{}/{}", source.id, candidate.upstream_key))[..16]
        );
        let mut id = prefix.clone();
        let mut n = 2;
        while !used_ids.insert(id.clone()) {
            id = format!("{prefix}-{n}");
            n += 1;
        }
        delta.added.push(Profile {
            id,
            subscription_id: source.id.clone(),
            ..candidate.clone()
        });
        preview.added.push(AddedSubscriptionProfile {
            upstream_key: candidate.upstream_key.clone(),
            name: candidate.upstream_name.clone(),
            xray_group: candidate.xray_group.is_some(),
            group_size: candidate.group_size(),
        });
    }
    for (i, prior) in base.iter().enumerate() {
        if prior.subscription_id != source.id || matched.contains(&i) || prior.subscription_missing
        {
            continue;
        }
        delta.replacement.insert(
            i,
            Profile {
                subscription_missing: true,
                ..prior.clone()
            },
        );
        preview.missing.push(MissingSubscriptionProfile {
            profile_id: prior.id.clone(),
            name: nonempty(&prior.label, &prior.upstream_name).into(),
            used_by: references.for_profile(&prior.id),
        });
        let endpoint = subscription_endpoint_key(prior);
        if endpoint.is_empty() {
            continue;
        }
        let candidates: Vec<_> = incoming
            .iter()
            .enumerate()
            .filter(|(index, candidate)| {
                !next_to_old.contains_key(index) && endpoint == subscription_endpoint_key(candidate)
            })
            .map(|(_, candidate)| candidate.upstream_name.clone())
            .collect();
        if !candidates.is_empty() {
            preview.ambiguous.push(AmbiguousSubscriptionProfile {
                profile_id: prior.id.clone(),
                candidates,
            });
        }
    }
    if delta
        .profiles(base)
        .filter(|entry| entry.catalog_profile)
        .count()
        > MAX_CATALOG_PROFILES
    {
        return Err(format!(
            "каталог достиг лимита в {MAX_CATALOG_PROFILES} профилей. Удалите ненужные профили и повторите"
        ));
    }
    Ok(delta)
}

pub fn subscription_snapshot(profiles: &[Profile], id: &str) -> (String, usize) {
    let mut keys: Vec<_> = profiles
        .iter()
        .filter(|entry| entry.subscription_id == id && !entry.subscription_missing)
        .map(|entry| format!("{}|{}", entry.upstream_key, entry.upstream_name))
        .collect();
    keys.sort_unstable();
    (digest(keys.join("\n")), keys.len())
}

pub fn engine_profiles<'a>(
    profiles: &'a [Profile],
    active_targets: &HashSet<&str>,
    runtime_health_target: &str,
) -> Vec<&'a Profile> {
    profiles
        .iter()
        .filter(|entry| {
            !entry.catalog_profile
                || active_targets.contains(entry.id.as_str())
                || entry.id == runtime_health_target
        })
        .collect()
}

pub fn subscription_endpoint_key(entry: &Profile) -> String {
    if let Some(group) = &entry.xray_group {
        let mut members: Vec<_> = group
            .members
            .iter()
            .map(|member| json_endpoint_key(&member.outbound))
            .collect();
        if members.iter().any(String::is_empty) {
            return String::new();
        }
        members.sort_unstable();
        return format!("group|{}", digest(members.join("\n")));
    }
    if let Some(outbound) = &entry.outbound {
        if entry.protocol == "hysteria2" {
            return format!("hysteria2|{}", entry.endpoint());
        }
        return json_endpoint_key(outbound);
    }
    let Ok(parts) = validate_hostname_parts(&entry.uri) else {
        return String::new();
    };
    let query = parse_query(parts.query).unwrap_or_default();
    let fields = ["type", "security", "sni", "host", "path", "serviceName"];
    format!(
        "uri|{}|{}",
        node_location(&parts),
        fields.map(|name| query_value(&query, name)).join("|")
    )
}

fn json_endpoint_key(outbound: &Value) -> String {
    let Some((server, _)) = json_server(outbound) else {
        return String::new();
    };
    let address = socket_address(&normalize_host(&server.address), server.port);
    let stream = &outbound["streamSettings"];
    let get = |k| stream[k].as_str().unwrap_or_default();
    let inner = |k: &str, p: &str| stream[k][p].as_str().unwrap_or_default();
    [
        "json",
        &address,
        get("network"),
        get("security"),
        inner("tlsSettings", "serverName"),
        inner("realitySettings", "serverName"),
        inner("grpcSettings", "serviceName"),
        inner("wsSettings", "host"),
        inner("wsSettings", "path"),
        inner("xhttpSettings", "host"),
        inner("xhttpSettings", "path"),
        inner("splithttpSettings", "host"),
        inner("splithttpSettings", "path"),
        inner("httpupgradeSettings", "host"),
        inner("httpupgradeSettings", "path"),
    ]
    .join("|")
}
