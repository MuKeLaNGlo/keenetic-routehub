mod auth;
mod config;
mod core_api;
mod core_store;
mod diagnostics_api;
mod dns;
mod geo_cache;
mod imports_api;
mod lan;
mod managed_awg;
mod runtime;
mod runtime_dir;
mod saved_checks;
mod server;
mod storage;
mod subscriptions_api;
mod telemetry;
mod topology;
mod transaction;
mod vpn_health;
mod xray;
mod zapret;

use anyhow::{Context, Result, bail, ensure};
use config::Plan;
use runtime::{Selected, Settings};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};

struct Args {
    command: String,
    config: PathBuf,
    xray: PathBuf,
    output: Option<PathBuf>,
    panel_key: Option<PathBuf>,
    allow_lan: bool,
    log_file: Option<PathBuf>,
    helper_dir: PathBuf,
    dns_listen: Option<std::net::SocketAddr>,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut values = std::env::args().skip(1);
        let command = values
            .next()
            .filter(|command| {
                matches!(
                    command.as_str(),
                    "serve" | "check" | "compile" | "boot-enabled"
                )
            })
            .context("команда: routehub {serve|check|compile|boot-enabled} -config путь")?;
        let mut args = Self {
            command,
            config: "/opt/etc/routehub/config.json".into(),
            xray: "/opt/sbin/xray".into(),
            output: None,
            panel_key: None,
            allow_lan: false,
            log_file: None,
            helper_dir: "/opt/lib/routehub".into(),
            dns_listen: Some("127.0.0.1:18955".parse()?),
        };
        while let Some(raw) = values.next() {
            let (name, inline) = raw
                .trim_start_matches('-')
                .split_once('=')
                .map_or((raw.trim_start_matches('-'), None), |(name, value)| {
                    (name, Some(value.to_owned()))
                });
            let mut value = || {
                inline
                    .clone()
                    .or_else(|| values.next())
                    .with_context(|| format!("для -{name} укажите значение"))
            };
            match name {
                "config" => args.config = value()?.into(),
                "xray" => args.xray = value()?.into(),
                "output" => args.output = Some(value()?.into()),
                "panel-key-file" => args.panel_key = Some(value()?.into()),
                "log-file" => args.log_file = Some(value()?.into()),
                "allow-lan" => {
                    args.allow_lan = inline
                        .as_deref()
                        .map(str::parse::<bool>)
                        .transpose()?
                        .unwrap_or(true)
                }
                "helper-dir" => args.helper_dir = value()?.into(),
                "dns-listen" => {
                    let address = value()?;
                    args.dns_listen = if address.is_empty() {
                        None
                    } else {
                        Some(address.parse()?)
                    };
                }
                _ => bail!("flag provided but not defined: -{name}"),
            }
        }
        Ok(args)
    }
}

fn access_key(path: &Path) -> Result<String> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.len() <= 256 && meta.permissions().mode() & 0o077 == 0,
        "файл ключа должен быть приватным, например с правами 0600"
    );
    let mut value = String::new();
    file.take(257).read_to_string(&mut value)?;
    ensure!(
        value.trim().len() >= 24,
        "минимальная длина ключа панели — 24 символа"
    );
    Ok(value.trim().to_owned())
}

async fn run(args: Args, log: Option<Arc<storage::Log>>) -> Result<()> {
    if args.command == "boot-enabled" {
        if Settings::load(&args.config)?
            .is_some_and(|s| s.boot.vpn || s.boot.zapret_youtube || s.boot.zapret_discord)
        {
            println!("enabled");
        }
        return Ok(());
    }
    let (plan, geo) = Plan::load(&args.config)?;
    ensure!(
        !args.allow_lan || plan.transparent.is_some(),
        "флаг -allow-lan требует секцию transparent"
    );
    if args.command == "serve" {
        if let Some(address) = args.dns_listen {
            ensure!(
                address.port() != 0
                    && (address.ip().is_loopback() || address.ip().to_string() == plan.panel_host),
                "dns-listen должен слушать loopback или частный адрес панели"
            );
        }
        let initial_key = args.panel_key.as_deref().map(access_key).transpose()?;
        return server::serve(server::ServerConfig {
            plan,
            geo,
            engine: args.xray,
            config: args.config,
            initial_key,
            allow_lan: args.allow_lan,
            helper_dir: args.helper_dir,
            dns_listen: args.dns_listen,
            log,
        })
        .await;
    }
    let settings = Settings::load(&args.config)?;
    let selected = Selected::boot(&plan, settings.as_ref());
    let effective = selected.apply(plan);
    let policy = effective.policy(args.allow_lan, None, &geo)?;
    if args.command == "compile" {
        let xray_config = xray::compile(&effective, args.allow_lan, &policy, &HashMap::new())?;
        return xray::write_new(
            &args
                .output
                .context("укажите -output для записи приватного конфига")?,
            &xray_config,
        );
    }
    let directory = crate::runtime_dir::create()?;
    let file = xray::compile_runtime(&effective, args.allow_lan, &policy, &HashMap::new(), &geo)?
        .write(directory.path(), &geo, None)?;
    xray::check(&args.xray, &file).await?;
    println!("Xray принял сгенерированный конфиг");
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
    let args = match Args::parse() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let log = args
        .log_file
        .clone()
        .filter(|_| args.command == "serve")
        .map(|path| Arc::new(storage::Log::new(path)));
    if let Err(err) = run(args, log.clone()).await {
        if let Some(log) = log {
            let _ = log.append(&err.to_string());
        }
        eprintln!("{err}");
        return std::process::ExitCode::FAILURE;
    }
    std::process::ExitCode::SUCCESS
}
