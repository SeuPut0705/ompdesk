//! Mobile web's brain on this computer (was `MobileWebService` of `src/main/tailscale/service.ts`): the switch, the
//! Tailscale it needs, and the page's address. Every poll tick looks at the world again (`status --json`, `serve
//! status --json`) and derives the phase from it, so a Tailscale that goes away, signs out or loses HTTPS moves
//! `ready` back by itself; the user's clicks only start a step (install, start the app, sign in) or flip the switch.
//! The CLI calls are 4a's functions of this module's parent, called in this process.
//!
//! Main keeps what is its own and asks the core's questions: the prefs, the setup item, the located CLI and the
//! environment it runs in, the web server (`WebServerPort`), the browser and the OS's settings. A question is the
//! event `mobileWeb.ask` `{service, token, call, op, …}` and main's answer the request `mobileWeb.answer` `{call, ok,
//! result | message}`, as `remote.ask` and `remote.answer` are. The ops: `prefGet {key}` (`{value}`, none when unset),
//! `prefSet {key, value}`, `prefDelete {key}`, `locate` (`null`, or `{located, env}`: the CLI found and main's whole
//! environment with the CLI's own variables over it), `startApp {located}` (`{code, line}`), `openExternal {url}`,
//! `openSystemSettings`, `serverStart` (`{port}`), `serverStop`, `serverConfigure {host, publicPort, secure,
//! servePrefix}`, `serveSecret`, `install` (the setup item it ended in), `cancelInstall`.
//!
//! Main keeps the chain: the steps that run one at a time (`mobileWeb.step`: `enable`, `disable`, `startApp`, `login`,
//! `retry`, `tick`) are serialized and bounded there by `SerialChain`, and the poll's sleep is main's timer; the core
//! answers each step with what it ended in and the delay to the next poll (`pollMs`, none while off). A step main
//! stopped is cancelled: its questions are dropped, no CLI starts in it, and it goes no further (`Step::check` before
//! and after every call that reaches outside, as `fencedCall` did), so it neither starts the next call nor writes
//! state the next step owns. Requests that were never in the chain (`mobileWeb.act`: install, cancel, the lists, the
//! watch flag) run beside a step and interleave at its awaits, as they did in the one JavaScript thread.
//!
//! The state is pushed as the event `mobileWeb.state` `{service, state, pollMs, seq}` on every change, and answers
//! carry it too; `seq` orders them. The state holds what only the core decides: `install`, `allowedUsers` and
//! `confirmNewDevices` are main's (the setup item and the prefs it reads synchronously) and main adds them.
//!
//! The clock is the system's unless a request says what time it is (`now`: a test's), as `schedules`' manual clock.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use url::Url;

use super::status::{Backend, Status};
use super::{
    CliParams, Confirm, ConfirmParams, Publish, PublishParams, StatusAnswer, Unpublish,
    UnpublishParams, UpAnswer, UpParams, WhoisParams, version,
};
use crate::fs::order::js_trim;
use crate::run::Runner;
use crate::server::{Call, Events, Fault, Registry, Reply, Scope};

/// The poll's delay, and while Settings watches or a step waits on the user or the OS.
const POLL_MS: u64 = 15_000;
const FAST_POLL_MS: u64 = 2_000;
const LOGIN_TIMEOUT_MS: i64 = 10 * 60 * 1000;
/// Tailscale that stays unreachable or `Starting` this long after it was started waits on the OS (approval).
const OS_APPROVAL_AFTER_MS: i64 = 20_000;
/// A refused publish (policy, HTTPS off) is tried again at most this often on its own.
const BLOCK_RETRY_MS: i64 = 60_000;
/// The port `serve` tries first (`MOBILE_WEB_PORT`).
const MOBILE_WEB_PORT: u32 = 47_831;
/// Every CLI call's ceiling and output cap (`cli.ts`).
const CLI_TIMEOUT_MS: u64 = 10_000;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
/// A whois answers from the daemon's own netmap: slower than this is a daemon in trouble.
const WHOIS_TIMEOUT_MS: u64 = 4_000;
const MIN_TAILSCALE_VERSION: &str = "1.52.0";
const ADMIN_DNS_URL: &str = "https://login.tailscale.com/admin/dns";
const ADMIN_MACHINES_URL: &str = "https://login.tailscale.com/admin/machines";

/// Prefs (electron-store; a dotted key is a nested path), as `MOBILE_WEB_PREFS`.
const PREF_ENABLED: &str = "mobileWeb.enabled";
const PREF_ALLOWED_USERS: &str = "mobileWeb.allowedUsers";
const PREF_CONFIRM_NEW_DEVICES: &str = "mobileWeb.confirmNewDevices";
const PREF_SERVE: &str = "mobileWeb.serve";

fn system_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Off,
    Detecting,
    NotInstalled,
    Installing,
    AppNotRunning,
    NeedsOsApproval,
    NeedsLogin,
    LoggingIn,
    NeedsMachineApproval,
    HttpsDisabled,
    ServeBlocked,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Os {
    Darwin,
    Win32,
    Other,
}

// ── the questions to main ────────────────────────────────────────────────────

/// Main's answer to a question.
enum Answer {
    Result(Value),
    Failed(String),
}

#[derive(Default)]
struct Asks {
    next: u64,
    /// By call number: the service that asked, and where the answer goes.
    waiting: HashMap<u64, (u64, oneshot::Sender<Answer>)>,
}

static ASKS: LazyLock<Mutex<Asks>> = LazyLock::new(Mutex::default);

fn asks() -> MutexGuard<'static, Asks> {
    ASKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Sends the question `op` and returns the call number and where the answer comes.
fn send_ask(
    service: u64,
    events: &Events,
    token: u64,
    op: &str,
    data: Value,
    wait: bool,
) -> (u64, Option<oneshot::Receiver<Answer>>) {
    let (call, answered) = {
        let mut asks = asks();
        asks.next += 1;
        let call = asks.next;
        let answered = wait.then(|| {
            let (sender, receiver) = oneshot::channel();
            asks.waiting.insert(call, (service, sender));
            receiver
        });
        (call, answered)
    };
    let mut message = Map::new();
    message.insert("service".into(), service.into());
    message.insert("token".into(), token.into());
    message.insert("call".into(), call.into());
    message.insert("op".into(), op.into());
    if let Value::Object(fields) = data {
        message.extend(fields);
    }
    events.send("mobileWeb.ask", &message);
    (call, answered)
}

/// A question and its answer. `scope` is the request that asks: when it is cancelled the question is dropped.
async fn ask(
    service: u64,
    events: &Events,
    token: u64,
    scope: Option<&Scope>,
    op: &str,
    data: Value,
) -> Result<Value, Fault> {
    if scope.is_some_and(Scope::cancelled) {
        return Err(Fault::cancelled());
    }
    let (call, answered) = send_ask(service, events, token, op, data, true);
    let Some(answered) = answered else {
        return Err(Fault::cancelled());
    };
    let answer = match scope {
        Some(scope) => {
            tokio::select! {
                answer = answered => answer,
                () = scope.on_cancel() => {
                    asks().waiting.remove(&call);
                    return Err(Fault::cancelled());
                }
            }
        }
        None => answered.await,
    };
    if scope.is_some_and(Scope::cancelled) {
        return Err(Fault::cancelled());
    }
    match answer {
        Ok(Answer::Result(value)) => Ok(value),
        Ok(Answer::Failed(message)) => Err(Fault::new("ask_failed", message)),
        // The service was closed: nobody waits for this.
        Err(_) => Err(Fault::cancelled()),
    }
}

/// The step a request runs in: what it asks main, its hold on the CLI runs it starts and its clock.
pub struct Step {
    service: u64,
    token: u64,
    scope: Scope,
    events: Events,
    now: Option<i64>,
}

impl Step {
    fn now(&self) -> i64 {
        self.now.unwrap_or_else(system_now)
    }

    /// Fails when the step was stopped: nothing more starts in it and nothing more is written by it.
    fn check(&self) -> Result<(), Fault> {
        if self.scope.cancelled() {
            return Err(Fault::cancelled());
        }
        Ok(())
    }

    /// A question to main, fenced to this step: it is not asked in a stopped step, and a stopped step goes no further
    /// when the answer comes.
    pub async fn ask(&self, op: &str, data: Value) -> Result<Value, Fault> {
        ask(
            self.service,
            &self.events,
            self.token,
            Some(&self.scope),
            op,
            data,
        )
        .await
    }

    /// A question whose answer nobody waits for (main still gets it and does it).
    pub fn tell(&self, op: &str, data: Value) {
        send_ask(self.service, &self.events, self.token, op, data, false);
    }
}

// ── the web server ───────────────────────────────────────────────────────────

/// The address the page is published at and the secret path of the serve handler's target: only a request that
/// carries it came through serve, so only then are Tailscale's identity headers believed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    pub host: String,
    pub public_port: u32,
    pub secure: bool,
    pub serve_prefix: String,
}

/// What Mobile web needs of the page's server (MobileWA's `WebServer`): the seam the web edge's move plugs into. Every
/// operation is held to the step it is made in (`Step`).
pub trait WebServerPort: Send + Sync + 'static {
    /// Listens on loopback; the port is where. Resolves at once when it already does.
    fn start(&self, step: &Step) -> impl Future<Output = Result<u16, Fault>> + Send;
    fn stop(&self, step: &Step) -> impl Future<Output = Result<(), Fault>> + Send;
    /// Starts the stop without waiting for it (Funnel exposes our port: the step goes on).
    fn begin_stop(&self, step: &Step);
    fn configure(
        &self,
        step: &Step,
        address: &Address,
    ) -> impl Future<Output = Result<(), Fault>> + Send;
    /// The per-install secret path of the serve target (never stored in the prefs).
    fn serve_secret(&self, step: &Step) -> impl Future<Output = Result<String, Fault>> + Send;
}

/// The page's server is main's for now: each operation is a question (`serverStart`, `serverStop`,
/// `serverConfigure`, `serveSecret`).
pub struct AsksMain;

impl WebServerPort for AsksMain {
    async fn start(&self, step: &Step) -> Result<u16, Fault> {
        let answer = step.ask("serverStart", json!({})).await?;
        answer
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .ok_or_else(|| Fault::new("ask_failed", "The page's server gave no port"))
    }

    async fn stop(&self, step: &Step) -> Result<(), Fault> {
        step.ask("serverStop", json!({})).await.map(|_| ())
    }

    fn begin_stop(&self, step: &Step) {
        step.tell("serverStop", json!({}));
    }

    async fn configure(&self, step: &Step, address: &Address) -> Result<(), Fault> {
        let data = serde_json::to_value(address).unwrap_or(Value::Null);
        step.ask("serverConfigure", data).await.map(|_| ())
    }

    async fn serve_secret(&self, step: &Step) -> Result<String, Fault> {
        let answer = step.ask("serveSecret", json!({})).await?;
        answer
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Fault::new("ask_failed", "The serve secret is not text"))
    }
}

/// The page's server of every service: swap these two lines for the in-core edge.
type Port = AsksMain;

fn new_port() -> Port {
    AsksMain
}

// ── the located CLI ──────────────────────────────────────────────────────────

/// The Tailscale CLI main located, and how it runs: main's whole environment with the CLI's own variables over it.
struct CliInfo {
    /// What main handed over, given back to it as it was (`startApp`).
    located: Value,
    path: String,
    variant: String,
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct LocatedAnswer {
    located: Value,
    env: BTreeMap<String, String>,
}

impl CliInfo {
    fn runner(&self) -> Runner {
        Runner {
            bin: self.path.clone(),
            args: Vec::new(),
            env: self.env.clone(),
            timeout_ms: CLI_TIMEOUT_MS,
            max_bytes: MAX_OUTPUT,
        }
    }
}

/// A call that failed for any reason but the step's stop is an answer, as `cli.ts` words it (`fallback` over the
/// message): a CLI that cannot run reads as one that said something.
fn answered<T>(result: Result<T, Fault>, fallback: impl FnOnce(String) -> T) -> Result<T, Fault> {
    match result {
        Err(fault) if fault.code != "cancelled" => Ok(fallback(fault.message)),
        other => other,
    }
}

impl CliInfo {
    async fn status(&self, scope: &Scope) -> Result<StatusAnswer, Fault> {
        let params = CliParams {
            tailscale: self.runner(),
        };
        answered(super::status(params, scope.clone()).await, |line| {
            StatusAnswer {
                code: None,
                spawn_error: None,
                line: Some(line),
                status: None,
                https_problem: None,
            }
        })
    }

    async fn whois(&self, scope: &Scope, ip: String) -> Result<Option<super::whois::Peer>, Fault> {
        let params = WhoisParams {
            tailscale: self.runner(),
            ip,
            timeout_ms: WHOIS_TIMEOUT_MS,
        };
        answered(super::whois(params, scope.clone()).await, |_| None)
    }

    async fn up(&self, scope: &Scope, json: bool) -> Result<UpAnswer, Fault> {
        let params = UpParams {
            tailscale: self.runner(),
            json,
            timeout_ms: Some(CLI_TIMEOUT_MS),
        };
        answered(super::up(params, scope.clone()).await, |line| UpAnswer {
            code: None,
            line: Some(line),
            auth_url: None,
            login_url: None,
        })
    }

    async fn control_host(&self, scope: &Scope) -> Result<Option<String>, Fault> {
        let params = CliParams {
            tailscale: self.runner(),
        };
        answered(super::control_host(params, scope.clone()).await, |_| None)
    }

    async fn publish(
        &self,
        scope: &Scope,
        host: &str,
        target: &str,
        base: &str,
        record: Value,
    ) -> Result<Publish, Fault> {
        let params = PublishParams {
            tailscale: self.runner(),
            host: host.to_owned(),
            target: target.to_owned(),
            base: base.to_owned(),
            record,
            first: MOBILE_WEB_PORT,
        };
        answered(super::publish(params, scope.clone()).await, |detail| {
            Publish::Blocked { detail }
        })
    }

    async fn confirm(
        &self,
        scope: &Scope,
        host: &str,
        port: u32,
        base: &str,
        target: &str,
    ) -> Result<Confirm, Fault> {
        let params = ConfirmParams {
            tailscale: self.runner(),
            host: host.to_owned(),
            port,
            base: base.to_owned(),
            target: target.to_owned(),
        };
        answered(super::confirm(params, scope.clone()).await, |_| {
            Confirm::Missing
        })
    }

    async fn unpublish(
        &self,
        scope: &Scope,
        record: Value,
        secret: String,
    ) -> Result<Unpublish, Fault> {
        let params = UnpublishParams {
            tailscale: self.runner(),
            record,
            secret,
        };
        answered(super::unpublish(params, scope.clone()).await, |detail| {
            Unpublish::Failed { detail, off: false }
        })
    }
}

/// Whether `open_external` may be given `url` for a sign-in: https on Tailscale's own login host, or on the host of
/// the control server this tailnet signs in to (a self-hosted one). Nothing else is ever opened.
fn login_url_allowed(url: &str, control_host: Option<&str>) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str().map(str::to_lowercase) else {
        return false;
    };
    host == "login.tailscale.com" || control_host.is_some_and(|known| host == known.to_lowercase())
}

/// Trimmed, no empties, no repeats (case aside), in the order given.
fn clean_logins<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut logins = Vec::new();
    for value in values.into_iter().flatten() {
        let login = js_trim(value);
        if login.is_empty() || !seen.insert(login.to_lowercase()) {
            continue;
        }
        logins.push(login.to_owned());
    }
    logins
}

fn logins_of(stored: &Option<Value>) -> Option<Vec<String>> {
    match stored {
        Some(Value::Array(values)) => Some(clean_logins(values.iter().map(Value::as_str))),
        _ => None,
    }
}

// ── the state ────────────────────────────────────────────────────────────────

struct Blocked {
    phase: Phase,
    detail: String,
    at: i64,
}

/// What the last status said that later requests read.
struct Seen {
    backend: Backend,
    auth_url: Option<String>,
}

struct Inner {
    enabled: bool,
    disposed: bool,
    phase: Phase,
    cli: Option<Arc<CliInfo>>,
    seen: Option<Seen>,
    version: Option<String>,
    update_available: bool,
    user: Option<String>,
    phones: Vec<String>,
    detail: Option<String>,
    login_url: Option<String>,
    guide_url: Option<String>,
    /// The `login.tailscale.com` page a refused `serve` named ("enable HTTPS").
    serve_guide: Option<String>,
    control_host: Option<String>,
    funnel_exposed: bool,
    published: bool,
    host: Option<String>,
    port: Option<u32>,
    server_up: bool,
    local_port: Option<u16>,
    login_started_at: Option<i64>,
    app_started_at: Option<i64>,
    unreachable_since: Option<i64>,
    /// `up` ran for a stopped Tailscale in this round (enable, retry, start-app, login).
    up_tried: bool,
    up_error: Option<String>,
    /// Start the app once the install that was just done finished.
    auto_start_app: bool,
    /// Why the last "start the app" failed.
    launch_error: Option<String>,
    install_requested: bool,
    /// The setup item `tailscale`, as main sent it with the last request (`SetupItemState`).
    setup_item: Option<Value>,
    blocked: Option<Blocked>,
    watching: bool,
    last_emitted: String,
    seq: u64,
}

impl Inner {
    fn new() -> Inner {
        Inner {
            enabled: false,
            disposed: false,
            phase: Phase::Off,
            cli: None,
            seen: None,
            version: None,
            update_available: false,
            user: None,
            phones: Vec::new(),
            detail: None,
            login_url: None,
            guide_url: None,
            serve_guide: None,
            control_host: None,
            funnel_exposed: false,
            published: false,
            host: None,
            port: None,
            server_up: false,
            local_port: None,
            login_started_at: None,
            app_started_at: None,
            unreachable_since: None,
            up_tried: false,
            up_error: None,
            auto_start_app: false,
            launch_error: None,
            install_requested: false,
            setup_item: None,
            blocked: None,
            watching: false,
            last_emitted: String::new(),
            seq: 0,
        }
    }

    fn state(&self) -> State {
        let on = self.enabled;
        State {
            enabled: on,
            phase: self.phase,
            url: match (self.phase, &self.host, self.port) {
                (Phase::Ready, Some(host), Some(port)) if port != 0 => {
                    Some(format!("https://{host}:{port}"))
                }
                _ => None,
            },
            host: self.host.clone().filter(|_| on),
            port: self.port.filter(|_| on),
            user: self.user.clone(),
            tailscale: self.cli.as_ref().filter(|_| on).map(|cli| TailscaleInfo {
                variant: cli.variant.clone(),
                path: cli.path.clone(),
                version: self.version.clone(),
                update_available: self.update_available,
            }),
            login_url: self
                .login_url
                .clone()
                .filter(|_| matches!(self.phase, Phase::NeedsLogin | Phase::LoggingIn)),
            guide_url: self.guide_url.clone(),
            detail: self.detail.clone(),
            funnel_exposed: self.funnel_exposed,
            published: self.published,
            phones: self.phones.clone(),
        }
    }

    /// The delay to the next poll; none while off or closed.
    fn poll_ms(&self) -> Option<u64> {
        if !self.enabled || self.disposed {
            return None;
        }
        let fast = self.watching
            || matches!(
                self.phase,
                Phase::AppNotRunning
                    | Phase::NeedsOsApproval
                    | Phase::LoggingIn
                    | Phase::Detecting
                    | Phase::Starting
            );
        Some(if fast { FAST_POLL_MS } else { POLL_MS })
    }

    fn snapshot(&mut self) -> Snapshot {
        self.seq += 1;
        Snapshot {
            state: self.state(),
            poll_ms: self.poll_ms(),
            seq: self.seq,
        }
    }

    /// The setup item's phase when it is `phase`.
    fn setup_phase_is(&self, phases: &[&str]) -> bool {
        self.setup_item
            .as_ref()
            .and_then(|item| item.get("phase"))
            .and_then(Value::as_str)
            .is_some_and(|phase| phases.contains(&phase))
    }

    /// Nothing is known of Tailscale (it is not installed).
    fn forget_tailscale(&mut self) {
        self.seen = None;
        self.phones = Vec::new();
        self.published = false;
        self.login_url = None;
        self.guide_url = None;
        self.detail = None;
        self.version = None;
    }

    /// A fresh round: the one-shot steps (`up`, the app start) may run again.
    fn reset_round(&mut self) {
        self.up_tried = false;
        self.up_error = None;
        self.blocked = None;
        self.serve_guide = None;
        self.funnel_exposed = false;
        self.login_started_at = None;
        self.app_started_at = None;
        self.launch_error = None;
        self.unreachable_since = None;
        self.login_url = None;
        self.guide_url = None;
        self.detail = None;
        self.published = false;
    }

    fn block(&mut self, phase: Phase, detail: String, now: i64) {
        self.published = false;
        self.guide_url = (phase == Phase::HttpsDisabled).then(|| {
            self.serve_guide
                .clone()
                .unwrap_or_else(|| ADMIN_DNS_URL.into())
        });
        self.blocked = Some(Blocked {
            phase,
            detail: detail.clone(),
            at: now,
        });
        self.phase = phase;
        self.detail = Some(detail);
    }

    /// Funnel exposes our port: nothing is served. The caller stops the page's server.
    fn refuse_funnel(&mut self, host: &str, port: u32, ours: bool) {
        self.funnel_exposed = true;
        self.published = ours;
        self.port = Some(port);
        self.phase = Phase::ServeBlocked;
        self.detail = Some(format!(
            "Tailscale Funnel exposes https://{host}:{port} to the internet, so OMPdesk will not serve there"
        ));
        self.guide_url = None;
    }

    fn when_needs_login(&mut self, auth_url: Option<String>, now: i64) {
        self.app_started_at = None;
        self.guide_url = None;
        let logging_in = self
            .login_started_at
            .is_some_and(|started| now - started < LOGIN_TIMEOUT_MS);
        if !logging_in {
            self.login_started_at = None;
        }
        let url = auth_url.or_else(|| self.login_url.clone());
        self.login_url = url.filter(|url| login_url_allowed(url, self.control_host.as_deref()));
        self.phase = if logging_in {
            Phase::LoggingIn
        } else {
            Phase::NeedsLogin
        };
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleInfo {
    variant: String,
    path: String,
    version: Option<String>,
    update_available: bool,
}

/// `MobileWebState` without what main adds (`install`, `allowedUsers`, `confirmNewDevices`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    enabled: bool,
    phase: Phase,
    url: Option<String>,
    host: Option<String>,
    port: Option<u32>,
    user: Option<String>,
    tailscale: Option<TailscaleInfo>,
    login_url: Option<String>,
    guide_url: Option<String>,
    detail: Option<String>,
    funnel_exposed: bool,
    published: bool,
    phones: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    state: State,
    poll_ms: Option<u64>,
    seq: u64,
}

// ── the service ──────────────────────────────────────────────────────────────

struct Service<P: WebServerPort> {
    id: u64,
    os: Os,
    port: P,
    inner: Mutex<Inner>,
}

type Svc = Service<Port>;

static SERVICES: LazyLock<Mutex<HashMap<u64, Arc<Svc>>>> = LazyLock::new(Mutex::default);

fn services() -> MutexGuard<'static, HashMap<u64, Arc<Svc>>> {
    SERVICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The service main named, made with its first request.
fn service(id: u64, os: Os) -> Arc<Svc> {
    Arc::clone(services().entry(id).or_insert_with(|| {
        Arc::new(Service {
            id,
            os,
            port: new_port(),
            inner: Mutex::new(Inner::new()),
        })
    }))
}

impl<P: WebServerPort> Service<P> {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// One uninterrupted stretch of state work: JavaScript ran such a stretch between two awaits.
    fn with<R>(&self, work: impl FnOnce(&mut Inner) -> R) -> R {
        work(&mut self.lock())
    }

    /// Pushes the whole state when it changed since the last push.
    fn emit(&self, events: &Events) {
        let mut inner = self.lock();
        let Ok(text) = serde_json::to_string(&inner.state()) else {
            return;
        };
        if text == inner.last_emitted {
            return;
        }
        inner.last_emitted = text;
        let snapshot = inner.snapshot();
        events.send(
            "mobileWeb.state",
            &json!({
                "service": self.id,
                "state": snapshot.state,
                "pollMs": snapshot.poll_ms,
                "seq": snapshot.seq,
            }),
        );
    }

    fn done(&self, schedule: bool) -> Done {
        Done {
            snapshot: self.with(Inner::snapshot),
            schedule,
        }
    }

    async fn pref(&self, step: &Step, key: &str) -> Result<Option<Value>, Fault> {
        let answer = step.ask("prefGet", json!({"key": key})).await?;
        Ok(answer.get("value").cloned())
    }

    async fn set_pref(&self, step: &Step, key: &str, value: Value) -> Result<(), Fault> {
        step.ask("prefSet", json!({"key": key, "value": value}))
            .await
            .map(|_| ())
    }

    // ── requests ─────────────────────────────────────────────────────────────

    async fn enable(&self, step: &Step) -> Result<bool, Fault> {
        if self.os == Os::Other {
            self.with(|inner| {
                inner.phase = Phase::Error;
                inner.detail = Some("Mobile web needs macOS or Windows".into());
            });
            self.emit(&step.events);
            return Ok(false);
        }
        self.set_pref(step, PREF_ENABLED, Value::Bool(true)).await?;
        self.with(|inner| {
            inner.enabled = true;
            inner.reset_round();
            inner.phase = Phase::Detecting;
        });
        self.emit(&step.events);
        self.tick(step).await?;
        Ok(true)
    }

    async fn disable(&self, step: &Step) -> Result<bool, Fault> {
        self.set_pref(step, PREF_ENABLED, Value::Bool(false))
            .await?;
        self.with(|inner| {
            inner.enabled = false;
            inner.phase = Phase::Off;
        });
        self.emit(&step.events);
        // A lookup that fails (main cannot answer) leaves the handler and its record for the next launch; the switch
        // still goes off.
        let cli = match self.cli_or_null(step).await {
            Ok(cli) => cli,
            Err(fault) if fault.code == "cancelled" => return Err(fault),
            Err(_) => None,
        };
        let removed = match &cli {
            Some(cli) => self.unpublish(step, cli).await?,
            None => Unpublish::None,
        };
        self.stop_server(step).await?;
        self.with(|inner| {
            inner.reset_round();
            inner.cli = None;
            inner.seen = None;
            inner.phones = Vec::new();
            inner.host = None;
            inner.port = None;
            inner.detail = match removed {
                Unpublish::Failed { detail, .. } => Some(detail),
                _ => None,
            };
        });
        self.emit(&step.events);
        Ok(false)
    }

    /// The install runs on beside the steps: when it ended the core asks main for a poll (`mobileWeb.refresh`).
    fn install(self: &Arc<Self>, step: &Step) {
        let begun = self.with(|inner| {
            if inner.install_requested {
                return false;
            }
            inner.install_requested = true;
            inner.phase = Phase::Installing;
            true
        });
        if !begun {
            return;
        }
        self.emit(&step.events);
        let service = Arc::clone(self);
        let events = step.events.clone();
        let token = step.token;
        tokio::spawn(async move {
            match ask(service.id, &events, token, None, "install", json!({})).await {
                Ok(item) => service.with(|inner| {
                    inner.install_requested = false;
                    let present = item
                        .get("presence")
                        .and_then(|presence| presence.get("kind"))
                        .and_then(Value::as_str)
                        == Some("present");
                    if present {
                        inner.auto_start_app = true;
                    }
                    inner.setup_item = (!item.is_null()).then_some(item);
                }),
                // The service ended while it waited: nobody wants a poll.
                Err(fault) if fault.code == "cancelled" => return,
                Err(fault) => service.with(|inner| {
                    inner.install_requested = false;
                    inner.detail = Some(fault.message);
                }),
            }
            events.send("mobileWeb.refresh", &json!({"service": service.id}));
        });
    }

    async fn start_app(&self, step: &Step) -> Result<bool, Fault> {
        let Some(cli) = self.cli_or_null(step).await? else {
            return Ok(false);
        };
        // A stopped Tailscale is started with `up`; the app itself is only opened when it is not running.
        let stopped = self.with(|inner| {
            inner
                .seen
                .as_ref()
                .is_some_and(|seen| seen.backend == Backend::Stopped)
        });
        if stopped {
            self.with(|inner| {
                inner.up_tried = false;
                inner.up_error = None;
            });
        } else {
            self.launch_app(step, &cli).await?;
        }
        self.tick(step).await?;
        Ok(true)
    }

    async fn launch_app(&self, step: &Step, cli: &CliInfo) -> Result<(), Fault> {
        self.with(|inner| inner.app_started_at = Some(step.now()));
        let started = step
            .ask("startApp", json!({"located": cli.located}))
            .await?;
        let ok = started.get("code").and_then(Value::as_i64) == Some(0);
        let line = started
            .get("line")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.with(|inner| {
            inner.launch_error =
                (!ok).then(|| line.unwrap_or_else(|| "Could not start Tailscale".into()));
        });
        Ok(())
    }

    async fn login(&self, step: &Step) -> Result<bool, Fault> {
        let Some(cli) = self.cli_or_null(step).await? else {
            return Ok(false);
        };
        let seen = self.with(|inner| {
            inner
                .seen
                .as_ref()
                .filter(|seen| seen.backend == Backend::NeedsLogin)
                .map(|seen| seen.auth_url.clone())
        });
        let Some(auth_url) = seen else {
            return Ok(false);
        };
        let url = match auth_url.or_else(|| self.with(|inner| inner.login_url.clone())) {
            Some(url) => url,
            None => {
                let up = cli.up(&step.scope, true).await?;
                step.check()?;
                let Some(url) = up.auth_url.or(up.login_url) else {
                    self.with(|inner| {
                        inner.detail = Some(
                            up.line
                                .unwrap_or_else(|| "Tailscale gave no sign-in link".into()),
                        );
                    });
                    self.emit(&step.events);
                    return Ok(false);
                };
                url
            }
        };
        let control_host = self.control_host_for(step, &cli).await?;
        if !login_url_allowed(&url, control_host.as_deref()) {
            self.with(|inner| {
                inner.detail =
                    Some("Tailscale gave a sign-in link that is not on its login host".into());
            });
            self.emit(&step.events);
            return Ok(false);
        }
        self.with(|inner| {
            inner.login_url = Some(url.clone());
            inner.login_started_at = Some(step.now());
            inner.detail = None;
            inner.phase = Phase::LoggingIn;
        });
        self.emit(&step.events);
        step.ask("openExternal", json!({"url": url})).await?;
        Ok(true)
    }

    async fn retry(&self, step: &Step) -> Result<bool, Fault> {
        if !self.with(|inner| inner.enabled) {
            return Ok(false);
        }
        let cli = self.cli_or_null(step).await?;
        // Our own handler that Funnel exposes is taken down (ours only, by the ownership rules) and put up private.
        if let Some(cli) = &cli
            && self.with(|inner| inner.funnel_exposed)
        {
            self.unpublish(step, cli).await?;
        }
        self.with(|inner| {
            inner.reset_round();
            inner.cli = None;
            inner.phase = Phase::Detecting;
        });
        self.emit(&step.events);
        self.tick(step).await?;
        Ok(true)
    }

    async fn set_allowed_users(&self, step: &Step, users: &[String]) -> Result<(), Fault> {
        let cleaned = clean_logins(users.iter().map(|user| Some(user.as_str())));
        let user = self.with(|inner| inner.user.clone());
        let next = if cleaned.is_empty() {
            user.into_iter().collect()
        } else {
            cleaned
        };
        if next.is_empty() {
            return Err(Fault::new(
                "invalid_params",
                "At least one Tailscale user must be allowed",
            ));
        }
        self.set_pref(step, PREF_ALLOWED_USERS, json!(next)).await?;
        self.emit(&step.events);
        Ok(())
    }

    /// This computer's tailnet login as computer sharing read it (Mobile web may be off): allowed by default.
    async fn adopt_login(&self, step: &Step, login: String) -> Result<(), Fault> {
        if self.with(|inner| inner.user.as_deref() == Some(login.as_str())) {
            return Ok(());
        }
        self.adopt_user(step, Some(&login)).await?;
        self.emit(&step.events);
        Ok(())
    }

    /// At launch: pick the switch up where the last run left it. True when it was on.
    async fn start(&self, step: &Step) -> Result<bool, Fault> {
        let on = self.pref(step, PREF_ENABLED).await? == Some(Value::Bool(true));
        if !on || self.os == Os::Other {
            return Ok(false);
        }
        self.with(|inner| {
            inner.enabled = true;
            inner.phase = Phase::Detecting;
        });
        self.emit(&step.events);
        Ok(true)
    }

    /// Which node and user a tailnet address belongs to, or none. Read-only and not queued behind the poll.
    async fn whois(
        &self,
        step: &Step,
        address: String,
    ) -> Result<Option<super::whois::Peer>, Fault> {
        if !self.with(|inner| inner.enabled) {
            return Ok(None);
        }
        let Some(cli) = self.cli_or_null(step).await? else {
            return Ok(None);
        };
        cli.whois(&step.scope, address).await
    }

    /// App quit: the page's server stops; the serve handler stays in the daemon, as the design says.
    fn dispose(&self, events: &Events) {
        let up = self.with(|inner| {
            inner.disposed = true;
            std::mem::take(&mut inner.server_up)
        });
        if up {
            // No request asks: main finds no step to hold it to.
            send_ask(self.id, events, 0, "serverStop", json!({}), false);
        }
    }

    // ── the poll tick ────────────────────────────────────────────────────────

    async fn tick(&self, step: &Step) -> Result<(), Fault> {
        if !self.with(|inner| inner.enabled && !inner.disposed) {
            return Ok(());
        }
        match self.evaluate(step).await {
            Ok(()) => {}
            Err(fault) if fault.code == "cancelled" => return Err(fault),
            Err(fault) => self.with(|inner| {
                inner.published = false;
                inner.phase = Phase::Error;
                inner.detail = Some(fault.message);
            }),
        }
        self.emit(&step.events);
        Ok(())
    }

    async fn evaluate(&self, step: &Step) -> Result<(), Fault> {
        let installing = self.with(|inner| {
            let installing =
                inner.install_requested || inner.setup_phase_is(&["running", "queued"]);
            if installing {
                inner.phase = Phase::Installing;
            }
            installing
        });
        if installing {
            return Ok(());
        }
        let Some(cli) = self.cli_or_null(step).await? else {
            self.with(|inner| {
                inner.forget_tailscale();
                inner.phase = Phase::NotInstalled;
            });
            return Ok(());
        };
        let read = cli.status(&step.scope).await?;
        step.check()?;
        if matches!(read.spawn_error.as_deref(), Some("ENOENT" | "EACCES")) {
            self.with(|inner| {
                inner.cli = None;
                inner.forget_tailscale();
                inner.phase = Phase::NotInstalled;
            });
            return Ok(());
        }
        match read.status {
            None => self.unreachable(step, &cli, read.line).await,
            Some(status) => {
                self.apply_status(step, &cli, status, read.https_problem)
                    .await
            }
        }
    }

    /// Tailscale does not answer: its app or daemon is not running (or the OS holds it up).
    async fn unreachable(
        &self,
        step: &Step,
        cli: &CliInfo,
        line: Option<String>,
    ) -> Result<(), Fault> {
        let auto_start = self.with(|inner| {
            inner.seen = None;
            inner.phones = Vec::new();
            inner.published = false;
            inner.login_url = None;
            let _ = inner.unreachable_since.get_or_insert(step.now());
            std::mem::take(&mut inner.auto_start_app)
        });
        if auto_start {
            self.launch_app(step, cli).await?;
        }
        self.with(|inner| {
            let waiting_on_os = inner
                .app_started_at
                .is_some_and(|started| step.now() - started >= OS_APPROVAL_AFTER_MS);
            inner.phase = if waiting_on_os {
                Phase::NeedsOsApproval
            } else {
                Phase::AppNotRunning
            };
            inner.detail = Some(
                inner
                    .launch_error
                    .clone()
                    .or(line)
                    .unwrap_or_else(|| "Tailscale is not running".into()),
            );
        });
        Ok(())
    }

    /// The phase this status means. A stopped Tailscale that `up` started is read again (`when_stopped`).
    async fn apply_status(
        &self,
        step: &Step,
        cli: &CliInfo,
        status: Status,
        https_problem: Option<&'static str>,
    ) -> Result<(), Fault> {
        let mut next = Some((status, https_problem));
        while let Some((status, problem)) = next.take() {
            next = self.apply_once(step, cli, status, problem).await?;
        }
        Ok(())
    }

    async fn apply_once(
        &self,
        step: &Step,
        cli: &CliInfo,
        status: Status,
        https_problem: Option<&'static str>,
    ) -> Result<Option<(Status, Option<&'static str>)>, Fault> {
        self.adopt_user(step, status.login.as_deref()).await?;
        let early = self.with(|inner| {
            inner.seen = Some(Seen {
                backend: status.backend,
                auth_url: status.auth_url.clone(),
            });
            inner.launch_error = None;
            inner.version = status.version.clone();
            inner.update_available = status.update_available;
            inner.phones = status.phones.clone();
            if !matches!(status.backend, Backend::Starting | Backend::NoState) {
                inner.unreachable_since = None;
            }
            if status.backend != Backend::Running {
                inner.published = false;
                inner.detail = None;
            }
            let too_old = status.version.as_deref().is_some_and(|found| {
                version::compare(found, MIN_TAILSCALE_VERSION).is_some_and(|order| order.is_lt())
            });
            if too_old {
                inner.phase = Phase::Error;
                inner.detail = Some(format!(
                    "Tailscale {MIN_TAILSCALE_VERSION} or newer is required (found {})",
                    status.version.as_deref().unwrap_or_default()
                ));
            }
            too_old
        });
        if early {
            return Ok(None);
        }
        match status.backend {
            Backend::Running => {
                self.with(|inner| {
                    inner.app_started_at = None;
                    inner.guide_url = None;
                });
                self.when_running(step, cli, status.dns_name, https_problem)
                    .await?;
            }
            Backend::NeedsLogin => {
                self.with(|inner| inner.when_needs_login(status.auth_url, step.now()));
            }
            Backend::Stopped => return self.when_stopped(step, cli).await,
            Backend::NeedsMachineAuth => self.with(|inner| {
                inner.phase = Phase::NeedsMachineApproval;
                inner.guide_url = Some(ADMIN_MACHINES_URL.into());
            }),
            Backend::Starting | Backend::NoState => self.with(|inner| {
                let since = *inner.unreachable_since.get_or_insert(step.now());
                inner.phase = if step.now() - since >= OS_APPROVAL_AFTER_MS {
                    Phase::NeedsOsApproval
                } else {
                    Phase::Detecting
                };
            }),
            Backend::InUseOtherUser => self.with(|inner| {
                inner.phase = Phase::ServeBlocked;
                inner.detail = Some("Tailscale is in use by another user of this computer".into());
            }),
            Backend::Unknown => self.with(|inner| {
                inner.phase = Phase::Error;
                inner.detail = Some(format!("Unknown Tailscale state: {}", status.backend_state));
            }),
        }
        Ok(None)
    }

    async fn when_stopped(
        &self,
        step: &Step,
        cli: &CliInfo,
    ) -> Result<Option<(Status, Option<&'static str>)>, Fault> {
        let first = self.with(|inner| {
            inner.app_started_at = None;
            !std::mem::replace(&mut inner.up_tried, true)
        });
        if first {
            let up = cli.up(&step.scope, false).await?;
            step.check()?;
            self.with(|inner| {
                inner.up_error = (up.code != Some(0)).then(|| {
                    up.line
                        .clone()
                        .unwrap_or_else(|| "tailscale up failed".into())
                });
                if let Some(url) = up.login_url.clone() {
                    inner.login_url = Some(url);
                }
            });
            let again = cli.status(&step.scope).await?;
            step.check()?;
            if let Some(status) = again.status
                && status.backend != Backend::Stopped
            {
                return Ok(Some((status, again.https_problem)));
            }
        }
        self.with(|inner| {
            inner.phase = if inner.up_error.is_some() {
                Phase::Error
            } else {
                Phase::AppNotRunning
            };
            inner.detail = Some(
                inner
                    .up_error
                    .clone()
                    .unwrap_or_else(|| "Tailscale is turned off".into()),
            );
        });
        Ok(None)
    }

    async fn when_running(
        &self,
        step: &Step,
        cli: &CliInfo,
        host: Option<String>,
        https_problem: Option<&'static str>,
    ) -> Result<(), Fault> {
        let problem = https_problem.map(str::to_owned).or_else(|| {
            host.is_none()
                .then(|| "This machine has no MagicDNS name".into())
        });
        let host = match (host, problem) {
            (Some(host), None) => host,
            (_, problem) => {
                self.with(|inner| {
                    inner.published = false;
                    inner.phase = Phase::HttpsDisabled;
                    inner.detail = problem;
                    inner.guide_url = Some(
                        inner
                            .serve_guide
                            .clone()
                            .unwrap_or_else(|| ADMIN_DNS_URL.into()),
                    );
                });
                return Ok(());
            }
        };
        let held = self.with(|inner| {
            inner.host = Some(host.clone());
            let Some(blocked) = &inner.blocked else {
                return false;
            };
            if step.now() - blocked.at >= BLOCK_RETRY_MS {
                return false;
            }
            let (phase, detail) = (blocked.phase, blocked.detail.clone());
            inner.guide_url = (phase == Phase::HttpsDisabled).then(|| {
                inner
                    .serve_guide
                    .clone()
                    .unwrap_or_else(|| ADMIN_DNS_URL.into())
            });
            inner.phase = phase;
            inner.detail = Some(detail);
            true
        });
        if held {
            return Ok(());
        }
        self.publish(step, cli, &host).await
    }

    // ── serve ────────────────────────────────────────────────────────────────

    async fn publish(&self, step: &Step, cli: &CliInfo, host: &str) -> Result<(), Fault> {
        let announce = self.with(|inner| {
            let announce = inner.phase != Phase::Ready;
            if announce {
                inner.phase = Phase::Starting;
                inner.detail = None;
            }
            announce
        });
        if announce {
            self.emit(&step.events);
        }
        if !self.with(|inner| inner.server_up) {
            match self.port.start(step).await {
                Ok(port) => self.with(|inner| {
                    inner.local_port = Some(port);
                    inner.server_up = true;
                }),
                Err(fault) if fault.code == "cancelled" => return Err(fault),
                Err(fault) => {
                    self.with(|inner| {
                        inner.phase = Phase::Error;
                        inner.detail = Some(fault.message);
                    });
                    return Ok(());
                }
            }
        }
        let local = self
            .with(|inner| inner.local_port)
            .ok_or_else(|| Fault::new("internal", "The page's server has no port"))?;
        let base = format!("http://127.0.0.1:{local}");
        // Serve joins the target's path to every request's path: only traffic through serve carries the secret.
        let secret = self.port.serve_secret(step).await?;
        let target = format!("{base}/{secret}");
        let record = self.pref(step, PREF_SERVE).await?.unwrap_or(Value::Null);
        let outcome = cli
            .publish(&step.scope, host, &target, &base, record)
            .await?;
        step.check()?;
        let port = match outcome {
            Publish::Blocked { detail } => {
                self.with(|inner| inner.block(Phase::ServeBlocked, detail, step.now()));
                return Ok(());
            }
            Publish::Exposed { port, ours } => {
                self.refuse_funnel(step, host, port, ours);
                return Ok(());
            }
            Publish::Refused { detail, guide } => {
                // A "turn on HTTPS" page in `serve`'s words means the tailnet needs it, anything else is a block.
                self.with(|inner| {
                    let phase = if guide.is_some() {
                        Phase::HttpsDisabled
                    } else {
                        Phase::ServeBlocked
                    };
                    if guide.is_some() {
                        inner.serve_guide = guide;
                    }
                    inner.block(phase, detail, step.now());
                });
                return Ok(());
            }
            Publish::Published { port } => {
                self.with(|inner| inner.published = false);
                let record = json!({"host": host, "port": port, "target": base});
                self.set_pref(step, PREF_SERVE, record).await?;
                let confirmed = cli.confirm(&step.scope, host, port, &base, &target).await?;
                step.check()?;
                match confirmed {
                    Confirm::Missing => {
                        self.with(|inner| {
                            inner.block(
                                Phase::ServeBlocked,
                                "Tailscale accepted the command, but the handler is not in place"
                                    .into(),
                                step.now(),
                            );
                        });
                        return Ok(());
                    }
                    Confirm::Exposed => {
                        self.refuse_funnel(step, host, port, true);
                        return Ok(());
                    }
                    Confirm::Ready => port,
                }
            }
            Publish::Reuse { port } => port,
        };
        self.with(|inner| {
            inner.blocked = None;
            inner.serve_guide = None;
            inner.funnel_exposed = false;
        });
        // The server answers only to the address it is published at, only to traffic that came through serve (the
        // secret path), and only for an allowed tailnet user.
        let secret = self.port.serve_secret(step).await?;
        let address = Address {
            host: host.to_owned(),
            public_port: port,
            secure: true,
            serve_prefix: secret,
        };
        self.port.configure(step, &address).await?;
        self.with(|inner| {
            inner.published = true;
            inner.port = Some(port);
            inner.phase = Phase::Ready;
            inner.detail = None;
            inner.guide_url = None;
        });
        Ok(())
    }

    /// Funnel exposes our port: nothing is served, the page's server stops (the step does not wait for it).
    fn refuse_funnel(&self, step: &Step, host: &str, port: u32, ours: bool) {
        let stop = self.with(|inner| {
            inner.refuse_funnel(host, port, ours);
            std::mem::take(&mut inner.server_up)
        });
        if stop {
            self.port.begin_stop(step);
        }
    }

    /// Takes our handler down: only when the prefs record matches what is there exactly, then verifies that the
    /// user's other handlers are as they were. A record that no longer matches is only forgotten.
    async fn unpublish(&self, step: &Step, cli: &CliInfo) -> Result<Unpublish, Fault> {
        let stored = self.pref(step, PREF_SERVE).await?;
        let secret = self.port.serve_secret(step).await?;
        let outcome = cli
            .unpublish(&step.scope, stored.clone().unwrap_or(Value::Null), secret)
            .await?;
        step.check()?;
        // No record: whatever else the pref held goes. A handler that was taken down takes its record with it, also
        // when the check after it failed; any other failure keeps the record: the handler may still be there.
        let forget = match &outcome {
            Unpublish::None => stored.is_some(),
            Unpublish::RecordDropped | Unpublish::Removed => true,
            Unpublish::Failed { off, .. } => *off,
        };
        if forget {
            step.ask("prefDelete", json!({"key": PREF_SERVE})).await?;
        }
        if matches!(
            outcome,
            Unpublish::Removed | Unpublish::Failed { off: true, .. }
        ) {
            self.with(|inner| inner.published = false);
        }
        Ok(outcome)
    }

    async fn stop_server(&self, step: &Step) -> Result<(), Fault> {
        if !self.with(|inner| std::mem::take(&mut inner.server_up)) {
            return Ok(());
        }
        match self.port.stop(step).await {
            Err(fault) if fault.code == "cancelled" => Err(fault),
            _ => step.check(),
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    async fn cli_or_null(&self, step: &Step) -> Result<Option<Arc<CliInfo>>, Fault> {
        if let Some(cli) = self.with(|inner| inner.cli.clone()) {
            return Ok(Some(cli));
        }
        let answer = step.ask("locate", json!({})).await?;
        let found: Option<LocatedAnswer> = serde_json::from_value(answer)
            .map_err(|error| Fault::new("ask_failed", format!("locate: {error}")))?;
        let cli = found.and_then(|found| {
            let path = found.located.get("path")?.as_str()?.to_owned();
            let variant = found.located.get("variant")?.as_str()?.to_owned();
            Some(Arc::new(CliInfo {
                located: found.located,
                path,
                variant,
                env: found.env,
            }))
        });
        self.with(|inner| inner.cli.clone_from(&cli));
        Ok(cli)
    }

    /// The host of the control server this Tailscale signs in to (a self-hosted tailnet), asked once.
    async fn control_host_for(&self, step: &Step, cli: &CliInfo) -> Result<Option<String>, Fault> {
        if let Some(known) = self.with(|inner| inner.control_host.clone()) {
            return Ok(Some(known));
        }
        let host = cli.control_host(&step.scope).await?;
        step.check()?;
        self.with(|inner| inner.control_host.clone_from(&host));
        Ok(host)
    }

    /// This computer's tailnet user: allowed by default, so the allow list is never empty once it is known.
    async fn adopt_user(&self, step: &Step, login: Option<&str>) -> Result<(), Fault> {
        let Some(login) = login.filter(|login| !login.is_empty()) else {
            return Ok(());
        };
        self.with(|inner| inner.user = Some(login.to_owned()));
        let stored = self.pref(step, PREF_ALLOWED_USERS).await?;
        if logins_of(&stored).is_none_or(|logins| logins.is_empty()) {
            self.set_pref(step, PREF_ALLOWED_USERS, json!([login]))
                .await?;
        }
        Ok(())
    }
}

// ── the methods ──────────────────────────────────────────────────────────────

/// What every request carries: the service it is for (made with its first request), the platform it runs on, the
/// number its questions go by, and a test's clock.
#[derive(Deserialize)]
struct Common {
    service: u64,
    platform: Os,
    token: u64,
    now: Option<f64>,
    /// The setup item `tailscale` as main has it now (`SetupItemState`), sent with every request.
    #[serde(default)]
    setup_item: Option<Value>,
}

impl Common {
    fn service(&self) -> Arc<Svc> {
        let service = service(self.service, self.platform);
        service.with(|inner| inner.setup_item.clone_from(&self.setup_item));
        service
    }

    fn step(&self, call: &Call) -> Step {
        Step {
            service: self.service,
            token: self.token,
            scope: call.scope.clone(),
            events: call.events.clone(),
            now: self.now.map(|now| now as i64),
        }
    }
}

/// A step's answer: the state it ended in, the delay to the next poll and whether the step ended where the poll's
/// timer is armed again.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Done {
    #[serde(flatten)]
    snapshot: Snapshot,
    schedule: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum StepAction {
    Enable,
    Disable,
    StartApp,
    Login,
    Retry,
    Tick,
}

#[derive(Deserialize)]
struct StepParams {
    action: StepAction,
}

/// One serialized step; main's chain runs them one at a time and bounds each.
async fn step(call: Call) -> Result<Reply, Fault> {
    let common: Common = call.params()?;
    let params: StepParams = call.params()?;
    let service = common.service();
    let step = common.step(&call);
    let schedule = match params.action {
        StepAction::Enable => service.enable(&step).await?,
        StepAction::Disable => service.disable(&step).await?,
        StepAction::StartApp => service.start_app(&step).await?,
        StepAction::Login => service.login(&step).await?,
        StepAction::Retry => service.retry(&step).await?,
        StepAction::Tick => {
            service.tick(&step).await?;
            true
        }
    };
    Reply::json(&service.done(schedule))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
enum Act {
    Install,
    CancelInstall,
    OpenSystemSettings,
    SetAllowedUsers { users: Vec<String> },
    SetConfirmNewDevices { on: bool },
    Watch { on: bool },
}

#[derive(Deserialize)]
struct ActParams {
    request: Act,
}

/// A request that is no step: it runs beside whatever step is running.
async fn act(call: Call) -> Result<Reply, Fault> {
    let common: Common = call.params()?;
    let params: ActParams = call.params()?;
    let service = common.service();
    let step = common.step(&call);
    match params.request {
        Act::Install => service.install(&step),
        Act::CancelInstall => {
            step.ask("cancelInstall", json!({})).await?;
        }
        Act::OpenSystemSettings => {
            step.ask("openSystemSettings", json!({})).await?;
        }
        Act::SetAllowedUsers { users } => service.set_allowed_users(&step, &users).await?,
        Act::SetConfirmNewDevices { on } => {
            service
                .set_pref(&step, PREF_CONFIRM_NEW_DEVICES, Value::Bool(on))
                .await?;
            service.emit(&step.events);
        }
        Act::Watch { on } => service.with(|inner| inner.watching = on),
    }
    Reply::json(&service.done(false))
}

#[derive(Serialize)]
struct Started {
    started: bool,
    #[serde(flatten)]
    snapshot: Snapshot,
}

/// At launch: pick the switch up where the last run left it.
async fn start(call: Call) -> Result<Reply, Fault> {
    let common: Common = call.params()?;
    let service = common.service();
    let started = service.start(&common.step(&call)).await?;
    Reply::json(&Started {
        started,
        snapshot: service.with(Inner::snapshot),
    })
}

#[derive(Deserialize)]
struct WhoisRequest {
    address: String,
}

async fn whois(call: Call) -> Result<Reply, Fault> {
    let common: Common = call.params()?;
    let params: WhoisRequest = call.params()?;
    let peer = common
        .service()
        .whois(&common.step(&call), params.address)
        .await?;
    Reply::json(&peer)
}

#[derive(Deserialize)]
struct AdoptParams {
    login: String,
}

async fn adopt(call: Call) -> Result<Reply, Fault> {
    let common: Common = call.params()?;
    let params: AdoptParams = call.params()?;
    common
        .service()
        .adopt_login(&common.step(&call), params.login)
        .await?;
    Reply::json(&Value::Null)
}

async fn dispose(call: Call) -> Result<Reply, Fault> {
    let common: Common = call.params()?;
    let service = common.service();
    service.dispose(&call.events);
    services().remove(&common.service);
    // What it still asks is not wanted any more.
    asks()
        .waiting
        .retain(|_, (asker, _)| *asker != common.service);
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct AnswerParams {
    call: u64,
    ok: bool,
    result: Option<Value>,
    message: Option<String>,
}

/// Main's answer to a question reaches whoever waits for it; one that nobody waits for any more is dropped.
fn resolve(call: u64, answer: Answer) {
    let waiting = asks().waiting.remove(&call);
    if let Some((_, waiting)) = waiting {
        let _ = waiting.send(answer);
    }
}

async fn answer(call: Call) -> Result<Reply, Fault> {
    let params: AnswerParams = call.params()?;
    resolve(
        params.call,
        if params.ok {
            Answer::Result(params.result.unwrap_or(Value::Null))
        } else {
            Answer::Failed(params.message.unwrap_or_default())
        },
    );
    Reply::json(&Value::Null)
}

pub fn register(registry: &mut Registry) {
    registry.add("mobileWeb.step", |call| Box::pin(step(call)));
    registry.add("mobileWeb.act", |call| Box::pin(act(call)));
    registry.add("mobileWeb.start", |call| Box::pin(start(call)));
    registry.add("mobileWeb.whois", |call| Box::pin(whois(call)));
    registry.add("mobileWeb.adopt", |call| Box::pin(adopt(call)));
    registry.add("mobileWeb.dispose", |call| Box::pin(dispose(call)));
    registry.add("mobileWeb.answer", |call| Box::pin(answer(call)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_a_sign_in_link_only_on_a_login_host() {
        // The cases of `loginUrlAllowed` in the TypeScript's `cli.test.ts`.
        let rows: &[(&str, Option<&str>, bool)] = &[
            ("https://login.tailscale.com/a/x", None, true),
            ("https://LOGIN.tailscale.com/a/x", None, true),
            ("http://login.tailscale.com/a/x", None, false),
            ("https://login.tailscale.com.evil.example/a", None, false),
            ("https://user:pw@login.tailscale.com/a", None, false),
            ("javascript:alert(1)", None, false),
            ("https://hs.example.org/register/x", None, false),
            (
                "https://hs.example.org/register/x",
                Some("hs.example.org"),
                true,
            ),
            (
                "https://HS.example.org/register/x",
                Some("hs.EXAMPLE.org"),
                true,
            ),
            ("not a url", Some("hs.example.org"), false),
        ];
        for (url, control, allowed) in rows {
            assert_eq!(login_url_allowed(url, *control), *allowed, "{url}");
        }
    }

    #[test]
    fn cleans_logins_as_the_typescript_did() {
        let clean = |values: &[Option<&str>]| clean_logins(values.iter().copied());
        assert_eq!(
            clean(&[
                Some(" family@example.com "),
                Some("FAMILY@example.com"),
                Some(""),
                None,
                Some("\u{a0}"),
                Some("seuput@example.com"),
            ]),
            ["family@example.com", "seuput@example.com"]
        );
        assert!(clean(&[Some(" ")]).is_empty());
        let stored = Some(json!([" a@x ", 7, "A@X", "b@x"]));
        assert_eq!(logins_of(&stored).unwrap(), ["a@x", "b@x"]);
        assert_eq!(logins_of(&Some(json!("a@x"))), None);
        assert_eq!(logins_of(&None), None);
    }

    #[test]
    fn polls_fast_while_a_step_waits_and_not_at_all_while_off() {
        let mut inner = Inner::new();
        assert_eq!(inner.poll_ms(), None);
        inner.enabled = true;
        for (phase, ms) in [
            (Phase::Ready, POLL_MS),
            (Phase::NeedsLogin, POLL_MS),
            (Phase::Error, POLL_MS),
            (Phase::AppNotRunning, FAST_POLL_MS),
            (Phase::NeedsOsApproval, FAST_POLL_MS),
            (Phase::LoggingIn, FAST_POLL_MS),
            (Phase::Detecting, FAST_POLL_MS),
            (Phase::Starting, FAST_POLL_MS),
        ] {
            inner.phase = phase;
            assert_eq!(inner.poll_ms(), Some(ms));
        }
        inner.phase = Phase::Ready;
        inner.watching = true;
        assert_eq!(inner.poll_ms(), Some(FAST_POLL_MS));
        inner.disposed = true;
        assert_eq!(inner.poll_ms(), None);
    }

    #[test]
    fn names_the_state_as_the_page_reads_it() {
        let mut inner = Inner::new();
        assert_eq!(
            serde_json::to_value(inner.state()).unwrap(),
            json!({
                "enabled": false, "phase": "off", "url": null, "host": null, "port": null, "user": null,
                "tailscale": null, "loginUrl": null, "guideUrl": null, "detail": null,
                "funnelExposed": false, "published": false, "phones": [],
            })
        );
        inner.enabled = true;
        inner.phase = Phase::NeedsMachineApproval;
        inner.host = Some("laptop.tail.ts.net".into());
        inner.port = Some(47831);
        inner.login_url = Some("https://login.tailscale.com/a/x".into());
        let state = serde_json::to_value(inner.state()).unwrap();
        assert_eq!(state["phase"], "needs-machine-approval");
        // The address is only given while ready, and the sign-in link only while signing in.
        assert_eq!(
            (&state["url"], &state["loginUrl"]),
            (&Value::Null, &Value::Null)
        );
        assert_eq!(
            (&state["host"], &state["port"]),
            (&json!("laptop.tail.ts.net"), &json!(47831))
        );
        inner.phase = Phase::Ready;
        assert_eq!(
            inner.state().url.as_deref(),
            Some("https://laptop.tail.ts.net:47831")
        );
        inner.phase = Phase::LoggingIn;
        assert!(inner.state().login_url.is_some());
        inner.enabled = false;
        assert_eq!((inner.state().host, inner.state().port), (None, None));
    }

    #[test]
    fn a_block_keeps_its_guide_only_for_https() {
        let mut inner = Inner::new();
        inner.serve_guide = Some("https://login.tailscale.com/f/serve?node=n".into());
        inner.block(Phase::HttpsDisabled, "off".into(), 7);
        assert_eq!(inner.guide_url.as_deref(), inner.serve_guide.as_deref());
        assert_eq!(inner.blocked.as_ref().map(|blocked| blocked.at), Some(7));
        inner.block(Phase::ServeBlocked, "policy".into(), 8);
        assert_eq!(inner.guide_url, None);
        inner.serve_guide = None;
        inner.block(Phase::HttpsDisabled, "off".into(), 9);
        assert_eq!(inner.guide_url.as_deref(), Some(ADMIN_DNS_URL));
    }

    #[test]
    fn refuses_a_funnel_port_in_words_and_keeps_what_is_ours() {
        let mut inner = Inner::new();
        inner.refuse_funnel("h.ts.net", 47831, true);
        assert!(inner.funnel_exposed && inner.published);
        assert_eq!(inner.phase, Phase::ServeBlocked);
        assert_eq!(
            inner.detail.as_deref(),
            Some(
                "Tailscale Funnel exposes https://h.ts.net:47831 to the internet, so OMPdesk will not serve there"
            )
        );
        inner.refuse_funnel("h.ts.net", 47832, false);
        assert!(!inner.published);
        assert_eq!(inner.port, Some(47832));
    }

    #[test]
    fn signing_in_lasts_ten_minutes_and_offers_only_an_allowed_link() {
        let mut inner = Inner::new();
        inner.login_started_at = Some(1_000);
        inner.when_needs_login(
            Some("https://login.tailscale.com/a/1".into()),
            1_000 + LOGIN_TIMEOUT_MS - 1,
        );
        assert_eq!(inner.phase, Phase::LoggingIn);
        assert_eq!(
            inner.login_url.as_deref(),
            Some("https://login.tailscale.com/a/1")
        );
        inner.when_needs_login(None, 1_000 + LOGIN_TIMEOUT_MS);
        assert_eq!(inner.phase, Phase::NeedsLogin);
        assert_eq!(inner.login_started_at, None);
        // The link kept from before is shown again, unless it is not on a login host.
        assert_eq!(
            inner.login_url.as_deref(),
            Some("https://login.tailscale.com/a/1")
        );
        inner.when_needs_login(Some("https://evil.example/a".into()), 5);
        assert_eq!(inner.login_url, None);
    }

    /// The machine over a stand-in `tailscale` script and a main that answers (a shell script: POSIX only).
    #[cfg(unix)]
    mod machine {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::Duration;

        use tokio::sync::mpsc::UnboundedReceiver;

        use super::super::*;
        use crate::wire::Frame;

        static NEXT: AtomicU64 = AtomicU64::new(1_000);

        // ── the machine, over a stand-in `tailscale` and a main that answers ──────

        /// What main is in these tests: prefs, the questions it was asked, the states pushed to it.
        struct World {
            prefs: Mutex<HashMap<String, Value>>,
            asked: Mutex<Vec<(String, Value)>>,
            states: Mutex<Vec<Value>>,
            bin: String,
            /// A question that is never answered.
            hang: Option<&'static str>,
        }

        impl World {
            fn asked(&self, op: &str) -> Vec<Value> {
                let asked = self.asked.lock().unwrap();
                asked
                    .iter()
                    .filter(|(asked, _)| asked == op)
                    .map(|(_, data)| data.clone())
                    .collect()
            }

            fn pref(&self, key: &str) -> Option<Value> {
                self.prefs.lock().unwrap().get(key).cloned()
            }

            fn answer(&self, op: &str, data: &Value) -> Answer {
                let result = |value: Value| Answer::Result(value);
                match op {
                    "prefGet" => {
                        let prefs = self.prefs.lock().unwrap();
                        match prefs.get(data["key"].as_str().unwrap()) {
                            Some(value) => result(json!({"value": value})),
                            None => result(json!({})),
                        }
                    }
                    "prefSet" => {
                        let key = data["key"].as_str().unwrap().to_owned();
                        self.prefs
                            .lock()
                            .unwrap()
                            .insert(key, data["value"].clone());
                        result(Value::Null)
                    }
                    "prefDelete" => {
                        self.prefs
                            .lock()
                            .unwrap()
                            .remove(data["key"].as_str().unwrap());
                        result(Value::Null)
                    }
                    "locate" => result(json!({
                        "located": {"path": self.bin, "variant": "mac-cli", "app": null, "env": {}},
                        "env": std::env::vars().collect::<BTreeMap<_, _>>(),
                    })),
                    "serverStart" => result(json!({"port": 51000})),
                    "serveSecret" => result(json!("secret0123")),
                    "startApp" => result(json!({"code": 0, "line": null})),
                    _ => result(Value::Null),
                }
            }
        }

        /// Answers the core's questions the way `World` says, and records them and the states.
        fn serve_asks(mut frames: UnboundedReceiver<Frame>, world: Arc<World>) {
            tokio::spawn(async move {
                while let Some(frame) = frames.recv().await {
                    let (head, _) = frame.parts();
                    let Ok(head) = serde_json::from_slice::<Value>(head) else {
                        continue;
                    };
                    let data = head["data"].clone();
                    match head["event"].as_str() {
                        Some("mobileWeb.state") => {
                            world.states.lock().unwrap().push(data["state"].clone())
                        }
                        Some("mobileWeb.ask") => {
                            let op = data["op"].as_str().unwrap().to_owned();
                            world.asked.lock().unwrap().push((op.clone(), data.clone()));
                            if world.hang != Some(op.as_str()) {
                                resolve(data["call"].as_u64().unwrap(), world.answer(&op, &data));
                            }
                        }
                        _ => {}
                    }
                }
            });
        }

        /// A `tailscale` stand-in: the file `down` makes it fail like an app that is not running, `needslogin` signs
        /// it out; `serve` writes `serve.json`; every call is appended to `calls`.
        fn stand_in() -> (std::path::PathBuf, String) {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!(
                "ompdesk-ts-service-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let script = r#"#!/bin/sh
    dir="$(dirname "$0")"
    echo "$*" >> "$dir/calls"
    if [ -f "$dir/down" ]; then echo "failed to connect to local tailscaled" >&2; exit 1; fi
    case "$1 $2" in
    "status --json")
      if [ -f "$dir/needslogin" ]; then
        echo '{"BackendState":"NeedsLogin","Version":"1.104.1-tfake","AuthURL":"https://login.tailscale.com/a/fake"}'
      else
        echo '{"BackendState":"Running","Version":"1.104.1-tfake","Self":{"ID":"nSELF","HostName":"laptop","DNSName":"laptop.tail1234.ts.net.","UserID":1001,"Capabilities":["https"]},"User":{"1001":{"LoginName":"seuput@example.com"}},"CertDomains":["laptop.tail1234.ts.net"],"CurrentTailnet":{"MagicDNSEnabled":true},"Peer":{}}'
      fi ;;
    "serve status")
      if [ -f "$dir/serve.json" ]; then cat "$dir/serve.json"; else echo '{}'; fi ;;
    "serve --bg")
      port="${3#--https=}"
      printf '{"TCP":{"%s":{"HTTPS":true}},"Web":{"laptop.tail1234.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$port" "$port" "$4" > "$dir/serve.json" ;;
    serve\ --https=*)
      rm -f "$dir/serve.json" ;;
    *) echo "unexpected: $*" >&2; exit 2 ;;
    esac
    "#;
            let path = dir.join("tailscale");
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            let bin = path.to_string_lossy().into_owned();
            (dir, bin)
        }

        struct Machine {
            dir: std::path::PathBuf,
            world: Arc<World>,
            svc: Arc<Svc>,
            id: u64,
            events: Events,
            _keep: tokio::sync::mpsc::UnboundedSender<Frame>,
        }

        impl Machine {
            fn new(hang: Option<&'static str>) -> Machine {
                let (dir, bin) = stand_in();
                let world = Arc::new(World {
                    prefs: Mutex::default(),
                    asked: Mutex::default(),
                    states: Mutex::default(),
                    bin,
                    hang,
                });
                let (events, keep, frames) = Events::capture();
                serve_asks(frames, Arc::clone(&world));
                let id = NEXT.fetch_add(1, Ordering::SeqCst);
                Machine {
                    svc: service(id, Os::Darwin),
                    dir,
                    world,
                    id,
                    events,
                    _keep: keep,
                }
            }

            fn step(&self, now: i64) -> Step {
                Step {
                    service: self.id,
                    token: 1,
                    scope: Scope::detached(),
                    events: self.events.clone(),
                    now: Some(now),
                }
            }

            fn calls(&self) -> Vec<String> {
                std::fs::read_to_string(self.dir.join("calls"))
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_owned)
                    .collect()
            }

            fn phase(&self) -> Value {
                serde_json::to_value(self.svc.with(|inner| inner.state()).phase).unwrap()
            }
        }

        impl Drop for Machine {
            fn drop(&mut self) {
                services().remove(&self.id);
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        const NOW: i64 = 1_000_000;

        #[tokio::test]
        async fn publishes_beside_the_users_own_handlers_and_takes_only_its_own_down() {
            let machine = Machine::new(None);
            let step = machine.step(NOW);
            assert!(machine.svc.enable(&step).await.unwrap());
            let state = machine
                .svc
                .with(|inner| serde_json::to_value(inner.state()).unwrap());
            assert_eq!(state["phase"], "ready");
            assert_eq!(state["url"], "https://laptop.tail1234.ts.net:47831");
            assert_eq!(
                (&state["published"], &state["user"]),
                (&json!(true), &json!("seuput@example.com"))
            );
            assert_eq!(state["tailscale"]["variant"], "mac-cli");
            let world = &machine.world;
            assert_eq!(world.pref(PREF_ENABLED), Some(json!(true)));
            assert_eq!(
                world.pref(PREF_ALLOWED_USERS),
                Some(json!(["seuput@example.com"]))
            );
            assert_eq!(
                world.pref(PREF_SERVE),
                Some(
                    json!({"host": "laptop.tail1234.ts.net", "port": 47831, "target": "http://127.0.0.1:51000"})
                )
            );
            assert_eq!(
                world.asked("serverConfigure").last().map(|data| {
                    (
                        data["host"].clone(),
                        data["publicPort"].clone(),
                        data["secure"].clone(),
                        data["servePrefix"].clone(),
                    )
                }),
                Some((
                    json!("laptop.tail1234.ts.net"),
                    json!(47831),
                    json!(true),
                    json!("secret0123")
                ))
            );
            assert!(machine.calls().contains(
                &"serve --bg --https=47831 http://127.0.0.1:51000/secret0123".to_owned()
            ));
            // The states it pushed end in the one it holds.
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(world.states.lock().unwrap().last(), Some(&state));
            // A poll that finds nothing changed pushes nothing.
            let pushed = world.states.lock().unwrap().len();
            machine.svc.tick(&step).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(world.states.lock().unwrap().len(), pushed);
            assert_eq!(
                machine
                    .calls()
                    .iter()
                    .filter(|call| call.starts_with("serve --bg"))
                    .count(),
                1
            );

            assert!(!machine.svc.disable(&step).await.unwrap());
            assert_eq!(machine.phase(), "off");
            assert!(!machine.dir.join("serve.json").exists());
            assert_eq!(world.pref(PREF_SERVE), None);
            assert_eq!(world.pref(PREF_ENABLED), Some(json!(false)));
            assert_eq!(world.asked("serverStop").len(), 1);
            assert_eq!(machine.svc.with(|inner| inner.poll_ms()), None);
            assert!(
                machine
                    .calls()
                    .iter()
                    .any(|call| call == "serve --https=47831 off")
            );
            // Nothing here ever resets serve or runs Funnel (spelled apart: the sources are searched for the words).
            let banned = [["re", "set"].concat(), ["fun", "nel"].concat()];
            assert!(machine.calls().iter().all(|call| {
                banned
                    .iter()
                    .all(|word| !call.to_lowercase().contains(word.as_str()))
            }));
        }

        #[tokio::test]
        async fn a_stopped_step_asks_nothing_more_and_writes_nothing() {
            let machine = Machine::new(Some("serverStart"));
            let step = machine.step(NOW);
            let scope = step.scope.clone();
            let svc = Arc::clone(&machine.svc);
            let running = tokio::spawn(async move { svc.enable(&step).await });
            // It waits for the page's server, which never answers.
            for _ in 0..200 {
                if !machine.world.asked("serverStart").is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(machine.world.asked("serverStart").len(), 1);
            let before = machine
                .svc
                .with(|inner| serde_json::to_value(inner.state()).unwrap());
            assert_eq!(before["phase"], "starting");
            scope.cancel();
            let ended = running.await.unwrap();
            assert_eq!(ended.unwrap_err(), Fault::cancelled());
            // The server answers late: nothing happens with it.
            let call = machine.world.asked("serverStart")[0]["call"]
                .as_u64()
                .unwrap();
            resolve(call, Answer::Result(json!({"port": 51001})));
            tokio::time::sleep(Duration::from_millis(100)).await;
            let after = machine
                .svc
                .with(|inner| serde_json::to_value(inner.state()).unwrap());
            assert_eq!(after, before);
            assert!(!machine.svc.with(|inner| inner.server_up));
            assert!(machine.world.asked("serveSecret").is_empty());
            assert!(!machine.dir.join("serve.json").exists());
            // A step that starts in a stopped scope asks and runs nothing.
            let stopped = machine.step(NOW);
            stopped.scope.cancel();
            assert_eq!(
                machine.svc.retry(&stopped).await.unwrap_err(),
                Fault::cancelled()
            );
            assert_eq!(machine.world.asked("locate").len(), 1);
        }

        #[tokio::test]
        async fn waits_on_the_os_twenty_seconds_after_it_started_the_app() {
            let machine = Machine::new(None);
            std::fs::write(machine.dir.join("down"), "").unwrap();
            assert!(machine.svc.enable(&machine.step(NOW)).await.unwrap());
            let state = machine
                .svc
                .with(|inner| serde_json::to_value(inner.state()).unwrap());
            assert_eq!(state["phase"], "app-not-running");
            assert_eq!(state["detail"], "failed to connect to local tailscaled");
            // Not running: the app is opened, and the OS gets 20 s before it is blamed.
            assert!(machine.svc.start_app(&machine.step(NOW)).await.unwrap());
            assert_eq!(machine.world.asked("startApp").len(), 1);
            assert_eq!(machine.phase(), "app-not-running");
            machine
                .svc
                .tick(&machine.step(NOW + OS_APPROVAL_AFTER_MS - 1))
                .await
                .unwrap();
            assert_eq!(machine.phase(), "app-not-running");
            machine
                .svc
                .tick(&machine.step(NOW + OS_APPROVAL_AFTER_MS))
                .await
                .unwrap();
            assert_eq!(machine.phase(), "needs-os-approval");
            // It carries on by itself once Tailscale answers.
            std::fs::remove_file(machine.dir.join("down")).unwrap();
            machine.svc.tick(&machine.step(NOW + 30_000)).await.unwrap();
            assert_eq!(machine.phase(), "ready");
        }

        #[tokio::test]
        async fn signs_in_through_a_link_on_the_login_host_for_ten_minutes() {
            let machine = Machine::new(None);
            std::fs::write(machine.dir.join("needslogin"), "").unwrap();
            machine.svc.enable(&machine.step(NOW)).await.unwrap();
            let state = machine
                .svc
                .with(|inner| serde_json::to_value(inner.state()).unwrap());
            assert_eq!(state["phase"], "needs-login");
            assert_eq!(state["loginUrl"], "https://login.tailscale.com/a/fake");
            assert!(machine.svc.login(&machine.step(NOW)).await.unwrap());
            assert_eq!(machine.phase(), "logging-in");
            assert_eq!(
                machine
                    .world
                    .asked("openExternal")
                    .last()
                    .map(|data| data["url"].clone()),
                Some(json!("https://login.tailscale.com/a/fake"))
            );
            machine
                .svc
                .tick(&machine.step(NOW + LOGIN_TIMEOUT_MS - 1))
                .await
                .unwrap();
            assert_eq!(machine.phase(), "logging-in");
            machine
                .svc
                .tick(&machine.step(NOW + LOGIN_TIMEOUT_MS))
                .await
                .unwrap();
            assert_eq!(machine.phase(), "needs-login");
            // Signed out nowhere else: this is not a state `login` acts on.
            std::fs::remove_file(machine.dir.join("needslogin")).unwrap();
            machine
                .svc
                .tick(&machine.step(NOW + LOGIN_TIMEOUT_MS))
                .await
                .unwrap();
            assert!(!machine.svc.login(&machine.step(NOW)).await.unwrap());
        }

        #[tokio::test]
        async fn keeps_the_allow_list_non_empty_and_the_pref_is_main_s() {
            let machine = Machine::new(None);
            let step = machine.step(NOW);
            let empty = machine.svc.set_allowed_users(&step, &[" ".into()]).await;
            assert_eq!(
                empty.unwrap_err().message,
                "At least one Tailscale user must be allowed"
            );
            machine
                .svc
                .adopt_login(&step, "me@example.com".into())
                .await
                .unwrap();
            assert_eq!(
                machine.world.pref(PREF_ALLOWED_USERS),
                Some(json!(["me@example.com"]))
            );
            machine
                .svc
                .set_allowed_users(&step, &[" a@x ".into(), "A@X".into(), "b@x".into()])
                .await
                .unwrap();
            assert_eq!(
                machine.world.pref(PREF_ALLOWED_USERS),
                Some(json!(["a@x", "b@x"]))
            );
            machine.svc.set_allowed_users(&step, &[]).await.unwrap();
            assert_eq!(
                machine.world.pref(PREF_ALLOWED_USERS),
                Some(json!(["me@example.com"]))
            );
            // A list that is set is not replaced when the login is adopted again.
            machine
                .svc
                .adopt_login(&step, "other@example.com".into())
                .await
                .unwrap();
            assert_eq!(
                machine.world.pref(PREF_ALLOWED_USERS),
                Some(json!(["me@example.com"]))
            );
        }
    }
}
