use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::{
    Json, Router, body,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use routehub_subscriptions::{
    CatalogReferences, Profile, ProfileDelta, Subscription, SubscriptionAttempt,
    SubscriptionPreview, SubscriptionSuccess, fetch_subscription, parse_subscription,
    pin_subscription_vless_node, profile_uri_outbound, public_subscriptions, subscription_endpoint,
    subscription_profile_changes, subscription_snapshot, validate_subscription_profiles,
    validate_subscriptions,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    auth::Auth,
    config::Plan,
    server::{App, Published, ServerError},
};

#[path = "subscription_probe.rs"]
mod probe;
pub(crate) use probe::{connect_route, pin_catalog_profiles};

const PREVIEW_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_REQUEST: usize = 4096;
const MAX_IMPORT_PROBE: usize = 32 << 10;
const PROBE_SLOTS: usize = 4;
const MIN_EXTRA_PROBE_MEMORY_KIB: u64 = 72 * 1024;
const CONFLICT: &str = "конфигурация изменилась. Обновите данные и получите новый предпросмотр";
const NOT_FOUND: &str = "подписка не найдена";

pub(crate) struct SubscriptionsState {
    pending: Mutex<HashMap<String, PreviewEntry>>,
    fetch_slot: tokio::sync::Mutex<()>,
    probes: tokio::sync::Semaphore,
    last_scheduled_id: Mutex<String>,
}

impl Default for SubscriptionsState {
    fn default() -> Self {
        Self {
            pending: Mutex::default(),
            fetch_slot: tokio::sync::Mutex::default(),
            probes: tokio::sync::Semaphore::new(PROBE_SLOTS),
            last_scheduled_id: Mutex::default(),
        }
    }
}

struct PreviewEntry {
    revision: String,
    token: String,
    expires: Instant,
    fetched_at: DateTime<Utc>,
    delta: ProfileDelta,
    validators: Option<(String, String)>,
}

fn lock<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|error| error.into_inner())
}

impl SubscriptionsState {
    fn prune(&self, revision: &str) {
        let now = Instant::now();
        lock(&self.pending).retain(|_, old| old.expires > now && old.revision == revision);
    }

    pub(crate) fn probe_slot(&self) -> Option<tokio::sync::SemaphorePermit<'_>> {
        let permit = self.probes.try_acquire().ok()?;
        if self.probes.available_permits() < PROBE_SLOTS - 2
            && !std::fs::read_to_string("/proc/meminfo")
                .ok()
                .is_some_and(|info| {
                    info.lines()
                        .find_map(|line| line.strip_prefix("MemAvailable:"))
                        .and_then(|line| line.split_whitespace().next())
                        .and_then(|value| value.parse::<u64>().ok())
                        .is_some_and(|available| available >= MIN_EXTRA_PROBE_MEMORY_KIB)
                })
        {
            return None;
        }
        Some(permit)
    }

    fn cache(&self, id: &str, entry: PreviewEntry) {
        let now = Instant::now();
        let mut pending = lock(&self.pending);
        pending.retain(|_, old| old.expires > now && old.revision == entry.revision);
        pending.insert(id.to_owned(), entry);
    }

    fn invalidate(&self, id: &str) {
        lock(&self.pending).remove(id);
    }

    fn refresh_entry(&self, id: &str, token: &str) -> Result<PreviewEntry, ServerError> {
        let mut pending = lock(&self.pending);
        if !pending
            .get(id)
            .is_some_and(|entry| valid_preview(entry, token))
        {
            return Err(conflict());
        }
        pending.remove(id).ok_or_else(conflict)
    }

    fn probe_entry(
        &self,
        request: &ProbeRequest,
        active: &Published,
    ) -> Result<Profile, ServerError> {
        let mut pending = lock(&self.pending);
        let entry = pending
            .get_mut(&request.subscription_id)
            .ok_or_else(conflict)?;
        if !valid_preview(entry, &request.preview_token) || entry.revision != active.revision {
            return Err(conflict());
        }
        let profile = entry
            .delta
            .profiles(&active.plan.profiles)
            .find(|profile| {
                profile.subscription_id == request.subscription_id
                    && !profile.subscription_missing
                    && (profile.upstream_key == request.profile_id
                        || profile.id == request.profile_id)
            })
            .cloned()
            .ok_or_else(|| fail(StatusCode::NOT_FOUND, "профиль не найден в предпросмотре"))?;
        entry.expires = Instant::now() + PREVIEW_TTL;
        Ok(profile)
    }
}

fn valid_preview(entry: &PreviewEntry, token: &str) -> bool {
    !token.is_empty() && entry.token == token && entry.expires > Instant::now()
}

fn fail(status: StatusCode, message: impl Into<String>) -> ServerError {
    ServerError {
        status,
        message: message.into(),
    }
}

fn conflict() -> ServerError {
    fail(StatusCode::CONFLICT, CONFLICT)
}

fn new_token() -> Result<String, ServerError> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| {
        fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "не удалось создать ревизию",
        )
    })?;
    Ok(hex::encode(nonce))
}

pub(crate) fn router() -> Router<Arc<App>> {
    Router::new()
        .route(
            "/api/panel/subscriptions",
            get(list).put(save).delete(remove),
        )
        .route("/api/panel/subscriptions/preview", post(preview))
        .route("/api/panel/subscriptions/refresh", post(refresh))
        .route("/api/panel/subscriptions/probe", post(probe_profile))
        .route("/api/runtime/latency", post(probe_stored))
        .route("/api/panel/profiles/import/probe", post(probe_import))
}

fn view(active: &Published) -> Value {
    json!({
        "subscriptions": public_subscriptions(&active.plan.subscriptions),
        "statuses": active.plan.subscriptions.iter().map(Subscription::status).collect::<Vec<_>>(),
        "revision": active.revision,
    })
}

async fn list(State(app): State<Arc<App>>) -> Json<Value> {
    Json(view(&app.snapshot()))
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct SaveRequest {
    revision: String,
    id: String,
    name: String,
    url: String,
    device_id: Option<String>,
    user_agent: Option<String>,
    interval_hours: i32,
    enabled: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct ChangeRequest {
    id: String,
    revision: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct PreviewRequest {
    id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct RefreshRequest {
    id: String,
    token: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct ProbeRequest {
    subscription_id: String,
    preview_token: String,
    profile_id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RuntimeProbeRequest {
    profile: String,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ImportProbeRequest {
    uri: String,
    outbound: Option<Value>,
}

pub(crate) async fn read_input<T: serde::de::DeserializeOwned>(
    app: &App,
    req: Request,
) -> Result<T, ServerError> {
    read_bounded_input(app, req, MAX_REQUEST).await
}

async fn read_bounded_input<T: serde::de::DeserializeOwned>(
    app: &App,
    req: Request,
    limit: usize,
) -> Result<T, ServerError> {
    if !app.auth.can_edit()
        || !app.auth.authorized(req.headers())
        || !Auth::same_origin(req.headers())
    {
        return Err(fail(StatusCode::FORBIDDEN, "Доступ к управлению запрещён"));
    }
    if !req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(fail(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Требуется application/json",
        ));
    }
    let raw = body::to_bytes(req.into_body(), limit)
        .await
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "Некорректный запрос управления"))?;
    serde_json::from_slice(&raw)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "Некорректный запрос управления"))
}

fn subscription_index(plan: &Plan, id: &str) -> Option<usize> {
    plan.subscriptions.iter().position(|source| source.id == id)
}

fn set_source(plan: &mut Plan, input: SaveRequest) -> Result<String, ServerError> {
    let enabled = input.enabled.ok_or_else(|| {
        fail(
            StatusCode::BAD_REQUEST,
            "укажите режим автоматического обновления подписки",
        )
    })?;
    let index = if input.id.is_empty() {
        let token = new_token()?;
        plan.subscriptions.push(Subscription {
            id: format!("sub-{}", &token[..16]),
            kind: "vless-list".into(),
            added_at: Some(Utc::now()),
            ..Subscription::default()
        });
        plan.subscriptions.len() - 1
    } else {
        subscription_index(plan, &input.id).ok_or_else(|| fail(StatusCode::NOT_FOUND, NOT_FOUND))?
    };
    let source = &mut plan.subscriptions[index];
    if !input.url.is_empty() {
        let endpoint = subscription_endpoint(&input.url)
            .map_err(|message| fail(StatusCode::BAD_REQUEST, message))?;
        if subscription_endpoint(&source.url).ok().as_ref() != Some(&endpoint) {
            if subscription_endpoint(&source.url)
                .is_ok_and(|old| old.host_str() != endpoint.host_str())
            {
                source.device_id.clear();
                source.user_agent.clear();
            }
            source.url = endpoint.to_string();
            source.etag.clear();
            source.last_modified.clear();
            source.last_attempt = None;
            source.last_success = None;
            source.added_at = Some(Utc::now());
        }
    }
    let changed_device = input.device_id.is_some_and(|device| {
        if source.device_id == device {
            return false;
        }
        source.device_id = device;
        true
    });
    let changed_agent = if let Some(agent) = input.user_agent {
        if agent.len() > 128 || !agent.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
            return Err(fail(
                StatusCode::BAD_REQUEST,
                "User-Agent должен содержать не более 128 печатных символов ASCII",
            ));
        }
        let agent = agent.trim();
        if source.user_agent == agent {
            false
        } else {
            source.user_agent = agent.to_owned();
            true
        }
    } else {
        false
    };
    if changed_device || changed_agent {
        source.etag.clear();
        source.last_modified.clear();
        source.last_attempt = None;
    }
    source.name = input.name;
    source.interval_hours = input.interval_hours;
    source.enabled = enabled;
    let id = source.id.clone();
    plan.subscriptions = validate_subscriptions(&plan.subscriptions)
        .map_err(|message| fail(StatusCode::BAD_REQUEST, message))?;
    Ok(id)
}

async fn save(State(app): State<Arc<App>>, req: Request) -> Result<Json<Value>, ServerError> {
    let input: SaveRequest = read_input(&app, req).await?;
    if input.enabled.is_none() {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "укажите режим автоматического обновления подписки",
        ));
    }
    let active = app.snapshot();
    if active.revision != input.revision {
        return Err(conflict());
    }
    let mut next = active.plan.clone();
    let id = set_source(&mut next, input)?;
    if active.plan.subscriptions != next.subscriptions {
        app.commit(&active.revision, next)
            .await
            .map_err(map_conflict)?;
        app.subscriptions.invalidate(&id);
        subscription_event(&app, "ok", "Настройки подписки сохранены");
    }
    Ok(Json(view(&app.snapshot())))
}

async fn remove(State(app): State<Arc<App>>, req: Request) -> Result<Json<Value>, ServerError> {
    let input: ChangeRequest = read_input(&app, req).await?;
    let active = app.snapshot();
    if active.revision != input.revision {
        return Err(conflict());
    }
    let mut next = active.plan.clone();
    let index = subscription_index(&next, &input.id)
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, NOT_FOUND))?;
    next.subscriptions.remove(index);
    for profile in &mut next.profiles {
        if profile.subscription_id == input.id {
            profile.subscription_id.clear();
            profile.upstream_name.clear();
            profile.upstream_key.clear();
            profile.subscription_missing = false;
        }
    }
    app.commit(&active.revision, next)
        .await
        .map_err(map_conflict)?;
    app.subscriptions.invalidate(&input.id);
    subscription_event(&app, "ok", "Подписка удалена, профили сохранены");
    Ok(Json(view(&app.snapshot())))
}

fn map_conflict(err: ServerError) -> ServerError {
    if err.status == StatusCode::CONFLICT {
        conflict()
    } else {
        err
    }
}

async fn build_preview(
    active: &Published,
    source: &Subscription,
) -> (SubscriptionPreview, Option<PreviewEntry>) {
    let mut description = SubscriptionPreview::new(&source.id, Utc::now());
    let result = load_preview(active, source, &mut description).await;
    match result {
        Ok(entry) => (description, Some(entry)),
        Err(message) => {
            description.error = message;
            (description, None)
        }
    }
}

async fn load_preview(
    active: &Published,
    source: &Subscription,
    preview: &mut SubscriptionPreview,
) -> Result<PreviewEntry, String> {
    let download = fetch_subscription(source).await?;
    let mut delta = ProfileDelta::default();
    let mut validators = None;
    if !download.unchanged {
        let parsed = parse_subscription(&download.body);
        drop(download.body);
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(error) => {
                preview.incompatible = error.incompatible;
                return Err(error.error);
            }
        };
        preview.incompatible = parsed.incompatible;
        let global: Vec<_> = active
            .plan
            .rules
            .iter()
            .map(|rule| rule.target.clone())
            .collect();
        let devices: Vec<_> = active
            .plan
            .devices
            .iter()
            .flat_map(|device| {
                std::iter::once(device.default_target.clone())
                    .chain(device.rules.iter().map(|rule| rule.target.clone()))
            })
            .collect();
        let refs = CatalogReferences {
            default_target: &active.plan.default_target,
            global_targets: &global,
            device_targets: &devices,
        };
        delta = subscription_profile_changes(
            &active.plan.profiles,
            source,
            &parsed.profiles,
            &refs,
            preview,
        )?;
        let [selected, boot] = active.profile_references();
        for row in &mut preview.missing {
            if selected == Some(row.profile_id.as_str()) {
                row.used_by.push("Основной профиль".into());
            }
            if boot == Some(row.profile_id.as_str()) {
                row.used_by.push("Автозапуск".into());
            }
        }
        validators = Some((download.etag, download.modified));
    }
    let token = new_token().map_err(|error| error.message)?;
    preview.token.clone_from(&token);
    preview.ok = true;
    Ok(PreviewEntry {
        token,
        revision: active.revision.clone(),
        expires: Instant::now() + PREVIEW_TTL,
        fetched_at: preview.fetched_at,
        delta,
        validators,
    })
}

async fn preview(
    State(app): State<Arc<App>>,
    req: Request,
) -> Result<Json<SubscriptionPreview>, ServerError> {
    let input: PreviewRequest = read_input(&app, req).await?;
    let active = app.snapshot();
    let idx = subscription_index(&active.plan, &input.id)
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, NOT_FOUND))?;
    let _fetch = app.subscriptions.fetch_slot.try_lock().map_err(|_| {
        fail(
            StatusCode::TOO_MANY_REQUESTS,
            "уже загружается другая подписка",
        )
    })?;
    let (description, entry) = build_preview(&active, &active.plan.subscriptions[idx]).await;
    if let Some(entry) = entry {
        app.subscriptions.cache(&input.id, entry);
    } else {
        fail_attempt(
            &app,
            &active.revision,
            &input.id,
            description.fetched_at,
            &description.error,
        )
        .await;
    }
    Ok(Json(description))
}

async fn refresh(State(app): State<Arc<App>>, req: Request) -> Result<Json<Value>, ServerError> {
    let input: RefreshRequest = read_input(&app, req).await?;
    let _fetch = app.subscriptions.fetch_slot.lock().await;
    let entry = app.subscriptions.refresh_entry(&input.id, &input.token)?;
    let fetched_at = entry.fetched_at;
    let revision = entry.revision.clone();
    match apply_preview(&app, &input.id, entry).await {
        Ok((revision, count)) => Ok(Json(json!({"revision":revision,"profiles":count}))),
        Err(err) if err.status == StatusCode::CONFLICT => Err(conflict()),
        Err(err) => {
            fail_attempt(
                &app,
                &revision,
                &input.id,
                fetched_at,
                "не удалось применить обновление подписки",
            )
            .await;
            Err(fail(StatusCode::UNPROCESSABLE_ENTITY, err.message))
        }
    }
}

async fn apply_preview(
    app: &App,
    id: &str,
    entry: PreviewEntry,
) -> Result<(String, usize), ServerError> {
    let active = app.snapshot();
    if active.revision != entry.revision {
        return Err(conflict());
    }
    let index = subscription_index(&active.plan, id).ok_or_else(conflict)?;
    let mut next = active.plan.clone();
    let unchanged = entry.delta.unchanged();
    entry.delta.apply(&mut next.profiles);
    let (snapshot, profiles) = subscription_snapshot(&next.profiles, id);
    if profiles == 0 {
        return Err(fail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "в подписке нет совместимых профилей",
        ));
    }
    let source = &mut next.subscriptions[index];
    source.last_attempt = Some(SubscriptionAttempt {
        at: entry.fetched_at,
        ok: true,
        reason: String::new(),
    });
    source.last_success = Some(SubscriptionSuccess {
        at: entry.fetched_at,
        revision: snapshot,
        profiles,
    });
    if let Some((etag, modified)) = entry.validators {
        source.etag = etag;
        source.last_modified = modified;
    }
    validate_subscription_profiles(&next.profiles, &next.subscriptions)
        .map_err(|message| fail(StatusCode::UNPROCESSABLE_ENTITY, message))?;
    let revision = if unchanged {
        app.commit_status(&entry.revision, next).await?;
        entry.revision
    } else {
        app.commit(&entry.revision, next).await?
    };
    subscription_event(app, "ok", "Подписка обновлена");
    Ok((revision, profiles))
}

async fn fail_attempt(app: &App, revision: &str, id: &str, at: DateTime<Utc>, reason: &str) {
    let active = app.snapshot();
    if active.revision != revision {
        return;
    }
    let Some(index) = subscription_index(&active.plan, id) else {
        return;
    };
    let mut next = active.plan.clone();
    next.subscriptions[index].last_attempt = Some(SubscriptionAttempt {
        at,
        ok: false,
        reason: reason.into(),
    });
    let _ = app.commit_status(revision, next).await;
    subscription_event(app, "warn", "Не удалось обновить подписку");
}

fn subscription_event(app: &App, severity: &'static str, title: &'static str) {
    app.diagnostics
        .event("subscription", severity, "Подписки", title, "");
}

async fn probe_profile(State(app): State<Arc<App>>, req: Request) -> Result<Response, ServerError> {
    let input: ProbeRequest = read_input(&app, req).await?;
    let profile = app.subscriptions.probe_entry(&input, &app.snapshot())?;
    Ok(probe_response(&app, profile).await)
}

async fn probe_stored(State(app): State<Arc<App>>, req: Request) -> Result<Response, ServerError> {
    let input: RuntimeProbeRequest = read_input(&app, req).await?;
    let profile = app
        .snapshot()
        .plan
        .profiles
        .iter()
        .find(|profile| profile.id == input.profile)
        .cloned()
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Профиль VPN не найден"))?;
    Ok(probe_response(&app, profile).await)
}

async fn probe_import(State(app): State<Arc<App>>, req: Request) -> Result<Response, ServerError> {
    let input: ImportProbeRequest = read_bounded_input(&app, req, MAX_IMPORT_PROBE).await?;
    let profile = Profile {
        id: "preview-vless".into(),
        protocol: "vless".into(),
        uri: input.uri.trim().to_owned(),
        outbound: input.outbound,
        ..Profile::default()
    };
    let valid = match (profile.uri.is_empty(), profile.outbound.is_some()) {
        (true, true) => pin_subscription_vless_node(&profile, Ipv4Addr::new(1, 1, 1, 1)).is_ok(),
        (false, false) => profile_uri_outbound(&profile).is_ok(),
        _ => false,
    };
    if !valid {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "Для проверки нужен самостоятельный профиль VLESS",
        ));
    }
    Ok(probe_response(&app, profile).await)
}

async fn probe_response(app: &App, profile: Profile) -> Response {
    let Some(_permit) = app.subscriptions.probe_slot() else {
        return (
            [(header::RETRY_AFTER, "1")],
            fail(
                StatusCode::TOO_MANY_REQUESTS,
                "На роутере заняты все слоты проверки VPN",
            ),
        )
            .into_response();
    };
    let result = if profile.protocol == "amneziawg" && !profile.awg_config.is_empty() {
        let port = app.managed_awg_port(&profile.id);
        probe::run_managed_awg(profile.id, port).await
    } else {
        probe::run(app.xray_path(), profile).await
    };
    Json(result).into_response()
}

pub(crate) async fn schedule(app: Arc<App>) {
    if !app.auth.can_edit() {
        return;
    }
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        refresh_due(&app, Utc::now()).await;
    }
}

async fn refresh_due(app: &App, now: DateTime<Utc>) {
    let active = app.snapshot();
    app.subscriptions.prune(&active.revision);
    let Ok(_fetch) = app.subscriptions.fetch_slot.try_lock() else {
        return;
    };
    let len = active.plan.subscriptions.len();
    let start = subscription_index(&active.plan, &lock(&app.subscriptions.last_scheduled_id))
        .map_or(0, |index| index + 1);
    let Some(source) = (0..len)
        .map(|offset| &active.plan.subscriptions[(start + offset) % len])
        .find(|source| source.status().next_run.is_some_and(|due| due <= now))
    else {
        return;
    };
    lock(&app.subscriptions.last_scheduled_id).clone_from(&source.id);
    let (preview, entry) = build_preview(&active, source).await;
    if let Some(entry) = entry {
        if apply_preview(app, &source.id, entry).await.is_err() {
            fail_attempt(
                app,
                &active.revision,
                &source.id,
                preview.fetched_at,
                "не удалось применить обновление подписки",
            )
            .await;
        }
    } else {
        fail_attempt(
            app,
            &active.revision,
            &source.id,
            preview.fetched_at,
            &preview.error,
        )
        .await;
    }
}
