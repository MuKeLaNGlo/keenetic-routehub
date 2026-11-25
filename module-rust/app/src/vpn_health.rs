use std::{
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::RwLock,
    time::Duration,
};

use anyhow::{Result, ensure};
use chrono::Utc;
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    sync::watch,
    time::{self, MissedTickBehavior},
};

use crate::{config::Plan, runtime::Selected};

pub struct Health {
    address: SocketAddrV4,
    user: String,
    password: String,
    selection: watch::Sender<Option<Active>>,
    latest: RwLock<Option<Value>>,
}

#[derive(Clone, PartialEq, Eq)]
struct Active {
    id: String,
    group: bool,
}

impl Health {
    pub async fn reserve(avoid: &[u16]) -> Result<(Self, TcpListener)> {
        for _ in 0..8 {
            let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
            let SocketAddr::V4(address) = reservation.local_addr()? else {
                continue;
            };
            if avoid.contains(&address.port()) {
                continue;
            }
            let mut nonce = [0u8; 32];
            getrandom::fill(&mut nonce).map_err(|error| io::Error::other(error.to_string()))?;
            return Ok((
                Self {
                    address,
                    user: hex::encode(&nonce[..8]),
                    password: hex::encode(&nonce[8..]),
                    selection: watch::channel(None).0,
                    latest: RwLock::new(None),
                },
                reservation,
            ));
        }
        anyhow::bail!("не удалось зарезервировать порт проверки VPN");
    }

    pub fn append_config(&self, config: &mut Value, plan: &Plan) -> Result<()> {
        const ID: &str = "routehub-vpn-health";
        let selected = (!plan.health_target.is_empty())
            .then(|| {
                plan.profiles
                    .iter()
                    .find(|profile| profile.id == plan.health_target)
            })
            .flatten();
        let route = match selected {
            Some(profile) if profile.xray_group.is_some() => {
                let tag = format!("@rh/group/{}", profile.id);
                ensure!(
                    config["routing"]["balancers"]
                        .as_array()
                        .is_some_and(|list| list.iter().any(|entry| entry["tag"] == tag)),
                    "активная группа VPN отсутствует в Xray"
                );
                json!({"type":"field","inboundTag":[ID],"balancerTag":tag})
            }
            Some(profile) => {
                ensure!(
                    config["outbounds"]
                        .as_array()
                        .is_some_and(|list| list.iter().any(|entry| entry["tag"] == profile.id)),
                    "активный выход VPN отсутствует в Xray"
                );
                json!({"type":"field","inboundTag":[ID],"outboundTag":profile.id})
            }
            None => json!({"type":"field","inboundTag":[ID],"outboundTag":"@block"}),
        };
        config["inbounds"].as_array_mut().expect("Xray inbounds").push(json!({
            "tag":ID,"listen":"127.0.0.1","port":self.address.port(),"protocol":"socks",
            "settings":{"auth":"password","accounts":[{"user":self.user,"pass":self.password}],"udp":false}
        }));
        config["routing"]["rules"]
            .as_array_mut()
            .expect("Xray route rules")
            .insert(0, route);
        Ok(())
    }

    pub fn select(&self, choice: Option<(&Selected, &Plan)>) {
        let next = choice
            .filter(|(choice, _)| choice.vpn)
            .and_then(|(choice, plan)| {
                plan.profiles
                    .iter()
                    .find(|profile| profile.id == choice.profile)
                    .map(|profile| Active {
                        id: profile.id.clone(),
                        group: profile.xray_group.is_some(),
                    })
            });
        *self
            .latest
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        self.selection.send_replace(next);
    }

    pub fn status(&self) -> Option<Value> {
        self.latest
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub async fn verify(&self, group: bool) -> bool {
        matches!(
            routehub_subscriptions::probe_socks_https(
                self.address,
                &self.user,
                &self.password,
                group
            )
            .await,
            Some((204, _))
        )
    }

    pub async fn run(&self) {
        let mut selected = self.selection.subscribe();
        let mut ticker = time::interval(Duration::from_secs(300));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = ticker.tick() => {},
                ready = selected.changed() => if ready.is_err() { return; }
            }
            let Some(active) = selected.borrow_and_update().clone() else {
                continue;
            };
            let result = tokio::select! {
                result = routehub_subscriptions::probe_socks_https(self.address, &self.user, &self.password, active.group) => result,
                _ = selected.changed() => { ticker.reset_immediately(); continue; },
            };
            let at = Utc::now();
            let status = match result {
                Some((204, ms)) => json!({"status":"verified","latencyMs":ms,"checkedAt":at,
                    "message":"Контрольный HTTPS-запрос прошёл через активный VPN."}),
                Some(_) => json!({"status":"unverified","checkedAt":at,
                    "message":"Контрольный HTTPS-запрос через активный VPN получил неожиданный ответ."}),
                None => json!({"status":"failed","checkedAt":at,
                    "message":"Контрольный HTTPS-запрос через активный VPN не получил ответа."}),
            };
            if !selected.has_changed().unwrap_or(true) {
                *self
                    .latest
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(status);
            }
        }
    }
}
