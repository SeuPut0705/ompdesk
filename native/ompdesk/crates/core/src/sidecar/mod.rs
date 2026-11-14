//! omp's pipes and the tab's omp (was `src/main/sidecar.ts`'s `SidecarManager` state machine, `rpc-client.ts`'s
//! correlation, `rpc-bridge.ts`, `bridge-client.ts`'s socket client, `omp-stop.ts`, `omp-start-queue.ts`,
//! `run-messages.ts` and `omp-launch.ts`'s `sessionOpen`). Main keeps `SidecarManager` as the client and a mirror of
//! the lane's state (`docs/rust-remaining-units.md` §2.4, units 9b and 9c; the wire is `local://h1-contract.md`, with the
//! additions the report lists).
//!
//! One lane task per tab (`lane.rs`) owns the tab's whole state. Every request main makes about a tab carries a `seq`
//! (1, 2, 3 … in call order, from the one `sidecar.open` names): requests run concurrently in the core, so one that
//! arrives early waits here for the ones before it, and the lane applies them in order. Every event the lane sends
//! names the highest `seq` it had applied (`cmd`), so main can tell which state an event describes. The answers to the
//! lane's asks (`sidecar.resolved`, `sidecar.launched`, `sidecar.exitPlan`, `sidecar.gated`, `sidecar.slowLog`,
//! `sidecar.sessionFreed`) name the ask and carry no `seq`; one for an ask the lane has dropped is ignored.
//!
//! A tab that is gone (disposed and every omp it started exited) is remembered by its id, so a late request about it is
//! answered the way a tab with no omp answers.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot};

use crate::server::{Answer, Call, Events, Fault, Registry, Reply};

pub mod bridge;
mod frames;
mod lane;
mod launch;
mod messages;
mod process;
mod queue;
mod stop;
mod stream;
#[cfg(test)]
mod tests;

use lane::{Command, Msg, OpenParams, Plan, StockReply};
use process::Start;

/// How long a request about a tab whose `sidecar.open` has not come waits for it.
const OPEN_WAIT: Duration = Duration::from_secs(10);
/// How long the core's own end waits for the omps it stopped: main kills a core that has not exited 5 s after its stdin
/// closed.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

pub fn register(registry: &mut Registry) {
    registry.add("sidecar.open", open);
    registry.add("sidecar.start", |call| plain(call, |_: Seq| Command::Start));
    registry.add("sidecar.restart", |call| {
        plain(call, |params: RestartParams| Command::Restart {
            cwd: params.cwd,
            resume_session_path: params.resume_session_path,
        })
    });
    registry.add("sidecar.kill", |call| plain(call, |_: Seq| Command::Kill));
    registry.add("sidecar.sleep", |call| plain(call, |_: Seq| Command::Sleep));
    registry.add("sidecar.dispose", |call| {
        plain(call, |params: DisposeParams| Command::Dispose {
            stdin_grace: Duration::from_millis(params.stdin_grace_ms.unwrap_or(0)),
        })
    });
    registry.add("sidecar.cwd", |call| {
        plain(call, |params: CwdParams| Command::Cwd(params.cwd))
    });
    registry.add("sidecar.gate", |call| plain(call, |_: Seq| Command::Gate));
    registry.add("sidecar.send", |call| {
        plain(call, |params: SendParams| Command::Send(params.frame))
    });
    registry.add("sidecar.command", command);
    registry.add("sidecar.bridge", bridge_request);
    registry.add("sidecar.barrier", |call| waited(call, Command::Barrier));
    registry.add("sidecar.whenExited", |call| {
        waited(call, |_, reply| Command::WhenExited(reply))
    });
    registry.add("sidecar.resolved", resolved);
    registry.add("sidecar.launched", launched);
    registry.add("sidecar.exitPlan", exit_plan);
    registry.add("sidecar.gated", gated);
    registry.add("sidecar.slowLog", slow_log);
    registry.add("sidecar.sessionFreed", session_freed);
    registry.add("sidecar.holdStarts", hold_starts);
    registry.add("sidecar.stopAll", stop_all);
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Serialize)]
struct Done {}

fn done() -> Answer {
    Box::pin(async { Reply::json(&Done {}) })
}

fn failed(fault: Fault) -> Answer {
    Box::pin(async move { Err(fault) })
}

// ---- in-core subscribers ------------------------------------------------------------------------------------------

/// An event a lane sent main (`sidecar.status`, `sidecar.frame` with the frame as `bin`, as `stream.rs` slimmed it,
/// …), as an in-core subscriber gets it: the same name, data and bytes, in the order main gets them.
#[derive(Clone, Debug)]
pub struct LaneEvent {
    pub name: String,
    pub data: Value,
    pub bin: Option<std::sync::Arc<[u8]>>,
}

/// How many subscriptions are open: with none, a lane's events cost nothing more.
static TAPPED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static TAPS: LazyLock<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<LaneEvent>>>>> =
    LazyLock::new(Default::default);

/// Every event tab `tab`'s lane sends main from now on, beside main (code in the core that serves the tab too: a
/// paired device's link, `docs/rust-remaining-units.md` R6). The receiver ends when the lane is over.
pub fn subscribe(tab: &str) -> mpsc::UnboundedReceiver<LaneEvent> {
    let (sender, receiver) = mpsc::unbounded_channel();
    locked(&TAPS)
        .entry(tab.to_owned())
        .or_default()
        .push(sender);
    TAPPED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    receiver
}

/// Hands a lane's event to the tab's subscribers (`lane.rs` calls it beside every send to main).
pub(crate) fn tap(tab: &str, name: &str, data: &Value, bin: Option<&[u8]>) {
    if TAPPED.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        return;
    }
    let mut taps = locked(&TAPS);
    let Some(senders) = taps.get_mut(tab) else {
        return;
    };
    let event = LaneEvent {
        name: name.to_owned(),
        data: data.clone(),
        bin: bin.map(std::sync::Arc::from),
    };
    let before = senders.len();
    senders.retain(|sender| sender.send(event.clone()).is_ok());
    TAPPED.fetch_sub(before - senders.len(), std::sync::atomic::Ordering::SeqCst);
}

/// The lane of `tab` is over: its subscribers' receivers end.
pub(crate) fn untap(tab: &str) {
    if let Some(senders) = locked(&TAPS).remove(tab) {
        TAPPED.fetch_sub(senders.len(), std::sync::atomic::Ordering::SeqCst);
    }
}

// ---- the table of tabs --------------------------------------------------------------------------------------------

#[derive(Default)]
struct Tab {
    /// The `seq` the lane applies next; none until `sidecar.open` came.
    next: Option<u64>,
    /// Requests that arrived before their turn.
    buffer: BTreeMap<u64, Command>,
    inbox: Option<mpsc::UnboundedSender<Msg>>,
    /// The output of the call that opened the lane: what tells whose lane it is when a connection ends.
    events: Option<Events>,
}

#[derive(Default)]
struct Tabs {
    live: HashMap<String, Tab>,
    closed: HashSet<String>,
}

static TABS: LazyLock<Mutex<Tabs>> = LazyLock::new(Default::default);

impl Tab {
    /// Hands the lane every request whose turn has come.
    fn drain(&mut self) {
        let (Some(inbox), Some(mut next)) = (self.inbox.as_ref(), self.next) else {
            return;
        };
        while let Some(command) = self.buffer.remove(&next) {
            let _ = inbox.send(Msg::Seq(next, command));
            next += 1;
        }
        self.next = Some(next);
    }
}

/// A request about `tab`, in its place in the tab's order.
fn deliver(tab: &str, seq: u64, command: Command) {
    let mut tabs = locked(&TABS);
    if tabs.closed.contains(tab) {
        drop(tabs);
        command.refuse();
        return;
    }
    let fresh = !tabs.live.contains_key(tab);
    let entry = tabs.live.entry(tab.to_owned()).or_default();
    entry.buffer.insert(seq, command);
    entry.drain();
    drop(tabs);
    if fresh {
        // A request whose `sidecar.open` never comes (the lane was never made) must not wait for ever.
        let tab = tab.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(OPEN_WAIT).await;
            let gone = {
                let mut tabs = locked(&TABS);
                match tabs.live.get(&tab) {
                    Some(entry) if entry.inbox.is_none() => tabs.live.remove(&tab),
                    _ => None,
                }
            };
            for (_, command) in gone.into_iter().flat_map(|entry| entry.buffer) {
                command.refuse();
            }
        });
    }
}

/// The lane of `tab` is over: its id is remembered, and what is left of its table entry is refused.
fn finish(tab: &str) {
    let gone = {
        let mut tabs = locked(&TABS);
        tabs.closed.insert(tab.to_owned());
        tabs.live.remove(tab)
    };
    for (_, command) in gone.into_iter().flat_map(|entry| entry.buffer) {
        command.refuse();
    }
}

fn inbox_of(tab: &str) -> Option<mpsc::UnboundedSender<Msg>> {
    locked(&TABS)
        .live
        .get(tab)
        .and_then(|entry| entry.inbox.clone())
}

fn tell(tab: &str, message: Msg) {
    if let Some(inbox) = inbox_of(tab) {
        let _ = inbox.send(message);
    }
}

// ---- requests about a tab -----------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Seq {
    tab: String,
    seq: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestartParams {
    tab: String,
    seq: u64,
    cwd: Option<String>,
    resume_session_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisposeParams {
    tab: String,
    seq: u64,
    stdin_grace_ms: Option<u64>,
}

#[derive(Deserialize)]
struct CwdParams {
    tab: String,
    seq: u64,
    cwd: String,
}

#[derive(Deserialize)]
struct SendParams {
    tab: String,
    seq: u64,
    frame: Box<RawValue>,
}

trait Sequenced {
    fn place(&self) -> (&str, u64);
}

macro_rules! sequenced {
    ($($params:ty),*) => {$(
        impl Sequenced for $params {
            fn place(&self) -> (&str, u64) {
                (&self.tab, self.seq)
            }
        }
    )*};
}
sequenced!(Seq, RestartParams, DisposeParams, CwdParams, SendParams);

/// A request that is applied in its turn and answers `{}`.
fn plain<P: Sequenced + serde::de::DeserializeOwned>(
    call: Call,
    build: impl FnOnce(P) -> Command,
) -> Answer {
    let params: P = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let (tab, seq) = params.place();
    let (tab, seq) = (tab.to_owned(), seq);
    deliver(&tab, seq, build(params));
    done()
}

/// A request answered once the lane says so (`barrier`, `whenExited`).
fn waited(call: Call, build: impl FnOnce(u64, oneshot::Sender<()>) -> Command) -> Answer {
    let params: Seq = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let (reply, answer) = oneshot::channel();
    deliver(&params.tab, params.seq, build(params.seq, reply));
    Box::pin(async move {
        // A lane that ended without answering has nothing left to wait for.
        let _ = answer.await;
        Reply::json(&Done {})
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandParams {
    tab: String,
    seq: u64,
    command: Box<RawValue>,
    timeout_ms: Option<u64>,
}

/// A stock command: omp's correlated response, after every frame it sent before it went out as an event.
fn command(call: Call) -> Answer {
    let params: CommandParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let (reply, answer): (StockReply, _) = oneshot::channel();
    deliver(
        &params.tab,
        params.seq,
        Command::Stock {
            seq: params.seq,
            command: params.command,
            timeout: params.timeout_ms.map(Duration::from_millis),
            reply,
        },
    );
    let scope = call.scope;
    Box::pin(async move {
        // Main's own timeout cancels the call: the lane forgets the command, and omp's late answer is a frame.
        tokio::select! {
            answer = answer => match answer {
                Ok(Ok(())) => Reply::json(&Done {}),
                Ok(Err(fault)) => Err(fault),
                Err(_) => Err(Fault::new("sidecar_disconnected", "Sidecar disconnected")),
            },
            () = scope.on_cancel() => Err(Fault::cancelled()),
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeParams {
    tab: String,
    seq: u64,
    method: String,
    #[serde(default, deserialize_with = "keep_null")]
    params: Option<Box<RawValue>>,
    timeout_ms: Option<u64>,
}

/// A field that is present holds a value even when it is `null`: `{"params": null}` is not an absent `params`.
fn keep_null<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Box<RawValue>>, D::Error> {
    Box::<RawValue>::deserialize(deserializer).map(Some)
}

#[derive(Serialize)]
struct BridgeAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Box<RawValue>>,
}

/// A request to this spawn's bridge.
fn bridge_request(call: Call) -> Answer {
    let params: BridgeParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let (reply, answer) = oneshot::channel();
    deliver(
        &params.tab,
        params.seq,
        Command::Bridge {
            method: params.method,
            params: params.params,
            timeout: params.timeout_ms.map(Duration::from_millis),
            reply,
        },
    );
    let scope = call.scope;
    Box::pin(async move {
        tokio::select! {
            answer = answer => match answer {
                Ok(Ok(result)) => Reply::json(&BridgeAnswer { result }),
                Ok(Err(fault)) => Err(fault),
                Err(_) => Err(Fault::new("bridge_disconnected", "gui-bridge not connected")),
            },
            () = scope.on_cancel() => Err(Fault::cancelled()),
        }
    })
}

/// Makes the tab's lane. Answers only once the tab is disposed and every omp it started has exited, so main learns of
/// a lost core by this request's rejection.
fn open(call: Call) -> Answer {
    let params: OpenParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let answer = match open_native(params, call.events) {
        Ok(answer) => answer,
        Err(fault) => return failed(fault),
    };
    Box::pin(async move {
        match answer.await {
            Ok(Ok(())) | Err(_) => Reply::json(&Done {}),
            Ok(Err(fault)) => Err(fault),
        }
    })
}

/// The same lane setup for native application callers, without a Registry request or a second lane engine.
pub(crate) fn open_native(
    params: OpenParams,
    events: Events,
) -> Result<oneshot::Receiver<Result<(), Fault>>, Fault> {
    let (reply, answer) = oneshot::channel();
    {
        let mut tabs = locked(&TABS);
        if tabs.closed.contains(&params.tab) {
            return Err(Fault::new("tab_closed", "The tab was disposed"));
        }
        let (tab, seq) = (params.tab.clone(), params.seq);
        let entry = tabs.live.entry(tab).or_default();
        if entry.inbox.is_some() {
            return Err(Fault::new("tab_open", "The tab already has a lane"));
        }
        // A request the previous numbering left behind is stale.
        entry.buffer.retain(|at, _| *at > seq);
        entry.inbox = Some(lane::Lane::open(params, events.clone(), reply));
        entry.events = Some(events);
        entry.next = Some(seq + 1);
        entry.drain();
    }
    Ok(answer)
}

// ---- the answers to the lane's asks -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct ResolvedParams {
    tab: String,
    ask: u64,
    outcome: String,
    message: Option<String>,
}

fn resolved(call: Call) -> Answer {
    match call.params::<ResolvedParams>() {
        Ok(p) => {
            tell(
                &p.tab,
                Msg::Resolved {
                    ask: p.ask,
                    outcome: p.outcome,
                    message: p.message,
                },
            );
            done()
        }
        Err(fault) => failed(fault),
    }
}

#[derive(Deserialize)]
struct LaunchedParams {
    tab: String,
    ask: u64,
    start: Option<Start>,
    #[serde(rename = "hostTools")]
    host_tools: Option<serde_json::Value>,
    error: Option<String>,
}

fn launched(call: Call) -> Answer {
    match call.params::<LaunchedParams>() {
        Ok(p) => {
            tell(
                &p.tab,
                Msg::Launched {
                    ask: p.ask,
                    start: p.start,
                    host_tools: p.host_tools,
                    error: p.error,
                },
            );
            done()
        }
        Err(fault) => failed(fault),
    }
}

#[derive(Deserialize)]
struct PlanParams {
    tab: String,
    ask: u64,
    plan: Plan,
}

fn exit_plan(call: Call) -> Answer {
    match call.params::<PlanParams>() {
        Ok(p) => {
            tell(
                &p.tab,
                Msg::ExitPlan {
                    ask: p.ask,
                    plan: p.plan,
                },
            );
            done()
        }
        Err(fault) => failed(fault),
    }
}

#[derive(Deserialize)]
struct GatedParams {
    tab: String,
    ask: u64,
    cwd: Option<String>,
}

fn gated(call: Call) -> Answer {
    match call.params::<GatedParams>() {
        Ok(p) => {
            tell(
                &p.tab,
                Msg::Gated {
                    ask: p.ask,
                    cwd: p.cwd,
                },
            );
            done()
        }
        Err(fault) => failed(fault),
    }
}

#[derive(Deserialize)]
struct SlowLogParams {
    tab: String,
    ask: u64,
    #[serde(default)]
    lines: Vec<String>,
}

fn slow_log(call: Call) -> Answer {
    match call.params::<SlowLogParams>() {
        Ok(p) => {
            tell(
                &p.tab,
                Msg::SlowLog {
                    ask: p.ask,
                    lines: p.lines,
                },
            );
            done()
        }
        Err(fault) => failed(fault),
    }
}

#[derive(Deserialize)]
struct FreedParams {
    tab: String,
    ask: u64,
    outcome: String,
}

fn session_freed(call: Call) -> Answer {
    match call.params::<FreedParams>() {
        Ok(p) => {
            tell(
                &p.tab,
                Msg::SessionFreed {
                    ask: p.ask,
                    free: p.outcome == "free",
                },
            );
            done()
        }
        Err(fault) => failed(fault),
    }
}

// ---- the app's ----------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct HoldParams {
    hold: bool,
}

/// `hold: true` keeps every start back (the launch's reap of leftover omps is running); `false` lets them go.
fn hold_starts(call: Call) -> Answer {
    match call.params::<HoldParams>() {
        Ok(p) => {
            if p.hold {
                queue::queue().hold();
            } else {
                queue::queue().release_hold();
            }
            done()
        }
        Err(fault) => failed(fault),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopAllParams {
    bound_ms: u64,
}

#[derive(Serialize)]
struct Told {
    told: u32,
}

/// Asks every lane named by `chosen` to stop its omps, and waits for their exits, at most `bound`. How many omps were
/// told to stop.
async fn stop_lanes(
    chosen: impl Fn(&Tab) -> bool,
    message: impl Fn(oneshot::Sender<lane::Stopped>) -> Msg,
    bound: Duration,
) -> u32 {
    let inboxes: Vec<_> = locked(&TABS)
        .live
        .values()
        .filter(|tab| chosen(tab))
        .filter_map(|tab| tab.inbox.clone())
        .collect();
    let mut told = 0;
    let mut exits = Vec::new();
    for inbox in inboxes {
        let (reply, answer) = oneshot::channel();
        if inbox.send(message(reply)).is_err() {
            continue;
        }
        if let Ok(stopped) = answer.await {
            told += stopped.told;
            exits.extend(stopped.done);
        }
    }
    let _ = tokio::time::timeout(bound, lane::wait_all(exits)).await;
    told
}

/// The quit: every lane's omp is stopped as a stop stops it, bounded as `OmpProcesses.stopAll` was.
fn stop_all(call: Call) -> Answer {
    let params: StopAllParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    Box::pin(async move {
        let told = stop_lanes(
            |_| true,
            Msg::StopAll,
            Duration::from_millis(params.bound_ms),
        )
        .await;
        Reply::json(&Told { told })
    })
}

/// Ends every lane whose opening call came over the output `events` writes to (or over one that is gone): the
/// connection ended, and what waited on its omps has nobody to answer. The omps end with the core's pipes besides.
pub async fn close_all(events: &Events) {
    stop_lanes(
        |tab| {
            tab.events
                .as_ref()
                .is_some_and(|own| !own.reaches_another(events))
        },
        Msg::Shutdown,
        CLOSE_WAIT,
    )
    .await;
}
