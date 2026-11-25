use crate::{config::Plan, geo_cache::GeoCache};
use anyhow::{Context, Result, bail, ensure};
use routehub_policy::Plan as Policy;
use routehub_subscriptions::{Profile, XrayProfileGroup, profile_uri_outbound};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tempfile::{Builder, NamedTempFile};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::{Child, Command},
    time,
};

fn protocol_for(profile: &Profile) -> &str {
    if profile.protocol == "hysteria2" {
        "hysteria"
    } else {
        &profile.protocol
    }
}

fn outbound(profile: &Profile, managed: &HashMap<String, u16>) -> Result<Value> {
    if profile.protocol == "amneziawg" {
        if !profile.awg_config.is_empty() {
            let port = managed.get(&profile.id).copied().unwrap_or(1);
            return Ok(
                json!({"tag":profile.id,"protocol":"socks","settings":{"servers":[{"address":"127.0.0.1","port":port}]}}),
            );
        }
        return Ok(
            json!({"tag":profile.id,"protocol":"freedom","settings":{},"streamSettings":{"sockopt":{"interface":profile.interface}}}),
        );
    }
    if !profile.uri.is_empty() {
        return profile_uri_outbound(profile).map_err(anyhow::Error::msg);
    }
    let mut value = profile
        .outbound
        .clone()
        .context("outbound должен содержать соответствующий протокол Xray")?;
    ensure!(
        value.get("protocol").and_then(Value::as_str) == Some(protocol_for(profile)),
        "outbound должен содержать соответствующий протокол Xray"
    );
    value["tag"] = json!(profile.id);
    Ok(value)
}

pub(crate) fn group_outbound(
    id: &str,
    group: &XrayProfileGroup,
) -> Result<(Vec<Value>, Value, Vec<String>)> {
    ensure!(
        (2..=8).contains(&group.members.len()),
        "группа Xray должна содержать от 2 до 8 выходов"
    );
    ensure!(
        matches!(
            group.strategy.as_str(),
            "leastPing" | "leastLoad" | "random" | "roundRobin"
        ),
        "неизвестная стратегия группы Xray"
    );
    ensure!(
        group
            .fallback
            .is_none_or(|index| index < group.members.len()),
        "резервный выход должен принадлежать группе Xray"
    );
    let tag = |index| format!("@rh/member/{id}/{index}/");
    let mut members = Vec::with_capacity(group.members.len());
    let mut selectors = Vec::new();
    for (index, member) in group.members.iter().enumerate() {
        ensure!(
            member.protocol == "vless"
                && member.outbound.get("protocol").and_then(Value::as_str) == Some("vless"),
            "выход группы Xray должен быть самостоятельным VLESS"
        );
        if member.fallback_only {
            ensure!(
                group.fallback == Some(index),
                "выход вне пула может использоваться только как резервный"
            );
        } else {
            selectors.push(tag(index));
        }
        let mut value = member.outbound.clone();
        value["tag"] = json!(tag(index));
        members.push(value);
    }
    ensure!(
        !selectors.is_empty(),
        "выберите хотя бы один выход для балансировки"
    );
    let mut strategy = json!({"type":group.strategy});
    if let Some(settings) = &group.settings {
        let mut serialized = json!({"expected":settings.expected,"tolerance":settings.tolerance});
        if !settings.baselines.is_empty() {
            serialized["baselines"] = json!(settings.baselines);
        }
        if !settings.max_rtt.is_empty() {
            serialized["maxRTT"] = json!(settings.max_rtt);
        }
        let mut seen = HashSet::new();
        let mut weights = Vec::new();
        for cost in &settings.costs {
            ensure!(
                cost.member < members.len()
                    && seen.insert(cost.member)
                    && cost.value.is_finite()
                    && cost.value > 0.0
                    && cost.value <= 2e18,
                "некорректный вес выхода группы Xray"
            );
            weights.push(json!({"regexp":false,"match":tag(cost.member),"value":cost.value}));
        }
        if !weights.is_empty() {
            serialized["costs"] = json!(weights);
        }
        strategy["settings"] = serialized;
    }
    let balancer = json!({
        "tag":format!("@rh/group/{id}"),"selector":selectors,"strategy":strategy,
        "fallbackTag":group.fallback.map_or_else(|| "@block".into(), tag),
    });
    Ok((members, balancer, selectors))
}

pub fn compile(
    plan: &Plan,
    lan: bool,
    policy: &Policy,
    managed: &HashMap<String, u16>,
) -> Result<Value> {
    compile_with_assets(plan, lan, policy, managed, |_| String::new())
}

pub struct RuntimeConfig {
    pub json: Value,
    names: HashMap<String, String>,
}

pub fn compile_runtime(
    plan: &Plan,
    lan: bool,
    policy: &Policy,
    managed: &HashMap<String, u16>,
    geo: &GeoCache,
) -> Result<RuntimeConfig> {
    let mut names = HashMap::new();
    let json = compile_with_assets(plan, lan, policy, managed, |id| {
        let filename = geo.runtime_filename(id);
        if !filename.is_empty() {
            names.insert(id.to_owned(), filename.clone());
        }
        filename
    })?;
    Ok(RuntimeConfig { json, names })
}

fn compile_with_assets(
    plan: &Plan,
    lan: bool,
    policy: &Policy,
    managed: &HashMap<String, u16>,
    file_name: impl FnMut(&str) -> String,
) -> Result<Value> {
    let mut zapret = json!({"tag":"zapret","protocol":"freedom"});
    if plan.zapret {
        zapret["streamSettings"] = json!({"sockopt":{"mark":0x51000}});
    }
    let mut outbounds = vec![
        json!({"tag":"direct","protocol":"freedom"}),
        zapret,
        json!({"tag":"@block","protocol":"blackhole"}),
    ];
    let mut groups = HashMap::new();
    let mut balancers = Vec::new();
    let mut selectors = Vec::new();
    let referenced: HashSet<&str> = std::iter::once(plan.default_target.as_str())
        .chain(
            plan.rules
                .iter()
                .filter(|r| !r.disabled)
                .map(|r| r.target.as_str()),
        )
        .chain(plan.devices.iter().flat_map(|d| {
            std::iter::once(d.default_target.as_str()).chain(
                d.rules
                    .iter()
                    .filter(|r| !r.disabled)
                    .map(|r| r.target.as_str()),
            )
        }))
        .chain(Some(plan.health_target.as_str()))
        .collect();
    for profile in &plan.profiles {
        if profile.catalog_profile && !referenced.contains(profile.id.as_str()) {
            continue;
        }
        if let Some(group) = &profile.xray_group {
            let (members, balancer, tags) = group_outbound(&profile.id, group)?;
            groups.insert(profile.id.clone(), format!("@rh/group/{}", profile.id));
            outbounds.extend(members);
            balancers.push(balancer);
            selectors.extend(tags);
        } else {
            outbounds.push(
                outbound(profile, managed).with_context(|| format!("профиль {:?}", profile.id))?,
            );
        }
    }
    let mut inbounds = vec![
        json!({"tag":"local-socks","listen":"127.0.0.1","port":plan.socks_port,
        "protocol":"socks","settings":{"auth":"noauth","udp":true,"ip":"127.0.0.1"}}),
    ];
    if lan {
        let capture = plan
            .transparent
            .as_ref()
            .context("флаг -allow-lan требует секцию transparent")?;
        let (listen, network, mode) = if capture.mode == "redirect-tcp" {
            (plan.panel_host.as_str(), "tcp", "redirect")
        } else {
            ("127.0.0.1", "tcp,udp", "tproxy")
        };
        inbounds.push(
            json!({"tag":"lan-transparent","listen":listen,"port":capture.port,
            "protocol":"dokodemo-door","settings":{"network":network,"followRedirect":true},
            "streamSettings":{"sockopt":{"tproxy":mode}},
            "sniffing":{"enabled":true,"destOverride":["http","tls","quic"],"routeOnly":true}}),
        );
    }
    let mut rules =
        policy.xray_rules_with_assets(if lan { "lan-transparent" } else { "" }, file_name);
    for rule in &mut rules {
        if let Some(tag) = rule
            .get("outboundTag")
            .and_then(Value::as_str)
            .and_then(|id| groups.get(id))
        {
            let object = rule
                .as_object_mut()
                .context("правило Xray должно быть объектом")?;
            object.remove("outboundTag");
            object.insert("balancerTag".into(), json!(tag));
        }
    }
    let mut result = json!({"log":{"loglevel":"warning"},"inbounds":inbounds,"outbounds":outbounds,
        "routing":{"domainStrategy":"AsIs","rules":compact(rules)}});
    if !balancers.is_empty() {
        result["routing"]["balancers"] = json!(balancers);
        result["burstObservatory"] = json!({"subjectSelector":selectors,
            "pingConfig":{"destination":"https://www.gstatic.com/generate_204","interval":"45s","sampling":2,"timeout":"4s","httpMethod":"HEAD"}});
    }
    Ok(result)
}

fn compact(rules: Vec<Value>) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::with_capacity(rules.len());
    for rule in rules {
        let merged = result
            .last_mut()
            .and_then(Value::as_object_mut)
            .zip(rule.as_object())
            .is_some_and(|(previous, next)| {
                if next.len() != previous.len() {
                    return false;
                }
                for key in ["domain", "ip"] {
                    if let Some(items) = next.get(key).and_then(Value::as_array)
                        && previous.get(key).is_some_and(Value::is_array)
                        && previous
                            .iter()
                            .all(|(name, value)| name == key || next.get(name) == Some(value))
                        && let Some(previous) = previous.get_mut(key).and_then(Value::as_array_mut)
                    {
                        previous.extend(items.iter().cloned());
                        return true;
                    }
                }
                false
            });
        if !merged {
            result.push(rule);
        }
    }
    result
}

pub fn write_new(path: &Path, value: &Value) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = File::options()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    let mut file = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut file, value)?;
    file.flush()?;
    Ok(())
}

struct AssetFiles {
    dir: tempfile::TempDir,
    versions: Vec<(String, String)>,
}

pub struct ConfigFile {
    file: NamedTempFile,
    assets: Option<Arc<AssetFiles>>,
}

impl RuntimeConfig {
    pub fn write(
        &self,
        root: &Path,
        geo: &GeoCache,
        previous: Option<&ConfigFile>,
    ) -> Result<ConfigFile> {
        let versions = geo.runtime_versions(&self.names)?;
        let assets = if versions.is_empty() {
            None
        } else if let Some(previous) = previous
            .and_then(|file| file.assets.as_ref())
            .filter(|assets| assets.versions == versions)
        {
            Some(previous.clone())
        } else {
            let dir = Builder::new().prefix("xray-geo-").tempdir_in(root)?;
            geo.stage_runtime(&dir.path().join("assets"), &self.names)?;
            Some(Arc::new(AssetFiles { dir, versions }))
        };
        Ok(ConfigFile {
            file: write_private(&self.json, root)?,
            assets,
        })
    }
}

impl ConfigFile {
    pub fn path(&self) -> &Path {
        self.file.path()
    }

    fn set_environment(&self, command: &mut Command) {
        if let Some(assets) = &self.assets {
            command.env("XRAY_LOCATION_ASSET", assets.dir.path().join("assets"));
        }
    }

    pub fn fingerprint(&self) -> Result<[u8; 32]> {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        std::io::copy(&mut self.file.reopen()?, &mut hash)?;
        if let Some(assets) = &self.assets {
            serde_json::to_writer(&mut hash, &assets.versions)?;
        }
        Ok(hash.finalize().into())
    }
}

pub fn private_config(value: &Value) -> Result<ConfigFile> {
    Ok(ConfigFile {
        file: write_private(value, &std::env::temp_dir())?,
        assets: None,
    })
}

fn write_private(value: &Value, root: &Path) -> Result<NamedTempFile> {
    let mut file = Builder::new()
        .prefix("xray-config-")
        .suffix(".json")
        .tempfile_in(root)?;
    {
        let mut writer = BufWriter::new(file.as_file_mut());
        serde_json::to_writer(&mut writer, value)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(file)
}

pub fn private_copy(previous: &ConfigFile) -> Result<ConfigFile> {
    let parent = previous
        .path()
        .parent()
        .context("не найден каталог рабочего конфига")?;
    let mut file = Builder::new()
        .prefix("xray-config-")
        .suffix(".json")
        .tempfile_in(parent)?;
    std::io::copy(&mut previous.file.reopen()?, file.as_file_mut())?;
    Ok(ConfigFile {
        file,
        assets: previous.assets.clone(),
    })
}

pub async fn version(path: &Path) -> String {
    let output = time::timeout(
        Duration::from_secs(6),
        Command::new(path)
            .kill_on_drop(true)
            .arg("version")
            .output(),
    )
    .await;
    output
        .ok()
        .and_then(Result::ok)
        .filter(|result| result.status.success())
        .and_then(|result| {
            String::from_utf8_lossy(&result.stdout)
                .split_whitespace()
                .nth(1)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

pub async fn check(path: &Path, config: &ConfigFile) -> Result<()> {
    let mut command = Command::new(path);
    command
        .kill_on_drop(true)
        .args(["run", "-test", "-c"])
        .arg(config.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    config.set_environment(&mut command);
    let result = time::timeout(Duration::from_secs(10), command.status()).await??;
    ensure!(
        result.success(),
        "Xray отклонил конфиг ({}). Для диагностики сохраните private JSON командой compile",
        result
    );
    Ok(())
}

pub struct Engine {
    child: Child,
    config: ConfigFile,
}

impl Engine {
    pub async fn start(
        path: PathBuf,
        config: ConfigFile,
        socks: std::net::SocketAddr,
    ) -> Result<Self> {
        if std::net::TcpListener::bind(socks).is_err() {
            bail!("SOCKS-порт занят: {socks}");
        }
        let mut command = Command::new(path);
        command
            .kill_on_drop(true)
            .args(["run", "-c"])
            .arg(config.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "linux")]
        {
            let parent = std::process::id() as libc::pid_t;
            // SAFETY: the closure uses only async-signal-safe Linux syscalls after fork.
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
        }
        config.set_environment(&mut command);
        let mut child = command.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                bail!("ядро Xray завершилось при запуске: {status}");
            }
            let ready = time::timeout(Duration::from_millis(200), async {
                let mut socket = TcpStream::connect(socks).await?;
                socket.write_all(&[5, 1, 0]).await?;
                let mut reply = [0u8; 2];
                socket.read_exact(&mut reply).await?;
                Ok::<bool, std::io::Error>(reply == [5, 0])
            })
            .await;
            if matches!(ready, Ok(Ok(true))) {
                return Ok(Self { child, config });
            }
            time::sleep(Duration::from_millis(60)).await;
        }
        bail!("ядро Xray не открыло SOCKS-порт");
    }

    pub fn config_file(&self) -> &ConfigFile {
        &self.config
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn wait(&mut self) -> Result<std::process::ExitStatus> {
        Ok(self.child.wait().await?)
    }

    pub async fn stop(self) -> Result<()> {
        self.stop_for_restart().await.map(|_| ())
    }

    pub async fn stop_for_restart(mut self) -> Result<ConfigFile> {
        if self.child.try_wait()?.is_none() {
            if let Some(pid) = self.child.id() {
                // SAFETY: pid is the live direct child owned by this Engine.
                unsafe { libc::kill(pid as i32, libc::SIGTERM) };
            }
            if time::timeout(Duration::from_secs(1), self.child.wait())
                .await
                .is_err()
            {
                self.child.kill().await?;
            }
        }
        Ok(self.config)
    }
}
