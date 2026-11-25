use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use tokio::{process::Command, time::timeout};

use crate::config::Plan;

pub struct Capture {
    helper: PathBuf,
    interface: String,
    source: String,
    listener: String,
    port: String,
    mode: Mode,
}

#[derive(Clone, Copy)]
enum Mode {
    Redirect,
    Tproxy,
}

impl Capture {
    pub fn new(plan: &Plan, directory: &Path) -> Result<Self> {
        ensure!(cfg!(target_os = "linux"), "Захват LAN доступен на Linux");
        let transparent = plan
            .transparent
            .as_ref()
            .context("флаг -allow-lan требует секцию transparent")?;
        let mode = if transparent.mode == "redirect-tcp" {
            Mode::Redirect
        } else {
            Mode::Tproxy
        };
        let helper = directory.join(match mode {
            Mode::Redirect => "routehub-redirect-tcp",
            Mode::Tproxy => "routehub-transparent",
        });
        let listener = plan.panel_host.clone();
        let bind = match mode {
            Mode::Redirect => listener.as_str(),
            Mode::Tproxy => "127.0.0.1",
        };
        std::net::TcpListener::bind((bind, transparent.port)).context("порт захвата LAN занят")?;
        Ok(Self {
            helper,
            mode,
            listener,
            interface: transparent.interface.clone(),
            source: transparent.source.clone(),
            port: transparent.port.to_string(),
        })
    }

    pub fn name(&self) -> &'static str {
        match self.mode {
            Mode::Redirect => "redirect-tcp",
            Mode::Tproxy => "tproxy",
        }
    }

    pub async fn prepare(&self) -> Result<()> {
        if matches!(self.mode, Mode::Redirect) {
            self.run(&[
                "prepare",
                &self.interface,
                &self.source,
                &self.listener,
                &self.port,
                &std::process::id().to_string(),
            ])
            .await?;
        }
        Ok(())
    }

    pub async fn activate(&self, engine_pid: u32) -> Result<()> {
        match self.mode {
            Mode::Redirect => self.run(&["activate", &engine_pid.to_string()]).await,
            Mode::Tproxy => {
                self.run(&[
                    "start",
                    &self.interface,
                    &self.source,
                    &self.port,
                    &std::process::id().to_string(),
                ])
                .await
            }
        }
    }

    pub async fn deactivate(&self) -> Result<()> {
        self.run(&[match self.mode {
            Mode::Redirect => "deactivate",
            Mode::Tproxy => "stop",
        }])
        .await
    }

    pub async fn cleanup(&self) -> Result<()> {
        self.run(&["stop"]).await
    }

    async fn run(&self, args: &[&str]) -> Result<()> {
        let status = timeout(
            Duration::from_secs(6),
            Command::new(&self.helper)
                .args(args)
                .kill_on_drop(true)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
        )
        .await
        .context("сетевой помощник не ответил")?
        .with_context(|| format!("не удалось запустить {}", self.name()))?;
        ensure!(
            status.success(),
            "сетевой помощник {}: команда {} завершилась со статусом {status}",
            self.name(),
            args[0]
        );
        Ok(())
    }
}
