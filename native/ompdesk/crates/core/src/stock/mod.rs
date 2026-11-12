//! The stock helper's host (was `StockHelper` of `src/main/stock-helper.ts`): starts and supervises the Bun workers
//! that run stock omp's own code for main (`resources/gui-bridge/stock-helper/host.ts <worker>`), which stay
//! TypeScript because they import omp's modules.
//!
//! A worker speaks JSON lines on its stdio: `{id, method, params}` in, `{id, result}` or `{id, error}` out, and
//! `{cancel: id}` in to withdraw a request its caller gave up on. The params and the result are JSON text main and
//! the worker wrote; they cross the core as the bytes after the frame (`bin`) and are passed on unread, so a
//! terminal's megabyte of scrollback is parsed once, in main. Three kinds, by the request's method:
//! - `terminals` (`terminal.*`, `pty.*`): holds every live shell and answers every request at once. It is never
//!   ended for a request that hung or for a changed omp: its shells would go with it.
//! - `extensions` (`extensions.*`): a serial lane of its own, because a plugin upgrade runs `bun install` for minutes
//!   and must neither hold the stock lane nor be ended as hung. It holds nothing between requests, so it is let go
//!   `EXTENSIONS_IDLE_EXIT` after its last answer.
//! - `stock`: everything else, one serial lane (the worker's own queue; a few read-only probes answer beside it).
//!
//! Main hands in how a worker starts, when one is needed: the core asks with the event `stock.launch`
//! `{host, worker, launch}` and main answers `stock.launched` with the binary, its arguments, the whole environment
//! and the file whose time and size identify the installed omp, or with why none can start. So omp is resolved only
//! when a worker starts, as before, and a request carries no environment.
//!
//! Each request has its own timeout (main names it), armed before any worker starts. It fails only that request; the
//! worker is told to skip it if it has not started it (a mutation never runs after its caller was told it failed) and
//! answers `withdrawn` in its turn. A stock worker that answers nothing for `RECYCLE_GRACE` after a timeout is stuck:
//! everything waiting on it fails, it is ended and the next request starts a fresh one.
//!
//! A stock or extensions worker that outlived a reinstall of omp (the stamp file changed since it started) holds the
//! old files in its module registry and would import the new ones beside them, so it is let go and a fresh one
//! started, but only with nothing in flight on it.
//!
//! One lane per `(host, worker)`: a task that owns the lane's whole state and takes one message at a time, so no
//! step interleaves with another. A timer or a worker's reader that reports late names the worker it was armed for
//! (`generation`), and a report about a worker that is no longer the lane's is dropped. `host` names the caller's set
//! of lanes (the app has one; each test helper its own), so `stock.stop` ends exactly those. The workers end with the
//! core: their stdin is the core's pipe, the core's job object holds them on Windows and main kills its process
//! group on POSIX.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::io::AsyncWriteExt;
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Notify, mpsc, oneshot, watch};

use crate::fs::error::uv_code;
use crate::json::whole_surrogates;
use crate::run::{Runner, terminate};
use crate::server::{Call, Events, Fault, Registry, Reply};

/// How long past its timeout a stock request may stay unanswered before its worker counts as hung.
const RECYCLE_GRACE: Duration = Duration::from_secs(30);
/// How long the extensions worker stays up with nothing in its lane. Kept up, its stock module graph (about 145 MB,
/// measured on omp 18.14.0, macOS) sat idle between the launch pass, the 4-hourly ones and Settings; a later request
/// starts it again in about 0.35 s.
const EXTENSIONS_IDLE_EXIT: Duration = Duration::from_secs(60);
/// How long a stop waits for the workers it let go to exit (an omp update must not replace files a live worker
/// still reads) before it answers anyway.
const STOP_WAIT: Duration = Duration::from_secs(5);
/// How long the core's own end waits for them: main kills a core that has not exited 5 s after its stdin closed.
const CLOSE_WAIT: Duration = Duration::from_secs(2);
/// A terminal's whole scrollback is one line of about 1 MB.
const READ_BUFFER: usize = 64 * 1024;

pub fn register(registry: &mut Registry) {
    registry.add("stock.request", |call| Box::pin(request(call)));
    registry.add("stock.launched", |call| {
        Box::pin(async move { launched(&call) })
    });
    registry.add("stock.stop", |call| Box::pin(stop(call)));
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Worker {
    Stock,
    Terminals,
    Extensions,
}

impl Worker {
    /// The worker a method runs in.
    fn of(method: &str) -> Worker {
        if method.starts_with("terminal.") || method.starts_with("pty.") {
            Worker::Terminals
        } else if method.starts_with("extensions.") {
            Worker::Extensions
        } else {
            Worker::Stock
        }
    }

    fn name(self) -> &'static str {
        match self {
            Worker::Stock => "stock",
            Worker::Terminals => "terminals",
            Worker::Extensions => "extensions",
        }
    }
}

/// What a test sets apart from the app's lanes: the worker every method of its host runs in, and shorter waits.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tuning {
    worker: Option<Worker>,
    recycle_grace_ms: Option<u64>,
    idle_exit_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestParams {
    host: String,
    method: String,
    timeout_ms: u64,
    #[serde(default)]
    tuning: Tuning,
}

/// How a worker starts, as main hands it over.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    bin: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    /// omp's `package.json`: its time and size tell one install from the next.
    stamp_file: Option<PathBuf>,
}

#[derive(Deserialize)]
struct LaunchFailure {
    message: String,
    /// omp cannot run on this computer yet: main's readers show nothing for it and read again later.
    #[serde(default)]
    unavailable: bool,
}

#[derive(Deserialize)]
struct LaunchedParams {
    host: String,
    worker: Worker,
    launch: u64,
    start: Option<Launch>,
    error: Option<LaunchFailure>,
}

#[derive(Deserialize)]
struct StopParams {
    host: String,
}

#[derive(Serialize)]
struct Done {}

#[derive(Serialize)]
struct LaunchAsk<'a> {
    host: &'a str,
    worker: Worker,
    launch: u64,
}

/// A worker's result as the JSON text it wrote (none for `undefined`), or why there is none.
type Answer = Result<Option<Vec<u8>>, Fault>;

/// What reaches a lane, one at a time.
enum Msg {
    Request {
        id: u64,
        method: String,
        line: Vec<u8>,
        timeout: Duration,
        tuning: Tuning,
        events: Events,
        reply: oneshot::Sender<Answer>,
    },
    /// The request's caller stopped waiting: its timeout passed (or main withdrew the call).
    GaveUp(u64),
    Launched {
        launch: u64,
        how: Result<Launch, Fault>,
    },
    Line {
        generation: u64,
        line: Vec<u8>,
    },
    Exited {
        generation: u64,
    },
    /// A timed-out request's grace passed.
    Overdue {
        generation: u64,
        id: u64,
    },
    /// The idle exit armed as `epoch` is due.
    Idle {
        generation: u64,
        epoch: u64,
    },
    /// Ends the lane; answers with the exits of every worker it started that has not exited yet.
    Stop(oneshot::Sender<Vec<watch::Receiver<bool>>>),
}

struct Entry {
    inbox: mpsc::UnboundedSender<Msg>,
    /// The output of the lane's last request: what tells whose lane it is when a connection ends.
    events: Events,
}

static LANES: LazyLock<Mutex<HashMap<(String, Worker), Entry>>> = LazyLock::new(Default::default);
/// Names requests and starts: one sequence, so no two of either share a number in this process.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

async fn request(call: Call) -> Result<Reply, Fault> {
    let RequestParams {
        host,
        method,
        timeout_ms,
        tuning,
    } = call.params()?;
    // One line per request: JSON text never holds a raw line break, and a worker must never read one as two.
    if call
        .bin
        .as_ref()
        .is_some_and(|params| params.contains(&b'\n'))
    {
        return Err(Fault::new(
            "invalid_params",
            "stock.request's params hold a line break",
        ));
    }
    let worker = tuning.worker.unwrap_or_else(|| Worker::of(&method));
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let timeout = Duration::from_millis(timeout_ms);
    let (reply, answer) = oneshot::channel();
    let inbox = {
        // Sent under the table's lock, so a stop that takes the lane out never leaves a request behind it.
        let mut lanes = locked(&LANES);
        let entry = lanes
            .entry((host.clone(), worker))
            .or_insert_with(|| Entry {
                inbox: Lane::start(host, worker, call.events.clone()),
                events: call.events.clone(),
            });
        entry.events = call.events.clone();
        let _ = entry.inbox.send(Msg::Request {
            id,
            line: request_line(id, &method, call.bin.as_deref()),
            method,
            timeout,
            tuning,
            events: call.events.clone(),
            reply,
        });
        entry.inbox.clone()
    };
    let gave_up = |fault: Fault| {
        let _ = inbox.send(Msg::GaveUp(id));
        Err(fault)
    };
    // The timer runs from here, so a worker that never finishes starting fails the request too.
    tokio::select! {
        biased;
        answer = answer => match answer {
            Ok(Ok(result)) => {
                let reply = Reply::json(&Done {})?;
                Ok(match result {
                    Some(result) => reply.with_bin(result),
                    None => reply,
                })
            }
            Ok(Err(fault)) => Err(fault),
            Err(_) => Err(stopped()),
        },
        () = tokio::time::sleep(timeout) => gave_up(Fault::new("stock_timeout", "omp stock helper request timed out")),
        () = call.scope.on_cancel() => gave_up(Fault::cancelled()),
    }
}

fn launched(call: &Call) -> Result<Reply, Fault> {
    let LaunchedParams {
        host,
        worker,
        launch,
        start,
        error,
    } = call.params()?;
    let how = match (start, error) {
        (Some(start), None) => Ok(start),
        (_, Some(failure)) if failure.unavailable => {
            Err(Fault::new("omp_unavailable", failure.message))
        }
        (_, Some(failure)) => Err(Fault::new("stock_launch", failure.message)),
        (None, None) => Err(Fault::new(
            "invalid_params",
            "stock.launched names neither a start nor an error",
        )),
    };
    // A lane that was stopped since it asked has nobody left to tell.
    if let Some(entry) = locked(&LANES).get(&(host, worker)) {
        let _ = entry.inbox.send(Msg::Launched { launch, how });
    }
    Reply::json(&Done {})
}

async fn stop(call: Call) -> Result<Reply, Fault> {
    let StopParams { host } = call.params()?;
    end_lanes(|(lane_host, _), _| *lane_host == host, STOP_WAIT).await;
    Reply::json(&Done {})
}

/// Ends every lane whose last request came over the output `events` writes to (or over one that is gone): the
/// connection ended, and what waited on its workers has nobody to answer.
pub async fn close_all(events: &Events) {
    end_lanes(|_, entry| !entry.events.reaches_another(events), CLOSE_WAIT).await;
}

/// Takes the chosen lanes out of the table, stops each and waits, at most `wait`, for their workers to exit.
async fn end_lanes(chosen: impl Fn(&(String, Worker), &Entry) -> bool, wait: Duration) {
    let stopping: Vec<_> = {
        let mut lanes = locked(&LANES);
        let keys: Vec<_> = lanes
            .iter()
            .filter(|(key, entry)| chosen(key, entry))
            .map(|(key, _)| key.clone())
            .collect();
        keys.into_iter()
            .filter_map(|key| lanes.remove(&key))
            .map(|entry| {
                let (stopped, exits) = oneshot::channel();
                let _ = entry.inbox.send(Msg::Stop(stopped));
                exits
            })
            .collect()
    };
    let exited = async {
        for exits in stopping {
            for mut exit in exits.await.unwrap_or_default() {
                let _ = exit.wait_for(|exited| *exited).await;
            }
        }
    };
    let _ = tokio::time::timeout(wait, exited).await;
}

fn stopped() -> Fault {
    Fault::new("stock_stopped", "Stock helper stopped")
}

/// The line a worker reads for a request; `params` is JSON text as main wrote it, absent for JavaScript's
/// `undefined`.
fn request_line(id: u64, method: &str, params: Option<&[u8]>) -> Vec<u8> {
    // A string always serializes.
    let method = serde_json::to_string(method).unwrap_or_default();
    let mut line = format!("{{\"id\":{id},\"method\":{method}").into_bytes();
    if let Some(params) = params {
        line.extend_from_slice(b",\"params\":");
        line.extend_from_slice(params);
    }
    line.extend_from_slice(b"}\n");
    line
}

/// A worker's line other than a plain result: an answer names its request; anything else (stock code that printed)
/// is dropped.
#[derive(Deserialize)]
struct WorkerLine<'a> {
    id: Option<u64>,
    #[serde(borrow)]
    result: Option<&'a RawValue>,
    #[serde(borrow)]
    error: Option<&'a RawValue>,
}

/// The answer in a worker's line and the request it is for. A result is the worker's own JSON text, passed on as it
/// came (none for JavaScript's `undefined`).
fn worker_answer(mut line: Vec<u8>) -> Option<(u64, Answer)> {
    while line.last().is_some_and(u8::is_ascii_whitespace) {
        line.pop();
    }
    // What `JSON.stringify({id, result})` writes, which is every answer but a failure: the result is cut out
    // unread, so a terminal's megabyte of scrollback is never parsed here. Main parses it.
    if let Some(rest) = line.strip_prefix(b"{\"id\":") {
        let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
        if let Some(result) = rest[digits..]
            .strip_prefix(b",\"result\":")
            .and_then(|rest| rest.strip_suffix(b"}"))
            && let Ok(id) = std::str::from_utf8(&rest[..digits]).ok()?.parse()
        {
            let (start, end) = (line.len() - 1 - result.len(), line.len() - 1);
            line.truncate(end);
            line.drain(..start);
            return Some((id, Ok(Some(line))));
        }
    }
    let parsed: WorkerLine = serde_json::from_slice(&line).ok()?;
    // Half a surrogate pair in a message (a file name Windows allows) reads as U+FFFD: an answer is never dropped
    // for it, since its request would then count as hung.
    let message = parsed
        .error
        .and_then(|error| serde_json::from_str::<String>(&whole_surrogates(error.get())).ok());
    let answer = match message {
        Some(message) if !message.is_empty() => Err(Fault::new("stock_failed", message)),
        _ => Ok(parsed.result.map(|result| result.get().as_bytes().to_vec())),
    };
    Some((parsed.id?, answer))
}

/// What identifies the installed omp now: its `package.json`'s time and size.
fn stamp(file: Option<&PathBuf>) -> Option<(SystemTime, u64)> {
    let metadata = std::fs::metadata(file?).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

struct Pending {
    method: String,
    /// Its line, until a worker was sent it.
    line: Option<Vec<u8>>,
    timeout: Duration,
    reply: oneshot::Sender<Answer>,
}

/// A worker the lane talks to.
struct Running {
    generation: u64,
    /// Lines to its stdin, written in order by its own task; dropping this closes the pipe, which ends the worker.
    stdin: mpsc::UnboundedSender<Vec<u8>>,
    kill: Arc<Notify>,
    exited: watch::Receiver<bool>,
    stamp_file: Option<PathBuf>,
    /// The stamp when it started, so a request can see omp was replaced since.
    started_stamp: Option<(SystemTime, u64)>,
    /// Requests it was sent and has not answered (a timed-out one included: it may still run, a plugin upgrade's
    /// `bun install`). Neither the idle exit nor a changed omp ends it while there is one.
    unanswered: HashSet<u64>,
    /// Timed-out stock requests it has not answered yet, each by the method to name: any answer (a late result, the
    /// withdrawal) shows the lane still moves; none within the grace means it is stuck.
    overdue: HashMap<u64, (String, Duration)>,
}

struct Lane {
    host: String,
    worker: Worker,
    inbox: mpsc::UnboundedSender<Msg>,
    tuning: Tuning,
    events: Events,
    /// Requests whose caller still waits.
    pending: HashMap<u64, Pending>,
    /// Those that wait for a worker to start, in the order they came.
    waiting: Vec<u64>,
    /// The start main was asked for and has not answered.
    launching: Option<u64>,
    running: Option<Running>,
    generations: u64,
    /// Which arming of the idle exit counts: a request or a newer arming outdates the one before.
    idle_epoch: u64,
    /// Workers let go that have not exited yet.
    leaving: Vec<watch::Receiver<bool>>,
}

impl Lane {
    fn start(host: String, worker: Worker, events: Events) -> mpsc::UnboundedSender<Msg> {
        let (inbox, mut messages) = mpsc::unbounded_channel();
        let mut lane = Lane {
            host,
            worker,
            inbox: inbox.clone(),
            tuning: Tuning::default(),
            events,
            pending: HashMap::new(),
            waiting: Vec::new(),
            launching: None,
            running: None,
            generations: 0,
            idle_epoch: 0,
            leaving: Vec::new(),
        };
        tokio::spawn(async move {
            while let Some(message) = messages.recv().await {
                match message {
                    Msg::Request {
                        id,
                        method,
                        line,
                        timeout,
                        tuning,
                        events,
                        reply,
                    } => {
                        lane.tuning = tuning;
                        lane.events = events;
                        let pending = Pending {
                            method,
                            line: Some(line),
                            timeout,
                            reply,
                        };
                        lane.request(id, pending);
                    }
                    Msg::GaveUp(id) => lane.gave_up(id),
                    Msg::Launched { launch, how } => lane.launched(launch, how),
                    Msg::Line { generation, line } => lane.line(generation, line),
                    Msg::Exited { generation } => lane.exited(generation),
                    Msg::Overdue { generation, id } => lane.overdue(generation, id),
                    Msg::Idle { generation, epoch } => lane.idle(generation, epoch),
                    Msg::Stop(stopped) => {
                        let _ = stopped.send(lane.stop());
                        break;
                    }
                }
            }
        });
        inbox
    }

    fn request(&mut self, id: u64, pending: Pending) {
        // A request keeps the worker up: the idle exit is armed again once this one is answered.
        self.idle_epoch += 1;
        self.pending.insert(id, pending);
        if self.outlived_its_omp() {
            eprintln!(
                "omp stock helper: omp changed under the {} worker; starting a fresh one",
                self.worker.name()
            );
            self.let_go();
        }
        if self.running.is_some() {
            self.write(id);
            return;
        }
        self.waiting.push(id);
        if self.launching.is_none() {
            // Named apart from every other start ever asked for, so a late answer to one asked before a stop is
            // never taken for the answer to this one.
            let launch = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            self.launching = Some(launch);
            let ask = LaunchAsk {
                host: &self.host,
                worker: self.worker,
                launch,
            };
            self.events.send("stock.launch", &ask);
        }
    }

    /// omp was reinstalled while this worker ran, and nothing is in flight on it: no request it was sent is
    /// unanswered and none but the asking one waits. The terminals worker is never let go for it.
    fn outlived_its_omp(&self) -> bool {
        let Some(running) = &self.running else {
            return false;
        };
        if self.worker == Worker::Terminals
            || running.started_stamp.is_none()
            || !running.unanswered.is_empty()
            || self.pending.len() > 1
        {
            return false;
        }
        let now = stamp(running.stamp_file.as_ref());
        now.is_some() && now != running.started_stamp
    }

    /// Lets the worker go: its stdin closes once what was written to it went out, and it ends on that.
    fn let_go(&mut self) -> Option<Running> {
        let running = self.running.take()?;
        self.idle_epoch += 1;
        self.leaving.retain(|exited| !*exited.borrow());
        self.leaving.push(running.exited.clone());
        Some(running)
    }

    fn write(&mut self, id: u64) {
        let (Some(running), Some(pending)) = (&mut self.running, self.pending.get_mut(&id)) else {
            return;
        };
        if let Some(line) = pending.line.take() {
            running.unanswered.insert(id);
            let _ = running.stdin.send(line);
        }
    }

    fn fail_pending(&mut self, fault: &Fault) {
        for (_, pending) in self.pending.drain() {
            let _ = pending.reply.send(Err(fault.clone()));
        }
        self.waiting.clear();
    }

    fn launched(&mut self, launch: u64, how: Result<Launch, Fault>) {
        // An answer to a start asked before a stop starts nothing.
        if self.launching != Some(launch) {
            return;
        }
        self.launching = None;
        match how.and_then(|launch| self.spawn(launch)) {
            Ok(running) => {
                self.running = Some(running);
                for id in std::mem::take(&mut self.waiting) {
                    self.write(id);
                }
                // Every request that waited for it timed out meanwhile: nothing will answer and arm it.
                self.arm_idle_exit();
            }
            Err(fault) => self.fail_pending(&fault),
        }
    }

    fn spawn(&mut self, launch: Launch) -> Result<Running, Fault> {
        let Launch {
            bin,
            args,
            env,
            stamp_file,
        } = launch;
        let runner = Runner {
            bin,
            args,
            env,
            timeout_ms: 0,
            max_bytes: 0,
        };
        let mut command = Command::new(&runner.bin);
        command
            .args(&runner.args)
            .env_clear()
            // An open pipe: the worker exits when it closes, so it never outlives the core.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Stock warnings stay off the answers, and no session data is logged.
            .stderr(Stdio::null());
        runner.environment(&mut command, &[]);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| {
            Fault::new(
                "stock_launch",
                format!("spawn {} {}", runner.bin, uv_code(&error)),
            )
        })?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(Fault::new("internal", "the worker's pipes were not open"));
        };
        // Read on a thread of its own with plain blocking reads: the runtime reads a child's pipe on Windows through
        // its blocking pool, a thread hop and a copy per 64 KB, which a megabyte of scrollback paid sixteen times.
        #[cfg(unix)]
        let stdout = stdout.into_owned_fd().map(std::fs::File::from);
        #[cfg(windows)]
        let stdout = stdout.into_owned_handle().map(std::fs::File::from);
        let stdout = stdout.map_err(|error| Fault::new("internal", error.to_string()))?;
        self.generations += 1;
        let generation = self.generations;
        let (lines, written) = mpsc::unbounded_channel();
        tokio::spawn(write_lines(stdin, written));
        let inbox = self.inbox.clone();
        std::thread::spawn(move || read_lines(stdout, generation, &inbox));
        let kill = Arc::new(Notify::new());
        let (exit, exited) = watch::channel(false);
        let (killed, inbox) = (Arc::clone(&kill), self.inbox.clone());
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                () = killed.notified() => {
                    terminate(&mut child);
                    let _ = child.wait().await;
                }
            }
            exit.send_replace(true);
            let _ = inbox.send(Msg::Exited { generation });
        });
        Ok(Running {
            generation,
            stdin: lines,
            kill,
            exited,
            started_stamp: stamp(stamp_file.as_ref()),
            stamp_file,
            unanswered: HashSet::new(),
            overdue: HashMap::new(),
        })
    }

    /// The lane's worker, if it is the one a late report was made about.
    fn current(&mut self, generation: u64) -> Option<&mut Running> {
        self.running
            .as_mut()
            .filter(|running| running.generation == generation)
    }

    fn line(&mut self, generation: u64, line: Vec<u8>) {
        let Some(running) = self.current(generation) else {
            return;
        };
        let Some((id, answer)) = worker_answer(line) else {
            return;
        };
        running.overdue.remove(&id);
        running.unanswered.remove(&id);
        self.arm_idle_exit();
        if let Some(pending) = self.pending.remove(&id) {
            let _ = pending.reply.send(answer);
        }
    }

    /// Only this request failed (its caller was already told). The worker is told to skip it if it has not started
    /// it. The stock worker is replaced only when its lane then stays silent past the grace; the terminals and
    /// extensions workers never are (a live shell must not be lost, a plugin upgrade may run for minutes).
    fn gave_up(&mut self, id: u64) {
        let Some(pending) = self.pending.remove(&id) else {
            return;
        };
        // Still waiting for a worker to start: `launched` skips it.
        let Some(running) = &mut self.running else {
            return;
        };
        let _ = running
            .stdin
            .send(format!("{{\"cancel\":{id}}}\n").into_bytes());
        if self.worker != Worker::Stock {
            return;
        }
        let grace = self
            .tuning
            .recycle_grace_ms
            .map_or(RECYCLE_GRACE, Duration::from_millis);
        running
            .overdue
            .insert(id, (pending.method, pending.timeout + grace));
        let (generation, inbox) = (running.generation, self.inbox.clone());
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let _ = inbox.send(Msg::Overdue { generation, id });
        });
    }

    /// The stock lane has not moved for a timed-out request's whole grace: end that worker (its queue would hold
    /// every later scan and validation forever) and let the next request start a fresh one.
    fn overdue(&mut self, generation: u64, id: u64) {
        let Some((method, waited)) = self
            .current(generation)
            .and_then(|running| running.overdue.remove(&id))
        else {
            return;
        };
        eprintln!(
            "omp stock helper: \"{method}\" hung for {} ms; restarting the worker",
            waited.as_millis()
        );
        self.fail_pending(&Fault::new(
            "stock_restarted",
            format!("omp stock helper restarted: \"{method}\" hung"),
        ));
        if let Some(running) = self.let_go() {
            running.kill.notify_one();
        }
    }

    fn exited(&mut self, generation: u64) {
        if self.current(generation).is_none() {
            return;
        }
        self.running = None;
        self.idle_epoch += 1;
        self.fail_pending(&Fault::new("stock_exited", "omp stock helper exited"));
    }

    /// Every request the worker was sent is answered: end it if nothing new comes within the idle exit.
    fn arm_idle_exit(&mut self) {
        let wait = match (self.tuning.idle_exit_ms, self.worker) {
            (Some(ms), _) => Duration::from_millis(ms),
            (None, Worker::Extensions) => EXTENSIONS_IDLE_EXIT,
            (None, _) => Duration::ZERO,
        };
        let Some(running) = &self.running else {
            return;
        };
        if wait.is_zero() || !running.unanswered.is_empty() {
            return;
        }
        self.idle_epoch += 1;
        let (generation, epoch, inbox) = (running.generation, self.idle_epoch, self.inbox.clone());
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let _ = inbox.send(Msg::Idle { generation, epoch });
        });
    }

    fn idle(&mut self, generation: u64, epoch: u64) {
        if epoch != self.idle_epoch {
            return;
        }
        if self
            .current(generation)
            .is_some_and(|running| running.unanswered.is_empty())
        {
            self.let_go();
        }
    }

    /// Fails what waits and lets the worker go; the exits of every worker that has not exited yet.
    fn stop(&mut self) -> Vec<watch::Receiver<bool>> {
        self.fail_pending(&stopped());
        self.launching = None;
        self.let_go();
        self.leaving.retain(|exited| !*exited.borrow());
        std::mem::take(&mut self.leaving)
    }
}

/// Writes a worker's lines in order; its stdin closes when the lane lets the worker go or the worker is gone.
async fn write_lines(mut stdin: ChildStdin, mut lines: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(&line).await.is_err() {
            break;
        }
    }
}

/// Reads a worker's lines to the end of its output (its exit) and hands each to the lane.
fn read_lines(stdout: std::fs::File, generation: u64, inbox: &mpsc::UnboundedSender<Msg>) {
    let mut stdout = std::io::BufReader::with_capacity(READ_BUFFER, stdout);
    // A viewer that follows a busy terminal gets one large line after another: each starts at the last one's size.
    let mut size = 0;
    loop {
        let mut line = Vec::with_capacity(size);
        match std::io::BufRead::read_until(&mut stdout, b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                size = read;
                if inbox.send(Msg::Line { generation, line }).is_err() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases of `helperWorker` in `stock-helper.test.ts`, as they were before it moved here.
    #[test]
    fn sends_terminals_and_ptys_to_their_own_worker_extension_calls_to_the_extensions_lane_and_the_rest_to_stock()
     {
        let table = [
            ("terminal.request", Worker::Terminals),
            ("terminal.dispose", Worker::Terminals),
            ("pty.request", Worker::Terminals),
            ("extensions.inventory", Worker::Extensions),
            ("extensions.plugin.upgrade", Worker::Extensions),
            ("sessions.list", Worker::Stock),
            ("models.validate", Worker::Stock),
            ("accounts.providers", Worker::Stock),
        ];
        for (method, worker) in table {
            assert_eq!(Worker::of(method), worker, "{method}");
        }
    }

    #[test]
    fn writes_a_request_as_the_line_the_worker_reads() {
        assert_eq!(
            request_line(7, "sessions.list", Some(b"{\"sessionsRoot\":\"C:\\\\s\"}")),
            b"{\"id\":7,\"method\":\"sessions.list\",\"params\":{\"sessionsRoot\":\"C:\\\\s\"}}\n"
        );
        assert_eq!(
            request_line(8, "a\"b", None),
            b"{\"id\":8,\"method\":\"a\\\"b\"}\n"
        );
    }

    #[test]
    fn reads_a_worker_s_answers_and_drops_what_names_no_request() {
        let result = |line: &str| {
            worker_answer(line.as_bytes().to_vec()).map(|(id, answer)| {
                let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
                (id, answer.map(|value| value.map(text)))
            })
        };
        let some = |text: &str| Ok(Some(text.to_owned()));
        assert_eq!(
            result("{\"id\":3,\"result\":[1, {\"a\":\"}\"}]}\n"),
            Some((3, some("[1, {\"a\":\"}\"}]")))
        );
        assert_eq!(
            result("{\"id\":12,\"result\":\"ok\"}\r\n"),
            Some((12, some("\"ok\"")))
        );
        // Keys in another order than the worker writes them still read.
        assert_eq!(
            result("{\"result\":{\"a\":1},\"id\":6}"),
            Some((6, some("{\"a\":1}")))
        );
        // `undefined` and an empty error are JavaScript's falsy answers: a result of nothing.
        assert_eq!(result("{\"id\":4}"), Some((4, Ok(None))));
        assert_eq!(result("{\"id\":4,\"error\":\"\"}"), Some((4, Ok(None))));
        assert_eq!(
            result("{\"id\":5,\"error\":\"withdrawn\"}"),
            Some((5, Err(Fault::new("stock_failed", "withdrawn"))))
        );
        assert_eq!(
            result("{\"id\":8,\"error\":\"no \\ud83d file \\ud83d\\ude00\"}"),
            Some((8, Err(Fault::new("stock_failed", "no \u{fffd} file 😀"))))
        );
        // A result is passed on as written, half a pair included: main reads it as the worker wrote it.
        assert_eq!(
            result("{\"id\":9,\"result\":\"\\ud83d\"}"),
            Some((9, some("\"\\ud83d\"")))
        );
        assert_eq!(result("{\"error\":\"Invalid stock helper request\"}"), None);
        assert_eq!(result("a stock module printed this"), None);
        assert_eq!(result("{\"id\":\"7\",\"result\":1}"), None);
        assert_eq!(result("{\"id\":,\"result\":1}"), None);
    }
}
