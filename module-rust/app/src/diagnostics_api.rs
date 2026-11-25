use std::{
    collections::VecDeque,
    net::{IpAddr, Ipv4Addr, SocketAddrV4},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Json, Router, body,
    extract::{Request, State},
    http::{Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, SecondsFormat, Utc};
use routehub_policy::{Decision, Destination, normalize_mac};
use routehub_subscriptions::{is_public_ipv4, lookup_public_ipv4};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
    time::timeout,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::ServerName},
};

use crate::{
    auth::{Auth, error},
    config::Plan,
    server::{App, Published},
};

#[path = "diagnostic_connections.rs"]
mod connections;
pub(crate) use connections::observation_available;

const EVENT_LIMIT: usize = 120;
const TASK_LIMIT: usize = 24;
const PROBE_TIMEOUT: Duration = Duration::from_secs(18);
const DNS_TIMEOUT: Duration = Duration::from_secs(4);
const HTTP_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_HTTP_HEADERS: usize = 32 << 10;

pub(crate) struct Diagnostics {
    journal: Mutex<Journal>,
    probe: Arc<Semaphore>,
    observation: Semaphore,
}

#[derive(Default)]
struct Journal {
    events: VecDeque<Event>,
    tasks: VecDeque<Task>,
}

impl Default for Diagnostics {
    fn default() -> Self {
        let diagnostics = Self {
            journal: Mutex::new(Journal::default()),
            probe: Arc::new(Semaphore::new(1)),
            observation: Semaphore::new(1),
        };
        diagnostics.event(
            "engine",
            "info",
            "RouteHub",
            "Модуль запущен",
            "Журнал хранит последние события текущего запуска.",
        );
        diagnostics
    }
}

impl Diagnostics {
    fn events(&self) -> Vec<Event> {
        self.journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .events
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    fn tasks(&self) -> Vec<Task> {
        self.journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tasks
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    pub(crate) fn event(
        &self,
        kind: &'static str,
        severity: &'static str,
        name: &'static str,
        title: &'static str,
        detail: impl Into<String>,
    ) {
        let event = Event {
            id: event_id(),
            at: Utc::now(),
            kind,
            severity,
            object: EventObject { kind, name },
            title,
            detail: detail.into(),
        };
        let mut journal = self
            .journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        push_bounded(&mut journal.events, event, EVENT_LIMIT);
    }

    fn update_task(&self, task: Task) {
        let mut journal = self
            .journal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = journal.tasks.iter_mut().find(|entry| entry.id == task.id) {
            *existing = task;
        } else {
            push_bounded(&mut journal.tasks, task, TASK_LIMIT);
        }
    }
}

fn push_bounded<T>(items: &mut VecDeque<T>, value: T, limit: usize) {
    if items.len() == limit {
        items.pop_front();
    }
    items.push_back(value);
}

fn event_id() -> String {
    static FALLBACK: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0; 16];
    if getrandom::fill(&mut bytes).is_ok() {
        return hex::encode(bytes);
    }
    format!(
        "{:016x}{:016x}",
        Utc::now().timestamp_micros(),
        FALLBACK.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Serialize)]
struct Event {
    id: String,
    at: DateTime<Utc>,
    #[serde(rename = "type")]
    kind: &'static str,
    severity: &'static str,
    object: EventObject,
    title: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
}

#[derive(Clone, Serialize)]
struct EventObject {
    kind: &'static str,
    name: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    kind: &'static str,
    title: &'static str,
    scope: &'static str,
    state: &'static str,
    started_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<DateTime<Utc>>,
    steps: [TaskStep; 4],
    cancellable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<ProbeResult>,
}

#[derive(Clone, Serialize)]
struct TaskStep {
    label: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
}

pub(crate) fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/panel/events", get(events))
        .route("/api/panel/tasks", get(tasks))
        .route("/api/panel/support-report", get(support_report))
        .route("/api/panel/real-test", post(real_test))
        .route("/api/panel/connections/observe", post(connections::observe))
}

async fn events(State(app): State<Arc<App>>) -> Json<Vec<Event>> {
    Json(app.diagnostics.events())
}

async fn tasks(State(app): State<Arc<App>>) -> Json<Vec<Value>> {
    let mut tasks = app
        .diagnostics
        .tasks()
        .into_iter()
        .filter_map(|task| serde_json::to_value(task).ok())
        .collect::<Vec<_>>();
    tasks.extend(app.cores.tasks());
    tasks.sort_by(|left, right| {
        let instant = |entry: &Value| {
            entry["startedAt"]
                .as_str()
                .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        };
        instant(right).cmp(&instant(left))
    });
    tasks.truncate(TASK_LIMIT);
    Json(tasks)
}

fn audit_action(method: &Method, path: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match (method, path) {
        (&Method::PUT, "/api/plan") => ("apply", "Маршрутизация", "Применение конфигурации"),
        (&Method::POST, "/api/panel/revisions/restore") => {
            ("rollback", "Конфигурация", "Восстановление ревизии")
        }
        (&Method::PUT, "/api/runtime/vpn") => ("profile", "VPN", "Изменение активного VPN"),
        (&Method::PUT, "/api/runtime/zapret") => ("zapret", "Zapret", "Изменение режима Zapret"),
        (&Method::POST, "/api/runtime/zapret/auto") => {
            ("zapret", "Zapret", "Запрос подбора стратегии Zapret")
        }
        (&Method::POST, "/api/zapret/check") => ("zapret", "Zapret", "Запрос диагностики Zapret"),
        (&Method::PUT, "/api/runtime/boot") => {
            ("apply", "Автозапуск", "Сохранение настроек автозапуска")
        }
        (&Method::PUT, "/api/dns") => ("dns", "DNS", "Сохранение настроек DNS"),
        (&Method::POST, "/api/dns/test") => ("dns", "DNS", "Запрос диагностики DNS"),
        (&Method::POST, "/api/geoip/update") => {
            ("update", "Геоданные", "Запрос обновления геоданных")
        }
        _ => return None,
    })
}

pub(crate) async fn audit(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let action = audit_action(request.method(), request.uri().path());
    let response = next.run(request).await;
    if let Some((kind, name, title)) = action {
        let code = response.status();
        if code.is_success() {
            let (severity, detail) = if matches!(kind, "apply" | "rollback" | "profile") {
                ("ok", "Модуль подтвердил изменение.")
            } else {
                ("info", "Модуль обработал запрос.")
            };
            app.diagnostics.event(kind, severity, name, title, detail);
        } else if code.as_u16() >= 400
            && !matches!(code, StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED)
        {
            app.diagnostics.event(
                kind,
                "error",
                name,
                title,
                format!("Модуль отклонил запрос. HTTP {}.", code.as_u16()),
            );
        }
    }
    response
}

#[derive(Serialize)]
struct ReportLine {
    key: &'static str,
    value: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    redacted: bool,
}

impl ReportLine {
    fn new(key: &'static str, value: impl Into<String>) -> Self {
        Self {
            key,
            value: value.into(),
            redacted: false,
        }
    }

    fn hidden(key: &'static str) -> Self {
        Self {
            key,
            value: "Скрыты".into(),
            redacted: true,
        }
    }
}

#[derive(Serialize)]
struct ReportSection {
    title: &'static str,
    lines: Vec<ReportLine>,
}

fn report(plan: &Plan, state: &Value, runtime: &Value) -> Value {
    let mut profiles = Vec::with_capacity(5);
    for protocol in ["vless", "hysteria2", "trojan", "amneziawg"] {
        let count = plan
            .profiles
            .iter()
            .filter(|profile| profile.protocol == protocol)
            .count();
        if count != 0 {
            profiles.push(ReportLine::new(protocol, count.to_string()));
        }
    }
    profiles.push(ReportLine::hidden("Параметры подключения"));
    let started_at = state["startedAt"]
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_default();
    let mut arch = std::env::consts::ARCH;
    if arch == "aarch64" {
        arch = "arm64";
    } else if arch == "x86_64" {
        arch = "amd64";
    }
    let operating_system = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let sections = [
        ReportSection {
            title: "Модуль",
            lines: vec![
                ReportLine::new("RouteHub", state["version"].as_str().unwrap_or_default()),
                ReportLine::new("Платформа", format!("{operating_system}/{arch}")),
                ReportLine::new("Запуск", started_at),
                ReportLine::new(
                    "Сетевой режим",
                    state["lanMode"]
                        .as_str()
                        .filter(|mode| !mode.is_empty())
                        .unwrap_or("Локальный SOCKS"),
                ),
            ],
        },
        ReportSection {
            title: "Профили",
            lines: profiles,
        },
        ReportSection {
            title: "Политика",
            lines: vec![
                ReportLine::new("Глобальные правила", plan.rules.len().to_string()),
                ReportLine::new("Настроенные устройства", plan.devices.len().to_string()),
                ReportLine::hidden("Назначения правил и идентификаторы устройств"),
            ],
        },
        ReportSection {
            title: "Режим работы",
            lines: vec![
                ReportLine::new("VPN", on_off(&runtime["vpn"]["enabled"])),
                ReportLine::new(
                    "Zapret для YouTube",
                    on_off(&runtime["zapret"]["youtube"]["enabled"]),
                ),
                ReportLine::new(
                    "Zapret для Discord",
                    on_off(&runtime["zapret"]["discord"]["enabled"]),
                ),
            ],
        },
    ];
    let section_bytes = serde_json::to_vec(&sections).map_or(0, |encoded| encoded.len());
    json!({"sections":sections, "redactedCount":2, "sizeKb":section_bytes.div_ceil(1024)})
}

fn on_off(value: &Value) -> &'static str {
    if value == true {
        "Включён"
    } else {
        "Выключен"
    }
}

async fn support_report(State(app): State<Arc<App>>) -> Json<Value> {
    let snapshot = app.snapshot();
    Json(report(
        &snapshot.plan,
        app.diagnostics_status(),
        &snapshot.runtime,
    ))
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct RouteSource {
    #[serde(rename = "type")]
    kind: String,
    device_id: String,
    segment_id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct TraceQuery {
    source: RouteSource,
    target: String,
    resolved_ip: String,
    proto: String,
    port: u16,
    flow_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    target: String,
    exit_label: String,
    stages: [ProbeStage; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    total_ms: Option<u128>,
    observed_from: &'static str,
    note: &'static str,
}

#[derive(Clone, Serialize)]
struct ProbeStage {
    stage: &'static str,
    label: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ms: Option<u128>,
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
}

impl ProbeStage {
    fn fail(&mut self, detail: impl Into<String>) {
        self.state = "fail";
        self.detail = detail.into();
    }

    fn pass(&mut self, start: Instant, detail: impl Into<String>) {
        self.state = "ok";
        self.detail = detail.into();
        self.ms = Some(start.elapsed().as_millis());
    }
}

async fn diagnostic_request<T: serde::de::DeserializeOwned>(
    app: &App,
    request: Request,
) -> Result<T, Response> {
    if !app.auth.can_edit()
        || !Auth::same_origin(request.headers())
        || !app.auth.authorized(request.headers())
    {
        return Err(error(StatusCode::FORBIDDEN, "Доступ к управлению запрещён"));
    }
    let json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next().map(str::trim))
        == Some("application/json");
    if !json {
        return Err(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Требуется application/json",
        ));
    }
    body::to_bytes(request.into_body(), 2048)
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<T>(&body).ok())
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Некорректный запрос управления"))
}

async fn real_test(State(app): State<Arc<App>>, request: Request) -> Response {
    let query: TraceQuery = match diagnostic_request(&app, request).await {
        Ok(query) => query,
        Err(response) => return response,
    };
    let snapshot = app.snapshot();
    let client = match probe_source(&app, &snapshot.plan, &query.source).await {
        Ok(mac) => mac,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    if query.proto != "tcp" || !matches!(query.port, 80 | 443) || !query.flow_id.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "Роутер может выполнить HTTP или HTTPS по TCP на порту 80 или 443",
        );
    }
    let host = query.target.trim().to_lowercase();
    let input = Destination {
        host: host.strip_suffix('.').unwrap_or(&host).into(),
        target_ip: query.resolved_ip,
        client_mac: client,
        network: query.proto,
        port: query.port,
        ..Destination::default()
    };
    let decision = match snapshot.policy.evaluate(&input) {
        Ok(decision) => decision,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    let Ok(permit) = app.diagnostics.probe.clone().try_acquire_owned() else {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "Запрос с роутера уже выполняется",
        );
    };
    let execution = tokio::spawn(async move {
        let _permit = permit;
        execute(&app, snapshot, input, decision).await
    });
    match execution.await {
        Ok(task) => Json(task).into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось завершить проверку",
        ),
    }
}

async fn probe_source(
    app: &App,
    plan: &Plan,
    source: &RouteSource,
) -> Result<String, &'static str> {
    match source.kind.as_str() {
        "device" => {
            let mac = normalize_mac(&source.device_id).map_err(|_| "Выберите устройство")?;
            let capture = plan.transparent.as_ref().filter(|_| app.capture_active);
            let rejected =
                "Keenetic не подтвердил устройство в подсети действующего перехвата RouteHub";
            let capture = capture.ok_or(rejected)?;
            let prefix = capture.source.parse().map_err(|_| rejected)?;
            let topology = app.topology.snapshot(plan, true).await;
            if !topology.captured_device(&mac, &capture.interface, prefix) {
                return Err(rejected);
            }
            Ok(mac)
        }
        "segment" => {
            if plan
                .transparent
                .as_ref()
                .is_some_and(|capture| source.segment_id != capture.interface)
            {
                return Err("Выберите сегмент перехвата RouteHub");
            }
            Ok(String::new())
        }
        _ => Err("Выберите сегмент или устройство"),
    }
}

async fn execute(
    app: &App,
    snapshot: Arc<Published>,
    input: Destination,
    decision: Decision,
) -> Task {
    let stages = [
        ("dns", "DNS"),
        ("connect", "Соединение"),
        ("tls", "TLS"),
        ("app", "Ответ приложения"),
    ];
    let mut task = Task {
        id: event_id(),
        kind: "real-test",
        title: "Запрос с роутера",
        scope: "Диагностика",
        state: "running",
        started_at: Utc::now(),
        finished_at: None,
        steps: stages.map(|(stage, label)| TaskStep {
            label,
            state: if stage == "dns" { "running" } else { "pending" },
            detail: String::new(),
        }),
        cancellable: false,
        result: None,
    };
    app.diagnostics.update_task(task.clone());
    let mut result = ProbeResult {
        target: input.host.clone(),
        exit_label: "Выход определяется политикой".into(),
        stages: stages.map(|(stage, label)| ProbeStage {
            stage,
            label,
            state: "skipped",
            ms: None,
            detail: String::new(),
        }),
        total_ms: None,
        observed_from: "router",
        note: "Проверка с роутера использует выбранный политикой выход. Она не измеряет перехват на клиенте. Для DNS используется системный резолвер роутера.",
    };
    if timeout(
        PROBE_TIMEOUT,
        run_probe(app, &snapshot, input, decision, &mut result),
    )
    .await
    .is_err()
    {
        let stage = result
            .stages
            .iter_mut()
            .find(|stage| stage.state == "skipped" && stage.detail.is_empty());
        if let Some(stage) = stage {
            stage.fail("Проверка не завершилась за отведённое время.");
        }
    }
    let mut severity = "ok";
    let mut detail: &str = "Получен ожидаемый HTTP-ответ.";
    task.state = "done";
    for (step, stage) in task.steps.iter_mut().zip(&result.stages) {
        step.state = match stage.state {
            "ok" => "done",
            "fail" => {
                task.state = "error";
                severity = "warn";
                detail = &stage.detail;
                "error"
            }
            _ => "skipped",
        };
        step.detail = match stage.ms {
            Some(ms) if stage.detail.is_empty() => format!("{ms} мс"),
            Some(ms) => format!("{} {ms} мс", stage.detail),
            None => stage.detail.clone(),
        };
    }
    app.diagnostics
        .event("task", severity, task.scope, task.title, detail);
    task.finished_at = Some(Utc::now());
    task.result = Some(result);
    app.diagnostics.update_task(task.clone());
    task
}

fn specified_ipv4(text: &str) -> Result<Ipv4Addr, &'static str> {
    match text.parse::<IpAddr>().map(|ip| ip.to_canonical()) {
        Ok(IpAddr::V4(ip)) if is_public_ipv4(ip) => Ok(ip),
        _ => Err("Проверка принимает только публичный IPv4."),
    }
}

async fn resolve_ipv4(host: &str, specified: &str) -> Result<(Ipv4Addr, bool), &'static str> {
    if !specified.is_empty() {
        return specified_ipv4(specified).map(|ip| (ip, false));
    }
    if host.parse::<IpAddr>().is_ok() {
        return specified_ipv4(host).map(|ip| (ip, false));
    }
    timeout(DNS_TIMEOUT, lookup_public_ipv4(host))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or("Резолвер роутера не вернул IPv4.")?
        .first()
        .copied()
        .map(|ip| (ip, true))
        .ok_or("Публичный IPv4 среди DNS-ответов отсутствует.")
}

async fn run_probe(
    app: &App,
    snapshot: &Published,
    mut input: Destination,
    decision: Decision,
    result: &mut ProbeResult,
) {
    if decision.target == "@block" {
        result.exit_label = "Блокировка".into();
        result.stages[1].fail("Предварительный расчёт дал блокировку. Для уточнения правил IP укажите адрес назначения.");
        return;
    }
    let started = Instant::now();
    let (ip, resolved) = match resolve_ipv4(&input.host, &input.target_ip).await {
        Ok(outcome) => outcome,
        Err(message) => {
            result.stages[0].fail(message);
            return;
        }
    };
    if resolved {
        result.stages[0].pass(started, "Получен публичный IPv4.");
    } else {
        result.stages[0].detail = "Использован заданный IPv4.".into();
    }
    input.target_ip = ip.to_string();
    let route = match snapshot.policy.evaluate(&input) {
        Ok(route) => route,
        Err(_) => {
            result.stages[1].fail("Не удалось рассчитать выход для полученного адреса.");
            return;
        }
    };
    match route.target.as_str() {
        "@block" => {
            result.exit_label = "Блокировка".into();
            result.stages[1].fail("Соединение остановлено правилом блокировки.");
            return;
        }
        "zapret" => {
            result.exit_label = "Zapret".into();
            result.stages[1].fail("Для проверки очереди и конкретной стратегии используйте диагностику YouTube или Discord в разделе Zapret.");
            return;
        }
        _ => {}
    }
    let address = SocketAddrV4::new(ip, input.port);
    let profile = snapshot
        .plan
        .profiles
        .iter()
        .find(|profile| route.target == profile.id);
    result.exit_label = if route.target == "direct" {
        "Напрямую".into()
    } else {
        format!(
            "VPN · {}",
            profile
                .filter(|p| !p.label.is_empty())
                .map_or(route.target.as_str(), |p| p.label.as_str())
        )
    };
    let _budget = if route.target == "direct" {
        None
    } else {
        match app.subscriptions.probe_slot() {
            Some(slot) => Some(slot),
            None => {
                result.stages[1]
                    .fail("Проверяется другой профиль. Повторите через несколько секунд.");
                return;
            }
        }
    };
    let connect_started = Instant::now();
    let connection = connect_probe(app, address, &route.target, profile).await;
    let mut connection = match connection {
        Ok(connection) => connection,
        Err(message) => {
            result.stages[1].fail(message);
            return;
        }
    };
    result.stages[1].pass(connect_started, "TCP-соединение открыто.");
    if probe_http(&mut connection.stream, &input, result).await {
        result.total_ms = Some(started.elapsed().as_millis());
    }
}

trait ProbeStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ProbeStream for T {}

struct ProbeConnection {
    stream: Box<dyn ProbeStream>,
    _engine: Option<Box<dyn Send>>,
}

async fn connect_probe(
    app: &App,
    address: SocketAddrV4,
    target: &str,
    profile: Option<&routehub_subscriptions::Profile>,
) -> Result<ProbeConnection, &'static str> {
    if target == "direct" {
        let stream = timeout(Duration::from_secs(4), TcpStream::connect(address))
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or("Выбранный выход не установил TCP-соединение.")?;
        return Ok(ProbeConnection {
            stream: Box::new(stream),
            _engine: None,
        });
    }
    let profile = profile.ok_or("Рабочий адаптер выбранного выхода недоступен.")?;
    if !profile.awg_config.is_empty() {
        return connect_awg(profile, address).await;
    }
    let (stream, engine) =
        crate::subscriptions_api::connect_route(app.xray_path(), profile.clone(), address)
            .await
            .map_err(|_| "Не удалось запустить изолированную проверку выбранного профиля.")?;
    Ok(ProbeConnection {
        stream: Box::new(stream),
        _engine: Some(Box::new(engine)),
    })
}

#[cfg(feature = "native-awg")]
async fn connect_awg(
    profile: &routehub_subscriptions::Profile,
    address: SocketAddrV4,
) -> Result<ProbeConnection, &'static str> {
    let settings = routehub_imports::parse_managed_awg(&profile.awg_config, &profile.awg_version)
        .map_err(|_| "Выбранный туннель не готов к проверке.")?;
    let tunnel = routehub_native_awg::Tunnel::start(&settings)
        .await
        .map_err(|_| "Выбранный туннель не готов к проверке.")?;
    let stream = timeout(Duration::from_secs(5), tunnel.connect(address.into()))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or("Выбранный выход не установил TCP-соединение.")?;
    Ok(ProbeConnection {
        stream: Box::new(stream),
        _engine: Some(Box::new(tunnel)),
    })
}

#[cfg(not(feature = "native-awg"))]
async fn connect_awg(
    _: &routehub_subscriptions::Profile,
    _: SocketAddrV4,
) -> Result<ProbeConnection, &'static str> {
    Err("Рабочий адаптер выбранного выхода недоступен.")
}

fn tls_connector() -> TlsConnector {
    static CLIENT: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    TlsConnector::from(
        CLIENT
            .get_or_init(|| {
                let roots =
                    RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
                Arc::new(
                    ClientConfig::builder_with_provider(Arc::new(
                        tokio_rustls::rustls::crypto::ring::default_provider(),
                    ))
                    .with_safe_default_protocol_versions()
                    .expect("ring supports TLS 1.2 and 1.3")
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
                )
            })
            .clone(),
    )
}

async fn probe_http(
    connection: &mut Box<dyn ProbeStream>,
    input: &Destination,
    result: &mut ProbeResult,
) -> bool {
    let mut tls;
    let stream: &mut dyn ProbeStream = if input.port == 443 {
        let started = Instant::now();
        let client = ServerName::try_from(input.host.clone()).ok();
        let secured = if let Some(client) = client {
            timeout(
                HTTP_TIMEOUT,
                tls_connector().connect(client, &mut **connection),
            )
            .await
            .ok()
            .and_then(Result::ok)
        } else {
            None
        };
        let Some(secure) = secured else {
            result.stages[2]
                .fail("Сервер не завершил TLS с действительным сертификатом для назначения.");
            return false;
        };
        tls = secure;
        result.stages[2].pass(started, "Сертификат проверен.");
        &mut tls
    } else {
        result.stages[2].detail = "HTTP без TLS на порту 80.".into();
        &mut **connection
    };
    let started = Instant::now();
    let response = timeout(HTTP_TIMEOUT, fetch_header(stream, &input.host))
        .await
        .unwrap_or(Err("Сервер не вернул корректные HTTP-заголовки."));
    match response {
        Ok(status @ 200..=399) => {
            result.stages[3].pass(started, format!("HTTP {status}."));
            true
        }
        Ok(status) => {
            result.stages[3].fail(format!(
                "HTTP {status}. Сервер доступен, но приложение не подтвердило успешный запрос."
            ));
            false
        }
        Err(message) => {
            result.stages[3].fail(message);
            false
        }
    }
}

async fn fetch_header(stream: &mut dyn ProbeStream, host: &str) -> Result<u16, &'static str> {
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: RouteHub\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| "Не удалось отправить HTTP-запрос.")?;
    let invalid = "Сервер не вернул корректные HTTP-заголовки.";
    let mut header = Vec::new();
    let mut chunk = [0; 1024];
    while header.len() < MAX_HTTP_HEADERS {
        let amount = stream.read(&mut chunk).await.map_err(|_| invalid)?;
        if amount == 0 {
            break;
        }
        let previous = header.len();
        header.extend_from_slice(&chunk[..amount.min(MAX_HTTP_HEADERS - previous)]);
        if let Some(index) = header[previous.saturating_sub(3)..]
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
        {
            let end = previous.saturating_sub(3) + index;
            return parse_http_status(&header[..end]).ok_or(invalid);
        }
    }
    Err(invalid)
}

fn parse_http_status(header: &[u8]) -> Option<u16> {
    let mut lines = header.split(|byte| *byte == b'\n');
    let status = std::str::from_utf8(lines.next()?)
        .ok()?
        .trim_end_matches('\r');
    let (version, status) = status.split_once(' ')?;
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return None;
    }
    let code = status.split(' ').next()?;
    if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if lines.any(|line| {
        let name = line.split(|byte| *byte == b':').next().unwrap_or_default();
        !line.contains(&b':')
            || name.is_empty()
            || !name
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^`_|~".contains(byte))
    }) {
        return None;
    }
    code.parse::<u16>().ok().filter(|status| *status >= 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_limits_retention_and_reverses_order() {
        let diagnostics = Diagnostics::default();
        assert_eq!(diagnostics.events()[0].kind, "engine");
        for number in 0..EVENT_LIMIT + 2 {
            diagnostics.event("task", "ok", "Диагностика", "Запрос", number.to_string());
        }
        let events = diagnostics.events();
        assert_eq!(events.len(), EVENT_LIMIT);
        assert_eq!(events[0].detail, "121");
        assert_eq!(events.last().unwrap().detail, "2");
        assert_eq!(events[0].id.len(), 32);
    }

    #[test]
    fn report_counts_without_including_profile_or_routing_details() {
        let plan = Plan {
            profiles: vec![routehub_subscriptions::Profile {
                id: "private-profile".into(),
                label: "private-label".into(),
                uri: "vless://hidden@secret.example:443".into(),
                protocol: "vless".into(),
                ..Default::default()
            }],
            rules: vec![routehub_policy::Rule {
                domain: "hidden.example".into(),
                ..Default::default()
            }],
            ..Plan::default()
        };
        let report = report(
            &plan,
            &json!({"version":"1.2.3","startedAt":"2026-11-21T19:00:00.123456789Z"}),
            &json!({"vpn":{"enabled":true}}),
        );
        assert_eq!(report["redactedCount"], 2);
        assert_eq!(
            report["sections"][0]["lines"][2]["value"],
            "2026-11-21T19:00:00Z"
        );
        assert_eq!(
            report["sections"][1]["lines"][0],
            json!({"key":"vless","value":"1"})
        );
        assert_eq!(report["sections"][1]["lines"][1]["redacted"], true);
        assert_eq!(report["sections"][3]["lines"][0]["value"], "Включён");
        let text = report.to_string();
        for value in [
            "private-profile",
            "private-label",
            "hidden.example",
            "secret.example",
            "vless://",
        ] {
            assert!(!text.contains(value));
        }
    }

    #[tokio::test]
    async fn router_probe_rejects_local_destinations_and_reads_redirect_once() {
        for address in [
            "127.0.0.1",
            "100.100.100.200",
            "169.254.169.254",
            "192.168.10.1",
            "203.0.113.1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(resolve_ipv4(address, "").await.is_err(), "{address}");
        }
        assert_eq!(
            resolve_ipv4("example.com", "1.1.1.1").await,
            Ok((Ipv4Addr::new(1, 1, 1, 1), false))
        );
        let (mut request, mut server) = tokio::io::duplex(256);
        let serve = async {
            let mut buffer = [0; 256];
            let amount = server.read(&mut buffer).await.unwrap();
            assert!(buffer[..amount].starts_with(b"GET / HTTP/1.1\r\nHost: example.com\r\n"));
            server
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\n")
                .await
                .unwrap();
            server
                .write_all(b"Content-Length: 0\r\n\r\n")
                .await
                .unwrap();
        };
        let (status, _) = tokio::join!(fetch_header(&mut request, "example.com"), serve);
        assert_eq!(status, Ok(302));
        assert!(parse_http_status(b"HTTP/1.1 204 OK\r\nmalformed").is_none());
    }
}
