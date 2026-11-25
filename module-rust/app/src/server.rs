use crate::{
    auth::{Auth, error},
    config::Plan,
    core_store::{self, ManagedCore},
    geo_cache::{GeoCache, GeoUpdate},
    runtime::{Selected, Settings},
    storage::{Log, LogStorage},
    transaction, xray,
    zapret::Zapret,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::{self, Body, Bytes},
    extract::{ConnectInfo, Request, State},
    http::{HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use ipnet::IpNet;
use routehub_policy::{Binding, Destination, Plan as Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
};

const HTML: &str = include_str!("../../../module/panel/dist/index.html");
const LEGACY: &str = include_str!("../../../module/index.html");
const TRAFFIC_JS: &str = include_str!("../../../module/panel_traffic.js");
const CONTENT_POLICY: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

#[derive(Clone)]
pub(crate) struct Published {
    pub(crate) plan: Plan,
    pub(crate) revision: String,
    pub(crate) policy: Arc<Policy>,
    configured: Arc<Policy>,
    geo: Arc<GeoCache>,
    public: Bytes,
    pub(crate) runtime: Value,
}

impl Published {
    pub(crate) fn profile_references(&self) -> [Option<&str>; 2] {
        [
            self.runtime["vpn"]["profile"].as_str(),
            self.runtime["boot"]["profile"].as_str(),
        ]
        .map(|value| value.filter(|id| !id.is_empty()))
    }
}

pub(crate) struct App {
    authority: String,
    allowed: IpNet,
    pub(crate) auth: Arc<Auth>,
    state: RwLock<Arc<Published>>,
    status: Value,
    log: Option<Arc<Log>>,
    pub(crate) data_dir: PathBuf,
    engine_path: PathBuf,
    updates: mpsc::Sender<WorkerMessage>,
    pub(crate) topology: crate::topology::TopologyCache,
    pub(crate) capture_active: bool,
    telemetry: Arc<crate::telemetry::Telemetry>,
    zapret: Arc<Zapret>,
    health: Option<Arc<crate::vpn_health::Health>>,
    pub(crate) subscriptions: crate::subscriptions_api::SubscriptionsState,
    pub(crate) core_runtime_dir: PathBuf,
    pub(crate) cores: crate::core_api::CoreState,
    pub(crate) diagnostics: crate::diagnostics_api::Diagnostics,
    dns: crate::dns::DnsControl,
    managed_awg_ports: RwLock<std::collections::HashMap<String, u16>>,
    geo_slot: tokio::sync::Semaphore,
}

#[derive(Debug)]
pub(crate) struct ServerError {
    pub status: StatusCode,
    pub message: String,
}

impl ServerError {
    fn apply(err: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            message: err.to_string(),
        }
    }
    fn conflict() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: "Правила изменились. Загрузите свежую конфигурацию".into(),
        }
    }
    fn unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Применение конфигурации недоступно".into(),
        }
    }
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        error(self.status, &self.message)
    }
}

enum WorkerMessage {
    Plan(Box<PlanChange>),
    Runtime(RuntimeChange, oneshot::Sender<Result<Value, ServerError>>),
    Core(ManagedCore, oneshot::Sender<Result<(), ServerError>>),
    Geo(GeoUpdate, oneshot::Sender<Result<(), ServerError>>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VpnChange {
    enabled: bool,
    #[serde(default)]
    profile: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ZapretChange {
    service: String,
    enabled: bool,
    #[serde(default)]
    strategy: String,
}

enum RuntimeChange {
    Vpn(VpnChange),
    Boot(crate::runtime::Boot),
    Zapret(ZapretChange),
    AutoZapret(String),
}

struct PlanChange {
    expected: String,
    next: Plan,
    status_only: bool,
    result: oneshot::Sender<Result<String, ServerError>>,
}

impl App {
    pub(crate) fn snapshot(&self) -> Arc<Published> {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    async fn runtime_view(&self) -> Value {
        let current = self.snapshot();
        let mut state = current.runtime.clone();
        if let Some(status) = self.health.as_ref().and_then(|health| health.status()) {
            state["vpn"]["health"] = status;
        }
        if current.plan.zapret {
            state["zapret"]["strategies"] = json!(self.zapret.strategies());
            state["zapret"]["available"] = json!(self.zapret.capability().await);
        }
        state
    }

    pub(crate) fn diagnostics_status(&self) -> &Value {
        &self.status
    }

    async fn refresh_geo(&self, id: &str) -> Result<(), ServerError> {
        let _permit = self.geo_slot.try_acquire().map_err(|_| ServerError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "Дождитесь текущего обновления GeoIP".into(),
        })?;
        let update = self
            .snapshot()
            .geo
            .prepare_update(id)
            .await
            .map_err(ServerError::apply)?;
        let (result, recv) = oneshot::channel();
        self.updates
            .try_send(WorkerMessage::Geo(update, result))
            .map_err(|_| ServerError::unavailable())?;
        recv.await.map_err(|_| ServerError::unavailable())?
    }

    pub(crate) fn runtime_xray_version(&self) -> String {
        self.snapshot().runtime["xrayVersion"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    pub(crate) async fn install_core(&self, candidate: ManagedCore) -> Result<(), ServerError> {
        let (result, recv) = oneshot::channel();
        self.updates
            .try_send(WorkerMessage::Core(candidate, result))
            .map_err(|_| ServerError::unavailable())?;
        recv.await.map_err(|_| ServerError::unavailable())?
    }

    pub(crate) fn managed_awg_port(&self, id: &str) -> Option<u16> {
        self.managed_awg_ports
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .copied()
    }

    fn update_awg_ports(&self, awg: &crate::managed_awg::Pool) {
        *self
            .managed_awg_ports
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = awg.ports();
    }

    pub(crate) fn xray_path(&self) -> &Path {
        &self.engine_path
    }

    pub(crate) async fn commit(&self, expected: &str, next: Plan) -> Result<String, ServerError> {
        self.submit(expected, next, false).await
    }

    pub(crate) async fn commit_status(
        &self,
        expected: &str,
        next: Plan,
    ) -> Result<(), ServerError> {
        self.submit(expected, next, true).await.map(|_| ())
    }

    async fn submit(
        &self,
        expected: &str,
        next: Plan,
        status_only: bool,
    ) -> Result<String, ServerError> {
        let (result, recv) = oneshot::channel();
        self.updates
            .try_send(WorkerMessage::Plan(Box::new(PlanChange {
                expected: expected.into(),
                next,
                status_only,
                result,
            })))
            .map_err(|_| ServerError::unavailable())?;
        recv.await.map_err(|_| ServerError::unavailable())?
    }
}

pub struct ServerConfig {
    pub plan: Plan,
    pub geo: GeoCache,
    pub engine: PathBuf,
    pub config: PathBuf,
    pub initial_key: Option<String>,
    pub allow_lan: bool,
    pub helper_dir: PathBuf,
    pub dns_listen: Option<SocketAddr>,
    pub log: Option<Arc<Log>>,
}

pub async fn serve(config: ServerConfig) -> Result<()> {
    let ServerConfig {
        plan,
        geo,
        engine,
        config,
        initial_key,
        allow_lan,
        helper_dir,
        dns_listen,
        log,
    } = config;
    let capture = allow_lan
        .then(|| crate::lan::Capture::new(&plan, &helper_dir))
        .transpose()?;
    let avoid = [
        plan.panel_port,
        plan.socks_port,
        plan.transparent.as_ref().map_or(0, |lan| lan.port),
        dns_listen.map_or(0, |address| address.port()),
    ];
    let (health, reservation) = match crate::vpn_health::Health::reserve(&avoid).await {
        Ok((health, reservation)) => (Some(Arc::new(health)), Some(reservation)),
        Err(_) => (None, None),
    };
    let topology = crate::topology::TopologyCache::default();
    let inventory = inventory_for(&topology, &plan, allow_lan).await;
    let data_dir = config.parent().unwrap_or(Path::new(".")).to_path_buf();
    let zapret = Arc::new(Zapret::new(helper_dir.clone(), data_dir.clone()));
    let settings = Settings::load(&config)?;
    let mut selected = Selected::boot(&plan, settings.as_ref());
    if plan.zapret {
        if let Some(settings) = &settings {
            selected.youtube = settings.boot.zapret_youtube
                && zapret.has_strategy("youtube", &selected.youtube_strategy);
            selected.discord = settings.boot.zapret_discord
                && zapret.has_strategy("discord", &selected.discord_strategy);
        } else if allow_lan && let Some(services) = &plan.zapret_services {
            selected.youtube = services.youtube && zapret.has_strategy("youtube", "custom");
            selected.discord = services.discord && zapret.has_strategy("discord", "custom");
            selected.youtube_strategy = "custom".into();
            selected.discord_strategy = "custom".into();
        }
    }
    let mut prepared = selected.apply(plan.clone());
    crate::subscriptions_api::pin_catalog_profiles(&mut prepared).await?;
    let awg = crate::managed_awg::Pool::default()
        .prepare(&prepared, &selected)
        .await?;
    let settings = settings.unwrap_or_default();
    let engine = std::fs::canonicalize(engine)?;
    let runtime_dir = crate::runtime_dir::create()?;
    let core_link = runtime_dir.path().join("xray-active");
    repoint_core(&core_link, &engine)?;
    let mut version = xray::version(&engine).await;
    let mut published = publish(
        plan,
        &selected,
        &version,
        &settings.boot,
        new_revision()?,
        inventory.clone(),
        Arc::new(geo),
    )?;
    let mut compiled = xray::compile_runtime(
        &prepared,
        allow_lan,
        &published.policy,
        &awg.ports(),
        &published.geo,
    )?;

    let address = published.plan.panel()?;
    let listener = TcpListener::bind(address).await?;
    let socks = published.plan.socks();
    if let Err(err) = zapret.select(&Selected::default(), &selected).await {
        if let Some(log) = &log {
            let _ = log.append(&err.to_string());
        }
        selected.youtube = false;
        selected.discord = false;
        published = publish(
            published.plan,
            &selected,
            &version,
            &settings.boot,
            published.revision,
            inventory,
            published.geo,
        )?;
        compiled = xray::compile_runtime(
            &selected.apply(prepared.clone()),
            allow_lan,
            &published.policy,
            &awg.ports(),
            &published.geo,
        )?;
    }
    if let Some(health) = &health {
        health.append_config(&mut compiled.json, &prepared)?;
    }
    let xray_config = compiled.write(runtime_dir.path(), &published.geo, None)?;
    let compiled_digest = xray_config.fingerprint()?;
    drop(compiled);
    drop(prepared);
    let mut managed =
        match core_store::restore(&config, runtime_dir.path(), &engine, &xray_config).await {
            Ok(candidate) => candidate,
            Err(err) => {
                if let Some(log) = &log {
                    let _ = log.append(&err.to_string());
                }
                None
            }
        };
    if let Some(candidate) = &managed {
        repoint_core(&core_link, candidate.path())?;
    }
    drop(reservation);
    let xray = async {
        xray::check(&core_link, &xray_config).await?;
        if managed.is_some() {
            let candidate_config = xray::private_copy(&xray_config)?;
            match initial_engine(&core_link, candidate_config, socks, capture.as_ref()).await {
                Ok(instance) => {
                    if let Some(candidate) = &managed {
                        version = candidate.version().to_owned();
                    }
                    return Ok(instance);
                }
                Err(err) => {
                    if let Some(log) = &log {
                        let _ = log.append(&err.to_string());
                    }
                    repoint_core(&core_link, &engine)?;
                    managed = None;
                }
            }
        }
        initial_engine(&core_link, xray_config, socks, capture.as_ref()).await
    }
    .await;
    let xray = match xray {
        Ok(engine) => engine,
        Err(err) => {
            let _ = zapret.select(&selected, &Selected::default()).await;
            return Err(err);
        }
    };
    if version.is_empty() {
        published
            .runtime
            .as_object_mut()
            .map(|value| value.remove("xrayVersion"));
    } else {
        published.runtime["xrayVersion"] = json!(version);
    }
    let auth = Arc::new(Auth::new(
        config.with_file_name("panel-password.json"),
        initial_key,
    ));
    let allowed = if address.ip().is_loopback() {
        "127.0.0.0/8".parse()?
    } else {
        published.plan.panel_network.parse()?
    };
    let lan_dns = (|| {
        let lan = published.plan.transparent.as_ref()?;
        crate::dns::LanDns::new(
            &helper_dir,
            &lan.interface,
            lan.source.parse().ok()?,
            published.plan.panel_host.parse().ok()?,
            dns_listen?.port(),
            allowed,
        )
    })();
    let dns_scope = if dns_listen.is_some_and(|address| address.ip().is_loopback()) {
        "127.0.0.0/8".parse()?
    } else {
        allowed
    };
    let dns = match crate::dns::DnsControl::start(data_dir.clone(), dns_listen, dns_scope, lan_dns)
        .await
    {
        Ok(dns) => dns,
        Err(error) => {
            if let Some(capture) = &capture {
                let _ = capture.cleanup().await;
            }
            let _ = zapret.select(&selected, &Selected::default()).await;
            let _ = xray.stop().await;
            return Err(error);
        }
    };
    let mut status = json!({"socks":socks.to_string(),"lan":allow_lan,"zapret":false,"panel":format!("http://{address}"),
        "version":env!("CARGO_PKG_VERSION"),"startedAt":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos,true),
        "canEdit":auth.can_edit()});
    if let Some(capture) = capture.as_ref() {
        status["lanMode"] = json!(capture.name());
    }
    let (updates, receiver) = mpsc::channel(1);
    let telemetry = Arc::new(crate::telemetry::Telemetry::new(data_dir.clone()));
    telemetry.set_xray_pid(xray.pid());
    if let Some(health) = &health {
        health.select(Some((&selected, &published.plan)));
    }
    let app = Arc::new(App {
        authority: address.to_string(),
        allowed,
        auth,
        state: RwLock::new(Arc::new(published)),
        status,
        log: log.clone(),
        data_dir,
        topology,
        capture_active: allow_lan,
        telemetry: telemetry.clone(),
        zapret,
        health: health.clone(),
        engine_path: core_link,
        updates,
        subscriptions: Default::default(),
        core_runtime_dir: runtime_dir.path().to_path_buf(),
        cores: Default::default(),
        diagnostics: Default::default(),
        dns,
        managed_awg_ports: RwLock::new(awg.ports()),
        geo_slot: tokio::sync::Semaphore::new(1),
    });
    let routes = Router::new()
        .route(
            "/",
            get(|| async { asset(HTML, "text/html; charset=utf-8") }),
        )
        .route(
            "/legacy",
            get(|| async { asset(LEGACY, "text/html; charset=utf-8") }),
        )
        .route(
            "/panel-traffic.js",
            get(|| async { asset(TRAFFIC_JS, "text/javascript; charset=utf-8") }),
        )
        .route(
            "/api/status",
            get(|State(app): State<Arc<App>>| async move {
                let mut status = app.status.clone();
                let snapshot = app.snapshot();
                status["zapret"] = json!(
                    snapshot.runtime["zapret"]["youtube"]["enabled"] == true
                        || snapshot.runtime["zapret"]["discord"]["enabled"] == true
                );
                Json(status)
            }),
        )
        .route(
            "/api/plan",
            get(|State(app): State<Arc<App>>| async move {
                public_response(app.snapshot().public.clone())
            })
            .put(edit_plan),
        )
        .route(
            "/api/runtime",
            get(|State(app): State<Arc<App>>| async move { Json(app.runtime_view().await) }),
        )
        .route("/api/evaluate", post(evaluate))
        .route("/api/geoip/update", post(geo_update))
        .route("/api/runtime/vpn", axum::routing::put(set_vpn))
        .route("/api/dns", get(dns_status).put(dns_apply))
        .route("/api/dns/test", post(dns_test))
        .route("/api/panel/capabilities", get(capabilities))
        .route(
            "/api/geoip",
            get(|State(app): State<Arc<App>>| async move {
                let snapshot = app.snapshot();
                Json(json!({"sources":snapshot.geo.status()}))
            }),
        )
        .route("/api/runtime/boot", axum::routing::put(set_boot))
        .route("/api/runtime/zapret", axum::routing::put(set_zapret))
        .route("/api/runtime/zapret/auto", post(zapret_auto))
        .route("/api/zapret/check", post(zapret_test))
        .route("/api/runtime/boot/check", post(boot_check))
        .route(
            "/api/panel/session",
            get(session).post(session).put(session).delete(session),
        )
        .route("/api/panel/password", axum::routing::put(session))
        .route(
            "/api/panel/log-storage",
            get(|State(app): State<Arc<App>>| async move {
                Json(
                    app.log
                        .as_ref()
                        .map_or_else(LogStorage::disabled, |log| log.status()),
                )
            }),
        )
        .route("/api/panel/revisions", get(revisions))
        .route("/api/panel/revisions/restore", post(restore_revision))
        .route("/api/panel/apply/preview", post(preview_plan))
        .route("/api/panel/saved-checks/results", get(saved_check_results))
        .route("/api/backup", post(backup))
        .route("/api/panel/router-resources", get(resources))
        .route("/api/devices", get(devices))
        .route(
            "/api/panel/topology",
            get(|State(app): State<Arc<App>>| async move {
                Json(
                    app.topology
                        .snapshot(&app.snapshot().plan, app.capture_active)
                        .await,
                )
            }),
        )
        .route(
            "/api/traffic",
            get(|State(app): State<Arc<App>>| async move { Json(app.telemetry.traffic()) }),
        )
        .merge(crate::subscriptions_api::router())
        .merge(crate::imports_api::router())
        .merge(crate::diagnostics_api::router())
        .merge(crate::core_api::router())
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(
            app.clone(),
            crate::diagnostics_api::audit,
        ))
        .layer(middleware::from_fn_with_state(app.clone(), boundary))
        .with_state(app.clone());
    let msg = format!("RouteHub готов, панель {address}, SOCKS {socks}");
    if log.as_ref().is_none_or(|log| log.append(&msg).is_err()) {
        eprintln!("{msg}");
    }
    let server = axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = shutdown().await;
    });
    let refresh = crate::subscriptions_api::schedule(app.clone());
    let geo_refresh = watch_geo(app.clone());
    let mut worker = Worker {
        app,
        config,
        receiver,
        engine: Some(xray),
        digest: compiled_digest,
        selected,
        settings,
        version,
        socks,
        capture,
        awg,
        managed,
        _runtime_dir: runtime_dir,
    };
    let refresh = async {
        refresh.await;
        std::future::pending::<()>().await
    };
    let health_worker = async {
        if let Some(health) = health {
            health.run().await;
        }
        std::future::pending::<()>().await
    };
    let (stop, stopping) = oneshot::channel();
    let mut task = tokio::spawn(async move {
        let result = run_transactions(&mut worker, stopping).await;
        worker.app.dns.shutdown().await;
        let zapret = worker
            .app
            .zapret
            .select(&worker.selected, &Selected::default())
            .await;
        let capture = if let Some(capture) = &worker.capture {
            capture.cleanup().await
        } else {
            Ok(())
        };
        let engine = if let Some(engine) = worker.engine.take() {
            engine.stop().await
        } else {
            Ok(())
        };
        result.and(zapret).and(capture).and(engine)
    });
    let result = tokio::select! {
        _=health_worker=>unreachable!(),
        _=geo_refresh=>unreachable!(),
        _=refresh=>unreachable!(),
        _=telemetry.run()=>unreachable!(),
        result=server=>result.map_err(anyhow::Error::from),
        result=&mut task=>return result?,
    };
    let _ = stop.send(());
    result.and(task.await?)
}

async fn initial_engine(
    path: &Path,
    config: xray::ConfigFile,
    socks: SocketAddr,
    capture: Option<&crate::lan::Capture>,
) -> Result<xray::Engine> {
    let Some(capture) = capture else {
        return xray::Engine::start(path.to_owned(), config, socks).await;
    };
    capture.prepare().await?;
    let engine = xray::Engine::start(path.to_owned(), config, socks).await;
    match engine {
        Ok(engine) => {
            if let Err(error) = capture
                .activate(engine.pid().context("ядро Xray завершилось")?)
                .await
            {
                let _ = capture.cleanup().await;
                let _ = engine.stop().await;
                return Err(error);
            }
            Ok(engine)
        }
        Err(error) => {
            let _ = capture.cleanup().await;
            Err(error)
        }
    }
}

async fn inventory_for(
    topology: &crate::topology::TopologyCache,
    plan: &Plan,
    capture: bool,
) -> Option<Vec<Binding>> {
    if !capture {
        return None;
    }
    Some(
        topology
            .snapshot(plan, true)
            .await
            .neighbors()
            .iter()
            .map(|neighbor| Binding {
                mac: neighbor.mac.clone(),
                address: neighbor.address.clone(),
                fixed: neighbor.fixed,
            })
            .collect(),
    )
}

fn new_revision() -> Result<String> {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy)
        .map_err(|err| anyhow::anyhow!("не удалось создать ревизию: {err}"))?;
    Ok(hex::encode(entropy))
}

fn publish(
    plan: Plan,
    selected: &Selected,
    version: &str,
    boot: &crate::runtime::Boot,
    revision: String,
    inventory: Option<Vec<Binding>>,
    geo: Arc<GeoCache>,
) -> Result<Published> {
    let capture = inventory.is_some();
    let configured = Arc::new(plan.policy(capture, inventory.clone(), &geo)?);
    let policy = if selected.changes_policy(&plan) {
        Arc::new(
            selected
                .apply(plan.clone())
                .policy(capture, inventory, &geo)?,
        )
    } else {
        configured.clone()
    };
    let public = public_plan(&plan, &revision)?;
    let runtime = selected.state(version, &plan, boot, capture);
    Ok(Published {
        plan,
        revision,
        configured,
        policy,
        geo,
        public,
        runtime,
    })
}

struct Worker {
    app: Arc<App>,
    config: PathBuf,
    receiver: mpsc::Receiver<WorkerMessage>,
    engine: Option<xray::Engine>,
    digest: [u8; 32],
    selected: Selected,
    settings: Settings,
    version: String,
    socks: SocketAddr,
    capture: Option<crate::lan::Capture>,
    awg: crate::managed_awg::Pool,
    managed: Option<ManagedCore>,
    _runtime_dir: tempfile::TempDir,
}

async fn run_transactions(worker: &mut Worker, mut stopping: oneshot::Receiver<()>) -> Result<()> {
    loop {
        let Some(engine) = worker.engine.as_mut() else {
            return Err(anyhow::anyhow!("не удалось восстановить ядро Xray"));
        };
        tokio::select! {
            _=&mut stopping=>return Ok(()),
            state=engine.wait()=>return state.and_then(|status|Err(anyhow::anyhow!("ядро Xray завершилось: {status}"))),
            message=worker.receiver.recv()=>{
                match message {
                    Some(WorkerMessage::Plan(change)) => {
                        let PlanChange {expected,next,status_only,result}=*change;
                        let _ = result.send(worker.apply(&expected, next, status_only).await);
                    }
                    Some(WorkerMessage::Runtime(change, result)) => {
                        let _ = result.send(worker.change_runtime(change).await);
                    }
                    Some(WorkerMessage::Core(candidate, result)) => {
                        let _ = result.send(worker.change_core(candidate).await.map_err(ServerError::apply));
                    }
                    Some(WorkerMessage::Geo(update,result)) => {
                        let _=result.send(worker.change_geo(update).await.map_err(ServerError::apply));
                    }
                    None => return Ok(()),
                }
            }
        }
    }
}

fn repoint_core(link: &Path, target: &Path) -> Result<()> {
    let stage = link.with_extension("new");
    symlink(target, &stage)?;
    if let Err(error) = std::fs::rename(&stage, link) {
        let _ = std::fs::remove_file(&stage);
        return Err(error.into());
    }
    Ok(())
}

impl Worker {
    async fn change_geo(&mut self, update: GeoUpdate) -> Result<()> {
        let active = self.app.snapshot();
        let plan = &active.plan;
        let geo = Arc::new(update.candidate(&active.geo)?);
        plan.policy(true, None, &geo)
            .context("в обновлённой базе отсутствуют теги, используемые в активных правилах")?;
        let reload = update.needs_reload(&active.geo, &plan.rules, &plan.devices);
        let revision = if reload {
            new_revision()?
        } else {
            active.revision.clone()
        };
        let capture = self.capture.is_some();
        let inventory = inventory_for(&self.app.topology, plan, capture).await;
        let updated = publish(
            plan.clone(),
            &self.selected,
            &self.version,
            &self.settings.boot,
            revision,
            inventory,
            geo,
        )?;
        let cache = update.install(&active.geo)?;
        let prepared = if reload {
            let mut plan = self.selected.apply(plan.clone());
            crate::subscriptions_api::pin_catalog_profiles(&mut plan).await?;
            let mut config = xray::compile_runtime(
                &plan,
                capture,
                &updated.policy,
                &self.awg.ports(),
                &updated.geo,
            )?;
            if let Some(health) = &self.app.health {
                health.append_config(&mut config.json, &plan)?;
            }
            let private = config.write(
                self._runtime_dir.path(),
                &updated.geo,
                self.engine.as_ref().map(xray::Engine::config_file),
            )?;
            let digest = private.fingerprint()?;
            if digest != self.digest {
                xray::check(self.app.xray_path(), &private).await?;
            }
            Some((private, digest))
        } else {
            None
        };
        if let Some((private, digest)) = prepared {
            if let Err(error) = self
                .replace_config(digest != self.digest, private, || Ok(()))
                .await
            {
                cache
                    .rollback()
                    .context("не удалось вернуть предыдущий файл GeoIP")?;
                return Err(error);
            }
            self.digest = digest;
        }
        cache.commit();
        *self
            .app
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(updated);
        Ok(())
    }

    async fn change_core(&mut self, candidate: ManagedCore) -> Result<()> {
        let engine = self.engine.as_ref().context("Ядро не запущено")?;
        let candidate_config = xray::private_copy(engine.config_file())?;
        xray::check(candidate.path(), &candidate_config).await?;
        let config_path = self.config.clone();
        let (candidate, pending) = tokio::task::spawn_blocking(move || {
            let pending = core_store::stage_compressed_core(&candidate, &config_path)?;
            Ok::<_, anyhow::Error>((candidate, pending))
        })
        .await??;
        let link = self.app.xray_path().to_owned();
        let previous_path = std::fs::read_link(&link)?;
        if let Some(capture) = &self.capture {
            capture.deactivate().await?;
        }
        let previous = self.engine.take().context("Ядро не запущено")?;
        let old_config = previous.stop_for_restart().await?;
        let attempt = match self.restart(candidate.path(), candidate_config).await {
            Ok(current) if self.selected.vpn => {
                let active = self.app.snapshot();
                let group = active
                    .plan
                    .profiles
                    .iter()
                    .any(|p| p.id == self.selected.profile && p.xray_group.is_some());
                let verified = match &self.app.health {
                    Some(health) => health.verify(group).await,
                    None => false,
                };
                if verified {
                    Ok(current)
                } else {
                    if let Some(capture) = &self.capture {
                        let _ = capture.deactivate().await;
                    }
                    let _ = current.stop().await;
                    Err(anyhow::anyhow!(
                        "Контрольный HTTPS-запрос через активный VPN не прошёл после обновления"
                    ))
                }
            }
            result => result,
        };
        let failure = match attempt {
            Ok(current) => match repoint_core(&link, candidate.path()) {
                Ok(()) => match pending.commit() {
                    Ok(()) => {
                        self.app.telemetry.set_xray_pid(current.pid());
                        self.engine = Some(current);
                        self.version = candidate.version().to_owned();
                        self.managed = Some(candidate);
                        let mut active = self.app.snapshot().as_ref().clone();
                        active.runtime["xrayVersion"] = json!(self.version);
                        *self
                            .app
                            .state
                            .write()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(active);
                        return Ok(());
                    }
                    Err(error) => {
                        if let Some(capture) = &self.capture {
                            let _ = capture.deactivate().await;
                        }
                        let _ = current.stop().await;
                        repoint_core(&link, &previous_path)?;
                        error
                    }
                },
                Err(error) => {
                    if let Some(capture) = &self.capture {
                        let _ = capture.deactivate().await;
                    }
                    let _ = current.stop().await;
                    error
                }
            },
            Err(error) => error,
        };
        let restored = self.restart(&previous_path, old_config).await?;
        self.app.telemetry.set_xray_pid(restored.pid());
        self.engine = Some(restored);
        Err(failure.context("Обновление не применилось, прежнее ядро Xray восстановлено"))
    }

    async fn change_runtime(&mut self, change: RuntimeChange) -> Result<Value, ServerError> {
        let active = self.app.snapshot();
        let plan = &active.plan;
        let mut next = self.selected.clone();
        let mut settings = self.settings.clone();
        let (change, auto_checks) = if let RuntimeChange::AutoZapret(service) = change {
            if !matches!(service.as_str(), "youtube" | "discord") {
                return Err(ServerError {
                    status: StatusCode::BAD_REQUEST,
                    message: "Укажите YouTube или Discord".into(),
                });
            }
            if !plan.zapret {
                return Err(ServerError {
                    status: StatusCode::CONFLICT,
                    message: "Zapret не разрешён в конфигурации RouteHub".into(),
                });
            }
            let (checks, best) = self
                .app
                .zapret
                .auto(&self.selected, &service)
                .await
                .map_err(ServerError::apply)?;
            if let Some(strategy) = best {
                (
                    RuntimeChange::Zapret(ZapretChange {
                        service,
                        enabled: true,
                        strategy,
                    }),
                    Some(checks),
                )
            } else {
                return Ok(json!({"checks":checks,"runtime":self.app.runtime_view().await}));
            }
        } else {
            (change, None)
        };
        let contains = |id: &str| plan.profiles.iter().any(|profile| profile.id == id);
        let choose = || {
            if contains(&settings.last_profile) {
                settings.last_profile.clone()
            } else if contains(&plan.default_target) {
                plan.default_target.clone()
            } else {
                plan.profiles
                    .first()
                    .map(|p| p.id.clone())
                    .unwrap_or_default()
            }
        };
        match change {
            RuntimeChange::Vpn(input) => {
                if !input.profile.is_empty() {
                    next.profile.clone_from(&input.profile);
                } else if !contains(&next.profile) {
                    next.profile = choose();
                }
                if !contains(&next.profile) && (input.enabled || !input.profile.is_empty()) {
                    return Err(ServerError {
                        status: StatusCode::BAD_REQUEST,
                        message: "Выберите существующий профиль VPN".into(),
                    });
                }
                next.vpn = input.enabled;
                if input.enabled || !input.profile.is_empty() {
                    settings.last_profile.clone_from(&next.profile);
                }
            }
            RuntimeChange::Boot(mut boot) => {
                if !contains(&boot.profile) && !boot.profile.is_empty() {
                    return Err(ServerError {
                        status: StatusCode::BAD_REQUEST,
                        message: "Выберите существующий профиль автозапуска".into(),
                    });
                }
                if boot.vpn && boot.profile.is_empty() {
                    boot.profile = choose();
                    if boot.profile.is_empty() {
                        return Err(ServerError {
                            status: StatusCode::BAD_REQUEST,
                            message: "Выберите существующий профиль автозапуска".into(),
                        });
                    }
                }
                if boot.zapret_youtube || boot.zapret_discord {
                    if !plan.zapret {
                        return Err(ServerError {
                            status: StatusCode::CONFLICT,
                            message: "Zapret не разрешён в конфигурации RouteHub".into(),
                        });
                    }
                    let mut boot_selection = next.clone();
                    boot_selection.youtube = boot.zapret_youtube;
                    boot_selection.discord = boot.zapret_discord;
                    self.app
                        .zapret
                        .validate(&boot_selection)
                        .map_err(ServerError::apply)?;
                }
                settings.boot = boot;
            }
            RuntimeChange::Zapret(input) => {
                let (enabled, strategy, saved) = match input.service.as_str() {
                    "youtube" => (
                        &mut next.youtube,
                        &mut next.youtube_strategy,
                        &mut settings.youtube_strategy,
                    ),
                    "discord" => (
                        &mut next.discord,
                        &mut next.discord_strategy,
                        &mut settings.discord_strategy,
                    ),
                    _ => {
                        return Err(ServerError {
                            status: StatusCode::BAD_REQUEST,
                            message: "Укажите YouTube или Discord".into(),
                        });
                    }
                };
                if !input.strategy.is_empty() {
                    *strategy = input.strategy;
                }
                if !strategy.is_empty() && !Zapret::strategy_known(strategy) {
                    return Err(ServerError {
                        status: StatusCode::BAD_REQUEST,
                        message: "Неизвестная стратегия Zapret".into(),
                    });
                }
                if input.enabled && !plan.zapret {
                    return Err(ServerError {
                        status: StatusCode::CONFLICT,
                        message: "Zapret не разрешён в конфигурации RouteHub".into(),
                    });
                }
                if input.enabled && !self.app.zapret.has_strategy(&input.service, strategy) {
                    return Err(ServerError {
                        status: StatusCode::BAD_REQUEST,
                        message: "Установите и выберите подготовленную стратегию Zapret".into(),
                    });
                }
                *enabled = input.enabled;
                saved.clone_from(strategy);
            }
            RuntimeChange::AutoZapret(_) => unreachable!(),
        }
        let capture = self.capture.is_some();
        let inventory = inventory_for(&self.app.topology, plan, capture).await;
        let published = publish(
            plan.clone(),
            &next,
            &self.version,
            &settings.boot,
            active.revision.clone(),
            inventory.clone(),
            active.geo.clone(),
        )
        .map_err(ServerError::apply)?;
        let mut prepared = next.apply(plan.clone());
        crate::subscriptions_api::pin_catalog_profiles(&mut prepared)
            .await
            .map_err(ServerError::apply)?;
        let awg = self
            .awg
            .prepare(&prepared, &next)
            .await
            .map_err(ServerError::apply)?;
        let config = xray::compile_runtime(
            &prepared,
            capture,
            &published.policy,
            &awg.ports(),
            &published.geo,
        )
        .and_then(|mut compiled| {
            if let Some(health) = &self.app.health {
                health.append_config(&mut compiled.json, &prepared)?;
            }
            compiled.write(
                self._runtime_dir.path(),
                &published.geo,
                self.engine.as_ref().map(xray::Engine::config_file),
            )
        })
        .map_err(ServerError::apply)?;
        let digest = config.fingerprint().map_err(ServerError::apply)?;
        let changed = digest != self.digest;
        if changed {
            xray::check(self.app.xray_path(), &config)
                .await
                .map_err(ServerError::apply)?;
        }
        let path = self.config.with_file_name("runtime.json");
        let pending = transaction::stage(&path, &settings).map_err(ServerError::apply)?;
        self.app
            .zapret
            .select(&self.selected, &next)
            .await
            .map_err(ServerError::apply)?;
        if let Err(error) = self.activate(changed, config, pending, &path).await {
            self.app
                .zapret
                .select(&next, &self.selected)
                .await
                .context("не удалось восстановить прежнее состояние Zapret")
                .map_err(ServerError::apply)?;
            return Err(ServerError::apply(error));
        }
        self.digest = digest;
        self.app.update_awg_ports(&awg);
        self.awg = awg;
        self.selected = next;
        self.settings = settings;
        if let Some(health) = &self.app.health {
            health.select(Some((&self.selected, &published.plan)));
        }
        *self
            .app
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(published);
        let runtime = self.app.runtime_view().await;
        Ok(match auto_checks {
            Some(checks) => json!({"checks":checks,"runtime":runtime}),
            None => runtime,
        })
    }

    async fn apply(
        &mut self,
        expected: &str,
        mut plan: Plan,
        status_only: bool,
    ) -> Result<String, ServerError> {
        let active = self.app.snapshot();
        if expected != active.revision {
            return Err(ServerError::conflict());
        }
        let geo = if plan.geo_sources == active.plan.geo_sources {
            active.geo.clone()
        } else {
            Arc::new(
                GeoCache::load(&self.app.data_dir, &plan.geo_sources)
                    .map_err(ServerError::apply)?,
            )
        };
        plan.normalize(&geo).map_err(ServerError::apply)?;
        validate_runtime_references(&plan, &active.runtime).map_err(ServerError::apply)?;
        let revision = if status_only {
            active.revision.clone()
        } else {
            new_revision().map_err(ServerError::apply)?
        };
        let capture = self.capture.is_some();
        let inventory = inventory_for(&self.app.topology, &plan, capture).await;
        let published = publish(
            plan,
            &self.selected,
            &self.version,
            &self.settings.boot,
            revision.clone(),
            inventory.clone(),
            geo,
        )
        .map_err(ServerError::apply)?;
        if status_only {
            transaction::stage(&self.config, &published.plan)
                .and_then(|pending| {
                    pending.persist(&self.config)?;
                    Ok(())
                })
                .map_err(ServerError::apply)?;
            *self
                .app
                .state
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(published);
            return Ok(revision);
        }
        if let Some(error) = crate::saved_checks::compare(
            (&active.plan, &active.configured),
            (&published.plan, &published.configured),
            capture,
            inventory.as_deref().unwrap_or_default(),
        )
        .1
        .into_iter()
        .next()
        {
            return Err(ServerError::apply(error));
        }
        let mut prepared = self.selected.apply(published.plan.clone());
        crate::subscriptions_api::pin_catalog_profiles(&mut prepared)
            .await
            .map_err(ServerError::apply)?;
        let awg = self
            .awg
            .prepare(&prepared, &self.selected)
            .await
            .map_err(ServerError::apply)?;
        let config = xray::compile_runtime(
            &prepared,
            capture,
            &published.policy,
            &awg.ports(),
            &published.geo,
        )
        .and_then(|mut compiled| {
            if let Some(health) = &self.app.health {
                health.append_config(&mut compiled.json, &prepared)?;
            }
            compiled.write(
                self._runtime_dir.path(),
                &published.geo,
                self.engine.as_ref().map(xray::Engine::config_file),
            )
        })
        .map_err(ServerError::apply)?;
        let digest = config.fingerprint().map_err(ServerError::apply)?;
        let changed = digest != self.digest;
        if changed {
            xray::check(self.app.xray_path(), &config)
                .await
                .map_err(ServerError::apply)?;
        }
        let pending =
            transaction::stage(&self.config, &published.plan).map_err(ServerError::apply)?;
        let history = self.app.data_dir.join("revisions");
        let snapshot = transaction::archive(&history, &active.revision, &active.plan)
            .map_err(ServerError::apply)?;
        let result = self
            .activate(changed, config, pending, &self.config.clone())
            .await;
        if let Err(err) = result {
            let _ = std::fs::remove_file(snapshot);
            return Err(ServerError::apply(err));
        }
        self.digest = digest;
        self.app.update_awg_ports(&awg);
        self.awg = awg;
        if changed && let Some(health) = &self.app.health {
            health.select(Some((&self.selected, &published.plan)));
        }
        *self
            .app
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(published);
        transaction::prune(&history);
        Ok(revision)
    }

    async fn activate(
        &mut self,
        changed: bool,
        config: xray::ConfigFile,
        pending: tempfile::NamedTempFile,
        destination: &Path,
    ) -> Result<()> {
        self.replace_config(changed, config, || {
            pending.persist(destination).map_err(|error| error.error)?;
            Ok(())
        })
        .await
    }

    async fn replace_config(
        &mut self,
        changed: bool,
        config: xray::ConfigFile,
        persist: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        if !changed {
            return persist();
        }
        let path = self.app.xray_path().to_path_buf();
        if let Some(capture) = &self.capture {
            capture.deactivate().await?;
        }
        let Some(previous) = self.engine.take() else {
            return Err(anyhow::anyhow!("Ядро не запущено"));
        };
        let old_config = previous.stop_for_restart().await?;
        let new = self.restart(&path, config).await;
        let failure = match new {
            Ok(engine) => match persist() {
                Ok(_) => {
                    self.app.telemetry.set_xray_pid(engine.pid());
                    self.engine = Some(engine);
                    return Ok(());
                }
                Err(err) => {
                    if let Some(capture) = &self.capture {
                        let _ = capture.deactivate().await;
                    }
                    let _ = engine.stop().await;
                    err
                }
            },
            Err(err) => err,
        };
        let engine = self.restart(&path, old_config).await?;
        self.app.telemetry.set_xray_pid(engine.pid());
        self.engine = Some(engine);
        Err(failure.context("изменения не применились, прежняя конфигурация восстановлена"))
    }

    async fn restart(&self, path: &Path, config: xray::ConfigFile) -> Result<xray::Engine> {
        let engine = xray::Engine::start(path.to_owned(), config, self.socks).await?;
        if let Some(capture) = &self.capture {
            let pid = engine.pid().context("ядро Xray завершилось")?;
            if let Err(error) = capture.activate(pid).await {
                let _ = capture.deactivate().await;
                let _ = engine.stop().await;
                return Err(error);
            }
        }
        Ok(engine)
    }
}

async fn shutdown() -> Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! { result=tokio::signal::ctrl_c() => result?, _=terminate.recv()=>{} }
    Ok(())
}

async fn boundary(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != Some(app.authority.as_str())
    {
        return (StatusCode::BAD_REQUEST, "Недопустимый HTTP Host\n").into_response();
    }
    if !app.allowed.contains(&peer.ip().to_canonical()) {
        return (StatusCode::FORBIDDEN, "Адрес клиента вне подсети панели\n").into_response();
    }
    let path = request.uri().path();
    let mut response = if path.starts_with("/api/panel/")
        && path != "/api/panel/session"
        && !app.auth.authorized(request.headers())
    {
        error(StatusCode::UNAUTHORIZED, "Войдите в панель")
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_POLICY),
    );
    if headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v == "application/json")
    {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        let (parts, body) = response.into_parts();
        if let Ok(mut bytes) = body::to_bytes(body, 8 << 20).await.map(|b| b.to_vec()) {
            bytes.push(b'\n');
            return Response::from_parts(parts, Body::from(bytes));
        }
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось сформировать ответ",
        );
    }
    response
}

async fn set_vpn(State(app): State<Arc<App>>, request: Request) -> Response {
    runtime_request(app, request, RuntimeChange::Vpn).await
}

async fn set_zapret(State(app): State<Arc<App>>, request: Request) -> Response {
    runtime_request(app, request, RuntimeChange::Zapret).await
}

async fn devices(State(app): State<Arc<App>>) -> Response {
    let active = app.snapshot();
    match app
        .topology
        .device_list(
            &active.plan,
            &active.policy,
            app.allowed,
            app.capture_active,
        )
        .await
    {
        Ok(list) => Json(list).into_response(),
        Err(message) => error(StatusCode::SERVICE_UNAVAILABLE, message),
    }
}

async fn set_boot(State(app): State<Arc<App>>, request: Request) -> Response {
    runtime_request(app, request, RuntimeChange::Boot).await
}

async fn runtime_request<T: serde::de::DeserializeOwned>(
    app: Arc<App>,
    request: Request,
    change: impl FnOnce(T) -> RuntimeChange,
) -> Response {
    if !app.auth.can_edit()
        || !Auth::same_origin(request.headers())
        || !app.auth.authorized(request.headers())
    {
        return error(StatusCode::FORBIDDEN, "Доступ к управлению запрещён");
    }
    let media = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if media
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        != Some("application/json")
    {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Требуется application/json",
        );
    }
    let Some(payload) = body::to_bytes(request.into_body(), 2048)
        .await
        .ok()
        .and_then(|input| serde_json::from_slice::<T>(&input).ok())
    else {
        return error(StatusCode::BAD_REQUEST, "Некорректный запрос управления");
    };
    let (result, recv) = oneshot::channel();
    if app
        .updates
        .try_send(WorkerMessage::Runtime(change(payload), result))
        .is_err()
    {
        return ServerError::unavailable().into_response();
    }
    match recv.await {
        Ok(Ok(state)) => Json(state).into_response(),
        Ok(Err(error)) => error.into_response(),
        Err(_) => ServerError::unavailable().into_response(),
    }
}

async fn evaluate(State(app): State<Arc<App>>, request: Request) -> Response {
    let input = body::to_bytes(request.into_body(), 4096)
        .await
        .ok()
        .and_then(|data| serde_json::from_slice::<Destination>(&data).ok());
    let Some(input) = input else {
        return error(StatusCode::BAD_REQUEST, "Некорректный запрос JSON");
    };
    let snapshot = app.snapshot();
    let decision = match snapshot.policy.evaluate(&input) {
        Ok(result) => result,
        Err(err) => return error(StatusCode::BAD_REQUEST, &err),
    };
    let configured = configured_target(&snapshot.plan, &decision);
    let mut value = match serde_json::to_value(&decision) {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Не удалось сформировать ответ",
            );
        }
    };
    value["configuredTarget"] = json!(configured);
    if decision.target == "direct" && configured != decision.target {
        let active = &snapshot.runtime;
        if configured == "zapret"
            && active["zapret"]["youtube"]["enabled"] != true
            && active["zapret"]["discord"]["enabled"] != true
        {
            value["runtimeReason"] = json!("zapret-disabled");
        } else if configured != "zapret" && active["vpn"]["enabled"] != true {
            value["runtimeReason"] = json!("vpn-disabled");
        }
    }
    let client = if decision.device_mac.is_empty() {
        routehub_policy::normalize_mac(&input.client_mac).unwrap_or_default()
    } else {
        decision.device_mac
    };
    if !client.is_empty()
        && let Some(device) = snapshot
            .policy
            .devices()
            .iter()
            .find(|device| device.mac == client)
    {
        let mut policy = json!({"mode":device.mode,"active":device.active});
        if !device.reason.is_empty() {
            policy["reason"] = json!(device.reason);
        }
        value["clientPolicy"] = policy;
    }
    Json(value).into_response()
}

fn configured_target<'a>(plan: &'a Plan, decision: &'a routehub_policy::Decision) -> &'a str {
    if !decision.game_preset_id.is_empty() {
        return &decision.target;
    }
    let (rules, fallback) = if decision.scope == "device" {
        let Some(device) = plan.devices.iter().find(|device| {
            routehub_policy::normalize_mac(&device.mac).is_ok_and(|mac| mac == decision.device_mac)
        }) else {
            return &decision.target;
        };
        (&device.rules, &device.default_target)
    } else {
        (&plan.rules, &plan.default_target)
    };
    if !decision.rule.is_empty() {
        return rules
            .iter()
            .find(|rule| rule.name.trim() == decision.rule)
            .map_or(decision.target.as_str(), |rule| rule.target.as_str());
    }
    if fallback.is_empty() {
        &decision.target
    } else {
        fallback
    }
}

async fn session(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response {
    app.auth.clone().session(request, peer.ip()).await
}

fn asset(content: &'static str, media: &'static str) -> Response {
    ([(header::CONTENT_TYPE, media)], content).into_response()
}

async fn not_found(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        error(StatusCode::NOT_FOUND, "Маршрут не найден")
    } else {
        (StatusCode::NOT_FOUND, "404 page not found\n").into_response()
    }
}

fn public_response(body: Bytes) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

fn public_plan(plan: &Plan, revision: &str) -> Result<Bytes> {
    // Serialize the redacted profile list directly to avoid copying provider
    // config, private keys and credentials into an intermediate JSON tree.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Public<'a> {
        panel_host: &'a str,
        #[serde(skip_serializing_if = "str_empty")]
        panel_network: &'a str,
        panel_port: u16,
        socks_port: u16,
        zapret: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        transparent: Option<&'a crate::config::Transparent>,
        profiles: Vec<routehub_subscriptions::Profile>,
        rules: &'a [routehub_policy::Rule],
        default_target: &'a str,
        #[serde(skip_serializing_if = "<[routehub_policy::Device]>::is_empty")]
        devices: &'a [routehub_policy::Device],
        #[serde(skip_serializing_if = "Option::is_none")]
        zapret_services: Option<&'a crate::config::ZapretServices>,
        #[serde(skip_serializing_if = "<[serde_json::Value]>::is_empty")]
        geo_sources: &'a [Value],
        #[serde(skip_serializing_if = "<[routehub_policy::NamedSet]>::is_empty")]
        named_sets: &'a [routehub_policy::NamedSet],
        #[serde(skip_serializing_if = "<[crate::config::GamePreset]>::is_empty")]
        games: &'a [crate::config::GamePreset],
        #[serde(skip_serializing_if = "<[crate::saved_checks::SavedCheck]>::is_empty")]
        saved_checks: &'a [crate::saved_checks::SavedCheck],
        #[serde(skip_serializing_if = "Vec::is_empty")]
        subscriptions: Vec<routehub_subscriptions::Subscription>,
        revision: &'a str,
    }
    fn str_empty(value: &&str) -> bool {
        value.is_empty()
    }
    let mut bytes = serde_json::to_vec(&Public {
        panel_host: &plan.panel_host,
        panel_network: &plan.panel_network,
        panel_port: plan.panel_port,
        socks_port: plan.socks_port,
        zapret: plan.zapret,
        transparent: plan.transparent.as_ref(),
        profiles: plan.profiles.iter().map(|p| p.public()).collect(),
        rules: &plan.rules,
        default_target: &plan.default_target,
        devices: &plan.devices,
        zapret_services: plan.zapret_services.as_ref(),
        geo_sources: &plan.geo_sources,
        named_sets: &plan.named_sets,
        games: &plan.games,
        saved_checks: &plan.saved_checks,
        subscriptions: routehub_subscriptions::public_subscriptions(&plan.subscriptions),
        revision,
    })?;
    bytes.push(b'\n');
    Ok(bytes.into())
}

async fn revisions(State(app): State<Arc<App>>) -> Json<Vec<Value>> {
    use std::os::unix::fs::PermissionsExt;
    let mut rows = Vec::new();
    if let Ok(entries) = std::fs::read_dir(app.data_dir.join("revisions")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|v| v.strip_suffix(".json")) else {
                continue;
            };
            if id.len() != 32
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() || meta.permissions().mode() & 0o077 != 0 || meta.len() > 4 << 20 {
                continue;
            }
            let Ok(at) = meta.modified() else {
                continue;
            };
            rows.push(
                json!({"revision":id,"createdAt":chrono::DateTime::<Utc>::from(at),
                "by":"RouteHub","note":"Сохранена перед заменой плана маршрутизации"}),
            );
        }
    }
    rows.sort_unstable_by(|a, b| {
        b["createdAt"]
            .as_str()
            .cmp(&a["createdAt"].as_str())
            .then_with(|| b["revision"].as_str().cmp(&a["revision"].as_str()))
    });
    Json(rows)
}

async fn resources(State(app): State<Arc<App>>) -> Response {
    match app.telemetry.resources() {
        Some(sample) => Json(sample).into_response(),
        None => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Первый замер ещё готовится",
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanUpdate {
    revision: String,
    profiles: Option<Vec<ProfileUpdate>>,
    rules: Option<Vec<routehub_policy::Rule>>,
    default_target: Option<String>,
    devices: Option<Vec<routehub_policy::Device>>,
    zapret_services: Option<crate::config::ZapretServices>,
    geo_sources: Option<Vec<Value>>,
    named_sets: Option<Vec<routehub_policy::NamedSet>>,
    games: Option<Vec<crate::config::GamePreset>>,
    saved_checks: Option<Vec<crate::saved_checks::SavedCheck>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileUpdate {
    id: String,
    protocol: String,
    label: Option<String>,
    location: Option<String>,
    #[serde(rename = "server")]
    _server: Option<String>,
    #[serde(rename = "xrayGroup")]
    _xray_group: Option<bool>,
    #[serde(rename = "groupSize")]
    _group_size: Option<usize>,
    uri: Option<String>,
    outbound: Option<Value>,
    interface: Option<String>,
    awg_version: Option<String>,
    awg_config: Option<String>,
}

impl ProfileUpdate {
    fn merge(
        self,
        profiles: &[routehub_subscriptions::Profile],
    ) -> Result<routehub_subscriptions::Profile> {
        let old = profiles.iter().find(|profile| profile.id == self.id);
        if old.is_some_and(|p| !p.subscription_id.is_empty()) {
            ensure!(
                self.uri.is_none()
                    && self.outbound.is_none()
                    && self.interface.is_none()
                    && self.awg_config.is_none()
                    && old.is_some_and(|p| p.protocol == self.protocol),
                "параметры подключения профиля обновляются его подпиской"
            );
        }
        ensure!(
            self.uri
                .as_ref()
                .is_none_or(|v| !v.is_empty() && self.outbound.is_none())
                && self
                    .interface
                    .as_ref()
                    .is_none_or(|v| !v.is_empty() && self.awg_config.is_none())
                && self.awg_config.as_ref().is_none_or(|v| !v.is_empty()),
            "проверьте способ подключения в профиле"
        );
        let same = old.filter(|p| p.protocol == self.protocol);
        let mut profile = same.cloned().unwrap_or_default();
        profile.id = self.id;
        profile.protocol = self.protocol;
        if let Some(label) = self.label {
            profile.label = label;
        } else if let Some(old) = old {
            profile.label = old.label.clone();
        }
        if let Some(location) = self.location {
            profile.location = location;
        } else if let Some(old) = old {
            profile.location = old.location.clone();
        }
        if let Some(uri) = self.uri {
            profile.uri = uri;
            profile.outbound = None;
            profile.xray_group = None;
        }
        if let Some(outbound) = self.outbound {
            profile.outbound = Some(outbound);
            profile.uri.clear();
            profile.xray_group = None;
        }
        if let Some(name) = self.interface {
            profile.interface = name;
            profile.awg_config.clear();
        }
        if let Some(config) = self.awg_config {
            profile.awg_config = config;
            profile.interface.clear();
        }
        if let Some(version) = self.awg_version {
            profile.awg_version = version;
        }
        Ok(profile)
    }
}

async fn parse_plan_edit(app: &App, request: Request) -> Result<PlanUpdate, Box<Response>> {
    if !app.auth.can_edit()
        || !Auth::same_origin(request.headers())
        || !app.auth.authorized(request.headers())
    {
        return Err(Box::new(error(
            StatusCode::FORBIDDEN,
            "Доступ к редактированию запрещён",
        )));
    }
    let media = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if media.split(';').next().map(str::trim) != Some("application/json") {
        return Err(Box::new(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Требуется application/json",
        )));
    }
    let body = match body::to_bytes(request.into_body(), 4 << 20).await {
        Ok(body) => body,
        Err(_) => {
            return Err(Box::new(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Размер конфигурации не должен превышать 4 МиБ",
            )));
        }
    };
    let Ok(update) = serde_json::from_slice::<PlanUpdate>(&body) else {
        return Err(Box::new(error(
            StatusCode::BAD_REQUEST,
            "Укажите ревизию и данные для сохранения",
        )));
    };
    Ok(update)
}

fn merge_plan_update(current: &Plan, update: PlanUpdate) -> Result<(Plan, bool)> {
    let mut next = current.clone();
    let checks_only = update.saved_checks.is_some()
        && update.profiles.is_none()
        && update.rules.is_none()
        && update.default_target.is_none()
        && update.devices.is_none()
        && update.zapret_services.is_none()
        && update.geo_sources.is_none()
        && update.named_sets.is_none()
        && update.games.is_none();
    if let (Some(profiles), Some(rules)) = (update.profiles, update.rules) {
        next.profiles = profiles
            .into_iter()
            .map(|profile| profile.merge(&current.profiles))
            .collect::<Result<Vec<_>>>()?;
        next.rules = rules;
    } else if !checks_only {
        anyhow::bail!("Укажите ревизию и данные для сохранения");
    }
    if let Some(value) = update.default_target {
        next.default_target = value;
    }
    if let Some(value) = update.devices {
        next.devices = value;
    }
    if let Some(value) = update.zapret_services {
        next.zapret_services = Some(value);
    }
    if let Some(value) = update.geo_sources {
        next.geo_sources = value;
    }
    if let Some(value) = update.named_sets {
        next.named_sets = value;
    }
    if let Some(value) = update.games {
        next.games = value;
    }
    if let Some(value) = update.saved_checks {
        next.saved_checks = value;
    }
    Ok((next, checks_only))
}

async fn edit_plan(State(app): State<Arc<App>>, request: Request) -> Response {
    let update = match parse_plan_edit(&app, request).await {
        Ok(update) => update,
        Err(response) => return *response,
    };
    let current = app.snapshot();
    let revision = update.revision.clone();
    if current.revision != revision {
        return ServerError::conflict().into_response();
    }
    let (next, _) = match merge_plan_update(&current.plan, update) {
        Ok(plan) => plan,
        Err(err) => return error(StatusCode::BAD_REQUEST, &err.to_string()),
    };
    match app.commit(&revision, next).await {
        Ok(_) => public_response(app.snapshot().public.clone()),
        Err(err) => err.into_response(),
    }
}

async fn saved_check_results(State(app): State<Arc<App>>) -> Response {
    let current = app.snapshot();
    let bindings = inventory_for(&app.topology, &current.plan, app.capture_active).await;
    let config = (&current.plan, current.configured.as_ref());
    let (checks, _) = crate::saved_checks::compare(
        config,
        config,
        app.capture_active,
        bindings.as_deref().unwrap_or_default(),
    );
    Json(checks).into_response()
}

fn validate_runtime_references(plan: &Plan, runtime: &Value) -> Result<()> {
    let contains = |id: &str| plan.profiles.iter().any(|profile| profile.id == id);
    let selected = runtime["vpn"]["profile"].as_str().unwrap_or_default();
    let boot = runtime["boot"]["profile"].as_str().unwrap_or_default();
    ensure!(
        (runtime["vpn"]["enabled"] != true || contains(selected))
            && (boot.is_empty() || contains(boot)),
        "сначала смените профиль в VPN или в автозапуске"
    );
    ensure!(
        runtime["boot"]["vpn"] != true || !plan.profiles.is_empty(),
        "для автозапуска VPN нужен хотя бы один профиль"
    );
    Ok(())
}

async fn preview_plan(State(app): State<Arc<App>>, request: Request) -> Response {
    let update = match parse_plan_edit(&app, request).await {
        Ok(update) => update,
        Err(response) => return *response,
    };
    let current = app.snapshot();
    if current.revision != update.revision {
        return ServerError::conflict().into_response();
    }
    let mut result = json!({"errors":[],"warnings":[],"restarts":[]});
    let prepared = merge_plan_update(&current.plan, update).and_then(|(mut plan, checks_only)| {
        let geo = if current.plan.geo_sources == plan.geo_sources {
            current.geo.clone()
        } else {
            Arc::new(GeoCache::load(&app.data_dir, &plan.geo_sources)?)
        };
        plan.normalize(&geo)?;
        validate_runtime_references(&plan, &current.runtime)?;
        Ok((plan, geo, checks_only))
    });
    match prepared {
        Ok((plan, geo, checks_only)) => {
            let inventory = inventory_for(&app.topology, &plan, app.capture_active).await;
            let draft = plan.policy(app.capture_active, inventory.clone(), &geo);
            match draft {
                Ok(policy) => {
                    let (checks, errors) = crate::saved_checks::compare(
                        (&current.plan, &current.configured),
                        (&plan, &policy),
                        app.capture_active,
                        inventory.as_deref().unwrap_or_default(),
                    );
                    result["checks"] = json!(checks);
                    result["errors"] = json!(errors);
                }
                Err(error) => result["errors"] = json!([error.to_string()]),
            }
            if !checks_only {
                result["warnings"] = json!([{"level":"warn","text":"Применение перезапустит ядро. Текущие соединения через RouteHub могут прерваться."}]);
                result["restarts"] = json!(["Ядро Xray"]);
            }
        }
        Err(err) => result["errors"] = json!([err.to_string()]),
    }
    Json(result).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreRequest {
    revision: String,
    base_revision: String,
}

async fn restore_revision(State(app): State<Arc<App>>, request: Request) -> Response {
    let input: RestoreRequest = match authenticated_json(&app, request, 2048).await {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let path = match transaction::revision_path(&app.data_dir.join("revisions"), &input.revision) {
        Ok(path) if !input.base_revision.is_empty() => path,
        _ => return error(StatusCode::BAD_REQUEST, "Выберите сохранённую ревизию"),
    };
    let current = app.snapshot();
    if current.revision != input.base_revision {
        return ServerError::conflict().into_response();
    }
    let saved = match transaction::read_revision(&path) {
        Ok(Some(plan)) => plan,
        Ok(None) => return error(StatusCode::NOT_FOUND, "Ревизия недоступна"),
        Err(_) => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Не удалось прочитать ревизию",
            );
        }
    };
    let mut next = current.plan.clone();
    next.profiles = saved.profiles;
    next.rules = saved.rules;
    next.devices = saved.devices;
    next.default_target = saved.default_target;
    next.zapret_services = saved.zapret_services;
    next.geo_sources = saved.geo_sources;
    next.saved_checks = saved.saved_checks;
    next.named_sets = saved.named_sets;
    next.games = saved.games;
    next.subscriptions = saved.subscriptions;
    match app.commit(&input.base_revision, next).await {
        Ok(_) => public_response(app.snapshot().public.clone()),
        Err(err) => err.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupRequest {
    scope: String,
    #[serde(default, rename = "deviceMAC")]
    device_mac: String,
}

async fn backup(State(app): State<Arc<App>>, request: Request) -> Response {
    let input: BackupRequest = match authenticated_json(&app, request, 1024).await {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let current = app.snapshot();
    let (disposition, data) = match input.scope.as_str() {
        "rules" => {
            let rules = if input.device_mac.is_empty() {
                &current.plan.rules
            } else {
                let Ok(mac) = routehub_policy::normalize_mac(&input.device_mac) else {
                    return error(StatusCode::BAD_REQUEST, "Некорректный MAC устройства");
                };
                let Some(device) = current.plan.devices.iter().find(|entry| {
                    routehub_policy::normalize_mac(&entry.mac).is_ok_and(|actual| actual == mac)
                }) else {
                    return error(StatusCode::NOT_FOUND, "Устройство не найдено");
                };
                &device.rules
            };
            let exported = rules
                .iter()
                .map(|rule| {
                    let mut value = serde_json::to_value(rule).unwrap_or_default();
                    if let Some(set) = current
                        .plan
                        .named_sets
                        .iter()
                        .find(|entry| entry.id == rule.named_set)
                    {
                        if let Some(object) = value.as_object_mut() {
                            object.remove("namedSet");
                        }
                        if set.kind == "domains" {
                            value["domain"] = json!(
                                set.entries
                                    .iter()
                                    .filter_map(|entry| routehub_policy::normalize_routing_domain(
                                        entry
                                    ))
                                    .map(|domain| format!("domain:{domain}"))
                                    .collect::<Vec<_>>()
                            );
                        } else {
                            value["ip"] = json!(set.entries);
                        }
                    }
                    value
                })
                .collect::<Vec<_>>();
            (
                "attachment; filename=routehub-rules.json",
                serde_json::to_vec_pretty(&json!({"rules":exported})),
            )
        }
        "configuration" if input.device_mac.is_empty() => (
            "attachment; filename=routehub-config.json",
            serde_json::to_vec_pretty(&current.plan),
        ),
        "configuration" => {
            return error(
                StatusCode::BAD_REQUEST,
                "Для экспорта полной конфигурации оставьте выбор устройства пустым",
            );
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "Выберите правила или полную конфигурацию",
            );
        }
    };
    let Ok(mut bytes) = data else {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось подготовить экспорт",
        );
    };
    bytes.push(b'\n');
    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    )
        .into_response()
}

async fn authenticated_json<T: serde::de::DeserializeOwned>(
    app: &App,
    request: Request,
    limit: usize,
) -> Result<T, Box<Response>> {
    if !app.auth.can_edit()
        || !Auth::same_origin(request.headers())
        || !app.auth.authorized(request.headers())
    {
        return Err(Box::new(error(
            StatusCode::FORBIDDEN,
            "Доступ к управлению запрещён",
        )));
    }
    let media = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if media
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        != Some("application/json")
    {
        return Err(Box::new(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Требуется application/json",
        )));
    }
    body::to_bytes(request.into_body(), limit)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| {
            Box::new(error(
                StatusCode::BAD_REQUEST,
                "Некорректный запрос управления",
            ))
        })
}

async fn dns_status(State(app): State<Arc<App>>) -> Response {
    Json(app.dns.snapshot().await).into_response()
}

async fn dns_apply(State(app): State<Arc<App>>, request: Request) -> Response {
    let settings = match authenticated_json(&app, request, crate::dns::SETTINGS_LIMIT).await {
        Ok(settings) => settings,
        Err(response) => return *response,
    };
    match tokio::spawn(async move { app.dns.apply(settings).await }).await {
        Ok(Ok(state)) => Json(state).into_response(),
        Ok(Err(err)) => error(
            StatusCode::from_u16(err.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &err.message,
        ),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Не удалось применить DNS",
        ),
    }
}

async fn dns_test(State(app): State<Arc<App>>, request: Request) -> Response {
    let input = match authenticated_json(&app, request, crate::dns::PROBE_LIMIT).await {
        Ok(input) => input,
        Err(response) => return *response,
    };
    match app.dns.test(input).await {
        Ok(result) => Json(json!({"servers":result})).into_response(),
        Err(err) => error(
            StatusCode::from_u16(err.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &err.message,
        ),
    }
}

async fn capabilities(State(app): State<Arc<App>>) -> Json<Value> {
    let availability = |enabled: bool, reason: &str| {
        if enabled {
            json!({"available":true})
        } else {
            json!({"available":false,"reason":reason})
        }
    };
    let coverage =
        |enabled, note| json!({"state":if enabled {"configured"} else {"unsupported"},"note":note});
    let lan = app.capture_active;
    let mode = app.status["lanMode"].as_str().unwrap_or("socks");
    let udp = mode == "tproxy";
    let label = match mode {
        "redirect-tcp" => "TCP REDIRECT",
        "tproxy" => "TPROXY",
        _ => "Локальный SOCKS",
    };
    let model = std::fs::read_to_string("/proc/device-tree/model")
        .ok()
        .map(|s| {
            s.trim_matches(|c: char| c == '\0' || c.is_whitespace())
                .to_owned()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Keenetic".into());
    let can_write = app.auth.can_edit();
    let zapret = app.snapshot().plan.zapret && app.zapret.capability().await;
    let zapret_action = availability(
        zapret,
        "Zapret не установлен или недоступен в текущем режиме",
    );
    let dns_state = serde_json::to_value(app.dns.snapshot().await).unwrap_or_default();
    let dns_lan = dns_state["lanAvailable"] == true;
    let probe_parallelism = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|info| crate::storage::read_proc_kib(&info, "MemAvailable"))
        .filter(|value| *value >= 72 * 1024)
        .map_or(2, |_| 4);
    Json(json!({
        "access":if can_write {"write"} else {"read"},
        "profileProbeConcurrency":probe_parallelism,
        "device":{"model":model,"name":model,"firmware":"—","arch":if std::env::consts::ARCH=="aarch64"{"arm64"}else{std::env::consts::ARCH},"entware":"—"},
        "routehub":{"version":env!("CARGO_PKG_VERSION"),"build":"embedded"},
        "interception":{"mode":mode,"label":label,"notes":["Модуль управляет одной настроенной IPv4-подсетью"],"coverage":{
            "v4tcp":coverage(lan,"Зависит от настроенной подсети и правил перехвата"),
            "v4udp":coverage(udp,"Перехват UDP доступен в режиме TPROXY"),
            "v6tcp":coverage(false,"Перехват IPv6 не реализован"),
            "v6udp":coverage(false,"Перехват IPv6 не реализован")}},
        "actions":{"keenetic":availability(false,"Выбор отдельной политики Keenetic недоступен"),
            "direct":availability(true,""),"vpn":availability(true,""),"zapret":zapret_action,
            "block":availability(true,""),"inherit":availability(true,"")},
        "perSsidPolicy":availability(false,"Перехват не различает SSID"),
        "perDeviceDns":availability(false,"Резолвер использует единую политику DNS"),
        "zapret":zapret_action,
        "gameRouting":{"routeAtOpen":availability(lan,"Для прямого маршрута новых TCP-соединений нужен действующий перехват LAN"),
            "udpRouteAtOpen":availability(false,"UDP-сигнатуры доступны для наблюдения"),
            "lateSignalPriority":availability(false,"Наблюдение Netfilter показывает совпадения и не управляет открытыми соединениями"),
            "intelliQos":availability(false,"Категорийный приоритет настраивается в KeeneticOS"),
            "strictPriority":availability(false,"Управление сетевым приоритетом отдельных потоков недоступно")},
        "ipv6":availability(false,"Перехват клиентов поддерживает IPv4"),
        "trialApply":availability(false,"Пробный запуск требует изолированного перехвата для клиента"),
        "liveObservation":availability(crate::diagnostics_api::observation_available(&app.snapshot().plan,lan),
            "Для наблюдения нужны активная IPv4-подсеть RouteHub и доступ к таблице соединений Netfilter"),
        "ispUplinks":[{"id":"isp-main","name":"Подключение по умолчанию","iface":""}],
        "features":{
            "segments":availability(false,"Модуль управляет только настроенной сетью"),
            "devices":availability(lan,"Нужен действующий перехват LAN и закреплённый IPv4-адрес клиента"),
            "deviceGroups":availability(false,"Группы устройств пока не поддерживаются"),
            "namedSets":availability(true,""),
            "activeVpnHealth":availability(app.health.is_some(),"Локальный канал проверки VPN недоступен"),
            "gamePresets":availability(true,""),
            "subscriptions":availability(true,""),
            "exitGroups":availability(false,"Автоматический выбор и резервирование выходов пока недоступны"),
            "engineSelection":availability(false,"Ядро определяется типом профиля и установкой модуля"),
            "updates":availability(cfg!(all(target_os="linux",target_arch="aarch64")),"Обновление Xray доступно для установленного ядра Linux ARM64"),
            "savedChecks":availability(lan,"Для проверок маршрутов нужен перехват LAN"),
            "dnsVpn":availability(false,"DNS-серверы текущего резолвера доступны напрямую"),
            "dnsLAN":availability(dns_lan,"Подключение LAN к резолверу недоступно"),
            "bootSettings":availability(true,""),
            "profileMetadata":availability(true,""),
            "profilePause":availability(false,"Пауза и отключение отдельного профиля пока недоступны"),
            "backup":availability(can_write,"Войдите с правом изменения настроек"),
            "realTest":availability(true,""),
            "revisions":availability(true,"")
        }
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceRequest {
    service: String,
}

async fn zapret_auto(State(app): State<Arc<App>>, request: Request) -> Response {
    runtime_request(app, request, |input: ServiceRequest| {
        RuntimeChange::AutoZapret(input.service)
    })
    .await
}

async fn zapret_test(State(app): State<Arc<App>>, request: Request) -> Response {
    let input: ServiceRequest = match authenticated_json(&app, request, 256).await {
        Ok(input) => input,
        Err(response) => return *response,
    };
    if !matches!(input.service.as_str(), "youtube" | "discord") {
        return error(
            StatusCode::BAD_REQUEST,
            "Укажите сервис YouTube или Discord",
        );
    }
    let current = app.snapshot();
    let state = &current.runtime["zapret"];
    if state[&input.service]["enabled"] != true {
        let message = if state["youtube"]["enabled"] == true || state["discord"]["enabled"] == true
        {
            "Набор Zapret для сервиса выключен в применённой конфигурации."
        } else {
            "Движок Zapret RouteHub выключен."
        };
        return Json(json!({"service":input.service,"status":"disabled","message":message}))
            .into_response();
    }
    let Ok(mut result) = app.zapret.test(&input.service).await else {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "Дождитесь завершения текущей проверки Zapret",
        );
    };
    let latest = app.snapshot();
    if result["status"] == "verified"
        && (current.revision != latest.revision || state != &latest.runtime["zapret"])
    {
        result["status"] = json!("unverified");
        result["message"] =
            json!("HTTPS ответил, но во время проверки изменилась конфигурация RouteHub.");
    }
    Json(result).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BootCheckRequest {}

async fn boot_check(State(app): State<Arc<App>>, request: Request) -> Response {
    let _: BootCheckRequest = match authenticated_json(&app, request, 2048).await {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let current = app.snapshot();
    let runtime = &current.runtime;
    let mut checks = ["vpn", "youtube", "discord"]
        .map(|id| json!({"id":id,"status":"disabled","message":"Автозапуск выключен."}));
    if runtime["boot"]["vpn"] == true {
        let profile = runtime["boot"]["profile"]
            .as_str()
            .filter(|id| !id.is_empty())
            .or_else(|| current.profile_references()[0]);
        let ready =
            profile.is_some_and(|id| current.plan.profiles.iter().any(|entry| entry.id == id));
        let message = if ready {
            "Профиль выбран. Доступность туннеля здесь не проверяется."
        } else {
            "Профиль отсутствует или имеет некорректные параметры."
        };
        checks[0] =
            json!({"id":"vpn","status":if ready {"ready"} else {"unavailable"},"message":message});
    }
    let boot = Selected {
        youtube: runtime["boot"]["zapretYouTube"] == true,
        discord: runtime["boot"]["zapretDiscord"] == true,
        youtube_strategy: runtime["zapret"]["youtube"]["strategy"]
            .as_str()
            .unwrap_or_default()
            .into(),
        discord_strategy: runtime["zapret"]["discord"]["strategy"]
            .as_str()
            .unwrap_or_default()
            .into(),
        ..Default::default()
    };
    let helper_error = if current.plan.zapret && boot.zapret_active() {
        app.zapret
            .check_ready(&boot)
            .await
            .err()
            .map(|err| err.to_string())
    } else {
        None
    };
    for (i, (id, enabled, strategy)) in [
        ("youtube", boot.youtube, &boot.youtube_strategy),
        ("discord", boot.discord, &boot.discord_strategy),
    ]
    .into_iter()
    .enumerate()
    {
        if !enabled {
            continue;
        }
        let error = helper_error.as_deref().or_else(|| {
            (!current.plan.zapret || !app.zapret.has_strategy(id, strategy))
                .then_some("Проверьте разрешение режима Zapret и наличие выбранной стратегии.")
        });
        checks[i + 1] = json!({"id":id,"status":if error.is_some() {"unavailable"} else {"ready"},
            "message":error.unwrap_or("Стратегия подготовлена для запуска при загрузке.")});
    }
    Json(json!({"checks":checks})).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GeoRequest {
    #[serde(default)]
    id: String,
}

async fn geo_update(State(app): State<Arc<App>>, request: Request) -> Response {
    let input: GeoRequest = match authenticated_json(&app, request, 1024).await {
        Ok(input) => input,
        Err(response) => return *response,
    };
    if input.id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "укажите источник GeoIP");
    }
    if let Err(err) = app.refresh_geo(&input.id).await {
        return err.into_response();
    }
    let active = app.snapshot();
    Json(json!({"sources":active.geo.status(),"revision":active.revision})).into_response()
}

async fn watch_geo(app: Arc<App>) {
    use std::time::{Duration, Instant};
    let mut attempts = std::collections::HashMap::new();
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let now = Instant::now();
        attempts.retain(|_, previous| now.duration_since(*previous) < Duration::from_secs(900));
        for id in app.snapshot().geo.due_updates(Utc::now()) {
            if attempts.contains_key(&id) {
                continue;
            }
            attempts.insert(id.clone(), now);
            let _ = app.refresh_geo(&id).await;
        }
    }
}
