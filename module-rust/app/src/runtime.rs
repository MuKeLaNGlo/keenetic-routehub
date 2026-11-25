use crate::config::{Plan, ZapretServices};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs::File, io::Read, os::unix::fs::PermissionsExt, path::Path};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Boot {
    pub vpn: bool,
    pub profile: String,
    #[serde(rename = "zapretYouTube")]
    pub zapret_youtube: bool,
    pub zapret_discord: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Settings {
    pub boot: Boot,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_profile: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub youtube_strategy: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub discord_strategy: String,
}

#[derive(Clone, Default)]
pub struct Selected {
    pub vpn: bool,
    pub profile: String,
    pub youtube: bool,
    pub discord: bool,
    pub youtube_strategy: String,
    pub discord_strategy: String,
}

impl Settings {
    pub fn load(config: &Path) -> Result<Option<Self>> {
        let location = config.with_file_name("runtime.json");
        let file = match File::open(location) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let stat = file.metadata()?;
        ensure!(
            stat.is_file() && stat.len() <= 4096 && stat.permissions().mode() & 0o077 == 0,
            "runtime.json должен быть обычным приватным файлом не более 4 КиБ"
        );
        Ok(Some(
            serde_json::from_reader(file.take(4097)).context("некорректные настройки запуска")?,
        ))
    }
}

impl Selected {
    pub fn boot(plan: &Plan, settings: Option<&Settings>) -> Self {
        let find = |id: &str| plan.profiles.iter().any(|p| p.id == id);
        let first = || {
            plan.profiles
                .first()
                .map(|entry| entry.id.clone())
                .unwrap_or_default()
        };
        match settings {
            Some(settings) => {
                let profile = if !settings.boot.profile.is_empty() {
                    settings.boot.profile.clone()
                } else if find(&settings.last_profile) {
                    settings.last_profile.clone()
                } else {
                    first()
                };
                Self {
                    vpn: settings.boot.vpn && find(&profile),
                    profile,
                    youtube_strategy: settings.youtube_strategy.clone(),
                    discord_strategy: settings.discord_strategy.clone(),
                    ..Self::default()
                }
            }
            None => {
                let profile = if find(&plan.default_target) {
                    plan.default_target.clone()
                } else {
                    first()
                };
                Self {
                    vpn: !profile.is_empty(),
                    profile,
                    ..Self::default()
                }
            }
        }
    }

    pub fn zapret_active(&self) -> bool {
        self.youtube || self.discord
    }

    pub fn zapret_differs(&self, other: &Self) -> bool {
        self.youtube != other.youtube
            || self.discord != other.discord
            || self.youtube && self.youtube_strategy != other.youtube_strategy
            || self.discord && self.discord_strategy != other.discord_strategy
    }

    pub fn target<'a>(&'a self, target: &'a str) -> &'a str {
        if target == "@vpn" {
            return if self.vpn {
                self.profile.as_str()
            } else {
                "direct"
            };
        }
        if !self.vpn && !matches!(target, "direct" | "zapret" | "@block" | "")
            || target == "zapret" && !self.youtube && !self.discord
        {
            return "direct";
        }
        target
    }

    pub fn changes_policy(&self, plan: &Plan) -> bool {
        let original = plan.zapret_services.clone().unwrap_or_default();
        original.youtube != self.youtube
            || original.discord != self.discord
            || self.target(&plan.default_target) != plan.default_target
            || plan
                .rules
                .iter()
                .any(|rule| self.target(&rule.target) != rule.target)
            || plan.devices.iter().any(|device| {
                self.target(&device.default_target) != device.default_target
                    || device
                        .rules
                        .iter()
                        .any(|rule| self.target(&rule.target) != rule.target)
            })
    }

    pub fn apply(&self, mut plan: Plan) -> Plan {
        if self.vpn {
            plan.health_target.clone_from(&self.profile);
        }
        plan.default_target = self.target(&plan.default_target).to_owned();
        for rule in &mut plan.rules {
            rule.target = self.target(&rule.target).to_owned();
        }
        for device in &mut plan.devices {
            device.default_target = self.target(&device.default_target).to_owned();
            for rule in &mut device.rules {
                rule.target = self.target(&rule.target).to_owned();
            }
        }
        plan.zapret = self.youtube || self.discord;
        plan.zapret_services = Some(ZapretServices {
            youtube: self.youtube,
            discord: self.discord,
        });
        plan
    }

    pub fn state(&self, version: &str, plan: &Plan, boot: &Boot, lan: bool) -> Value {
        let mut state = json!({
            "vpn":{"enabled":self.vpn,"profile":self.profile,"available":!plan.profiles.is_empty()},
            "zapret":{"available":false,
               "youtube":{"enabled":self.youtube,"strategy":self.youtube_strategy},
               "discord":{"enabled":self.discord,"strategy":self.discord_strategy},"strategies":[]},
            "boot":boot,"lan":lan,
        });
        if !version.is_empty() {
            state["xrayVersion"] = json!(version);
        }
        state
    }
}
