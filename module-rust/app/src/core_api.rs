use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::AbortHandle;

use crate::{
    core_store::{self, ManagedCore, UpdateCheck},
    server::{App, ServerError},
    subscriptions_api::read_input,
};

const CANDIDATE_TTL: Duration = Duration::from_secs(15 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const HISTORY_LIMIT: usize = 12;
const TASK_LIMIT: usize = 24;

#[derive(Default)]
pub(crate) struct CoreState {
    state: Mutex<CoreInner>,
}

struct CoreInner {
    state: &'static str,
    checksum: &'static str,
    target: Option<String>,
    checks: Vec<Step>,
    history: VecDeque<Record>,
    tasks: VecDeque<CoreTask>,
    candidate: Option<ManagedCore>,
    expiration: Option<AbortHandle>,
}

impl Default for CoreInner {
    fn default() -> Self {
        Self {
            state: "up-to-date",
            checksum: "untested",
            target: None,
            checks: Vec::new(),
            history: VecDeque::new(),
            tasks: VecDeque::new(),
            candidate: None,
            expiration: None,
        }
    }
}

impl CoreState {
    fn lock(&self) -> MutexGuard<'_, CoreInner> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(crate) fn tasks(&self) -> Vec<Value> {
        self.lock()
            .tasks
            .iter()
            .rev()
            .filter_map(|task| serde_json::to_value(task).ok())
            .collect()
    }
}

impl CoreInner {
    fn cancel_expiry(&mut self) {
        if let Some(timer) = self.expiration.take() {
            timer.abort();
        }
    }

    fn start(&mut self, install: bool) -> Result<(CoreTask, Option<ManagedCore>), ServerError> {
        if matches!(self.state, "checking" | "updating") {
            return Err(fail(
                StatusCode::CONFLICT,
                "операция с ядром уже выполняется",
            ));
        }
        if install && (self.state != "available" || self.candidate.is_none()) {
            return Err(fail(
                StatusCode::CONFLICT,
                "сначала проверьте и подготовьте обновление Xray",
            ));
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| {
            fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "не удалось создать задачу Xray",
            )
        })?;
        let task = CoreTask::new(hex::encode(bytes), install);
        self.cancel_expiry();
        let candidate = self.candidate.take();
        self.state = if install { "updating" } else { "checking" };
        if !install {
            self.target = None;
            self.checks.clear();
            self.checksum = "untested";
        }
        push(&mut self.tasks, TASK_LIMIT, task.clone());
        Ok((task, if install { candidate } else { None }))
    }

    fn complete(&mut self, task: &CoreTask) {
        if let Some(entry) = self.tasks.iter_mut().find(|entry| entry.id == task.id) {
            *entry = task.clone();
        }
    }
}

fn push<T>(entries: &mut VecDeque<T>, limit: usize, entry: T) {
    if entries.len() == limit {
        entries.pop_front();
    }
    entries.push_back(entry);
}

#[derive(Clone, Serialize)]
struct Step {
    label: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
}

fn step(label: &'static str, state: &'static str, detail: impl Into<String>) -> Step {
    Step {
        label,
        state,
        detail: detail.into(),
    }
}

#[derive(Serialize)]
struct Record {
    at: DateTime<Utc>,
    from: String,
    to: String,
    result: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreTask {
    id: String,
    kind: &'static str,
    title: &'static str,
    scope: &'static str,
    state: &'static str,
    started_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<DateTime<Utc>>,
    steps: Vec<Step>,
    cancellable: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
}

impl CoreTask {
    fn new(id: String, install: bool) -> Self {
        Self {
            id,
            kind: "update",
            title: if install {
                "Обновление Xray"
            } else {
                "Проверка обновления Xray"
            },
            scope: "Xray",
            state: "running",
            started_at: Utc::now(),
            finished_at: None,
            steps: Vec::new(),
            cancellable: false,
            error: String::new(),
        }
    }

    fn finish(&mut self, outcome: &'static str, error: String, steps: &[Step]) {
        self.state = outcome;
        self.error = error;
        self.finished_at = Some(Utc::now());
        self.steps = steps
            .iter()
            .map(|step| Step {
                state: match step.state {
                    "ok" => "done",
                    "fail" => "error",
                    _ => "skipped",
                },
                ..step.clone()
            })
            .collect();
    }
}

pub(crate) fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/panel/cores/updates", get(list))
        .route("/api/panel/cores/xray/check", post(check))
        .route("/api/panel/cores/xray/install", post(install))
}

async fn list(State(app): State<Arc<App>>) -> Json<Value> {
    let current = app.runtime_xray_version();
    let state = app.cores.lock();
    Json(serde_json::json!([{
        "component": "xray", "name": "Xray", "current": current, "channel": "stable",
        "target": state.target, "state": state.state, "signature": "unknown",
        "checksum": {"state": state.checksum, "algorithm": "sha256", "source": "github-releases"},
        "autoUpdate": false, "checks": state.checks, "history": state.history,
    }]))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

async fn check(
    State(app): State<Arc<App>>,
    req: Request,
) -> Result<(StatusCode, Json<CoreTask>), ServerError> {
    let _: Empty = read_input(&app, req).await?;
    let (task, _) = app.cores.lock().start(false)?;
    let response = task.clone();
    tokio::spawn(check_background(app, task));
    Ok((StatusCode::ACCEPTED, Json(response)))
}

async fn install(
    State(app): State<Arc<App>>,
    req: Request,
) -> Result<(StatusCode, Json<CoreTask>), ServerError> {
    let _: Empty = read_input(&app, req).await?;
    let (task, candidate) = app.cores.lock().start(true)?;
    let candidate = candidate.ok_or_else(|| fail(StatusCode::CONFLICT, "пакет Xray недоступен"))?;
    let response = task.clone();
    tokio::spawn(install_background(app, task, candidate));
    Ok((StatusCode::ACCEPTED, Json(response)))
}

async fn check_background(app: Arc<App>, mut task: CoreTask) {
    let current = app.runtime_xray_version();
    let result = tokio::time::timeout(
        CHECK_TIMEOUT,
        core_store::prepare_update(&app.core_runtime_dir, &app.data_dir, &current),
    )
    .await;
    let result = result.unwrap_or_else(|_| {
        Err(anyhow::anyhow!(
            "проверка обновления Xray превысила время ожидания"
        ))
    });
    let mut state = app.cores.lock();
    match result {
        Ok(UpdateCheck::Current { latest }) => {
            state.state = "up-to-date";
            state
                .checks
                .push(step("Последний стабильный релиз", "ok", latest));
            task.finish("done", String::new(), &state.checks);
        }
        Ok(UpdateCheck::Available(candidate)) => {
            let candidate_version = candidate.version().to_owned();
            let candidate_path = candidate.path().to_owned();
            state.target = Some(candidate_version.clone());
            state.state = "available";
            state.checksum = "ok";
            state.checks.extend([
                step("SHA-256 из GitHub Releases", "ok", ""),
                step("Запуск кандидата на ARM64", "ok", candidate_version),
            ]);
            state.candidate = Some(candidate);
            let app = Arc::downgrade(&app);
            let timer = tokio::spawn(async move {
                tokio::time::sleep(CANDIDATE_TTL).await;
                if let Some(app) = app.upgrade() {
                    let mut state = app.cores.lock();
                    if state.state == "available"
                        && state
                            .candidate
                            .as_ref()
                            .is_some_and(|candidate| candidate.path() == candidate_path)
                    {
                        state.candidate = None;
                        state.expiration = None;
                        state.state = "blocked";
                        state.checksum = "untested";
                        state.checks = vec![step(
                            "Срок проверки пакета",
                            "fail",
                            "Повторите проверку перед установкой",
                        )];
                    }
                }
            });
            state.expiration = Some(timer.abort_handle());
            task.finish("done", String::new(), &state.checks);
        }
        Err(error) => {
            let reason = error.to_string();
            state.state = "blocked";
            state
                .checks
                .push(step("Проверка кандидата Xray", "fail", reason.clone()));
            task.finish("error", reason, &state.checks);
        }
    }
    state.complete(&task);
    drop(state);
    report(&app, &task);
}

async fn install_background(app: Arc<App>, mut task: CoreTask, candidate: ManagedCore) {
    let current = app.runtime_xray_version();
    let target = candidate.version().to_owned();
    let result = app.install_core(candidate).await;
    let mut state = app.cores.lock();
    let (history, outcome, error) = match result {
        Ok(()) => {
            state.state = "up-to-date";
            state.target = None;
            state
                .checks
                .push(step("Активная конфигурация и контрольный HTTPS", "ok", ""));
            ("ok", "done", String::new())
        }
        Err(error) => {
            let restored = error
                .message
                .to_lowercase()
                .contains("прежнее ядро xray восстановлено");
            state.state = if restored { "rolled-back" } else { "failed" };
            state
                .checks
                .push(step("Установка Xray", "fail", error.message.clone()));
            if restored {
                ("rolled-back", "restored", error.message)
            } else {
                ("failed", "error", error.message)
            }
        }
    };
    push(
        &mut state.history,
        HISTORY_LIMIT,
        Record {
            at: Utc::now(),
            from: current,
            to: target,
            result: history,
        },
    );
    task.finish(outcome, error, &state.checks);
    state.complete(&task);
    drop(state);
    report(&app, &task);
}

fn report(app: &App, task: &CoreTask) {
    let severity = match task.state {
        "done" => "ok",
        "restored" => "warn",
        _ => "error",
    };
    app.diagnostics
        .event("update", severity, "Xray", task.title, task.error.clone());
}

fn fail(status: StatusCode, message: &str) -> ServerError {
    ServerError {
        status,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_is_exclusive_and_install_requires_a_prepared_core() {
        let mut state = CoreInner::default();
        assert_eq!(
            state.start(true).err().unwrap().status,
            StatusCode::CONFLICT
        );
        let (mut task, _) = state.start(false).unwrap();
        assert_eq!(
            state.start(false).err().unwrap().status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            state.start(true).err().unwrap().status,
            StatusCode::CONFLICT
        );
        let running = serde_json::to_value(&task).unwrap();
        assert_eq!(running["state"], "running");
        assert_eq!(running["cancellable"], false);
        assert!(running.get("finishedAt").is_none());
        task.finish(
            "error",
            "fixture failed".into(),
            &[step("check", "fail", "details")],
        );
        state.complete(&task);
        let done = serde_json::to_value(&state.tasks[0]).unwrap();
        assert_eq!(done["state"], "error");
        assert_eq!(done["steps"][0]["state"], "error");
        assert!(done.get("finishedAt").is_some());
    }
}
