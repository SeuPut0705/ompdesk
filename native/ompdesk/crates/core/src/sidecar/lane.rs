//! One tab's lane: a task that owns all of the tab's state and takes one message at a time (was the state machine of
//! `SidecarManager` in `src/main/sidecar.ts`). Main's `SidecarManager` is the lane's client and keeps a mirror of its
//! status; every closure of `SidecarOptions` (prefs, omp resolution, environment, launch profiles, the session tag, the
//! gate, the logs) stays main's, and the lane asks it by event (`sidecar.resolve`, `sidecar.launch`, `sidecar.exit`,
//! `sidecar.gateAsk`, `sidecar.slow`, `sidecar.sessionWait`), taking the answer as a request.
//!
//! Every `@code` tag of `formal/tab-session` and `formal/session-processes` that pointed into `sidecar.ts` points here.
//! A continuation that outlives the synchronous step (an ask's answer, the start queue, a bridge connect, the entry-id
//! fetch) names the generation it was made for, and is dropped when the lane has moved on (`is_live`).

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use super::bridge::{Bridge, CONNECT_TIMEOUT, Out, Sink, new_address, remove_address};
use super::frames::{Decoder, Frame, head_of, js_trim, strip_vt_control_characters, supports_v2};
use super::launch::{
    MAX_RESTART_ATTEMPTS, Open, WINDOWS_SESSION_END_EXIT_CODE, file_exists, restart_delay,
    session_open,
};
use super::messages::complete_run_messages;
use super::process::{self, Exit, Start, pump_stderr, pump_stdout, signal_name};
use super::queue::{Slot, queue};
use super::stop::{Proc, StdinMsg, Timing};
use super::stream::Stream;
use crate::server::{Events, Fault};

/// stderr lines kept per spawn for the crash report.
const STDERR_TAIL_LINES: usize = 20;
/// Cap on the stderr excerpt appended to the user-visible restart reason.
const STDERR_REASON_CHARS: usize = 240;
/// How long `agent_end` (and every frame behind it) may wait for its entry ids.
const ENTRY_ID_TIMEOUT: Duration = Duration::from_millis(5_000);
/// Longest wait after `exit` for the child's stderr to finish draining (a shim's grandchild may hold it open).
const STDERR_DRAIN: Duration = Duration::from_millis(1_000);
/// How long a started omp may stay silent before its tab says so (the owner's rule, 9 Nov 2026: a live omp is never
/// stopped or failed for being slow; only Restart stops it).
const START_SLOW: Duration = Duration::from_millis(20_000);
/// How long the lane's own protocol commands (`negotiate_protocol`, the filter) may wait for an answer
/// (`RpcClient`'s default timeout).
const COMMAND_TIMEOUT: Duration = Duration::from_millis(8_000);
/// `--model` of a spawn that boots on the configured default model (`DEFAULT_ROLE_MODEL_SELECTOR`).
const DEFAULT_MODEL_SELECTOR: &str = "@default";
const OWNED_TEXT: &str = "This session is still open in another omp process.";

/// Stock commands after which the sidecar's session identity is unknown until the next `get_state`.
const SESSION_CHANGING_COMMANDS: [&str; 5] =
    ["new_session", "switch_session", "fork", "branch", "handoff"];

fn disconnected() -> Fault {
    Fault::new("sidecar_disconnected", "Sidecar disconnected")
}

fn no_bridge() -> Fault {
    Fault::new("bridge_disconnected", "gui-bridge not connected")
}

/// A stock command's answer is an event (`sidecar.answer`, in order with the frames); this settles the request behind it.
pub type StockReply = oneshot::Sender<Result<(), Fault>>;
pub type BridgeReply = oneshot::Sender<Result<Option<Box<RawValue>>, Fault>>;

/// What main sent that the lane applies in `seq` order.
pub enum Command {
    Start,
    Restart {
        cwd: Option<String>,
        resume_session_path: Option<String>,
    },
    Kill,
    Sleep,
    Dispose {
        stdin_grace: Duration,
    },
    Cwd(String),
    Gate,
    Stock {
        seq: u64,
        command: Box<RawValue>,
        timeout: Option<Duration>,
        reply: StockReply,
    },
    Send(Box<RawValue>),
    Bridge {
        method: String,
        params: Option<Box<RawValue>>,
        timeout: Option<Duration>,
        reply: BridgeReply,
    },
    Barrier(u64, oneshot::Sender<()>),
    WhenExited(oneshot::Sender<()>),
}

impl Command {
    /// What a command is answered when there is no lane to apply it (the tab is gone).
    pub fn refuse(self) {
        match self {
            Command::Stock { reply, .. } => {
                let _ = reply.send(Err(disconnected()));
            }
            Command::Bridge { reply, .. } => {
                let _ = reply.send(Err(no_bridge()));
            }
            Command::Barrier(_, reply) | Command::WhenExited(reply) => {
                let _ = reply.send(());
            }
            _ => {}
        }
    }
}

/// An exit plan main answered (`sidecar.exitPlan`).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Plan {
    Word(String),
    Fallback {
        fallback: String,
    },
    BootModel {
        #[serde(rename = "bootModel")]
        boot_model: String,
    },
}

/// What a `sidecar.stopAll` or the core's end asks a lane: how many omps it told to stop, and their exits.
pub struct Stopped {
    pub told: u32,
    pub done: Vec<watch::Receiver<bool>>,
}

pub enum Msg {
    Seq(u64, Command),
    Resolved {
        ask: u64,
        outcome: String,
        message: Option<String>,
    },
    Launched {
        ask: u64,
        start: Option<Start>,
        host_tools: Option<Value>,
        error: Option<String>,
    },
    ExitPlan {
        ask: u64,
        plan: Plan,
    },
    Gated {
        ask: u64,
        cwd: Option<String>,
    },
    SlowLog {
        ask: u64,
        lines: Vec<String>,
    },
    SessionFreed {
        ask: u64,
        free: bool,
    },
    Frame {
        spawn_id: u64,
        frame: Frame,
    },
    BridgeLost {
        spawn_id: u64,
    },
    Stderr {
        spawn_id: u64,
        text: String,
    },
    ChildExit {
        spawn_id: u64,
        exit: Exit,
    },
    Drained {
        generation: u64,
        reason: String,
    },
    BridgeConnected {
        generation: u64,
        result: Result<(), String>,
    },
    EntryIds {
        id: u64,
        generation: u64,
        messages: Option<Value>,
    },
    SlowTimer {
        generation: u64,
        epoch: u64,
    },
    RestartTimer {
        epoch: u64,
    },
    NegotiateTimeout {
        generation: u64,
        id: String,
    },
    QueueWaits {
        generation: u64,
    },
    SlotGranted {
        generation: u64,
        slot: Option<Slot>,
    },
    AllExited,
    StopAll(oneshot::Sender<Stopped>),
    Shutdown(oneshot::Sender<Stopped>),
}

/// What a test sets apart from the app's lanes (`sidecar.open`'s `tuning`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    /// 0: this tab's starts bypass the queue; above 0: the process-wide queue's limit from now on.
    pub starts_at_once: Option<usize>,
    pub start_slot_cap_ms: Option<u64>,
    pub stop_grace_ms: Option<u64>,
    pub kill_wait_ms: Option<u64>,
    pub stderr_drain_ms: Option<u64>,
    pub restart_delays_ms: Option<Vec<u64>>,
}

/// `sidecar.open`'s params.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenParams {
    pub tab: String,
    pub seq: u64,
    pub cwd: String,
    #[serde(default)]
    pub fresh: bool,
    #[serde(default)]
    pub event_filter: Vec<String>,
    #[serde(default)]
    pub bridge: bool,
    pub ledger_file: Option<String>,
    pub start_slow_ms: Option<u64>,
    pub entry_id_timeout_ms: Option<u64>,
    pub tuning: Option<Tuning>,
    /// A re-open after a lost core: the session the tab was on.
    pub session_path: Option<String>,
    pub is_new: Option<bool>,
}

#[derive(Clone, Default, PartialEq, Debug)]
struct Detail {
    message: Option<String>,
    restart: Option<(u32, u32)>,
    model_fallback: Option<String>,
    session_ended: bool,
    session_held: bool,
    slow: bool,
    queued: bool,
}

impl Detail {
    fn message(message: impl Into<String>) -> Detail {
        Detail {
            message: Some(message.into()),
            ..Detail::default()
        }
    }

    fn payload(&self, status: &str, cwd: &str) -> Value {
        let mut payload = Map::new();
        payload.insert("status".into(), json!(status));
        payload.insert("cwd".into(), json!(cwd));
        if let Some(message) = &self.message {
            payload.insert("message".into(), json!(message));
        }
        if let Some((attempt, max)) = self.restart {
            payload.insert(
                "restart".into(),
                json!({ "attempt": attempt, "maxAttempts": max }),
            );
        }
        if let Some(model) = &self.model_fallback {
            payload.insert("modelFallback".into(), json!(model));
        }
        for (key, on) in [
            ("sessionEnded", self.session_ended),
            ("sessionHeld", self.session_held),
            ("slow", self.slow),
            ("queued", self.queued),
        ] {
            if on {
                payload.insert(key.into(), json!(true));
            }
        }
        Value::Object(payload)
    }
}

/// The live session's identity as last reported by `get_state`.
#[derive(Clone, PartialEq, Debug)]
struct Identity {
    session_id: Option<String>,
    session_file: Option<String>,
    session_name: Option<String>,
}

/// A command omp has not answered, and who waits for the answer.
enum Waiter {
    /// `sidecar.command`: main's call.
    Caller(u64, StockReply),
    /// The lane's own `negotiate_protocol` of that spawn.
    Negotiate(u64),
    /// The lane's own `get_state`, whose answer lets the tab read `ready` (no deadline).
    Answered(u64),
    /// A fire-and-forget command of the lane's.
    Ignore,
}

/// What a command's answer is read against (`#observeResponse`).
struct CommandInfo {
    ty: String,
    name: Option<String>,
    session_path: Option<String>,
}

struct Pending {
    id: String,
    command: CommandInfo,
    waiter: Waiter,
    /// Past it the command counts as timed out: its late answer is a frame and it is no longer `unanswered`.
    deadline: Option<Instant>,
}

/// One omp that runs, and everything that dies with it.
struct Running {
    spawn_id: u64,
    proc: Arc<Proc>,
    pending: Vec<Pending>,
    next_id: u64,
    bridge: Bridge,
    bridge_address: Option<String>,
    /// True once the omp's stderr closed.
    drained: watch::Receiver<bool>,
}

struct Stopping {
    done: watch::Receiver<bool>,
    exited: watch::Receiver<bool>,
}

/// An `agent_end` waiting for its entry ids, and every frame that arrived behind it, responses included. Holding the
/// tail keeps the renderer's frame order (`agent_end` before `prompt_result`/`session_settled`) intact, and a response
/// (`get_state`, a transcript page) never overtakes the run it already reports.
struct Held {
    id: u64,
    event: Value,
    frames: Vec<Frame>,
}

enum Ask {
    Resolve {
        seq: u64,
    },
    Launch {
        generation: u64,
        bridge_address: Option<String>,
    },
    Exit {
        generation: u64,
        reason: String,
    },
    Gate {
        generation: u64,
        model_fallback: Option<String>,
    },
    Slow {
        generation: u64,
    },
    SessionWait {
        seq: u64,
    },
}

/// Where the `ready` of one spawn has got to: it reads `ready` once the bridge settled, the protocol is negotiated
/// and omp answered its first `get_state`.
struct ReadyProgress {
    generation: u64,
    bridge_settled: bool,
    /// `None`: `negotiate_protocol` unanswered; `Some(with_filter)` once it is (an answer or its timeout).
    negotiated: Option<bool>,
    announced: bool,
    model_fallback: Option<String>,
}

pub struct Lane {
    tab: String,
    inbox: mpsc::UnboundedSender<Msg>,
    events: Events,
    open_reply: Option<oneshot::Sender<Result<(), Fault>>>,
    /// The highest `seq` applied: every event says which state it describes.
    applied: u64,
    cwd: String,
    event_filter: Vec<String>,
    bridge_enabled: bool,
    ledger_file: Option<String>,
    start_slow: Duration,
    entry_id_timeout: Duration,
    tuning: Tuning,
    timing: Timing,
    stderr_drain: Duration,

    status: &'static str,
    detail: Detail,
    /// The session this tab is on, for every spawn of it (`session_open`).
    session_path: Option<String>,
    is_new: bool,
    restart_count: u32,
    restart_epoch: u64,
    /// Spawn-cycle counter, bumped whenever a cycle is torn down or started. Every continuation that outlives the
    /// synchronous spawn captures it and drops itself when it no longer matches, so a dead child can never report
    /// `ready` or reset the crash-loop counter.
    generation: u64,
    /// `start()` calls so far; a superseded resolution must not spawn.
    start_seq: u64,
    spawn_counter: u64,
    runtime_known: bool,
    disposed: bool,
    /// The app is quitting: nothing starts again.
    quit: bool,
    quiet: bool,
    booted: bool,
    boot_model_fallback: Option<String>,
    no_model_boot: Option<String>,
    /// The GUI-executed tools this spawn registers once the protocol is negotiated (main's launch answer).
    host_tools: Option<Value>,
    session: Option<Identity>,
    last_stderr: Vec<String>,
    slow: bool,
    slow_log: Vec<String>,
    slow_epoch: u64,
    spawned_at_ms: u64,
    release_slot: Option<Slot>,
    exiting: Vec<Stopping>,
    start_gate: bool,
    held: Option<Held>,
    held_counter: u64,
    run_messages: Vec<Value>,
    barriers: Vec<(u64, oneshot::Sender<()>)>,
    running: Option<Running>,
    ask_counter: u64,
    asks: Vec<(u64, Ask)>,
    ready: Option<ReadyProgress>,
    /// What main reads of the frames (`stream.rs`).
    stream: Stream,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// Leading stderr line of the crashed spawn: a fatal message comes first (`dyld: Library not loaded …`, `error:
/// ENOENT …`) and whatever follows is stack or warning noise. The full tail rides on the runtime-log report.
pub fn stderr_excerpt(lines: &[String]) -> String {
    for line in lines {
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.encode_utf16().count() > STDERR_REASON_CHARS {
            return format!(
                "{}…",
                crate::json::utf16_prefix(trimmed, STDERR_REASON_CHARS - 1)
            );
        }
        return trimmed.to_owned();
    }
    String::new()
}

/// The reason an exit is reported with (`Exit code ${code}${signal ? ` (signal: ${signal})` : ""}`).
pub fn exit_reason(exit: &Exit) -> String {
    let code = exit
        .code
        .map_or_else(|| "null".to_owned(), |code| code.to_string());
    match exit.signal {
        Some(signal) => format!("Exit code {code} (signal: {})", signal_name(signal)),
        None => format!("Exit code {code}"),
    }
}

impl Lane {
    #[allow(clippy::new_ret_no_self)]
    pub fn open(
        params: OpenParams,
        events: Events,
        open_reply: oneshot::Sender<Result<(), Fault>>,
    ) -> mpsc::UnboundedSender<Msg> {
        let (inbox, mut messages) = mpsc::unbounded_channel();
        let tuning = params.tuning.clone().unwrap_or_default();
        if let Some(limit) = tuning.starts_at_once.filter(|limit| *limit > 0) {
            queue().configure(
                Some(limit),
                tuning.start_slot_cap_ms.map(Duration::from_millis),
            );
        } else if tuning.starts_at_once.is_none() && tuning.start_slot_cap_ms.is_some() {
            queue().configure(None, tuning.start_slot_cap_ms.map(Duration::from_millis));
        }
        let mut timing = Timing::default();
        if let Some(ms) = tuning.stop_grace_ms {
            timing.grace = Duration::from_millis(ms);
        }
        if let Some(ms) = tuning.kill_wait_ms {
            timing.kill_wait = Duration::from_millis(ms);
        }
        let mut lane = Lane {
            tab: params.tab,
            inbox: inbox.clone(),
            events,
            open_reply: Some(open_reply),
            applied: params.seq,
            cwd: params.cwd,
            event_filter: params.event_filter,
            bridge_enabled: params.bridge,
            ledger_file: params.ledger_file,
            start_slow: params
                .start_slow_ms
                .map_or(START_SLOW, Duration::from_millis),
            entry_id_timeout: params
                .entry_id_timeout_ms
                .map_or(ENTRY_ID_TIMEOUT, Duration::from_millis),
            stderr_drain: tuning
                .stderr_drain_ms
                .map_or(STDERR_DRAIN, Duration::from_millis),
            tuning,
            timing,
            status: "asleep",
            detail: Detail::default(),
            session_path: params.session_path,
            is_new: params.is_new.unwrap_or(params.fresh),
            restart_count: 0,
            restart_epoch: 0,
            generation: 0,
            start_seq: 0,
            spawn_counter: 0,
            runtime_known: false,
            disposed: false,
            quit: false,
            quiet: false,
            booted: false,
            boot_model_fallback: None,
            no_model_boot: None,
            host_tools: None,
            session: None,
            last_stderr: Vec::new(),
            slow: false,
            slow_log: Vec::new(),
            slow_epoch: 0,
            spawned_at_ms: 0,
            release_slot: None,
            exiting: Vec::new(),
            start_gate: false,
            held: None,
            held_counter: 0,
            run_messages: Vec::new(),
            barriers: Vec::new(),
            running: None,
            ask_counter: 0,
            asks: Vec::new(),
            ready: None,
            stream: Stream::default(),
        };
        tokio::spawn(async move {
            while let Some(message) = messages.recv().await {
                if lane.handle(message) {
                    break;
                }
            }
            lane.end();
            super::untap(&lane.tab);
        });
        inbox
    }

    // ---- events ---------------------------------------------------------------------------------------------------

    /// An event about this tab: its id and the highest command applied.
    fn emit(&self, name: &str, body: Value) {
        if self.quiet {
            return;
        }
        self.emit_always(name, body);
    }

    fn emit_always(&self, name: &str, body: Value) {
        let mut data = match body {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        data.insert("tab".into(), json!(self.tab));
        data.insert("cmd".into(), json!(self.applied));
        let data = Value::Object(data);
        super::tap(&self.tab, name, &data, None);
        self.events.send(name, &data);
    }

    /// The answer to the command main numbered `seq`: omp's response line (none for a barrier), sent in order with the
    /// frames, also by a tab that is over (`quiet`): the call waits for it.
    fn answer_event(&self, seq: u64, response: Option<Vec<u8>>) {
        let data = json!({ "tab": self.tab, "cmd": self.applied, "seq": seq });
        super::tap(&self.tab, "sidecar.answer", &data, response.as_deref());
        match response {
            Some(raw) => self.events.send_bin("sidecar.answer", &data, raw),
            None => self.events.send("sidecar.answer", &data),
        }
    }

    fn emit_frame(&mut self, frame: Frame) {
        if self.quiet {
            return;
        }
        let raw = self.stream.frame(frame.raw, frame.ty.as_deref());
        let data = json!({ "tab": self.tab, "cmd": self.applied });
        super::tap(&self.tab, "sidecar.frame", &data, Some(&raw));
        self.events.send_bin("sidecar.frame", &data, raw);
    }

    fn set_status(&mut self, status: &'static str, detail: Detail) {
        self.status = status;
        self.detail = detail;
        let payload = self.detail.payload(status, &self.cwd);
        self.emit("sidecar.status", json!({ "payload": payload }));
    }

    fn set_session(&mut self, next: Option<Identity>) {
        let changed = match (&self.session, &next) {
            (None, None) => false,
            (Some(a), Some(b)) => a.session_id != b.session_id || a.session_file != b.session_file,
            _ => true,
        };
        self.session = next;
        if changed {
            let identity = self.session.as_ref().map(|identity| {
                let mut map = Map::new();
                for (key, value) in [
                    ("sessionId", &identity.session_id),
                    ("sessionFile", &identity.session_file),
                    ("sessionName", &identity.session_name),
                ] {
                    if let Some(value) = value {
                        map.insert(key.into(), json!(value));
                    }
                }
                Value::Object(map)
            });
            self.emit("sidecar.session", json!({ "identity": identity }));
        }
    }

    fn set_tab_session(&mut self, path: Option<String>, is_new: bool) {
        if self.session_path == path && self.is_new == is_new {
            return;
        }
        self.session_path = path;
        self.is_new = is_new;
        self.emit(
            "sidecar.tabSession",
            json!({ "sessionPath": self.session_path, "isNew": self.is_new }),
        );
    }

    fn ask(&mut self, ask: Ask) -> u64 {
        self.ask_counter += 1;
        self.asks.push((self.ask_counter, ask));
        self.ask_counter
    }

    /// The pending ask `id`, taken: an answer to one asked before it was dropped finds none.
    fn answered(&mut self, id: u64) -> Option<Ask> {
        let at = self.asks.iter().position(|(ask, _)| *ask == id)?;
        Some(self.asks.remove(at).1)
    }

    /// Continuation guard: false once the spawn cycle that captured `generation` has been torn down or replaced.
    fn is_live(&self, generation: u64) -> bool {
        !self.disposed && generation == self.generation
    }

    fn write_line(&self, line: Vec<u8>) {
        if let Some(running) = &self.running {
            let _ = running.proc.stdin.send(StdinMsg::Line(line));
        }
    }

    fn prune_exiting(&mut self) {
        self.exiting.retain(|stopping| !*stopping.done.borrow());
    }

    // ---- the message loop -----------------------------------------------------------------------------------------

    /// One message; true once the lane is over.
    fn handle(&mut self, message: Msg) -> bool {
        match message {
            Msg::Seq(seq, command) => {
                self.applied = seq;
                self.command(command);
            }
            Msg::Resolved {
                ask,
                outcome,
                message,
            } => self.on_resolved(ask, &outcome, message),
            Msg::Launched {
                ask,
                start,
                host_tools,
                error,
            } => self.on_launched(ask, start, host_tools, error),
            Msg::ExitPlan { ask, plan } => self.on_exit_plan(ask, plan),
            Msg::Gated { ask, cwd } => self.on_gated(ask, cwd),
            Msg::SlowLog { ask, lines } => self.on_slow_log(ask, lines),
            Msg::SessionFreed { ask, free } => self.on_session_freed(ask, free),
            Msg::Frame { spawn_id, frame } => {
                if self
                    .running
                    .as_ref()
                    .is_some_and(|r| r.spawn_id == spawn_id)
                {
                    self.route_frame(frame);
                }
            }
            Msg::BridgeLost { spawn_id } => {
                if self
                    .running
                    .as_ref()
                    .is_some_and(|r| r.spawn_id == spawn_id)
                {
                    self.emit("sidecar.bridgeLost", json!({}));
                }
            }
            Msg::Stderr { spawn_id, text } => self.on_stderr(spawn_id, &text),
            Msg::ChildExit { spawn_id, exit } => self.on_child_exit(spawn_id, exit),
            Msg::Drained { generation, reason } => self.on_drained(generation, reason),
            Msg::BridgeConnected { generation, result } => {
                self.on_bridge_connected(generation, result)
            }
            Msg::EntryIds {
                id,
                generation,
                messages,
            } => self.on_entry_ids(id, generation, messages),
            Msg::SlowTimer { generation, epoch } => {
                if epoch == self.slow_epoch && self.is_live(generation) {
                    self.start_is_slow(generation);
                }
            }
            Msg::RestartTimer { epoch } => {
                if epoch == self.restart_epoch && !self.disposed {
                    self.spawn();
                }
            }
            Msg::NegotiateTimeout { generation, id } => self.on_negotiate_timeout(generation, &id),
            Msg::QueueWaits { generation } => {
                if self.is_live(generation) && self.status == "starting" && !self.detail.queued {
                    self.set_status(
                        "starting",
                        Detail {
                            queued: true,
                            ..Detail::default()
                        },
                    );
                }
            }
            Msg::SlotGranted { generation, slot } => self.on_slot(generation, slot),
            Msg::AllExited => return self.on_all_exited(),
            Msg::StopAll(reply) => {
                let stopped = self.stop_all(false);
                let _ = reply.send(stopped);
            }
            Msg::Shutdown(reply) => {
                let stopped = self.stop_all(true);
                let _ = reply.send(stopped);
            }
        }
        false
    }

    /// The lane is over: whatever still waits on it is told.
    fn end(&mut self) {
        let barriers = std::mem::take(&mut self.barriers);
        for (seq, barrier) in barriers {
            self.answer_event(seq, None);
            let _ = barrier.send(());
        }
        super::finish(&self.tab);
        if let Some(reply) = self.open_reply.take() {
            let _ = reply.send(Ok(()));
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Start => self.start(),
            Command::Restart {
                cwd,
                resume_session_path,
            } => self.restart(cwd, resume_session_path),
            Command::Kill => self.stop_child(None),
            Command::Sleep => self.sleep(),
            Command::Dispose { stdin_grace } => self.dispose(stdin_grace),
            Command::Cwd(cwd) => self.cwd = cwd,
            Command::Gate => self.start_gate = true,
            Command::Stock {
                seq,
                command,
                timeout,
                reply,
            } => self.stock(seq, &command, timeout, reply),
            Command::Send(frame) => {
                let mut line = frame.get().as_bytes().to_vec();
                line.push(b'\n');
                self.write_line(line);
            }
            Command::Bridge {
                method,
                params,
                timeout,
                reply,
            } => {
                let Some(running) = &self.running else {
                    let _ = reply.send(Err(no_bridge()));
                    return;
                };
                let bridge = running.bridge.clone();
                tokio::spawn(async move {
                    let _ = reply.send(bridge.request(&method, params, timeout).await);
                });
            }
            Command::Barrier(seq, reply) => {
                if self.held.is_some() {
                    self.barriers.push((seq, reply));
                } else {
                    self.answer_event(seq, None);
                    let _ = reply.send(());
                }
            }
            Command::WhenExited(reply) => {
                self.prune_exiting();
                let mut exits: Vec<watch::Receiver<bool>> = self
                    .exiting
                    .iter()
                    .map(|stopping| stopping.done.clone())
                    .collect();
                if let Some(running) = &self.running {
                    exits.push(running.proc.exited.clone());
                }
                tokio::spawn(async move {
                    wait_all(exits).await;
                    let _ = reply.send(());
                });
            }
        }
    }

    // ---- start, resolve, spawn, launch ----------------------------------------------------------------------------

    fn start(&mut self) {
        if self.disposed || self.quit {
            return;
        }
        self.set_status("starting", Detail::default());
        // omp + env resolution takes up to a few seconds. A restart()/start() landing inside that window supersedes
        // this pending spawn — it already killed whatever child existed (nothing yet) — so spawning on its answer
        // would orphan the newer child and tear it down with the session it just opened.
        self.start_seq += 1;
        let seq = self.start_seq;
        let ask = self.ask(Ask::Resolve { seq });
        self.emit(
            "sidecar.resolve",
            json!({ "ask": ask, "sessionPath": self.session_path }),
        );
    }

    fn on_resolved(&mut self, ask: u64, outcome: &str, message: Option<String>) {
        let Some(Ask::Resolve { seq }) = self.answered(ask) else {
            return;
        };
        if self.disposed || seq != self.start_seq {
            return;
        }
        match outcome {
            "owned" => {
                let message = message.unwrap_or_else(|| OWNED_TEXT.to_owned());
                self.set_status(
                    "error",
                    Detail {
                        message: Some(message),
                        session_held: true,
                        ..Detail::default()
                    },
                );
                self.when_session_let_go(seq);
            }
            // No usable omp: nothing ran, nothing failed. Machine setup installs it and main starts this tab then.
            "waiting" => self.set_status("waiting", Detail::message(message.unwrap_or_default())),
            _ => {
                self.runtime_known = true;
                self.spawn();
            }
        }
    }

    /// A tab left `error` because another omp keeps its session starts by itself once that omp lets go (it may close
    /// minutes later: a terminal, or a last launch still finishing a long tool), so the person never has to notice and
    /// press Restart. Each round is another `sessionFree` wait; a Restart, a new start or dispose ends it.
    fn when_session_let_go(&mut self, seq: u64) {
        let Some(path) = self.session_path.clone() else {
            return;
        };
        let ask = self.ask(Ask::SessionWait { seq });
        self.emit(
            "sidecar.sessionWait",
            json!({ "ask": ask, "sessionPath": path }),
        );
    }

    fn on_session_freed(&mut self, ask: u64, free: bool) {
        let Some(Ask::SessionWait { seq }) = self.answered(ask) else {
            return;
        };
        if self.disposed || seq != self.start_seq || self.status != "error" {
            return;
        }
        if free {
            self.start();
        } else {
            self.when_session_let_go(seq);
        }
    }

    /// Starts the next omp of this tab once every omp it stopped has exited (a replacement never overlaps its
    /// predecessor on the session) and the app's start queue gave it a place. Meanwhile a `starting` tab reads `queued`:
    /// waiting its turn, never a deadline (a paired device mirrors it instead of timing the start out).
    // formal/tab-session `Spawn`: the launch is built from `session_open(path, is_new)` (see `launch`, `start_process`).
    fn spawn(&mut self) {
        // One live child per lane. `running` is only ever set by `start_process`, so anything still attached means a
        // previous spawn was never retired: stop it through the normal teardown instead of letting it run parser-less.
        if self.running.is_some() {
            let superseded = self.cleanup();
            if let Some(superseded) = superseded {
                self.stop_proc(&superseded.proc, Duration::ZERO);
            }
        }
        if !self.runtime_known {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.prune_exiting();
        if !self.exiting.is_empty() {
            self.queue_waits(generation);
        }
        let exits: Vec<_> = self
            .exiting
            .iter()
            .map(|stopping| stopping.done.clone())
            .collect();
        let inbox = self.inbox.clone();
        let bypass = self.tuning.starts_at_once == Some(0);
        tokio::spawn(async move {
            wait_all(exits).await;
            let slot = if bypass {
                None
            } else {
                let waits = inbox.clone();
                Some(
                    queue()
                        .acquire(move || {
                            let _ = waits.send(Msg::QueueWaits { generation });
                        })
                        .await,
                )
            };
            let _ = inbox.send(Msg::SlotGranted { generation, slot });
        });
    }

    fn queue_waits(&mut self, generation: u64) {
        if self.is_live(generation) && self.status == "starting" && !self.detail.queued {
            self.set_status(
                "starting",
                Detail {
                    queued: true,
                    ..Detail::default()
                },
            );
        }
    }

    fn on_slot(&mut self, generation: u64, slot: Option<Slot>) {
        if !self.is_live(generation) {
            if let Some(slot) = slot {
                slot.release();
            }
            return;
        }
        self.release_slot = slot;
        if self.detail.queued {
            self.set_status("starting", Detail::default());
        }
        self.launch(generation);
    }

    /// The launch ask: how this spawn opens its session, then main assembles it (its settings are read now).
    fn launch(&mut self, generation: u64) {
        self.last_stderr.clear();
        self.slow_log.clear();
        self.spawned_at_ms = now_ms();
        self.booted = false;
        self.set_session(None);
        let open = session_open(self.session_path.as_deref(), self.is_new, file_exists);
        let bridge_address = self.bridge_enabled.then(new_address);
        let model = self.no_model_boot.clone().or_else(|| {
            self.boot_model_fallback
                .as_ref()
                .map(|_| DEFAULT_MODEL_SELECTOR.to_owned())
        });
        let ask = self.ask(Ask::Launch {
            generation,
            bridge_address: bridge_address.clone(),
        });
        let open: &Open = &open;
        self.emit(
            "sidecar.launch",
            json!({ "ask": ask, "open": open, "model": model, "bridgeAddress": bridge_address }),
        );
    }

    fn on_launched(
        &mut self,
        ask: u64,
        start: Option<Start>,
        host_tools: Option<Value>,
        error: Option<String>,
    ) {
        let Some(Ask::Launch {
            generation,
            bridge_address,
        }) = self.answered(ask)
        else {
            return;
        };
        if !self.is_live(generation) {
            return;
        }
        match (start, error) {
            (Some(start), None) => {
                self.host_tools = host_tools;
                self.start_process(generation, &start, bridge_address)
            }
            (_, error) => {
                // spawn() throws synchronously (EBADF/ENOENT) — surface it as a sidecar failure + retry, never an
                // uncaught main-process exception.
                self.release_slot = None;
                let reason = error.unwrap_or_else(|| "The launch gave no way to start omp".into());
                self.attempt_restart(&reason);
            }
        }
    }

    fn start_process(&mut self, generation: u64, start: &Start, bridge_address: Option<String>) {
        self.spawn_counter += 1;
        let spawn_id = self.spawn_counter;
        let inbox = self.inbox.clone();
        // An exit is told after the frames omp wrote before it were read (its stdout closed), at most `stderr_drain`
        // later: a shim's grandchild may hold the pipe open. The frames come first, as `readline` delivers them.
        let (stdout_signal, mut stdout_done) = watch::channel(false);
        let wait = self.stderr_drain;
        let started = process::start(start, self.timing, {
            let inbox = inbox.clone();
            move |exit| {
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(wait, stdout_done.wait_for(|done| *done)).await;
                    let _ = inbox.send(Msg::ChildExit { spawn_id, exit });
                });
            }
        });
        let started = match started {
            Ok(started) => started,
            Err(message) => {
                if let Some(address) = &bridge_address {
                    remove_address(address);
                }
                self.release_slot = None;
                self.attempt_restart(&message);
                return;
            }
        };
        let proc = Arc::clone(&started.proc);
        // The pipes: stdout's lines become frames in order, stderr's chunks the tail.
        {
            let inbox = inbox.clone();
            let mut decoder = Decoder::default();
            tokio::spawn(async move {
                pump_stdout(started.stdout, |line| {
                    if let Some(frame) = decoder.line(line) {
                        let _ = inbox.send(Msg::Frame { spawn_id, frame });
                    }
                })
                .await;
                stdout_signal.send_replace(true);
            });
        }
        let (drain_signal, drain_wait) = watch::channel(false);
        {
            let inbox = inbox.clone();
            let proc = Arc::clone(&proc);
            tokio::spawn(async move {
                let sent = inbox.clone();
                pump_stderr(started.stderr, proc, move |text| {
                    let _ = sent.send(Msg::Stderr { spawn_id, text });
                })
                .await;
                drain_signal.send_replace(true);
            });
        }
        // The pid ledger: named from the spawn to the exit, in that order.
        if let (Some(file), Some(pid)) = (self.ledger_file.clone(), proc.pid) {
            let mut exited = proc.exited.clone();
            tokio::spawn(async move {
                if let Err(fault) = crate::omp::record_spawn(&file, pid).await {
                    eprintln!("[omp-processes] {file} not saved: {}", fault.message);
                }
                let _ = exited.wait_for(|exited| *exited).await;
                if let Err(fault) = crate::omp::record_exit(&file, pid).await {
                    eprintln!("[omp-processes] {file} not saved: {}", fault.message);
                }
            });
        }
        let sink: Sink = {
            let inbox = inbox.clone();
            Arc::new(move |out| {
                let _ = inbox.send(match out {
                    Out::Event(frame) => Msg::Frame { spawn_id, frame },
                    Out::Lost => Msg::BridgeLost { spawn_id },
                });
            })
        };
        let bridge = Bridge::new(bridge_address.clone(), sink);
        self.running = Some(Running {
            spawn_id,
            proc: Arc::clone(&proc),
            pending: Vec::new(),
            next_id: 0,
            bridge,
            bridge_address,
            drained: drain_wait,
        });
        self.arm_slow_timer(generation);
        self.emit("sidecar.spawned", json!({ "pid": proc.pid }));
    }

    fn arm_slow_timer(&mut self, generation: u64) {
        self.slow_epoch += 1;
        let (epoch, wait, inbox) = (self.slow_epoch, self.start_slow, self.inbox.clone());
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let _ = inbox.send(Msg::SlowTimer { generation, epoch });
        });
    }

    // ---- commands and frames --------------------------------------------------------------------------------------

    /// Writes one command to omp (`{...cmd, id}`) and remembers who waits for the answer. Returns the id.
    fn send_command(
        &mut self,
        mut command: std::collections::BTreeMap<String, Box<RawValue>>,
        info: CommandInfo,
        waiter: Waiter,
        timeout: Option<Duration>,
    ) -> Result<String, Waiter> {
        let Some(running) = self.running.as_mut() else {
            return Err(waiter);
        };
        running.next_id += 1;
        let id = format!("gui-{}", running.next_id);
        let Ok(id_raw) = serde_json::value::to_raw_value(&id) else {
            running.next_id -= 1;
            return Err(waiter);
        };
        command.insert("id".into(), id_raw);
        let mut line = serde_json::to_vec(&command).unwrap_or_default();
        line.push(b'\n');
        running.pending.push(Pending {
            id: id.clone(),
            command: info,
            waiter,
            deadline: timeout.map(|timeout| Instant::now() + timeout),
        });
        let _ = running.proc.stdin.send(StdinMsg::Line(line));
        Ok(id)
    }

    /// A command of the lane's own.
    fn internal(
        &mut self,
        command: Value,
        waiter: Waiter,
        timeout: Option<Duration>,
    ) -> Option<String> {
        let Value::Object(map) = command else {
            return None;
        };
        let info = CommandInfo {
            ty: map
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            name: None,
            session_path: None,
        };
        let raw: std::collections::BTreeMap<String, Box<RawValue>> = map
            .into_iter()
            .filter_map(|(key, value)| Some((key, RawValue::from_string(value.to_string()).ok()?)))
            .collect();
        self.send_command(raw, info, waiter, timeout).ok()
    }

    /// `sidecar.command`: a stock command of main's, answered with omp's correlated response.
    fn stock(
        &mut self,
        seq: u64,
        command: &RawValue,
        timeout: Option<Duration>,
        reply: StockReply,
    ) {
        if self.running.is_none() {
            let _ = reply.send(Err(disconnected()));
            return;
        }
        let Ok(map) = serde_json::from_str::<std::collections::BTreeMap<String, Box<RawValue>>>(
            command.get(),
        ) else {
            let _ = reply.send(Err(Fault::new(
                "invalid_params",
                "A stock command is a JSON object",
            )));
            return;
        };
        let text = |key: &str| {
            map.get(key)
                .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
        };
        let info = CommandInfo {
            ty: text("type").unwrap_or_default(),
            name: text("name"),
            session_path: text("sessionPath"),
        };
        if let Err(Waiter::Caller(_, reply)) =
            self.send_command(map, info, Waiter::Caller(seq, reply), timeout)
        {
            let _ = reply.send(Err(disconnected()));
        }
    }

    fn route_frame(&mut self, frame: Frame) {
        // Request bookkeeping no window reads leaves in main, before any copy of the frame is made.
        if let Some(held) = self.held.as_mut() {
            held.frames.push(frame);
            return;
        }
        let ty = frame.ty.clone().unwrap_or_default();
        if ty != "response" {
            match ty.as_str() {
                "message_end" => {
                    if let Ok(value) = serde_json::from_slice::<Value>(&frame.raw)
                        && let Some(message) = value.get("message")
                        && (message.is_object() || message.is_array())
                    {
                        self.run_messages.push(message.clone());
                    }
                }
                "agent_end" => {
                    let delivered = std::mem::take(&mut self.run_messages);
                    if self.running.is_some()
                        && let Ok(mut event) = serde_json::from_slice::<Value>(&frame.raw)
                        && let Some(terminal) = event.get("messages").and_then(Value::as_array)
                    {
                        // Stock's agent_end can omit part of the run it already streamed (messages.rs).
                        if let Some(completed) = complete_run_messages(&delivered, terminal) {
                            event["messages"] = Value::Array(completed);
                        }
                        self.hold_for_entry_ids(event);
                        return;
                    }
                }
                "session_info_update" => self.set_session(None),
                _ => {}
            }
        }
        self.dispatch_frame(frame);
    }

    /// Stock `agent_end` messages carry no `entryId`, which the renderer needs to reconcile committed messages. Let
    /// the bridge match persisted ids with stock persistence helpers, then release the event and everything behind it.
    fn hold_for_entry_ids(&mut self, event: Value) {
        self.held_counter += 1;
        let id = self.held_counter;
        let params = json!({ "messages": event.get("messages") });
        self.held = Some(Held {
            id,
            event,
            frames: Vec::new(),
        });
        let generation = self.generation;
        let Some(bridge) = self.running.as_ref().map(|running| running.bridge.clone()) else {
            return;
        };
        let (inbox, timeout) = (self.inbox.clone(), self.entry_id_timeout);
        tokio::spawn(async move {
            let params = RawValue::from_string(params.to_string()).ok();
            let answer = tokio::time::timeout(
                timeout,
                bridge.request("sessions.attach_entry_ids", params, None),
            )
            .await;
            let messages = match answer {
                Ok(Ok(Some(raw))) => serde_json::from_str::<Value>(raw.get())
                    .ok()
                    .and_then(|result| result.get("messages").filter(|m| m.is_array()).cloned()),
                _ => None,
            };
            let _ = inbox.send(Msg::EntryIds {
                id,
                generation,
                messages,
            });
        });
    }

    fn on_entry_ids(&mut self, id: u64, generation: u64, messages: Option<Value>) {
        if !self.is_live(generation) || self.held.as_ref().is_none_or(|held| held.id != id) {
            return;
        }
        let Some(held) = self.held.take() else {
            return;
        };
        let mut event = held.event;
        if let Some(messages) = messages {
            event["messages"] = messages;
        }
        self.dispatch_frame(value_frame(&event));
        for frame in held.frames {
            self.route_frame(frame);
        }
        self.release_barriers();
    }

    fn release_barriers(&mut self) {
        if self.held.is_none() {
            let barriers = std::mem::take(&mut self.barriers);
            for (seq, barrier) in barriers {
                self.answer_event(seq, None);
                let _ = barrier.send(());
            }
        }
    }

    /// Release a held `agent_end` and its tail unchanged (the spawn is going away).
    fn release_held(&mut self) {
        let Some(held) = self.held.take() else {
            return;
        };
        self.dispatch_frame(value_frame(&held.event));
        for frame in held.frames {
            if frame.ty.as_deref() != Some("ready") {
                self.dispatch_frame(frame);
            }
        }
        self.release_barriers();
    }

    fn dispatch_frame(&mut self, frame: Frame) {
        match frame.ty.as_deref() {
            Some("ready") => {
                if let Ok(ready) = serde_json::from_slice::<Value>(&frame.raw) {
                    self.handle_ready(&ready);
                }
                return;
            }
            // A response nobody waits for is a frame like any other.
            Some("response") if self.on_response(&frame) => return,
            _ => {}
        }
        self.emit_frame(frame);
    }

    /// Routes an omp response to its waiting command; false when nobody waits (it was never asked, timed out or its
    /// caller gave up).
    fn on_response(&mut self, frame: &Frame) -> bool {
        let text = frame.text();
        let Some((_, Some(id))) = head_of(&text) else {
            return false;
        };
        let Some(running) = self.running.as_mut() else {
            return false;
        };
        let Some(at) = running.pending.iter().position(|pending| pending.id == id) else {
            return false;
        };
        let expired = running.pending[at]
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline);
        let abandoned =
            matches!(&running.pending[at].waiter, Waiter::Caller(_, reply) if reply.is_closed());
        if expired || abandoned {
            running.pending.remove(at);
            return false;
        }
        let pending = running.pending.remove(at);
        self.observe(&pending.command, &text);
        match pending.waiter {
            Waiter::Caller(seq, reply) => {
                // The answer is an event, in the order omp wrote it among the frames; the request answers behind it.
                self.answer_event(seq, Some(text.into_owned().into_bytes()));
                let _ = reply.send(Ok(()));
            }
            Waiter::Negotiate(generation) => self.after_negotiate(generation, true),
            Waiter::Answered(generation) => self.after_answered(generation),
            Waiter::Ignore => {}
        }
        true
    }

    /// Track the session identity through the responses every hydrate already requests.
    // formal/tab-session `Observe`, `Switch(f)`, `NewSession` (findings F1, F2; CORRESPONDENCE A5).
    fn observe(&mut self, command: &CommandInfo, response: &str) {
        #[derive(Deserialize)]
        struct Response {
            success: Option<Value>,
            data: Option<Box<RawValue>>,
        }
        let Ok(response) = serde_json::from_str::<Response>(response) else {
            return;
        };
        if response.success != Some(Value::Bool(true)) {
            return;
        }
        let data = response
            .data
            .as_ref()
            .and_then(|data| serde_json::from_str::<Value>(data.get()).ok());
        if command.ty == "get_state" {
            let Some(data @ (Value::Object(_) | Value::Array(_))) = data else {
                return;
            };
            let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
            let next = Identity {
                session_id: text("sessionId"),
                session_file: text("sessionFile"),
                session_name: text("sessionName"),
            };
            // The tab is on that session now: every later spawn reopens it, or starts a new one while stock has not
            // written it (`session_open`). Only then is the tab no longer new: an omp that crashes after `ready` but
            // before this answer must not leave the next spawn to stock's autoResume (formal/tab-session F1).
            let file = next.session_file.clone();
            self.set_session(Some(next));
            if let Some(file) = file {
                self.set_tab_session(Some(file), false);
            }
        } else if SESSION_CHANGING_COMMANDS.contains(&command.ty.as_str()) {
            self.set_session(None);
            self.run_messages.clear();
            // Stock's answer names no file, and the next get_state may come after a crash: the tab is on the session it
            // asked for, or on a new one stock has not named yet (formal/tab-session F2). A fork, branch or handoff
            // keeps the session it came from until get_state names the copy (formal/tab-session CORRESPONDENCE A5).
            let cancelled = data
                .as_ref()
                .and_then(|data| data.get("cancelled"))
                .is_some_and(|cancelled| cancelled == &Value::Bool(true));
            if cancelled {
                return;
            }
            if command.ty == "switch_session"
                && let Some(path) = &command.session_path
            {
                self.set_tab_session(Some(path.clone()), false);
            } else if command.ty == "new_session" {
                self.set_tab_session(None, true);
            }
        } else if command.ty == "set_session_name"
            && let Some(name) = &command.name
        {
            // Stock's RPC rename answers without the `session_info_update` a rename inside omp sends. Every rename of
            // the live session ends here (the sidebar's, the title bar's, Autopilot's, a paired computer's), so this is
            // where the tab, its windows and a paired computer viewing it learn the name.
            let frame = json!({ "type": "session_info_update", "title": js_trim(name) });
            self.route_frame(value_frame(&frame));
        }
    }

    // ---- ready ----------------------------------------------------------------------------------------------------

    // formal/tab-session `Ready`: a new tab is no longer new only once `get_state` names its session, not here.
    fn handle_ready(&mut self, ready: &Value) {
        self.booted = true;
        let model_fallback = self.boot_model_fallback.take();
        self.no_model_boot = None;
        // Negotiation settles after this frame — and when the sidecar dies on boot, `cleanup` drops the pending
        // command on a generation that is already gone. Unguarded, that announced "ready" and zeroed the restart
        // counter, so a broken binary respawned forever behind a healthy UI. Stay on v1 when an older/malformed sidecar
        // omits the negotiation fields or advertises limits this decoder cannot safely honor.
        let generation = self.generation;
        let v2 = supports_v2(ready);
        // The extension listens before omp prints `ready`; connecting first means GUI-side commands can use the bridge
        // from the first renderer request.
        let connect = if self.bridge_enabled {
            self.running.as_ref().map(|running| running.bridge.clone())
        } else {
            None
        };
        self.ready = Some(ReadyProgress {
            generation,
            bridge_settled: connect.is_none(),
            negotiated: if v2 { None } else { Some(false) },
            announced: false,
            model_fallback,
        });
        if let Some(bridge) = connect {
            let inbox = self.inbox.clone();
            tokio::spawn(async move {
                let result = bridge.connect(CONNECT_TIMEOUT).await;
                let _ = inbox.send(Msg::BridgeConnected { generation, result });
            });
        }
        if v2 {
            let id = self.internal(
                json!({ "type": "negotiate_protocol", "protocolVersion": 2 }),
                Waiter::Negotiate(generation),
                Some(COMMAND_TIMEOUT),
            );
            if let Some(id) = id {
                let inbox = self.inbox.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(COMMAND_TIMEOUT).await;
                    let _ = inbox.send(Msg::NegotiateTimeout { generation, id });
                });
            }
        }
        self.try_announce();
    }

    fn after_negotiate(&mut self, generation: u64, answered: bool) {
        let Some(ready) = self.ready.as_mut() else {
            return;
        };
        if ready.generation != generation || ready.negotiated.is_some() {
            return;
        }
        ready.negotiated = Some(answered);
        if answered && self.is_live(generation) && self.running.is_some() {
            let events = self.event_filter.clone();
            self.internal(
                json!({ "type": "set_event_filter", "events": events }),
                Waiter::Ignore,
                Some(COMMAND_TIMEOUT),
            );
            // Opt into upstream's `ask` protocol — the GUI renders ask dialogs.
            self.internal(
                json!({ "type": "set_ask_dialog", "enabled": true }),
                Waiter::Ignore,
                Some(COMMAND_TIMEOUT),
            );
            // GUI-executed tools: main's launch answer named the set that is on. They go before `get_state`, the omp's
            // first answer, after which the tab reads ready.
            if let Some(tools) = self.host_tools.clone() {
                self.internal(
                    json!({ "type": "set_host_tools", "tools": tools }),
                    Waiter::Ignore,
                    Some(COMMAND_TIMEOUT),
                );
            }
        }
        self.try_announce();
    }

    fn on_negotiate_timeout(&mut self, generation: u64, id: &str) {
        let Some(running) = self.running.as_mut() else {
            return;
        };
        let Some(at) = running.pending.iter().position(|pending| pending.id == id) else {
            return;
        };
        if matches!(running.pending[at].waiter, Waiter::Negotiate(_)) {
            running.pending.remove(at);
            self.after_negotiate(generation, false);
        }
    }

    fn on_bridge_connected(&mut self, generation: u64, result: Result<(), String>) {
        if let Some(ready) = self
            .ready
            .as_mut()
            .filter(|ready| ready.generation == generation)
        {
            ready.bridge_settled = true;
        }
        match result {
            Ok(()) => {
                if self.is_live(generation) {
                    self.emit("sidecar.bridgeState", json!({ "connected": true }));
                }
            }
            Err(error) => {
                eprintln!("[sidecar] gui-bridge unavailable: {error}");
                if self.is_live(generation) {
                    self.emit(
                        "sidecar.bridgeState",
                        json!({ "connected": false, "error": error }),
                    );
                }
            }
        }
        self.try_announce();
    }

    /// Once the bridge settled and the protocol is negotiated, asks omp's first answer.
    fn try_announce(&mut self) {
        let Some(ready) = self.ready.as_mut() else {
            return;
        };
        if ready.announced || !ready.bridge_settled || ready.negotiated.is_none() {
            return;
        }
        ready.announced = true;
        let generation = ready.generation;
        if !self.is_live(generation) {
            return;
        }
        // The omp's first answer: `get_state`, the command a stalled omp never answered. Only an omp that answered
        // reads `ready`, and its place in the start queue goes to the next start. No deadline: a slow omp is waited for,
        // and its exit or a stop drops the request.
        self.internal(
            json!({ "type": "get_state" }),
            Waiter::Answered(generation),
            None,
        );
    }

    fn after_answered(&mut self, generation: u64) {
        if !self.is_live(generation) {
            return;
        }
        self.slow_epoch += 1;
        self.slow = false;
        if let Some(slot) = self.release_slot.take() {
            slot.release();
        }
        let model_fallback = self
            .ready
            .as_ref()
            .filter(|ready| ready.generation == generation)
            .and_then(|ready| ready.model_fallback.clone());
        let gate = std::mem::take(&mut self.start_gate);
        let connected = self
            .running
            .as_ref()
            .is_some_and(|running| running.bridge.connected());
        if gate && connected {
            let ask = self.ask(Ask::Gate {
                generation,
                model_fallback,
            });
            self.emit("sidecar.gateAsk", json!({ "ask": ask }));
            return;
        }
        self.finish_ready(model_fallback);
    }

    // formal/tab-session `GateMove`: the tab's session begins in the worktree, a new one.
    fn on_gated(&mut self, ask: u64, cwd: Option<String>) {
        let Some(Ask::Gate {
            generation,
            model_fallback,
        }) = self.answered(ask)
        else {
            return;
        };
        if self.disposed {
            return;
        }
        if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
            // The tab's session begins in `cwd`: a fresh one, never an autoResume.
            self.set_tab_session(self.session_path.clone(), true);
            self.restart(Some(cwd), None);
            return;
        }
        if !self.is_live(generation) {
            return;
        }
        self.finish_ready(model_fallback);
    }

    fn finish_ready(&mut self, model_fallback: Option<String>) {
        self.set_status(
            "ready",
            Detail {
                model_fallback,
                ..Detail::default()
            },
        );
        self.restart_count = 0;
    }

    // ---- stderr, exit, restart ------------------------------------------------------------------------------------

    fn on_stderr(&mut self, spawn_id: u64, text: &str) {
        // omp colors fatal lines; the tail feeds UI text and the boot-failure parsers.
        let stripped = strip_vt_control_characters(text);
        let text = js_trim(&stripped);
        if text.is_empty() {
            return;
        }
        if spawn_id == self.spawn_counter {
            for line in text.split('\n') {
                self.last_stderr.push(line.to_owned());
                if self.last_stderr.len() > STDERR_TAIL_LINES {
                    self.last_stderr.remove(0);
                }
            }
            // A slow start shows what omp is saying while the tab waits for it.
            if self.slow {
                self.show_slow();
            }
        }
        self.emit("sidecar.stderr", json!({ "text": text }));
    }

    // formal/tab-session `Crash`: a non-zero exit, then `attempt_restart` spawns again on the same state.
    fn on_child_exit(&mut self, spawn_id: u64, exit: Exit) {
        let Some(running) = self
            .running
            .as_ref()
            .filter(|running| running.spawn_id == spawn_id)
        else {
            return;
        };
        let (pid, mut drained) = (running.proc.pid, running.drained.clone());
        self.cleanup();
        self.emit("sidecar.exited", json!({ "pid": pid }));
        if self.disposed {
            return;
        }
        if exit.code == Some(0) {
            self.set_status("exited", Detail::message("Normal shutdown"));
            return;
        }
        if exit.code == Some(WINDOWS_SESSION_END_EXIT_CODE) {
            self.set_status(
                "exited",
                Detail {
                    message: Some("The Windows session ended".into()),
                    session_ended: true,
                    ..Detail::default()
                },
            );
            return;
        }
        // `exit` can fire before stderr has drained, and the boot-failure parsers read it; a restart() meanwhile
        // advances the generation.
        let (generation, inbox, wait) = (self.generation, self.inbox.clone(), self.stderr_drain);
        let reason = exit_reason(&exit);
        tokio::spawn(async move {
            let _ = tokio::time::timeout(wait, drained.wait_for(|drained| *drained)).await;
            let _ = inbox.send(Msg::Drained { generation, reason });
        });
    }

    /// A spawn that died before `ready` because its saved session model could not be restored would fail identically on
    /// every retry (main reads the stderr): one `--model @default` respawn outside the crash budget. Stock omp exits
    /// before `ready` when no model has credentials, and would on every retry: one respawn with an explicit catalog
    /// model outside the crash budget. A spawn that already carried it falls through to the crash-loop path.
    fn on_drained(&mut self, generation: u64, reason: String) {
        if !self.is_live(generation) {
            return;
        }
        if self.booted || (self.boot_model_fallback.is_some() && self.no_model_boot.is_some()) {
            self.attempt_restart(&reason);
            return;
        }
        let stderr = self.last_stderr.join("\n");
        let ask = self.ask(Ask::Exit { generation, reason });
        self.emit(
            "sidecar.exit",
            json!({
                "ask": ask,
                "stderr": stderr,
                "booted": self.booted,
                "fallbackArmed": self.boot_model_fallback.is_some(),
                "noModelArmed": self.no_model_boot.is_some(),
            }),
        );
    }

    fn on_exit_plan(&mut self, ask: u64, plan: Plan) {
        let Some(Ask::Exit { generation, reason }) = self.answered(ask) else {
            return;
        };
        if !self.is_live(generation) {
            return;
        }
        match plan {
            Plan::Fallback { fallback } if !self.booted && self.boot_model_fallback.is_none() => {
                eprintln!(
                    "[sidecar] session model {fallback} unavailable at boot — resuming on the default model"
                );
                self.boot_model_fallback = Some(fallback);
                self.spawn();
            }
            Plan::BootModel { boot_model } if !self.booted && self.no_model_boot.is_none() => {
                eprintln!(
                    "[sidecar] omp has no usable model — booting on {boot_model} so onboarding can connect one"
                );
                self.no_model_boot = Some(boot_model);
                self.spawn();
            }
            // Main could not resolve a model: the tab stays as it is (the TypeScript left it there too).
            Plan::Word(word) if word == "none" => {}
            _ => self.attempt_restart(&reason),
        }
    }

    // formal/tab-session `Crash`: the restart timer calls `spawn` on the same session state.
    fn attempt_restart(&mut self, reason: &str) {
        // The exit code alone is never the diagnosis; the spawn's stderr carries it.
        let excerpt = stderr_excerpt(&self.last_stderr);
        let detail = if excerpt.is_empty() {
            reason.to_owned()
        } else {
            format!("{reason} — {excerpt}")
        };
        let exhausted = self.restart_count >= MAX_RESTART_ATTEMPTS;
        let attempt = if exhausted {
            MAX_RESTART_ATTEMPTS
        } else {
            self.restart_count + 1
        };
        self.emit(
            "sidecar.failure",
            json!({ "report": {
                "reason": detail, "attempt": attempt, "maxAttempts": MAX_RESTART_ATTEMPTS,
                "stderr": self.last_stderr, "cwd": self.cwd,
            } }),
        );
        let progress = Some((attempt, MAX_RESTART_ATTEMPTS));
        if exhausted {
            self.set_status(
                "error",
                Detail {
                    message: Some(detail),
                    restart: progress,
                    ..Detail::default()
                },
            );
            return;
        }
        let delay = self.tuning.restart_delays_ms.as_ref().map_or_else(
            || restart_delay(attempt),
            |delays| {
                let at = (attempt as usize).saturating_sub(1);
                Duration::from_millis(delays.get(at).or(delays.last()).copied().unwrap_or(4000))
            },
        );
        self.restart_count = attempt;
        self.set_status(
            "restarting",
            Detail {
                message: Some(detail),
                restart: progress,
                ..Detail::default()
            },
        );
        self.restart_epoch += 1;
        let (epoch, inbox) = (self.restart_epoch, self.inbox.clone());
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = inbox.send(Msg::RestartTimer { epoch });
        });
    }

    // ---- slow ---------------------------------------------------------------------------------------------------

    /// The started omp has not answered after `start_slow` (8 Nov 2026: a relaunch's omps went silent after their model
    /// discovery; 9 Nov 2026: every new omp of a MacBook stayed silent past 45 s, its stderr empty). It keeps running and
    /// is waited for: its place in the start queue goes to the next tab, and the tab reads `starting` with `slow` and the
    /// omp's stderr tail, or its own log's when stderr is empty, until it answers (`ready`), exits (the crash path) or
    /// the person restarts it. The log line also says whether omp printed `ready` and which commands it holds.
    fn start_is_slow(&mut self, generation: u64) {
        self.slow_epoch += 1;
        if let Some(slot) = self.release_slot.take() {
            slot.release();
        }
        self.slow = true;
        let pid = self.running.as_ref().and_then(|running| running.proc.pid);
        match pid {
            Some(pid) => {
                let ask = self.ask(Ask::Slow { generation });
                self.emit(
                    "sidecar.slow",
                    json!({ "ask": ask, "pid": pid, "spawnedAt": self.spawned_at_ms }),
                );
            }
            None => self.slow_report(generation, Vec::new()),
        }
    }

    fn on_slow_log(&mut self, ask: u64, lines: Vec<String>) {
        if let Some(Ask::Slow { generation }) = self.answered(ask) {
            self.slow_report(generation, lines);
        }
    }

    fn slow_report(&mut self, generation: u64, lines: Vec<String>) {
        if !self.is_live(generation) || !self.slow {
            return;
        }
        self.slow_log = lines.clone();
        let unanswered = self.unanswered();
        self.emit(
            "sidecar.slowReport",
            json!({ "report": {
                "waitedMs": self.start_slow.as_millis() as u64, "stderr": self.last_stderr, "ompLog": lines,
                "ready": self.booted, "unanswered": unanswered, "cwd": self.cwd,
            } }),
        );
        self.show_slow();
    }

    fn show_slow(&mut self) {
        let joined = self.last_stderr.join("\n");
        let mut tail = js_trim(&joined).to_owned();
        if tail.is_empty() {
            tail = self.slow_log.join("\n");
        }
        self.set_status(
            "starting",
            Detail {
                slow: true,
                message: (!tail.is_empty()).then_some(tail),
                ..Detail::default()
            },
        );
    }

    /// The types of the stock commands omp has not answered yet, oldest first (a timed-out one is no longer asked).
    fn unanswered(&self) -> Vec<String> {
        let now = Instant::now();
        self.running.as_ref().map_or_else(Vec::new, |running| {
            running
                .pending
                .iter()
                .filter(|pending| pending.deadline.is_none_or(|deadline| now < deadline))
                .map(|pending| pending.command.ty.clone())
                .collect()
        })
    }

    // ---- stopping -------------------------------------------------------------------------------------------------

    /// Tears the spawn cycle down. Any async continuation of the current cycle (pending negotiation) is stale from here
    /// on, even before the replacement spawns. Returns the omp that was running, for its stop.
    fn cleanup(&mut self) -> Option<Running> {
        // Main drops what the lane sent before the command that tears this down: nothing after leans on it.
        self.stream.reset();
        self.generation += 1;
        self.slow_epoch += 1;
        self.slow = false;
        if let Some(slot) = self.release_slot.take() {
            slot.release();
        }
        self.ready = None;
        self.release_held();
        self.run_messages.clear();
        let mut running = self.running.take();
        if let Some(running) = running.as_mut() {
            for pending in running.pending.drain(..) {
                if let Waiter::Caller(_, reply) = pending.waiter {
                    let _ = reply.send(Err(disconnected()));
                }
            }
            running.bridge.close();
            if let Some(address) = running.bridge_address.take() {
                remove_address(&address);
            }
        }
        running
    }

    /// Stops the omp (`stopOmp`): the next spawn of this tab waits for its exit.
    fn stop_proc(&mut self, proc: &Arc<Proc>, stdin_grace: Duration) {
        let done = proc.stop(stdin_grace);
        self.exiting.push(Stopping {
            done,
            exited: proc.exited.clone(),
        });
    }

    fn stop_child(&mut self, stdin_grace: Option<Duration>) {
        self.restart_epoch += 1;
        if let Some(running) = self.cleanup() {
            self.stop_proc(&running.proc, stdin_grace.unwrap_or(Duration::ZERO));
        }
    }

    /// Stop the tab's omp and start it again: in `cwd` when given (a session there, `resume_session_path` or a new
    /// one), else on `resume_session_path` or the session the tab is on.
    // formal/tab-session `Restart`, `Open(f)`, `Move`: synchronous in the lane: kill, state, start.
    fn restart(&mut self, cwd: Option<String>, resume_session_path: Option<String>) {
        self.stop_child(None);
        let cwd = cwd.filter(|cwd| !cwd.is_empty());
        let moved = cwd.is_some();
        if let Some(cwd) = cwd {
            self.cwd = cwd;
        }
        let path = resume_session_path.or_else(|| {
            if moved {
                None
            } else {
                self.session_path.clone()
            }
        });
        self.set_tab_session(path, self.is_new);
        self.boot_model_fallback = None;
        self.no_model_boot = None;
        self.restart_count = 0;
        self.start();
    }

    /// Stop the omp of an idle tab and read `asleep`, as a restored tab reads before its first start: the pool restarts
    /// it on its session file when it is shown or messaged (`idle-release.ts`). The omp stops as a restart stops it.
    fn sleep(&mut self) {
        if self.disposed || self.running.is_none() {
            return;
        }
        self.stop_child(None);
        self.restart_count = 0;
        self.set_status("asleep", Detail::default());
    }

    // formal/session-processes `Close`: the tab's tag ends only after the omps it stopped have exited.
    fn dispose(&mut self, stdin_grace: Duration) {
        self.disposed = true;
        // Stock omp emits `session_shutdown` (ai-memory's `session-end` hook, which makes the handoff) only when its stdin
        // ends; SIGTERM kills it before. With a grace period its stdin closes first.
        self.stop_child(Some(stdin_grace));
        self.quiet = true;
        self.when_all_exited();
    }

    /// What the tab's omps started ends once they have exited, so an omp's own cleanup of its tools comes first: main
    /// closes the tag on `sidecar.disposed`.
    fn when_all_exited(&mut self) {
        self.prune_exiting();
        let exits: Vec<_> = self
            .exiting
            .iter()
            .map(|stopping| stopping.done.clone())
            .collect();
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            wait_all(exits).await;
            let _ = inbox.send(Msg::AllExited);
        });
    }

    fn on_all_exited(&mut self) -> bool {
        if !self.disposed {
            return false;
        }
        self.emit_always("sidecar.disposed", json!({}));
        true
    }

    /// The quit (`sidecar.stopAll`) or the core's own end (`end`): every omp of the tab is stopped as a stop stops it,
    /// and the tab starts nothing again.
    fn stop_all(&mut self, end: bool) -> Stopped {
        self.quit = true;
        self.restart_epoch += 1;
        self.prune_exiting();
        let mut told = u32::try_from(
            self.exiting
                .iter()
                .filter(|stopping| !*stopping.exited.borrow())
                .count(),
        )
        .unwrap_or(u32::MAX);
        if let Some(running) = self.cleanup() {
            if running.proc.running() {
                told += 1;
            }
            self.stop_proc(&running.proc, Duration::ZERO);
        }
        if end {
            self.disposed = true;
            self.quiet = true;
            self.when_all_exited();
        }
        self.prune_exiting();
        Stopped {
            told,
            done: self
                .exiting
                .iter()
                .map(|stopping| stopping.done.clone())
                .collect(),
        }
    }
}

/// A frame made from a JSON value.
fn value_frame(value: &Value) -> Frame {
    Frame {
        raw: serde_json::to_vec(value).unwrap_or_default(),
        ty: value.get("type").and_then(Value::as_str).map(str::to_owned),
    }
}

/// Resolves once every exit has come (or its sender is gone).
pub async fn wait_all(exits: Vec<watch::Receiver<bool>>) {
    for mut exit in exits {
        let _ = exit.wait_for(|done| *done).await;
    }
}
