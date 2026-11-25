use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::Result;
use sha2::{Digest, Sha256};

use crate::{config::Plan, runtime::Selected};

#[derive(Default)]
pub struct Pool {
    active: HashMap<String, Arc<Proxy>>,
}

struct Proxy {
    fingerprint: [u8; 32],
    port: u16,
    #[cfg(feature = "native-awg")]
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

#[cfg(feature = "native-awg")]
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Pool {
    pub async fn prepare(&self, plan: &Plan, selected: &Selected) -> Result<Self> {
        let referenced: HashSet<_> = std::iter::once(plan.default_target.as_str())
            .chain(
                plan.rules
                    .iter()
                    .filter(|rule| !rule.disabled)
                    .map(|rule| rule.target.as_str()),
            )
            .chain(plan.devices.iter().flat_map(|device| {
                std::iter::once(device.default_target.as_str()).chain(
                    device
                        .rules
                        .iter()
                        .filter(|rule| !rule.disabled)
                        .map(|rule| rule.target.as_str()),
                )
            }))
            .chain(selected.vpn.then_some(selected.profile.as_str()))
            .collect();
        let mut active = HashMap::new();
        for profile in plan.profiles.iter().filter(|profile| {
            profile.protocol == "amneziawg"
                && !profile.awg_config.is_empty()
                && referenced.contains(profile.id.as_str())
        }) {
            let mut hash = Sha256::new();
            hash.update(profile.awg_version.as_bytes());
            hash.update([0]);
            hash.update(profile.awg_config.as_bytes());
            let signature = hash.finalize().into();
            let proxy = match self
                .active
                .get(&profile.id)
                .filter(|entry| entry.fingerprint == signature)
            {
                Some(existing) => existing.clone(),
                None => Arc::new(Proxy::start(profile, signature).await?),
            };
            active.insert(profile.id.clone(), proxy);
        }
        Ok(Self { active })
    }

    pub fn ports(&self) -> HashMap<String, u16> {
        self.active
            .iter()
            .map(|(id, proxy)| (id.clone(), proxy.port))
            .collect()
    }
}

impl Proxy {
    #[cfg(feature = "native-awg")]
    async fn start(
        profile: &routehub_subscriptions::Profile,
        fingerprint: [u8; 32],
    ) -> Result<Self> {
        use anyhow::Context;
        let config = routehub_imports::parse_managed_awg(&profile.awg_config, &profile.awg_version)
            .map_err(anyhow::Error::msg)?;
        let tunnel = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            routehub_native_awg::Tunnel::start(&config),
        )
        .await
        .context("AmneziaWG не ответил при запуске")??;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let task = tokio::spawn(routehub_native_awg::serve_socks(listener, tunnel));
        Ok(Self {
            fingerprint,
            port,
            task,
        })
    }

    #[cfg(not(feature = "native-awg"))]
    async fn start(_: &routehub_subscriptions::Profile, _: [u8; 32]) -> Result<Self> {
        anyhow::bail!("Для управляемого AmneziaWG нужна сборка RouteHub с native-awg")
    }
}
