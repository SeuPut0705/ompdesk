//! Scheduled runs (was `ScheduleService` and `ompRunLauncher` of `src/main/schedules.ts`): the clock that starts a
//! schedule when it comes due, the journal (`schedules.json`) and the run logs, the routines' events and their loop
//! guard, the webhook key and its check, and the omp a run starts under the supervisor (`launch`). `engine` is the
//! state machine, `rules` what a schedule must keep and when it starts next; this file is their host: it reads the
//! clock, keeps the files and speaks to main.
//!
//! Main opens one service per journal (`schedules.open`, named by main) and is its typed client
//! (`src/main/schedules.ts`). It sends what the page, an agent or a trigger asks (`schedules.command`, `create`,
//! `fire`, `webhook`, `triggerFailed`, `prune`, `log`), one request after the other, so they are taken in the order
//! they were made. What only main has, the core asks for by an event and main answers by a request:
//!
//! - `schedules.reserve` `{service, ask, device}` → `schedules.reserved`: whether a paired device has a model request
//!   left today (main's `PeerQuota`); `schedules.refund` `{service, charge}` gives one back that was not spent.
//! - `schedules.start` `{service, run, schedule, files, wake, charge?}` → `schedules.started`, then
//!   `schedules.ended`: main starts the run, because the omp, its environment and its extensions are main's to
//!   resolve (it hands them to `schedules.launch`) and a session's own wake-up is delivered by the control tools.
//!   `schedules.stop` `{service, run}` asks main to stop the run it started.
//! - `schedules.state` `{service, state}`: every change, which main keeps as the copy its synchronous readers read.
//!
//! A service that is still open when the core's input ends is closed then (`close_all`): its running runs read
//! stopped in the journal, as a quit recorded them. `schedules.closed` is the request main keeps open on a service;
//! its failure is how main learns the core died.
//!
//! The clock is the system's, read at every check. A test's service is opened `manual`: then the core keeps no timer,
//! every request says what time it is and `schedules.tick` is the check.

mod engine;
mod launch;
pub(crate) mod rules;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use crate::disk::saves::write_kept;
use crate::disk::tree::fault as node_fault;
use crate::server::{Call, Events, Fault, Registry, Reply};
use engine::{Commanded, Engine, Limits, Out};

/// A run's log is read back at most this much from its end.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

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

/// `randomUUID()`.
fn uuid() -> String {
    let mut bytes = [0; 16];
    if crate::sys::random(&mut bytes).is_err() {
        // An id is no secret: the clock tells runs apart where the system has no random bytes.
        bytes = (SystemTime::now().duration_since(UNIX_EPOCH))
            .map_or(0, |since| since.as_nanos())
            .to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `bytes.toString("base64url")`.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk
            .iter()
            .fold(0_u32, |group, byte| (group << 8) | u32::from(*byte))
            << (8 * (3 - chunk.len()));
        for place in 0..=chunk.len() {
            text.push(ALPHABET[(group >> (18 - 6 * place)) as usize & 63] as char);
        }
    }
    text
}

/// A new webhook key (`randomBytes(24).toString("base64url")`); empty where the system has no random bytes, which no
/// schedule can be saved with.
fn webhook_key() -> String {
    let mut bytes = [0; 24];
    match crate::sys::random(&mut bytes) {
        Ok(()) => base64url(&bytes),
        Err(_) => String::new(),
    }
}

/// The journal's writer: the newest state is written in one step by a thread of its own, so a rename Windows holds
/// back never holds a request.
struct Journal {
    file: PathBuf,
    queue: Mutex<Option<mpsc::Sender<String>>>,
    /// The writer thread, joined by `close`: nothing of it lands after the last write, not even a temp file.
    writer: Mutex<Option<std::thread::JoinHandle<()>>>,
    closed: Arc<AtomicBool>,
}

impl Journal {
    fn open(file: PathBuf) -> Journal {
        let (queue, texts) = mpsc::channel::<String>();
        let closed = Arc::new(AtomicBool::new(false));
        let writer = std::thread::spawn({
            let (file, closed) = (file.clone(), Arc::clone(&closed));
            move || {
                while let Ok(mut text) = texts.recv() {
                    // Only the newest state is worth writing.
                    while let Ok(newer) = texts.try_recv() {
                        text = newer;
                    }
                    if closed.load(Ordering::SeqCst) {
                        continue;
                    }
                    if let Err(fault) = write_kept(&file, text.as_bytes(), None, 0o777) {
                        eprintln!(
                            "ompdesk-core: couldn't save the schedules: {}",
                            fault.message
                        );
                    }
                }
            }
        });
        Journal {
            file,
            queue: Mutex::new(Some(queue)),
            writer: Mutex::new(Some(writer)),
            closed,
        }
    }

    fn keep(&self, text: String) {
        if let Some(queue) = &*locked(&self.queue) {
            let _ = queue.send(text);
        }
    }

    /// The last content, written before this returns, once the writer thread ended: nothing older lands after it.
    fn close(&self, text: &str) {
        self.closed.store(true, Ordering::SeqCst);
        locked(&self.queue).take();
        if let Some(writer) = locked(&self.writer).take() {
            let _ = writer.join();
        }
        if let Err(fault) = write_kept(&self.file, text.as_bytes(), None, 0o777) {
            eprintln!(
                "ompdesk-core: couldn't save the schedules on quit: {}",
                fault.message
            );
        }
    }
}

struct Service {
    name: String,
    events: Events,
    engine: Mutex<Engine>,
    log_dir: PathBuf,
    /// The clock is main's: every request says the time, and there is no timer here.
    manual: bool,
    journal: Journal,
    /// Run-now commands waiting for main's word on their charge, by ask.
    waits: Mutex<HashMap<u64, oneshot::Sender<Result<(), Fault>>>>,
    clock: Mutex<Option<JoinHandle<()>>>,
    closed: watch::Sender<bool>,
}

static SERVICES: LazyLock<Mutex<HashMap<String, Arc<Service>>>> = LazyLock::new(Default::default);

#[derive(Serialize)]
struct Named<'a, T: Serialize> {
    service: &'a str,
    #[serde(flatten)]
    told: T,
}

#[derive(Serialize)]
struct Files {
    log: String,
    prompt: String,
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

    fn log_file(&self, run: &str) -> PathBuf {
        self.log_dir.join(format!("{run}.log"))
    }

    fn prompt_file(&self, run: &str) -> PathBuf {
        self.log_dir.join(format!("{run}.prompt"))
    }

    /// The moment a request happens at.
    fn at(&self, given: Option<f64>) -> i64 {
        match given {
            Some(now) if self.manual => now as i64,
            _ if self.manual => locked(&self.engine).now(),
            _ => system_now(),
        }
    }

    /// One entry into the engine, and everything it left to do.
    fn with<T>(&self, entry: impl FnOnce(&mut Engine) -> T) -> T {
        let mut engine = locked(&self.engine);
        let answer = entry(&mut engine);
        self.settle(&mut engine);
        answer
    }

    fn settle(&self, engine: &mut Engine) {
        loop {
            let outs = std::mem::take(&mut engine.outs);
            if outs.is_empty() {
                break;
            }
            for out in outs {
                self.carry_out(engine, out);
            }
        }
    }

    fn carry_out(&self, engine: &mut Engine, out: Out) {
        let now = engine.now();
        match out {
            Out::Changed { state, journal } => {
                self.journal.keep(journal);
                self.tell("schedules.state", serde_json::json!({ "state": state }));
            }
            Out::Closed { journal } => self.journal.close(&journal),
            Out::Reserve { ask, device } => self.tell(
                "schedules.reserve",
                serde_json::json!({ "ask": ask, "device": device }),
            ),
            Out::Refund { charge } => {
                self.tell("schedules.refund", serde_json::json!({ "charge": charge }))
            }
            Out::Prepare { run, prompt, cwd } => {
                let failed = self.prepare(&run, &prompt, cwd.as_deref());
                engine.prepared(&run, failed, now);
            }
            Out::Start {
                run,
                schedule,
                wake,
                charge,
            } => {
                let files = Files {
                    log: self.log_file(&run).to_string_lossy().into_owned(),
                    prompt: self.prompt_file(&run).to_string_lossy().into_owned(),
                };
                self.tell(
                    "schedules.start",
                    serde_json::json!({ "run": run, "schedule": schedule, "files": files, "wake": wake, "charge": charge }),
                );
            }
            Out::WakeLog { run, text } => {
                let file = self.log_file(&run);
                if let Err(error) = fs::write(&file, text) {
                    engine.ended(
                        &run,
                        None,
                        Some(node_fault(&error, "open", &file).message),
                        now,
                    );
                }
            }
            Out::Stop { run } => self.tell("schedules.stop", serde_json::json!({ "run": run })),
            Out::RemovePrompt { run } => {
                let _ = fs::remove_file(self.prompt_file(&run));
            }
            Out::RemoveLogs { runs } => {
                for run in runs {
                    let _ = fs::remove_file(self.log_file(&run));
                }
            }
        }
    }

    /// A run's files; why they could not be made, or that its folder is gone.
    fn prepare(&self, run: &str, prompt: &str, cwd: Option<&str>) -> Option<String> {
        if let Err(error) = fs::create_dir_all(&self.log_dir) {
            return Some(node_fault(&error, "mkdir", &self.log_dir).message);
        }
        // A wake-up's prompt goes into its session: it has no file and needs no folder.
        let cwd = cwd?;
        let file = self.prompt_file(run);
        if let Err(error) = fs::write(&file, prompt) {
            return Some(node_fault(&error, "open", &file).message);
        }
        (!Path::new(cwd).exists()).then(|| format!("Project folder not found: {cwd}"))
    }

    fn close(&self, given: Option<f64>) {
        let now = self.at(given);
        self.with(|engine| engine.close(now));
        if let Some(clock) = locked(&self.clock).take() {
            clock.abort();
        }
        locked(&self.waits).clear();
        self.closed.send_replace(true);
    }
}

fn service(name: &str) -> Result<Arc<Service>, Fault> {
    locked(&SERVICES)
        .get(name)
        .cloned()
        .ok_or_else(|| Fault::new("schedules_closed", "These schedules are not open"))
}

/// Closes every service whose events go to `events`' output, or to none any more. `serve` calls it when its input
/// ended: a main that died never asks, and the request it keeps open on each service would keep the core alive.
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
        service.close(None);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    /// Main's name for the service.
    service: String,
    /// `schedules.json`.
    file: String,
    /// The folder of the run logs (and each running prompt).
    log_dir: String,
    /// How often due schedules are checked.
    tick_ms: u64,
    /// The length of a minute for intervals; only a test launch shortens it.
    minute_ms: i64,
    manual: bool,
    /// Whether main charges paired devices (`reserve`) and delivers wake-ups (`wake`).
    charges: bool,
    wakes: bool,
    limits: Limits,
    now: Option<f64>,
}

#[derive(Deserialize)]
struct At {
    service: String,
    now: Option<f64>,
}

#[derive(Deserialize)]
struct CommandParams {
    request: Value,
    origin: Option<String>,
}

#[derive(Deserialize)]
struct CreateParams {
    draft: Value,
    origin: Option<String>,
}

#[derive(Deserialize)]
struct FireParams {
    id: String,
    detail: String,
}

#[derive(Deserialize)]
struct WebhookParams {
    id: String,
    bearer: String,
    detail: String,
}

#[derive(Deserialize)]
struct FailedParams {
    id: String,
    reason: String,
}

#[derive(Deserialize)]
struct PruneParams {
    at: f64,
}

#[derive(Deserialize)]
struct ReservedParams {
    ask: u64,
    /// Why the device has no request left; absent when one was counted.
    refused: Option<String>,
}

#[derive(Deserialize)]
struct RunParams {
    run: String,
}

#[derive(Deserialize)]
struct EndedParams {
    run: String,
    code: Option<i64>,
    error: Option<String>,
}

/// A request's service and moment, and its own params.
fn asked<T: serde::de::DeserializeOwned>(call: &Call) -> Result<(Arc<Service>, i64, T), Fault> {
    let at: At = call.params()?;
    let service = service(&at.service)?;
    let now = service.at(at.now);
    Ok((service, now, call.params()?))
}

fn open(call: &Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    let engine = Engine::new(
        params.limits,
        params.minute_ms,
        params.charges,
        params.wakes,
        Box::new(rules::Local),
        Box::new(uuid),
        Box::new(webhook_key),
    );
    let file = PathBuf::from(&params.file);
    let service = Arc::new(Service {
        name: params.service.clone(),
        events: call.events.clone(),
        engine: Mutex::new(engine),
        log_dir: PathBuf::from(&params.log_dir),
        manual: params.manual,
        journal: Journal::open(file.clone()),
        waits: Mutex::default(),
        clock: Mutex::default(),
        closed: watch::channel(false).0,
    });
    {
        let mut services = locked(&SERVICES);
        if services.contains_key(&params.service) {
            return Err(Fault::new(
                "invalid_params",
                "These schedules are open already",
            ));
        }
        services.insert(params.service, Arc::clone(&service));
    }
    // What `readFile(file, "utf8")` read; a file that is not there is an empty journal.
    let stored = fs::read(&file).ok();
    let stored = stored.as_deref().map(String::from_utf8_lossy);
    let now = match params.now {
        Some(now) if params.manual => now as i64,
        _ => system_now(),
    };
    let state = service.with(|engine| {
        engine.load(stored.as_deref(), now);
        engine.state()
    });
    if !params.manual {
        let period = Duration::from_millis(params.tick_ms.max(1));
        let ticking = Arc::downgrade(&service);
        let clock = tokio::spawn(async move {
            let mut ticks = tokio::time::interval_at(Instant::now() + period, period);
            // A wall-clock check at each tick: a computer that slept starts what came due once, not once per tick missed.
            ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let Some(service) = ticking.upgrade() else {
                    break;
                };
                service.with(|engine| engine.tick(system_now()));
            }
        });
        *locked(&service.clock) = Some(clock);
    }
    Reply::json(&state)
}

async fn command(call: Call) -> Result<Reply, Fault> {
    let (service, now, params): (_, _, CommandParams) = asked(&call)?;
    let waiting = {
        let mut engine = locked(&service.engine);
        let commanded = engine.command(&params.request, params.origin.as_deref(), now);
        service.settle(&mut engine);
        match commanded? {
            Commanded::Done => None,
            // Registered before the engine is let go, so main's answer always finds it.
            Commanded::Asked(ask) => {
                let (answer, waiting) = oneshot::channel();
                locked(&service.waits).insert(ask, answer);
                Some(waiting)
            }
        }
    };
    if let Some(waiting) = waiting {
        waiting
            .await
            .map_err(|_| Fault::new("schedules_closed", "The schedules closed"))??;
    }
    Reply::json(&locked(&service.engine).state())
}

fn create(call: &Call) -> Result<Reply, Fault> {
    let (service, now, params): (_, _, CreateParams) = asked(call)?;
    let created = service.with(|engine| {
        let id = engine.create(&params.draft, params.origin.as_deref(), now)?;
        Ok::<_, Fault>(serde_json::json!({ "id": id, "state": engine.state() }))
    })?;
    Reply::json(&created)
}

fn reserved(call: &Call) -> Result<Reply, Fault> {
    let (service, now, params): (_, _, ReservedParams) = asked(call)?;
    let outcome =
        service.with(|engine| engine.reserved(params.ask, params.refused.as_deref(), now));
    if let (Some(outcome), Some(waiting)) = (outcome, locked(&service.waits).remove(&params.ask)) {
        let _ = waiting.send(outcome);
    }
    Reply::json(&())
}

/// The run's captured output, from its end when long.
fn log(call: &Call) -> Result<Reply, Fault> {
    use std::io::{Read, Seek, SeekFrom};
    let (service, _, params): (_, _, RunParams) = asked(call)?;
    if !locked(&service.engine).has_run(&params.run) {
        return Err(Fault::new("schedule_error", "Run not found"));
    }
    let path = service.log_file(&params.run);
    let Ok(mut file) = fs::File::open(&path) else {
        return Reply::json(&"");
    };
    let read = (|| {
        let size = file.metadata()?.len();
        file.seek(SeekFrom::Start(size.saturating_sub(LOG_TAIL_BYTES)))?;
        let mut tail = Vec::new();
        file.take(LOG_TAIL_BYTES).read_to_end(&mut tail)?;
        Ok(tail)
    })();
    let tail = read.map_err(|error: std::io::Error| node_fault(&error, "read", &path))?;
    Reply::json(&String::from_utf8_lossy(&tail))
}

async fn closed(call: Call) -> Result<Reply, Fault> {
    let at: At = call.params()?;
    // A service main never opened, or closed before it asked, is closed.
    if let Ok(service) = service(&at.service) {
        let mut closed = service.closed.subscribe();
        drop(service);
        let _ = closed.wait_for(|closed| *closed).await;
    }
    Reply::json(&())
}

pub fn register(registry: &mut Registry) {
    registry.add("schedules.open", |call| {
        Box::pin(async move { open(&call) })
    });
    registry.add("schedules.command", |call| Box::pin(command(call)));
    registry.add("schedules.create", |call| {
        Box::pin(async move { create(&call) })
    });
    registry.add("schedules.fire", |call| {
        Box::pin(async move {
            let (service, now, params): (_, _, FireParams) = asked(&call)?;
            Reply::json(&service.with(|engine| engine.fire(&params.id, &params.detail, now)))
        })
    });
    registry.add("schedules.webhook", |call| {
        Box::pin(async move {
            let (service, now, params): (_, _, WebhookParams) = asked(&call)?;
            Reply::json(
                &service
                    .with(|engine| engine.webhook(&params.id, &params.bearer, &params.detail, now)),
            )
        })
    });
    registry.add("schedules.triggerFailed", |call| {
        Box::pin(async move {
            let (service, now, params): (_, _, FailedParams) = asked(&call)?;
            Reply::json(
                &service.with(|engine| engine.trigger_failed(&params.id, &params.reason, now)),
            )
        })
    });
    registry.add("schedules.prune", |call| {
        Box::pin(async move {
            let (service, now, params): (_, _, PruneParams) = asked(&call)?;
            service.with(|engine| engine.prune(params.at as i64, now));
            Reply::json(&())
        })
    });
    registry.add("schedules.tick", |call| {
        Box::pin(async move {
            let (service, now, _): (_, _, Value) = asked(&call)?;
            service.with(|engine| engine.tick(now));
            Reply::json(&())
        })
    });
    registry.add("schedules.reserved", |call| {
        Box::pin(async move { reserved(&call) })
    });
    registry.add("schedules.started", |call| {
        Box::pin(async move {
            let (service, now, params): (_, _, RunParams) = asked(&call)?;
            service.with(|engine| engine.started(&params.run, now));
            Reply::json(&())
        })
    });
    registry.add("schedules.ended", |call| {
        Box::pin(async move {
            let (service, now, params): (_, _, EndedParams) = asked(&call)?;
            service.with(|engine| engine.ended(&params.run, params.code, params.error, now));
            Reply::json(&())
        })
    });
    registry.add("schedules.log", |call| Box::pin(async move { log(&call) }));
    registry.add("schedules.close", |call| {
        Box::pin(async move {
            let at: At = call.params()?;
            // Closing twice, or after the core's input ended, has nothing left to close.
            if let Some(service) = locked(&SERVICES).remove(&at.service) {
                service.close(at.now);
            }
            Reply::json(&())
        })
    });
    registry.add("schedules.closed", |call| Box::pin(closed(call)));
    launch::register(registry);
}

/// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted (commit
/// `c609c6c4`).
#[cfg(test)]
fn captured(table: &str) -> Vec<Value> {
    let rows: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    rows[table].as_array().unwrap().clone()
}

#[cfg(test)]
mod host_tests {
    use super::*;

    #[test]
    fn spells_ids_and_keys_as_node_did() {
        let id = uuid();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|part| part.len()).collect::<Vec<_>>(),
            [8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(id, uuid());
        // Node's own answers for the same bytes.
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(&[0xfb]), "-w");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
        assert_eq!(base64url(b"any carnal pleas"), "YW55IGNhcm5hbCBwbGVhcw");
        assert_eq!(webhook_key().len(), 32);
    }
}
