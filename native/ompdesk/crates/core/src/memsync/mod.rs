//! Memory shared between a person's paired computers (native-rust ledger 7e; was `src/main/ai-memory/sync.ts`): a
//! decision, rule, gotcha, procedure, preference or profile entry made on one computer is in the other's memory
//! server too, so a session the Mac opens on the Windows host recalls the Mac's decisions there. Only durable pages
//! cross; session pages and raw observations stay where they were captured. Deletes do not cross.
//!
//! Session conclusions cross too (each turn's final-answer excerpt, ≤ 2000 bytes, the server's `Stop` observations
//! with a body). They are immutable and written insert-if-absent under the computer that captured them (`origin`); a
//! conclusion is redacted again before it leaves and again when it arrives, never goes back to its origin, and is
//! forwarded to the other computers once.
//!
//! The device that connected to a host drives both directions over its link (`device`): `host.memory.pull`/`push`
//! for pages, `host.memory.conclusions.pull`/`push` for conclusions, every five minutes while a host is connected
//! and whenever its link comes up. The host answers them from its own server (`host`). Both read and write this
//! computer's server through the core's own client (`aimemory`), in process.
//!
//! What stays main's, asked for with a `memsync.ask` event and answered with `memsync.answer`:
//! - `request`: one request over the link to a host. This is the link seam: main's `RemoteDevices` holds the links
//!   and their requests until the remote program (R5-R7) moves them here, when `Link::request` calls the core's
//!   own link instead.
//! - `state`: this computer's memory server (none while memory is off), its device id, the hosts connected now and
//!   main's clock.
//! - `redact`: texts through `resources/gui-bridge/redactor.ts` `redactDiagnosticsText`, the one redactor (memory
//!   capture and diagnostics read it too, and the ai-memory build embeds it).
//!
//! Methods: `memsync.servePull`, `memsync.servePush`, `memsync.serveConclusionPull`, `memsync.serveConclusionPush`
//! (the host's side, one each), `memsync.readConclusions` (recall-terms' read of a stream), `memsync.start`, `memsync.sync`,
//! `memsync.hostOnline`, `memsync.syncAll`, `memsync.dispose` (a device's sync, named by main's `sync` number; each
//! carries its state file, interval and whether it was started, so a core that started again picks it up),
//! `memsync.answer`. Events: `memsync.ask`, `memsync.log` (a line main writes to its runtime log, source
//! `memory-sync`).

mod device;
mod host;
mod state;
mod store;
mod wire;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value, json};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use self::device::{Here, Report};
use self::host::Offer;
use self::state::{HostState, SyncFile};
use self::store::Store;
use self::wire::{ConclusionCursor, ConclusionWire, Cursor, PageWire, Source};
use crate::aimemory::client::Server;
use crate::server::{Call, Events, Fault, Registry, Reply};

/// While a host is connected and memory is on, they sync this often (and whenever the link comes up).
const INTERVAL_MS: u64 = 5 * 60_000;
/// A pull or push batch reads and writes pages on both servers: more than the link's default 30 s
/// (`MEMORY_REQUEST_TIMEOUT_MS`).
const REQUEST_TIMEOUT_MS: u64 = 120_000;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
struct Asks {
    next: u64,
    waiting: HashMap<u64, oneshot::Sender<Value>>,
}

static ASKS: LazyLock<Mutex<Asks>> = LazyLock::new(Mutex::default);

/// Forgets an ask whose wait was dropped (its request was cancelled), so a late answer finds nothing.
struct Asked(u64);

impl Drop for Asked {
    fn drop(&mut self) {
        lock(&ASKS).waiting.remove(&self.0);
    }
}

/// Asks main (`memsync.ask`) and waits for its `memsync.answer`; none when main never answers (its core went).
async fn ask(events: &Events, kind: &str, fields: Map<String, Value>) -> Option<Value> {
    let (answer, answered) = oneshot::channel();
    let call = {
        let mut asks = lock(&ASKS);
        asks.next += 1;
        let call = asks.next;
        asks.waiting.insert(call, answer);
        call
    };
    let _asked = Asked(call);
    let mut message = Map::new();
    message.insert("call".into(), call.into());
    message.insert("kind".into(), kind.into());
    message.extend(fields);
    events.send("memsync.ask", &message);
    answered.await.ok()
}

/// `texts` as main's redactor leaves them, in order.
async fn redact(events: &Events, texts: &[&str]) -> Result<Vec<String>, Fault> {
    let mut fields = Map::new();
    fields.insert("texts".into(), json!(texts));
    let answer = ask(events, "redact", fields).await;
    let redacted: Option<Vec<String>> =
        answer.and_then(|answer| serde_json::from_value(answer).ok());
    match redacted {
        Some(redacted) if redacted.len() == texts.len() => Ok(redacted),
        _ => Err(Fault::new(
            "internal",
            "Main did not redact the conclusions",
        )),
    }
}

/// One device's link to one host, as a round uses it.
pub struct Link<'a> {
    events: Events,
    sync: u64,
    host: &'a str,
}

impl Link<'_> {
    /// One request to the host over its link (main's `RemoteDevices.request`); a refusal comes back with its code.
    async fn request(&self, method: &str, params: Value) -> Result<Value, Fault> {
        let mut fields = Map::new();
        fields.insert("sync".into(), self.sync.into());
        fields.insert("host".into(), self.host.into());
        fields.insert("method".into(), method.into());
        fields.insert("params".into(), params);
        fields.insert("timeoutMs".into(), REQUEST_TIMEOUT_MS.into());
        let answer = ask(&self.events, "request", fields)
            .await
            .ok_or_else(|| Fault::new("internal", "Main did not answer the request"))?;
        if let Some(error) = answer.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("internal");
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(Fault::new(code.to_owned(), message));
        }
        Ok(answer.get("result").cloned().unwrap_or(Value::Null))
    }

    /// A line in main's runtime log (source `memory-sync`).
    fn log(&self, message: &str, details: Value) {
        self.events.send(
            "memsync.log",
            &json!({ "sync": self.sync, "message": message, "details": details }),
        );
    }
}

/// A device's sync with every host it is connected to.
pub struct Instance {
    id: u64,
    state_file: PathBuf,
    interval: Duration,
    events: Mutex<Events>,
    inner: Mutex<Inner>,
    saving: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Inner {
    file: Option<SyncFile>,
    /// Hosts a round runs with, and who waits for its report.
    running: HashMap<String, Vec<oneshot::Sender<Option<Report>>>>,
    /// Hosts whose OMPdesk has no memory sync (older): left alone until their link comes up again.
    unsupported: HashSet<String>,
    /// Hosts that sync pages but have no conclusion methods (older): asked again when their link comes up.
    conclusions_unsupported: HashSet<String>,
    disposed: bool,
    timer: Option<JoinHandle<()>>,
}

impl Instance {
    /// The link to `host`, on the events of the last call: they reach the main that runs now.
    fn link<'a>(&self, host: &'a str) -> Link<'a> {
        Link {
            events: self.events(),
            sync: self.id,
            host,
        }
    }

    fn events(&self) -> Events {
        lock(&self.events).clone()
    }

    fn unsupported(&self, host: &str) {
        lock(&self.inner).unsupported.insert(host.to_owned());
    }

    fn conclusions_unsupported(&self, host: &str) {
        lock(&self.inner)
            .conclusions_unsupported
            .insert(host.to_owned());
    }

    fn conclusions_unsupported_for(&self, host: &str) -> bool {
        lock(&self.inner).conclusions_unsupported.contains(host)
    }

    /// The host's state, from `sync.json` the first time (a file that does not read starts over).
    async fn host_state(&self, host: &str) -> HostState {
        if lock(&self.inner).file.is_none() {
            let file = self.state_file.clone();
            let text = tokio::task::spawn_blocking(move || std::fs::read_to_string(file).ok())
                .await
                .ok()
                .flatten();
            let parsed = text.as_deref().and_then(SyncFile::parse);
            let mut inner = lock(&self.inner);
            if inner.file.is_none() {
                inner.file = Some(parsed.unwrap_or_default());
            }
        }
        let mut inner = lock(&self.inner);
        inner.file.get_or_insert_default().host(host).clone()
    }

    fn put_host_state(&self, host: &str, state: HostState) {
        let mut inner = lock(&self.inner);
        *inner.file.get_or_insert_default().host(host) = state;
    }

    /// Writes `sync.json` as it is now (0600); saves run one after another, and a failed one is dropped.
    async fn save(&self) {
        let _turn = self.saving.lock().await;
        let Some(bytes) = lock(&self.inner)
            .file
            .as_ref()
            .and_then(|file| serde_json::to_vec(file).ok())
        else {
            return;
        };
        let file = self.state_file.clone();
        let _ = tokio::task::spawn_blocking(move || {
            crate::disk::tree::write_atomic_if(&file, &bytes, Some(0o600), 0o777, &|| true)
        })
        .await;
    }
}

static SYNCS: LazyLock<Mutex<HashMap<u64, Arc<Instance>>>> = LazyLock::new(Mutex::default);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncParams {
    sync: u64,
    state_file: PathBuf,
    #[serde(default)]
    interval_ms: Option<u64>,
    #[serde(default)]
    started: bool,
    #[serde(default)]
    host: Option<String>,
}

/// The instance main names, made on its first call (or the first after this core started).
fn instance(params: &SyncParams, events: &Events) -> Arc<Instance> {
    let instance = Arc::clone(lock(&SYNCS).entry(params.sync).or_insert_with(|| {
        Arc::new(Instance {
            id: params.sync,
            state_file: params.state_file.clone(),
            interval: Duration::from_millis(params.interval_ms.unwrap_or(INTERVAL_MS).max(1)),
            events: Mutex::new(events.clone()),
            inner: Mutex::default(),
            saving: tokio::sync::Mutex::new(()),
        })
    }));
    *lock(&instance.events) = events.clone();
    if params.started {
        let mut inner = lock(&instance.inner);
        if inner.timer.is_none() && !inner.disposed {
            let ticking = Arc::clone(&instance);
            inner.timer = Some(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(ticking.interval).await;
                    sync_all(&ticking).await;
                }
            }));
        }
    }
    instance
}

/// What main says now: none while memory is off here (or main is gone).
async fn here(instance: &Instance) -> Option<(Here, Vec<String>)> {
    let mut fields = Map::new();
    fields.insert("sync".into(), instance.id.into());
    let answer = ask(&instance.events(), "state", fields).await?;
    let hosts: Vec<String> = answer
        .get("hosts")
        .and_then(|hosts| serde_json::from_value(hosts.clone()).ok())
        .unwrap_or_default();
    let server: Option<Server> = answer
        .get("server")
        .and_then(|server| serde_json::from_value(server.clone()).ok());
    let here = server.map(|server| Here {
        store: Store::new(server),
        self_id: answer
            .get("self")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        now: answer
            .get("now")
            .and_then(Value::as_number)
            .cloned()
            .unwrap_or_else(|| Number::from(0)),
    });
    Some((here?, hosts))
}

/// One round with `host`, or the one running: its report, none when nothing ran.
fn sync(instance: &Arc<Instance>, host: String) -> oneshot::Receiver<Option<Report>> {
    let (report, reported) = oneshot::channel();
    {
        let mut inner = lock(&instance.inner);
        if let Some(waiting) = inner.running.get_mut(&host) {
            waiting.push(report);
            return reported;
        }
        if inner.disposed || inner.unsupported.contains(&host) {
            let _ = report.send(None);
            return reported;
        }
        inner.running.insert(host.clone(), vec![report]);
    }
    let instance = Arc::clone(instance);
    tokio::spawn(async move {
        let ran = match here(&instance).await {
            Some((here, _)) => device::round(&instance, &host, here).await,
            None => None,
        };
        let waiting = lock(&instance.inner)
            .running
            .remove(&host)
            .unwrap_or_default();
        for report in waiting {
            let _ = report.send(ran.clone());
        }
    });
    reported
}

async fn sync_all(instance: &Arc<Instance>) {
    if let Some((_, hosts)) = here(instance).await {
        for host in hosts {
            drop(sync(instance, host));
        }
    }
}

fn params<T: serde::de::DeserializeOwned>(raw: &RawValue) -> Result<T, Fault> {
    serde_json::from_str(raw.get()).map_err(|error| Fault::new("invalid_params", error.to_string()))
}

/// What every host-side request carries: this computer's server (null while memory is off), its device id, the
/// asking device and the request's own params.
#[derive(Deserialize)]
struct HostParams {
    server: Option<Server>,
    #[serde(rename = "self")]
    self_id: String,
    #[serde(default)]
    peer: String,
    params: Value,
}

fn invalid(error: impl std::fmt::Display) -> Fault {
    Fault::new("invalid_params", error.to_string())
}

fn field<'v>(value: &'v Value, name: &str) -> Result<&'v Value, Fault> {
    value
        .get(name)
        .ok_or_else(|| invalid(format!("{name} is missing")))
}

async fn serve_pull(call: Call) -> Result<Reply, Fault> {
    let p: HostParams = params(&call.params)?;
    let since = Cursor::parse(field(&p.params, "since")?).map_err(invalid)?;
    let reply = host::serve_pull(p.server.map(Store::new), &p.self_id, &p.peer, since).await?;
    Reply::json(&reply)
}

async fn serve_push(call: Call) -> Result<Reply, Fault> {
    let p: HostParams = params(&call.params)?;
    let offers = field(&p.params, "pages")?
        .as_array()
        .ok_or_else(|| invalid("pages"))?
        .iter()
        .map(|offer| {
            Ok(Offer {
                page: PageWire::parse(field(offer, "page")?).map_err(invalid)?,
                expect: field(offer, "expect")?.as_str().map(str::to_owned),
            })
        })
        .collect::<Result<Vec<_>, Fault>>()?;
    let reply = host::serve_push(p.server.map(Store::new), &p.self_id, offers).await?;
    Reply::json(&reply)
}

async fn serve_conclusion_pull(call: Call) -> Result<Reply, Fault> {
    let p: HostParams = params(&call.params)?;
    let since = ConclusionCursor::parse(field(&p.params, "since")?).map_err(invalid)?;
    let store = p.server.map(Store::new);
    let reply =
        host::serve_conclusion_pull(&call.events, store, &p.self_id, &p.peer, since).await?;
    Reply::json(&reply)
}

async fn serve_conclusion_push(call: Call) -> Result<Reply, Fault> {
    let p: HostParams = params(&call.params)?;
    let rows = field(&p.params, "conclusions")?
        .as_array()
        .ok_or_else(|| invalid("conclusions"))?
        .iter()
        .map(|row| ConclusionWire::parse(row).map_err(invalid))
        .collect::<Result<Vec<_>, Fault>>()?;
    let store = p.server.map(Store::new);
    let reply = host::serve_conclusion_push(&call.events, store, &p.self_id, rows).await?;
    Reply::json(&reply)
}

#[derive(Deserialize)]
struct ReadParams {
    server: Server,
    source: String,
    after: u64,
    #[serde(default)]
    known: Option<String>,
    limit: u64,
}

async fn read_conclusions(call: Call) -> Result<Reply, Fault> {
    let p: ReadParams = params(&call.params)?;
    let source = match p.source.as_str() {
        "native" => Source::Native,
        "synced" => Source::Synced,
        _ => return Err(invalid("source")),
    };
    let store = Store::new(p.server);
    Reply::json(
        &store::read_conclusions(&store, source, p.after, p.known.as_deref(), p.limit).await?,
    )
}

async fn sync_call(call: Call) -> Result<Reply, Fault> {
    let p: SyncParams = params(&call.params)?;
    let host = p.host.clone().ok_or_else(|| invalid("host"))?;
    let instance = instance(&p, &call.events);
    let report = sync(&instance, host).await.unwrap_or_default();
    Reply::json(&report)
}

/// `start()`: the timer of the five-minute rounds, nothing run yet.
async fn start(call: Call) -> Result<Reply, Fault> {
    let p: SyncParams = params(&call.params)?;
    instance(&p, &call.events);
    Reply::json(&Value::Null)
}

async fn host_online(call: Call) -> Result<Reply, Fault> {
    let p: SyncParams = params(&call.params)?;
    let host = p.host.clone().ok_or_else(|| invalid("host"))?;
    let instance = instance(&p, &call.events);
    // Its link came up: it may run a newer OMPdesk now, and its pages and conclusions may have changed meanwhile.
    {
        let mut inner = lock(&instance.inner);
        inner.unsupported.remove(&host);
        inner.conclusions_unsupported.remove(&host);
    }
    drop(sync(&instance, host));
    Reply::json(&Value::Null)
}

async fn sync_all_call(call: Call) -> Result<Reply, Fault> {
    let p: SyncParams = params(&call.params)?;
    let instance = instance(&p, &call.events);
    tokio::spawn(async move { sync_all(&instance).await });
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct DisposeParams {
    sync: u64,
}

async fn dispose(call: Call) -> Result<Reply, Fault> {
    let p: DisposeParams = params(&call.params)?;
    if let Some(instance) = lock(&SYNCS).remove(&p.sync) {
        let mut inner = lock(&instance.inner);
        inner.disposed = true;
        if let Some(timer) = inner.timer.take() {
            timer.abort();
        }
    }
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct AnswerParams {
    call: u64,
    result: Box<RawValue>,
}

async fn answer(call: Call) -> Result<Reply, Fault> {
    let p: AnswerParams = params(&call.params)?;
    if let Some(waiting) = lock(&ASKS).waiting.remove(&p.call) {
        let _ = waiting.send(serde_json::from_str(p.result.get()).unwrap_or(Value::Null));
    }
    Reply::json(&Value::Null)
}

pub fn register(registry: &mut Registry) {
    registry.add("memsync.servePull", |call| Box::pin(serve_pull(call)));
    registry.add("memsync.servePush", |call| Box::pin(serve_push(call)));
    registry.add("memsync.serveConclusionPull", |call| {
        Box::pin(serve_conclusion_pull(call))
    });
    registry.add("memsync.serveConclusionPush", |call| {
        Box::pin(serve_conclusion_push(call))
    });
    registry.add("memsync.readConclusions", |call| {
        Box::pin(read_conclusions(call))
    });
    registry.add("memsync.start", |call| Box::pin(start(call)));
    registry.add("memsync.sync", |call| Box::pin(sync_call(call)));
    registry.add("memsync.hostOnline", |call| Box::pin(host_online(call)));
    registry.add("memsync.syncAll", |call| Box::pin(sync_all_call(call)));
    registry.add("memsync.dispose", |call| Box::pin(dispose(call)));
    registry.add("memsync.answer", |call| Box::pin(answer(call)));
}
