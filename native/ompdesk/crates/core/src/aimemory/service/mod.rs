//! ai-memory as OMPdesk's memory (was `AiMemoryService` of `src/main/ai-memory/service.ts` with `binary.ts`,
//! `unit.ts`, `root.ts`, `terminal.ts`, `suppress.ts`, `recall-state.ts` and `config.ts`): stage the shipped binary,
//! keep ai-memory's own per-user service running and give the omp sessions OMPdesk spawns an app-owned extension
//! root. Memory and learning are always on (the user's decision of 29 Oct 2026): there is no off switch, and only
//! OMPdesk's own build ever runs, as OMPdesk's own service.
//!
//! Why ai-memory's own service rather than a child OMPdesk supervises: ai-memory documents it as the local single-user
//! setup (launchd LaunchAgent on macOS, a logon entry on Windows, `ai-memory setup`), and a terminal omp the person
//! connected keeps capturing while OMPdesk is closed. OMPdesk therefore supervises nothing long-lived: it runs short,
//! idempotent `ai-memory` commands, polls `/healthz`, and re-runs `setup` when the service or the root went missing.
//! `pass.rs` holds the passes; `binary`, `unit`, `root`, `terminal` and `text` what they use.
//!
//! Main opens one service (`aimemory.service.open`, named by main) and is its typed client
//! (`src/main/ai-memory/service.ts`). What only main has the core asks for with the event `aimemory.service.ask`
//! `{service, ask, what, …}`, answered by the request `aimemory.service.answer` `{ask, value}` or `{ask, error}`:
//! - `run` `{bin, args, env, isolated}` → `{ok, cancelled, output}` or `{spawn}`: an `ai-memory` command under main's
//!   `SetupRunner` and the setup supervisor (`setup --yes` isolated: the service host outlives the app and must hold
//!   no handle of it); `aimemory.service.cancel` `{ask}` stops it.
//! - `agentDir`, `terminalPref`, `persistTerminal {enabled}`, `bunPresent`, `beforeStart`, `spawnEnv`,
//!   `disabledLists {files}` (each config's `disabledExtensions`, read with main's YAML reader), and the test seams
//!   `codeRequirement {file}` and `unit {op}`.
//!
//! Events: `aimemory.service.state` `{state}` on every change (main keeps the copy its synchronous readers
//! read), `aimemory.service.log` `{message, details}` (main writes `gui-runtime.jsonl`: one writer per file),
//! `aimemory.service.stalled` when a step ran past its bound.
//!
//! One step at a time: the wiring pass, a purge and a terminal change queue (`aimemory.service.queue`, answered once
//! queued, so main's order is the queue's; `aimemory.service.outcome` waits for the step's end). A step past its
//! bound is stopped (its future dropped: a command it runs is cancelled, nothing it would still do happens) and the
//! next starts. A health check runs beside the queue and joins one already running.
//!
//! The clock is the system's; a test's service is opened `manual`: then every request says the time and every timer
//! is main's (`aimemory.service.timer` `{timer, ms, repeat}`, `clearTimer`, fired by `aimemory.service.fire`), so
//! vitest's fake timers drive the real core.

#[path = "../application.rs"]
pub mod application;

mod binary;
mod pass;
mod root;
mod terminal;
#[cfg(test)]
mod tests;
mod text;
mod unit;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::disk::tree::write_atomic_if;
use crate::server::{Call, Events, Fault, Registry, Reply};
use binary::{Builds, BuiltAsset};

/// A future a part takes from its caller (a command run, a signature check), sendable across the runtime's threads.
pub type Boxed<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn system_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// Why a step or one of its parts did not go on.
#[derive(Debug, Clone)]
pub enum Failure {
    /// A step failed; the message is what Settings shows (logged without a stack).
    Step(String),
    /// Something unexpected: a failure main reported with its stack, or one of the core's own.
    Error {
        message: String,
        stack: Option<String>,
    },
    /// The person's cancel (the runner stopped a command): not a failure.
    Cancelled,
}

impl Failure {
    pub fn step(message: impl Into<String>) -> Failure {
        Failure::Step(message.into())
    }

    pub fn message(&self) -> String {
        match self {
            Failure::Step(message) | Failure::Error { message, .. } => message.clone(),
            Failure::Cancelled => "Cancelled".to_owned(),
        }
    }

    /// As a step's own failure: the message kept, the stack dropped.
    pub fn into_step(self) -> Failure {
        match self {
            Failure::Error { message, .. } => Failure::Step(message),
            other => other,
        }
    }

    fn fault(&self) -> Fault {
        Fault::new("memory_service", self.message())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Wiring {
    pub app: bool,
    pub terminal: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub pages: Number,
    pub sessions: Number,
    pub observations: Number,
    pub disk_bytes: Number,
}

/// `AiMemoryState` of `src/shared/ai-memory.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub phase: &'static str,
    pub step: Option<&'static str>,
    pub version: Option<String>,
    pub binary: Option<String>,
    pub data_dir: Option<String>,
    pub server_url: Option<String>,
    pub web_url: Option<String>,
    pub wiring: Wiring,
    pub stats: Option<Stats>,
    pub detail: Option<String>,
    pub unsupported: Option<&'static str>,
}

/// How main opens the service: `AiMemoryServiceDeps` as data, and which asks it answers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Deps {
    platform: String,
    arch: String,
    automatic: bool,
    tools_dir: String,
    bundled_dir: Option<String>,
    binary_override: Option<String>,
    no_service: bool,
    home: String,
    root_dir: String,
    /// `<userData>/ai-memory/recall.json`, which every spawned omp reads memory's address from; none in tests.
    recall_file: Option<String>,
    uid: u32,
    /// Main stands in for the OS service (a test, the e2e's pid file): `unit` asks.
    unit_asks: bool,
    /// Main checks the macOS signature itself (a test): `codeRequirement` asks.
    code_requirement_asks: bool,
    bun_check: bool,
    before_start: bool,
    poll_ms: u64,
    health_wait_ms: u64,
    retry_delays_ms: Vec<u64>,
    step_max_ms: u64,
    manual: bool,
    now: Option<f64>,
    builds: Builds,
    hub_entry: Value,
}

/// What the wiring pass staged: the binary every command runs, its version, and the build to prune others against.
#[derive(Clone)]
struct Resolved {
    bin: String,
    version: Option<String>,
    staged: Option<BuiltAsset>,
}

/// What changes between the steps and checks.
struct Inner {
    state: State,
    disposed: bool,
    resolved: Option<Resolved>,
    down_polls: u32,
    last_rewire: i64,
    stats_at: i64,
    /// A wiring pass found no Bun: Bun arriving (`bunInstalled`) runs it again, once.
    awaiting_bun: bool,
    /// Automatic re-runs since the last pass that wired; bounded by `retry_delays_ms`.
    retries: usize,
    retry: Option<JoinHandle<()>>,
    poll: Option<JoinHandle<()>>,
    /// The health check running now, joined by any check asked for meanwhile.
    checking: Option<watch::Receiver<Option<Result<(), String>>>>,
}

/// One queued step: the pass, a purge or a terminal change, with whoever waits for its end.
enum Op {
    Enable,
    Purge,
    Terminal(bool),
}

struct Job {
    op: Op,
    done: Option<oneshot::Sender<Result<(), Fault>>>,
}

pub struct Service {
    name: String,
    events: Events,
    deps: Deps,
    native: Option<application::Native>,
    unit: Option<unit::Unit>,
    inner: Mutex<Inner>,
    jobs: mpsc::UnboundedSender<Job>,
    /// Outcomes of queued steps main will ask for, by step.
    outcomes: Mutex<HashMap<u64, oneshot::Receiver<Result<(), Fault>>>>,
    next_step: AtomicU64,
    asks: Mutex<HashMap<u64, oneshot::Sender<Result<Value, Failure>>>>,
    next_ask: AtomicU64,
    /// The clock main says (a `manual` service), and its timers by id.
    now: Mutex<i64>,
    timers: Mutex<HashMap<u64, mpsc::UnboundedSender<()>>>,
    next_timer: AtomicU64,
    recall: Option<RecallFile>,
    /// The queue's task: it ends with the service, and the step it runs with it.
    worker: Mutex<Option<JoinHandle<()>>>,
    closed: watch::Sender<bool>,
}

static SERVICES: LazyLock<Mutex<HashMap<String, Arc<Service>>>> = LazyLock::new(Default::default);

/// The file a spawned omp reads memory's address from (the bridge's recall, env `OMP_GUI_MEMORY`): `{url, dataDir}`
/// once the data folder is known, owner-only, written by a thread of its own (newest first) and only when it changed.
/// While the data folder is not known yet this launch, what an earlier launch wrote stays.
struct RecallFile {
    written: Arc<Mutex<Option<String>>>,
    queue: std_mpsc::Sender<String>,
}

impl RecallFile {
    fn open(file: PathBuf) -> RecallFile {
        let (queue, texts) = std_mpsc::channel::<String>();
        let written: Arc<Mutex<Option<String>>> = Arc::default();
        let failed = Arc::clone(&written);
        std::thread::spawn(move || {
            while let Ok(mut text) = texts.recv() {
                while let Ok(newer) = texts.try_recv() {
                    text = newer;
                }
                if write_atomic_if(&file, text.as_bytes(), Some(0o600), 0o777, &|| true).is_err() {
                    // The next state writes it again.
                    locked(&failed).take();
                }
            }
        });
        RecallFile { written, queue }
    }

    fn update(&self, env: &Value) {
        if env.is_null() {
            return;
        }
        let text = env.to_string();
        let mut written = locked(&self.written);
        if written.as_deref() == Some(text.as_str()) {
            return;
        }
        *written = Some(text.clone());
        let _ = self.queue.send(text);
    }
}

#[derive(Serialize)]
struct Named<'a, T: Serialize> {
    service: &'a str,
    #[serde(flatten)]
    told: T,
}

/// An ask main has not answered yet; dropping it (the step stopped) forgets it, and a dropped `run` is cancelled.
struct Pending<'a> {
    service: &'a Service,
    ask: u64,
    cancels: bool,
    answered: bool,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        locked(&self.service.asks).remove(&self.ask);
        if self.cancels {
            self.service
                .tell("aimemory.service.cancel", json!({ "ask": self.ask }));
        }
    }
}

/// A timer main runs for a `manual` service; dropping it clears main's.
struct Timer<'a> {
    service: &'a Service,
    id: u64,
    fired: mpsc::UnboundedReceiver<()>,
}

impl Drop for Timer<'_> {
    fn drop(&mut self) {
        locked(&self.service.timers).remove(&self.id);
        self.service
            .tell("aimemory.service.clearTimer", json!({ "timer": self.id }));
    }
}

impl Service {
    fn tell<T: Serialize>(&self, event: &str, told: T) {
        self.events.send(
            event,
            &Named {
                service: &self.name,
                told,
            },
        );
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        locked(&self.inner)
    }

    fn now(&self) -> i64 {
        if self.deps.manual {
            *locked(&self.now)
        } else {
            system_now()
        }
    }

    fn manual_timer(&self, ms: u64, repeat: bool) -> Timer<'_> {
        let id = self.next_timer.fetch_add(1, Ordering::Relaxed);
        let (fire, fired) = mpsc::unbounded_channel();
        locked(&self.timers).insert(id, fire);
        self.tell(
            "aimemory.service.timer",
            json!({ "timer": id, "ms": ms, "repeat": repeat }),
        );
        Timer {
            service: self,
            id,
            fired,
        }
    }

    /// Waits `ms` on the service's clock.
    async fn sleep(&self, ms: u64) {
        if self.deps.manual {
            let mut timer = self.manual_timer(ms, false);
            // A timer main forgot (the service closed) never fires: the step ends with the service.
            if timer.fired.recv().await.is_none() {
                std::future::pending::<()>().await;
            }
        } else {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }

    /// Calls `tick` every `ms` until the task holding this is aborted.
    async fn every(self: &Arc<Self>, ms: u64, tick: impl Fn(&Arc<Service>)) {
        if self.deps.manual {
            let mut timer = self.manual_timer(ms, true);
            while timer.fired.recv().await.is_some() {
                tick(self);
            }
        } else {
            let period = Duration::from_millis(ms.max(1));
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                tick(self);
            }
        }
    }

    /// Asks main for what only it has; `cancels`: dropping the wait cancels it (a command).
    async fn ask(&self, what: &str, cancels: bool, params: Value) -> Result<Value, Failure> {
        if self.native.is_some() {
            return Err(Failure::step(format!(
                "Unported native memory effect: {what}"
            )));
        }
        let ask = self.next_ask.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        locked(&self.asks).insert(ask, answer);
        let mut pending = Pending {
            service: self,
            ask,
            cancels,
            answered: false,
        };
        let mut told = match params {
            Value::Object(params) => params,
            _ => Map::new(),
        };
        told.insert("ask".into(), ask.into());
        told.insert("what".into(), what.into());
        self.tell("aimemory.service.ask", Value::Object(told));
        let answer = answered.await;
        pending.answered = true;
        answer.unwrap_or_else(|_| {
            Err(Failure::Error {
                message: "Memory's service closed".to_owned(),
                stack: None,
            })
        })
    }

    fn log(&self, message: &str, details: Value) {
        if self.native.is_some() && self.inner().disposed {
            return;
        }
        self.tell(
            "aimemory.service.log",
            json!({ "message": message, "details": details }),
        );
    }

    fn platform_ok(&self) -> bool {
        let deps = &self.deps;
        deps.platform != "other"
            && (deps.binary_override.is_some()
                || deps
                    .builds
                    .binaries
                    .contains_key(&format!("{}-{}", deps.platform, deps.arch)))
    }

    fn managed(&self) -> bool {
        self.deps.automatic && self.platform_ok()
    }

    /// Where a spawned omp reads memory itself: the server's URL and the data folder its token is in, while memory is
    /// on and its setup pass has found the data folder.
    fn recall_env(&self, state: &State) -> Value {
        match &state.data_dir {
            Some(data_dir) if self.managed() => json!({
                "url": state.server_url.as_deref().unwrap_or(crate::aimemory::DEFAULT_SERVER_URL),
                "dataDir": data_dir,
            }),
            _ => Value::Null,
        }
    }

    /// Changes the state, logs a change of phase, step or detail, and tells main the whole state.
    fn patch(&self, change: impl FnOnce(&mut State)) {
        let _publishing = self
            .native
            .as_ref()
            .map(|native| locked(&native.publishing));
        let (state, before) = {
            let mut inner = self.inner();
            if self.native.is_some() && inner.disposed {
                return;
            }
            let before = (
                inner.state.phase,
                inner.state.step,
                inner.state.detail.clone(),
            );
            change(&mut inner.state);
            if let Some(url) = inner.state.server_url.clone().filter(|url| !url.is_empty()) {
                inner.state.web_url = Some(format!("{url}/web"));
            }
            (inner.state.clone(), before)
        };
        if (state.phase, state.step, &state.detail) != (before.0, before.1, &before.2) {
            self.log(
                "phase",
                json!({ "phase": state.phase, "step": state.step, "detail": state.detail, "from": before.0, "fromStep": before.1 }),
            );
        }
        if let Some(recall) = &self.recall {
            recall.update(&self.recall_env(&state));
        }
        self.tell("aimemory.service.state", json!({ "state": state }));
    }

    fn state(&self) -> State {
        self.inner().state.clone()
    }

    /// Queues a step; `done` hears its end.
    fn enqueue(&self, op: Op, done: Option<oneshot::Sender<Result<(), Fault>>>) {
        // A closed service's worker is gone: nobody runs it, and whoever waits hears it.
        let _ = self.jobs.send(Job { op, done });
    }

    /// Queues a step and waits for its end.
    async fn run_step(&self, op: Op) -> Result<(), Fault> {
        let (done, ended) = oneshot::channel();
        self.enqueue(op, Some(done));
        ended.await.unwrap_or_else(|_| {
            Err(Fault::new(
                "memory_service_closed",
                "Memory's service closed",
            ))
        })
    }

    fn close(&self) {
        let native = self.native.as_ref();
        let _publishing = native.map(|native| locked(&native.publishing));
        let (retry, poll) = {
            let mut inner = self.inner();
            inner.disposed = true;
            (inner.retry.take(), inner.poll.take())
        };
        if let Some(native) = native {
            native.cancel();
        }
        for task in [retry, poll].into_iter().flatten() {
            task.abort();
        }
        if self.native.is_some() {
            self.enqueue(Op::Enable, None);
        } else if let Some(worker) = locked(&self.worker).take() {
            worker.abort();
        }
        // Whatever a check still waits for will not come.
        locked(&self.asks).clear();
        locked(&self.timers).clear();
        self.closed.send_replace(true);
    }
}

/// Runs the queue: one step at a time, each stopped past `step_max_ms`.
async fn work(service: Arc<Service>, mut jobs: mpsc::UnboundedReceiver<Job>) {
    while let Some(Job { op, done }) = jobs.recv().await {
        if service.inner().disposed {
            if let Some(done) = done {
                let _ = done.send(Ok(()));
            }
            break;
        }
        let bound = service.deps.step_max_ms;
        let ran = if let Some(native) = &service.native {
            native.begin_step();
            let mut step = Box::pin(service.step(op));
            let ran = tokio::select! {
                ran = &mut step => ran,
                () = service.sleep(bound) => {
                    native.cancel();
                    // A command still owns its scratch files. Join the cancelled step before the next begins.
                    let _ = step.await;
                    service.tell("aimemory.service.stalled", json!({ "ms": bound }));
                    Err(Fault::new("step_stalled", format!(
                        "step did not finish in {} and was stopped so the next one can run (ai-memory).", span(bound)
                    )))
                }
            };
            native.end_step();
            ran
        } else {
            tokio::select! {
                ran = service.step(op) => ran,
                () = service.sleep(bound) => {
                    service.tell("aimemory.service.stalled", json!({ "ms": bound }));
                    Err(Fault::new("step_stalled", format!(
                        "step did not finish in {} and was stopped so the next one can run (ai-memory).", span(bound)
                    )))
                }
            }
        };
        if let Some(done) = done {
            let _ = done.send(ran);
        }
    }
}

/// `formatSpan` of `serial-chain.ts`.
fn span(ms: u64) -> String {
    if ms >= 60_000 {
        format!("{} min", (ms as f64 / 60_000.0).round())
    } else {
        format!("{} s", (ms as f64 / 1000.0).round())
    }
}

fn service(name: &str) -> Result<Arc<Service>, Fault> {
    locked(&SERVICES)
        .get(name)
        .cloned()
        .ok_or_else(|| Fault::new("memory_service_closed", "Memory's service is not open"))
}

/// Closes every service whose events go to `events`' output, or to none any more (`serve` calls it when its input
/// ended): its timers and asks go, and the request main holds open on it ends.
pub fn close_all(events: &Events) {
    let ending: Vec<Arc<Service>> = {
        let mut services = locked(&SERVICES);
        let names: Vec<String> = services
            .iter()
            .filter(|(_, service)| !service.events.reaches_another(events))
            .map(|(name, _)| name.clone())
            .collect();
        names
            .iter()
            .filter_map(|name| services.remove(name))
            .collect()
    };
    for service in ending {
        service.close();
    }
}

#[derive(Deserialize)]
struct At {
    service: String,
    now: Option<f64>,
}

/// A request's service, with the time it says for a `manual` one.
fn asked(call: &Call) -> Result<Arc<Service>, Fault> {
    let at: At = call.params()?;
    let service = service(&at.service)?;
    if let (true, Some(now)) = (service.deps.manual, at.now) {
        *locked(&service.now) = now as i64;
    }
    Ok(service)
}

#[derive(Deserialize)]
struct OpenParams {
    service: String,
    deps: Deps,
}

fn open(call: &Call) -> Result<Reply, Fault> {
    let OpenParams {
        service: name,
        deps,
    } = call.params()?;
    let service = Service::create(name.clone(), deps, call.events.clone(), None);
    {
        let mut services = locked(&SERVICES);
        if services.contains_key(&name) {
            service.close();
            return Err(Fault::new(
                "invalid_params",
                "Memory's service is open already",
            ));
        }
        services.insert(name, Arc::clone(&service));
    }
    Reply::json(&service.state())
}

impl Service {
    fn create(
        name: String,
        deps: Deps,
        events: Events,
        native: Option<application::Native>,
    ) -> Arc<Self> {
        let unit = (!deps.unit_asks).then(|| {
            if deps.platform == "win32" {
                unit::Unit::logon(unit::system())
            } else {
                unit::Unit::launchd(std::path::Path::new(&deps.home), deps.uid, unit::system())
            }
        });
        let (jobs, queued) = mpsc::unbounded_channel();
        let now = deps.now.map_or_else(system_now, |now| now as i64);
        let service = Arc::new(Service {
            name: name.clone(),
            events,
            native,
            recall: deps
                .recall_file
                .as_ref()
                .map(|file| RecallFile::open(PathBuf::from(file))),
            unit,
            inner: Mutex::new(Inner {
                state: State {
                    phase: "starting",
                    step: Some("stage"),
                    version: None,
                    binary: None,
                    data_dir: None,
                    server_url: None,
                    web_url: None,
                    wiring: Wiring::default(),
                    stats: None,
                    detail: None,
                    unsupported: None,
                },
                disposed: false,
                resolved: None,
                down_polls: 0,
                last_rewire: 0,
                stats_at: 0,
                awaiting_bun: false,
                retries: 0,
                retry: None,
                poll: None,
                checking: None,
            }),
            deps,
            jobs,
            outcomes: Mutex::default(),
            next_step: AtomicU64::new(1),
            asks: Mutex::default(),
            next_ask: AtomicU64::new(1),
            now: Mutex::new(now),
            timers: Mutex::default(),
            next_timer: AtomicU64::new(1),
            worker: Mutex::default(),
            closed: watch::channel(false).0,
        });
        *locked(&service.worker) = Some(tokio::spawn(work(Arc::clone(&service), queued)));
        service
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
enum Queued {
    Retry,
    Purge,
    Terminal { enabled: bool },
}

/// `retry`, `purge`, `setTerminal`: queued in the order main asked, answered with the step to wait for (none: nothing
/// was queued).
fn queue(call: &Call) -> Result<Reply, Fault> {
    let service = asked(call)?;
    let queued: Queued = call.params()?;
    let op = match queued {
        Queued::Retry => {
            if !service.managed() {
                return Reply::json(&Value::Null);
            }
            if let Some(retry) = service.inner().retry.take() {
                retry.abort();
            }
            service.patch(|state| {
                state.phase = "starting";
                state.step = Some("stage");
                state.detail = None;
            });
            Op::Enable
        }
        Queued::Purge | Queued::Terminal { .. } if !service.managed() => {
            return Err(Fault::new(
                "memory_not_managed",
                "ai-memory is not managed by this build.",
            ));
        }
        Queued::Purge => {
            service.patch(|state| {
                state.phase = "starting";
                state.step = Some("purge");
                state.detail = None;
            });
            Op::Purge
        }
        Queued::Terminal { enabled } => Op::Terminal(enabled),
    };
    let step = service.next_step.fetch_add(1, Ordering::Relaxed);
    let (done, ended) = oneshot::channel();
    locked(&service.outcomes).insert(step, ended);
    service.enqueue(op, Some(done));
    Reply::json(&step)
}

#[derive(Deserialize)]
struct StepParams {
    step: u64,
}

async fn outcome(call: Call) -> Result<Reply, Fault> {
    let service = asked(&call)?;
    let StepParams { step } = call.params()?;
    let ended = locked(&service.outcomes)
        .remove(&step)
        .ok_or_else(|| Fault::new("invalid_params", "No such step"))?;
    drop(service);
    ended.await.unwrap_or_else(|_| {
        Err(Fault::new(
            "memory_service_closed",
            "Memory's service closed",
        ))
    })?;
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct AnswerParams {
    ask: u64,
    #[serde(default)]
    value: Value,
    error: Option<AnswerError>,
}

#[derive(Deserialize)]
struct AnswerError {
    message: String,
    stack: Option<String>,
}

fn answer(call: &Call) -> Result<Reply, Fault> {
    let service = asked(call)?;
    let AnswerParams { ask, value, error } = call.params()?;
    // An ask nobody waits for any more (its step was stopped) is dropped.
    if let Some(waiting) = locked(&service.asks).remove(&ask) {
        let _ = waiting.send(match error {
            Some(AnswerError { message, stack }) => Err(Failure::Error { message, stack }),
            None => Ok(value),
        });
    }
    Reply::json(&())
}

#[derive(Deserialize)]
struct FireParams {
    timer: u64,
}

fn fire(call: &Call) -> Result<Reply, Fault> {
    let service = asked(call)?;
    let FireParams { timer } = call.params()?;
    if let Some(fire) = locked(&service.timers).get(&timer) {
        let _ = fire.send(());
    }
    Reply::json(&())
}

#[derive(Deserialize)]
struct CwdParams {
    cwd: Option<String>,
}

async fn closed(call: Call) -> Result<Reply, Fault> {
    let at: At = call.params()?;
    if let Ok(service) = service(&at.service) {
        let mut closed = service.closed.subscribe();
        drop(service);
        let _ = closed.wait_for(|closed| *closed).await;
    }
    Reply::json(&())
}

pub fn register(registry: &mut Registry) {
    registry.add("aimemory.service.open", |call| {
        Box::pin(async move { open(&call) })
    });
    registry.add("aimemory.service.start", |call| {
        Box::pin(async move {
            let service = asked(&call)?;
            service.start().await;
            Reply::json(&Value::Null)
        })
    });
    registry.add("aimemory.service.queue", |call| {
        Box::pin(async move { queue(&call) })
    });
    registry.add("aimemory.service.outcome", |call| Box::pin(outcome(call)));
    registry.add("aimemory.service.bunInstalled", |call| {
        Box::pin(async move {
            let service = asked(&call)?;
            service.bun_installed();
            Reply::json(&Value::Null)
        })
    });
    registry.add("aimemory.service.refresh", |call| {
        Box::pin(async move {
            let service = asked(&call)?;
            service.refresh().await.map_err(|failure| failure.fault())?;
            Reply::json(&Value::Null)
        })
    });
    registry.add("aimemory.service.extensionArgs", |call| {
        Box::pin(async move {
            let service = asked(&call)?;
            let CwdParams { cwd } = call.params()?;
            let args = service.extension_args(cwd.as_deref()).await;
            Reply::json(&args.map_err(|failure| failure.fault())?)
        })
    });
    registry.add("aimemory.service.answer", |call| {
        Box::pin(async move { answer(&call) })
    });
    registry.add("aimemory.service.fire", |call| {
        Box::pin(async move { fire(&call) })
    });
    registry.add("aimemory.service.close", |call| {
        Box::pin(async move {
            let at: At = call.params()?;
            if let Some(service) = locked(&SERVICES).remove(&at.service) {
                service.close();
            }
            Reply::json(&())
        })
    });
    registry.add("aimemory.service.closed", |call| Box::pin(closed(call)));
}

/// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted.
#[cfg(test)]
fn captured(table: &str) -> Vec<Value> {
    let rows: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    rows[table].as_array().unwrap().clone()
}
