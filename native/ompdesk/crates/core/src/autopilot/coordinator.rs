//! The existing coordinator and its native host effects. `Service` admits native callers; the legacy wire remains a
//! process-parity entry. The run's state transitions are in `start.rs` and `cycle.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use ompdesk_app_contract::Owner;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use super::audit::{self, Snapshot};
use super::run::{ChildRun, Run, RunState, Settings, Stall};
use super::ship::{Fut, Hooks, PrInput, QueueItem, ShipRunner};
use super::steps::{Ended, Stalled, Steps};
use super::util::{Oops, R, flag, text};
use super::{MainPort, Tuning, git_from, now_ms};
use crate::git::run::Git;
use crate::ports::Port;
use crate::server::{Answer, Call, Fault, Registry, Reply};

/// What the bridge and the page define and this side reads, handed in as data once (the bridge's contracts are shared with
/// the page and the bridge, so there is one definition).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contracts {
    pub bridge: Bridge,
    pub objective: String,
    pub guide_file: String,
    pub guide_commit_max_bytes: usize,
    pub child_tag: String,
    pub default_ship_policy: Value,
    pub no_limits: Value,
    /// `shipPolicyForPreset` of each preset (`local`, `push`, `release`) for the default remote.
    pub presets: HashMap<String, Value>,
}

/// `AUTOPILOT_BRIDGE_METHODS`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bridge {
    pub arm: String,
    pub approval: String,
    pub status: String,
    pub configure: String,
    pub note: String,
    pub dismiss: String,
    pub set_state: String,
    pub ship_action: String,
    pub mark_reverted: String,
    pub take_ship_requests: String,
    pub cycle_amend: String,
    pub disarm: String,
    pub guide: String,
}

/// What main's pool says of a tab (`SidecarPool.tabFacts`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub awaiting_connection: bool,
    #[serde(default)]
    pub retrying: bool,
    #[serde(default)]
    pub scheduled_retry: bool,
}

/// What main says of a tab's omp (`SidecarPool.sidecarOf`).
#[derive(Debug, Clone, Deserialize)]
pub struct SidecarFacts {
    pub cwd: String,
    pub status: String,
    #[serde(default)]
    pub device: bool,
}

pub enum Msg {
    Frame {
        tab: String,
        frame: Value,
    },
    Status {
        tab: String,
        status: Value,
    },
    Ready {
        tab: String,
    },
    Released {
        tab: String,
    },
    Activity {
        tab: String,
        kind: String,
    },
    Aborted {
        tab: String,
        reply: oneshot::Sender<Value>,
    },
    ResumeSettled {
        tab: String,
        outcome: String,
    },
    Command {
        params: CommandParams,
        reply: oneshot::Sender<Value>,
    },
    ResumeGoal {
        tab: String,
        reply: oneshot::Sender<Value>,
    },
    BeforeFirstPrompt {
        child: Value,
        reply: oneshot::Sender<Value>,
    },
    Idle {
        reply: oneshot::Sender<Value>,
    },
    Close {
        reply: oneshot::Sender<Value>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandParams {
    pub call: u64,
    pub tab: String,
    pub command: Value,
    pub source: Source,
    pub today: String,
    /// Main's clock when it took the command: what the person chose is dated by it, as the TypeScript dated it,
    /// because a cycle's `startedAt` it is compared with comes from main's world too, and the core's clock is
    /// another process's (on Windows a tick apart).
    #[serde(default)]
    pub now: Option<i64>,
    /// Created by native admission only. Page/legacy JSON cannot construct a caller.
    #[serde(skip)]
    pub native_owner: Option<Owner>,
}

/// The tab a command came from (`sidecar.device`, `sidecar.cwd`).
#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub device: bool,
    pub cwd: String,
}

pub struct Coordinator {
    pub port: MainPort,
    pub tuning: Tuning,
    pub contracts: Contracts,
    /// Main brings its own `probeRepo` (a parity suite's stand-in): ask it instead of looking at the folder.
    pub probe_override: bool,
    pub runs: Mutex<HashMap<String, Arc<Run>>>,
    pub child_runs: Mutex<HashMap<String, ChildRun>>,
    /// A run's start waiting for its new tab's omp, by tab: it ends the wait with an error when the tab is released or the
    /// user stops the run. No deadline: a slow omp is waited for.
    pub start_waits: Mutex<HashMap<String, oneshot::Sender<String>>>,
    pub release_cache: Mutex<HashMap<String, (i64, Option<Value>)>>,
    /// Tabs whose restart waits for TurnResume's `resumeGoal`.
    pub awaiting_resume: Mutex<HashSet<String>>,
    /// Tabs `resumeGoal` already armed and resumed this launch: `on_ready` must not pause them as closed.
    pub resumed_on_launch: Mutex<HashSet<String>>,
    /// Tabs `on_ready` continued at once: a later TurnResume `resumeGoal` for that readiness has nothing left to do.
    pub continued_on_ready: Mutex<HashSet<String>>,
    /// Fire-and-forget steps in flight (a restart's check, a re-emit, a release poll), so `idle` can wait for them.
    pub background: watch::Sender<usize>,
    pub inbox: mpsc::UnboundedSender<Msg>,
}

pub fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

static INSTANCES: LazyLock<Mutex<HashMap<u64, Arc<Coordinator>>>> = LazyLock::new(Default::default);

fn instance(port: u64) -> Option<Arc<Coordinator>> {
    locked(&INSTANCES).get(&port).cloned()
}

// ---- the wire ---------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct OpenParams {
    port: u64,
    #[serde(default)]
    #[allow(dead_code)]
    seq: u64,
    state: Box<serde_json::value::RawValue>,
    contracts: Contracts,
    #[serde(default)]
    tuning: Tuning,
    #[serde(default, rename = "probeOverride")]
    probe_override: bool,
}

fn done() -> Answer {
    Box::pin(async { Reply::json(&json!({})) })
}

fn failed(fault: Fault) -> Answer {
    Box::pin(async move { Err(fault) })
}

fn open(call: Call) -> Answer {
    let params: OpenParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let port = match Port::open_raw(&call.events, params.port, &params.state) {
        Ok(port) => port,
        Err(fault) => return failed(fault),
    };
    let coordinator = Coordinator::new(
        Arc::new(super::host::Backend::Wire(port.clone())),
        params.contracts,
        params.tuning,
        params.probe_override,
    );
    locked(&INSTANCES).insert(params.port, coordinator.clone());
    let id = params.port;
    tokio::spawn(async move {
        port.until_closed().await;
        locked(&INSTANCES).remove(&id);
    });
    done()
}

/// Applies main's events in the order they came: what each does before its first await happens here, in that order.
async fn actor(coordinator: Arc<Coordinator>, mut queue: mpsc::UnboundedReceiver<Msg>) {
    while let Some(message) = queue.recv().await {
        if let Some(reply) = coordinator.apply(message) {
            // Release first to end start waits, timers and active step scopes. In-flight admission may still be returning
            // from the pool; after it settles, release any run it registered during that first quiescence.
            coordinator.release_all();
            coordinator.idle().await;
            coordinator.release_all();
            coordinator.idle().await;
            let _ = reply.send(json!({"ok":true}));
            break;
        }
    }
}

#[derive(Deserialize)]
struct On {
    port: u64,
}

/// An event main sends: put in the instance's order, answered at once.
fn event(call: Call, build: impl FnOnce(&Call) -> Result<Msg, Fault>) -> Answer {
    let on: On = match call.params() {
        Ok(on) => on,
        Err(fault) => return failed(fault),
    };
    let message = match build(&call) {
        Ok(message) => message,
        Err(fault) => return failed(fault),
    };
    if let Some(coordinator) = instance(on.port) {
        let _ = coordinator.inbox.send(message);
    }
    done()
}

#[derive(Deserialize)]
struct TabParams {
    tab: String,
}

#[derive(Deserialize)]
struct FrameParams {
    tab: String,
    frame: Value,
}

#[derive(Deserialize)]
struct StatusParams {
    tab: String,
    status: Value,
}

#[derive(Deserialize)]
struct ActivityParams {
    tab: String,
    kind: String,
}

#[derive(Deserialize)]
struct SettledParams {
    tab: String,
    outcome: String,
}

/// A call main awaits: its message is put in order, the answer is the step's own.
fn asked(
    call: Call,
    build: impl FnOnce(&Call, oneshot::Sender<Value>) -> Result<Msg, Fault>,
) -> Answer {
    let on: On = match call.params() {
        Ok(on) => on,
        Err(fault) => return failed(fault),
    };
    let Some(coordinator) = instance(on.port) else {
        return failed(Fault::new(
            "autopilot_closed",
            "Autopilot is not open on this port",
        ));
    };
    let (reply, answer) = oneshot::channel();
    let message = match build(&call, reply) {
        Ok(message) => message,
        Err(fault) => return failed(fault),
    };
    if coordinator.inbox.send(message).is_err() {
        return failed(Fault::new(
            "autopilot_closed",
            "Autopilot is not open on this port",
        ));
    }
    Box::pin(async move {
        let value = answer
            .await
            .map_err(|_| Fault::new("autopilot_closed", "Autopilot ended before it answered"))?;
        Reply::json(&value)
    })
}

pub fn register(registry: &mut Registry) {
    registry.add("autopilot.open", open);
    registry.add("autopilot.frame", |call| {
        event(call, |call| {
            let params: FrameParams = call.params()?;
            Ok(Msg::Frame {
                tab: params.tab,
                frame: params.frame,
            })
        })
    });
    registry.add("autopilot.status", |call| {
        event(call, |call| {
            let params: StatusParams = call.params()?;
            Ok(Msg::Status {
                tab: params.tab,
                status: params.status,
            })
        })
    });
    registry.add("autopilot.ready", |call| {
        event(call, |call| {
            Ok(Msg::Ready {
                tab: call.params::<TabParams>()?.tab,
            })
        })
    });
    registry.add("autopilot.released", |call| {
        event(call, |call| {
            Ok(Msg::Released {
                tab: call.params::<TabParams>()?.tab,
            })
        })
    });
    registry.add("autopilot.activity", |call| {
        event(call, |call| {
            let params: ActivityParams = call.params()?;
            Ok(Msg::Activity {
                tab: params.tab,
                kind: params.kind,
            })
        })
    });
    registry.add("autopilot.aborted", |call| {
        asked(call, |call, reply| {
            Ok(Msg::Aborted {
                tab: call.params::<TabParams>()?.tab,
                reply,
            })
        })
    });
    registry.add("autopilot.resumeSettled", |call| {
        event(call, |call| {
            let params: SettledParams = call.params()?;
            Ok(Msg::ResumeSettled {
                tab: params.tab,
                outcome: params.outcome,
            })
        })
    });
    registry.add("autopilot.command", |call| {
        asked(call, |call, reply| {
            Ok(Msg::Command {
                params: call.params()?,
                reply,
            })
        })
    });
    registry.add("autopilot.resumeGoal", |call| {
        asked(call, |call, reply| {
            Ok(Msg::ResumeGoal {
                tab: call.params::<TabParams>()?.tab,
                reply,
            })
        })
    });
    registry.add("autopilot.beforeFirstPrompt", |call| {
        asked(call, |call, reply| {
            #[derive(Deserialize)]
            struct Params {
                child: Value,
            }
            Ok(Msg::BeforeFirstPrompt {
                child: call.params::<Params>()?.child,
                reply,
            })
        })
    });
    registry.add("autopilot.idle", |call| {
        asked(call, |_, reply| Ok(Msg::Idle { reply }))
    });
}

// ---- applying main's events -------------------------------------------------------------------------------------

/// What a step or command that fails answers (`AutopilotError`'s message and code).
fn failure_value(error: &Oops) -> Value {
    let mut value = json!({"ok": false, "error": error.message});
    if let Some(code) = error.code {
        value["code"] = json!(code);
    }
    value
}

impl Coordinator {
    pub fn new(
        port: MainPort,
        contracts: Contracts,
        tuning: Tuning,
        probe_override: bool,
    ) -> Arc<Self> {
        let (inbox, queue) = mpsc::unbounded_channel();
        let coordinator = Arc::new(Self {
            port,
            tuning,
            contracts,
            probe_override,
            runs: Mutex::default(),
            child_runs: Mutex::default(),
            start_waits: Mutex::default(),
            release_cache: Mutex::default(),
            awaiting_resume: Mutex::default(),
            resumed_on_launch: Mutex::default(),
            continued_on_ready: Mutex::default(),
            background: watch::channel(0).0,
            inbox,
        });
        tokio::spawn(actor(coordinator.clone(), queue));
        coordinator
    }

    fn release_all(self: &Arc<Self>) {
        let mut tabs: HashSet<String> = locked(&self.runs).keys().cloned().collect();
        tabs.extend(locked(&self.start_waits).keys().cloned());
        tabs.extend(locked(&self.child_runs).keys().cloned());
        for tab in tabs {
            self.tab_released(&tab);
        }
    }

    pub fn apply(self: &Arc<Self>, message: Msg) -> Option<oneshot::Sender<Value>> {
        match message {
            Msg::Frame { tab, frame } => self.frame(&tab, &frame),
            Msg::Status { tab, status } => self.status_seen(&tab, &status),
            Msg::Ready { tab } => {
                let this = self.clone();
                self.track(async move {
                    if let Err(error) = this.on_ready(&tab).await {
                        this.log(&format!("ready: {}", error.message));
                    }
                });
            }
            Msg::Released { tab } => self.tab_released(&tab),
            Msg::Activity { tab, kind } => self.activity(&tab, &kind),
            Msg::Aborted { tab, reply } => {
                let this = self.clone();
                self.track(async move {
                    this.aborted(&tab).await;
                    let _ = reply.send(json!({"ok": true}));
                });
            }
            Msg::ResumeSettled { tab, outcome } => self.resume_settled(&tab, &outcome),
            Msg::Command { params, reply } => {
                let this = self.clone();
                self.track(async move {
                    let answer = match this.command(&params).await {
                        Ok(value) => value,
                        Err(error) => failure_value(&error),
                    };
                    let _ = reply.send(answer);
                });
            }
            Msg::ResumeGoal { tab, reply } => {
                let this = self.clone();
                self.track(async move {
                    let answer = match this.resume_goal(&tab).await {
                        Ok(()) => json!({"ok": true}),
                        Err(error) => failure_value(&error),
                    };
                    let _ = reply.send(answer);
                });
            }
            Msg::BeforeFirstPrompt { child, reply } => {
                let this = self.clone();
                self.track(async move {
                    let answer = match this.before_first_prompt(&child).await {
                        Ok(()) => json!({"ok": true}),
                        Err(error) => failure_value(&error),
                    };
                    let _ = reply.send(answer);
                });
            }
            Msg::Idle { reply } => {
                let this = self.clone();
                tokio::spawn(async move {
                    this.idle().await;
                    let _ = reply.send(json!({"ok": true}));
                });
            }
            Msg::Close { reply } => {
                self.port.begin_close();
                return Some(reply);
            }
        }
        None
    }

    /// Resolves when every queued cycle-end/stop task and every background step of every run has finished (tests, quit).
    pub async fn idle(&self) {
        loop {
            let chains: Vec<Arc<Run>> = locked(&self.runs).values().cloned().collect();
            let mut background = self.background.subscribe();
            let _ = background.wait_for(|count| *count == 0).await;
            for run in &chains {
                run.steps.idle().await;
            }
            // A task that queued another (a stop that settles itself) moved a chain on.
            let after: Vec<Arc<Run>> = locked(&self.runs).values().cloned().collect();
            let settled = *self.background.borrow() == 0
                && after.iter().all(|run| run.steps.pending() == 0)
                && after.len() == chains.len();
            if settled {
                return;
            }
        }
    }

    /// Runs `work` as a background step `idle` waits for.
    pub fn track(self: &Arc<Self>, work: impl Future<Output = ()> + Send + 'static) {
        self.background.send_modify(|count| *count += 1);
        let this = self.clone();
        tokio::spawn(async move {
            // A panic in the step is its own; the count still falls.
            let _ = tokio::spawn(work).await;
            this.background.send_modify(|count| *count -= 1);
        });
    }

    // ---- plumbing ---------------------------------------------------------------------------------------------

    pub fn log(&self, message: &str) {
        self.port.log(message);
    }

    pub fn now(&self) -> i64 {
        now_ms()
    }

    pub async fn git(&self) -> R<Git> {
        Ok(git_from(&self.port).await?)
    }

    /// The text main shows for `key` in this computer's language.
    pub async fn text(&self, key: &str, params: Value) -> String {
        self.port
            .text(key, params)
            .await
            .unwrap_or_else(|_| key.to_owned())
    }

    /// A stock command to the tab's omp: its response, whatever it says (a failed command is `success: false`).
    pub async fn stock_response(&self, tab: &str, command: Value) -> R<Value> {
        Ok(self.port.stock(tab, command).await?)
    }

    /// A stock command that must succeed: its data.
    pub async fn stock(&self, tab: &str, command: Value) -> R<Value> {
        let name = text(&command, "type").unwrap_or("command").to_owned();
        let response = self.stock_response(tab, command).await?;
        if !flag(&response, "success") {
            return Err(Oops::from(
                text(&response, "error").map_or_else(|| format!("{name} failed"), str::to_owned),
            ));
        }
        Ok(response.get("data").cloned().unwrap_or(Value::Null))
    }

    /// A call to the tab's bridge: its data.
    pub async fn bridge(
        &self,
        tab: &str,
        method: &str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> R<Value> {
        let response = self.port.bridge(tab, method, params, timeout_ms).await?;
        if !flag(&response, "success") {
            return Err(Oops::from(
                text(&response, "error").map_or_else(|| format!("{method} failed"), str::to_owned),
            ));
        }
        Ok(response.get("data").cloned().unwrap_or(Value::Null))
    }

    pub async fn facts(&self, tab: &str) -> Option<Facts> {
        self.port.facts(tab).await.ok().flatten()
    }

    pub async fn sidecar(&self, tab: &str) -> Option<SidecarFacts> {
        self.port.sidecar(tab).await.ok().flatten()
    }

    pub fn runs_get(&self, tab: &str) -> Option<Arc<Run>> {
        locked(&self.runs).get(tab).cloned()
    }

    /// Whether `run` is still the run of its tab.
    pub fn is_current(&self, run: &Arc<Run>) -> bool {
        self.runs_get(&run.tab)
            .is_some_and(|current| current.same(run))
    }

    /// Main's mirror of the run changed: the tell reaches main before anything this step asks of the bridge next.
    pub fn touch(&self, run: &Run) {
        self.port.mirror(run.mirror());
    }

    pub fn touch_child(&self, tab: &str, run: Option<&ChildRun>) {
        self.port.child_run(
            tab,
            run.map(|child| (child.parent.clone(), child.root.clone())),
        );
    }

    /// A note the next `begin` hands the agent (what only main saw: a failed push, a failed release run).
    pub async fn tell_agent(&self, run: &Run, note: String) {
        let bridge = &self.contracts.bridge;
        if let Err(error) = self
            .bridge(&run.tab, &bridge.note, json!({"text": note}), None)
            .await
        {
            self.log(&format!("note: {}", error.message));
        }
    }

    /// Queue one step of the run's pipeline. Each ends for real: past its bound (`step_max_ms`, or `max`) it is stopped,
    /// written to the log and shown in the run's status, and the next step starts.
    pub fn enqueue<F>(
        self: &Arc<Self>,
        run: &Arc<Run>,
        step: &'static str,
        max: Option<Duration>,
        work: F,
    ) where
        F: Future<Output = R<()>> + Send + 'static,
    {
        let ended = run.steps.run(step, max, work);
        let (this, tab) = (self.clone(), run.tab.clone());
        self.track(async move {
            if let Ended::Done(Err(error)) = ended.await {
                this.log(&format!("{tab}: {}", error.message));
            }
        });
    }

    /// The chain of one run's steps: a step that runs past its bound is written down in the status.
    pub fn steps_of(self: &Arc<Self>, tab: &str) -> Steps {
        let (this, tab) = (self.clone(), tab.to_owned());
        let on_stall: Arc<dyn Fn(&Stalled) + Send + Sync> = Arc::new({
            let tab = tab.clone();
            move |stall: &Stalled| {
                let Some(run) = this.runs_get(&tab) else {
                    return;
                };
                this.log(&format!("{tab}: {}", stall.message()));
                {
                    let mut state = run.lock();
                    // A stop the step began and never finished is abandoned with it: the person's next Stop starts it again.
                    if stall.step == "stop" {
                        state.stopping = false;
                    }
                    state.stalls.push(Stall {
                        step: stall.step.clone(),
                        at: now_ms(),
                        ms: stall.ms,
                    });
                    let extra = state.stalls.len().saturating_sub(5);
                    state.stalls.drain(..extra);
                }
                this.touch(&run);
                let again = this.clone();
                this.track(async move { again.refresh(&run).await });
            }
        });
        Steps::new(
            format!("autopilot {tab}"),
            Duration::from_millis(self.tuning.step_max_ms),
            Some(on_stall),
        )
    }

    /// A run for `tab`, registered; its ship queue's hooks reach the bridge and main through this coordinator.
    #[allow(clippy::too_many_arguments)]
    pub fn new_run(self: &Arc<Self>, tab: &str, state: RunState) -> Arc<Run> {
        let steps = self.steps_of(tab);
        let this = self.clone();
        let run = Arc::new_cyclic(|weak| {
            let hooks = Arc::new(RunHooks {
                co: this.clone(),
                run: weak.clone(),
            });
            Run {
                tab: tab.to_owned(),
                state: Mutex::new(state),
                steps,
                ship: ShipRunner::new(
                    this.port.clone(),
                    hooks,
                    Duration::from_millis(this.tuning.ship_drain_max_ms),
                    Duration::from_millis(this.tuning.land_stop_grace_ms),
                ),
                titling: tokio::sync::Mutex::new(()),
            }
        });
        locked(&self.runs).insert(tab.to_owned(), run.clone());
        self.touch(&run);
        run
    }

    /// Make the bridge re-emit `autopilot_update` (through main's overlay) after something only main changed.
    pub async fn refresh(&self, run: &Arc<Run>) {
        {
            let mut state = run.lock();
            if state.refreshing {
                state.refresh_again = true;
                return;
            }
            state.refreshing = true;
        }
        loop {
            run.lock().refresh_again = false;
            let _ = self
                .bridge(&run.tab, &self.contracts.bridge.configure, json!({}), None)
                .await;
            if !run.lock().refresh_again {
                break;
            }
        }
        run.lock().refreshing = false;
    }

    pub async fn fetch_status(&self, run: &Arc<Run>) -> R<Value> {
        let status = self
            .bridge(&run.tab, &self.contracts.bridge.status, json!({}), None)
            .await?;
        self.remember_status(run, &status);
        Ok(status)
    }

    /// The status the bridge last said: `run.status`, and its settings (the ship policy is mirrored).
    pub fn remember_status(&self, run: &Arc<Run>, status: &Value) {
        let changed = {
            let mut state = run.lock();
            state.status = Some(status.clone());
            match status.get("settings") {
                Some(settings) if settings.is_object() => {
                    let changed = state.settings.0.get("ship") != settings.get("ship");
                    state.settings = Settings(settings.clone());
                    changed
                }
                _ => false,
            }
        };
        if changed {
            self.touch(run);
        }
    }

    /// Journal a state through the bridge, keeping what the last status said about the rest. A change that names no state
    /// (a push's in-flight mark) sends none: the journal keeps its own, which a pause given after this process last read the
    /// status has already changed (a push's mark once wrote `running` over the user's Pause).
    pub async fn set_state(&self, run: &Arc<Run>, change: Value) -> R<()> {
        let current = run.lock().status.clone().unwrap_or(Value::Null);
        let named = change.get("state").and_then(Value::as_str);
        let same_state = named.is_none() || named == text(&current, "state");
        let mut params = serde_json::Map::new();
        if let Some(state) = named {
            params.insert("state".into(), json!(state));
            let reason = change
                .get("reason")
                .and_then(Value::as_str)
                .or_else(|| same_state.then(|| text(&current, "reason")).flatten());
            if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
                params.insert("reason".into(), json!(reason));
            }
            let detail = change
                .get("detail")
                .and_then(Value::as_str)
                .or_else(|| same_state.then(|| text(&current, "detail")).flatten());
            if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
                params.insert("detail".into(), json!(detail));
            }
        }
        if let Some(in_flight) = change.get("inFlight") {
            params.insert("inFlight".into(), in_flight.clone());
        }
        if let Some(reset) = change.get("quotaResetAt") {
            params.insert("quotaResetAt".into(), reset.clone());
        }
        self.bridge(
            &run.tab,
            &self.contracts.bridge.set_state,
            Value::Object(params),
            None,
        )
        .await
        .map(|_| ())
    }

    /// The release procedure of the repository at `root` (cached a minute), or why there is none.
    pub async fn release_for(&self, root: &str) -> (Option<Value>, Option<String>) {
        let now = self.now();
        let cached = locked(&self.release_cache)
            .get(root)
            .filter(|(at, _)| now - at < self.tuning.release_cache_ms as i64)
            .cloned();
        let value = match cached {
            Some((_, value)) => value,
            None => {
                let value = self.port.release_procedure(root).await.ok().flatten();
                locked(&self.release_cache).insert(root.to_owned(), (now, value.clone()));
                value
            }
        };
        match value {
            Some(procedure) => (Some(procedure), None),
            None => (
                None,
                Some(self.text("autopilot.err.noRelease", json!({})).await),
            ),
        }
    }

    /// A pause or stop the run's own pipeline wrote down for `tab`: the audit's baseline after a run's own git work.
    pub async fn rebase_snapshot(&self, run: &Arc<Run>) {
        let (root, checkout, before) = {
            let state = run.lock();
            (
                state.root.clone(),
                state.checkout_root.clone(),
                state.snapshot.clone(),
            )
        };
        let snapshot = self.snapshot(&root, &checkout).await.or(before);
        run.lock().snapshot = snapshot;
    }

    /// The repository's refs, config and default checkout now; none when git cannot say.
    pub async fn snapshot(&self, root: &str, checkout_root: &str) -> Option<Snapshot> {
        let git = self.git().await.ok()?;
        audit::take_snapshot(&git, root, Some(checkout_root))
            .await
            .ok()
    }
}

// ---- the ship queue's hooks -------------------------------------------------------------------------------------

/// What a run's ship queue needs of the run: journaling a ref move for the audit, telling the screen, the pull request.
struct RunHooks {
    co: Arc<Coordinator>,
    run: std::sync::Weak<Run>,
}

impl Hooks for RunHooks {
    fn journal(&self, action: Value) -> Fut<Result<(), String>> {
        let (co, run) = (self.co.clone(), self.run.upgrade());
        Box::pin(async move {
            let Some(run) = run else {
                return Err("the run is gone".to_owned());
            };
            {
                let mut state = run.lock();
                if let Some(refs) = action.get("refs").and_then(Value::as_array) {
                    state
                        .expected_refs
                        .extend(refs.iter().filter_map(Value::as_str).map(str::to_owned));
                }
                match text(&action, "kind") {
                    Some("merge") => state.checkout_may_move = true,
                    Some("push") => state.config_may_change = true,
                    _ => {}
                }
            }
            co.bridge(&run.tab, &co.contracts.bridge.ship_action, action, None)
                .await
                .map(|_| ())
                .map_err(|error| error.message)
        })
    }

    fn changed(&self, _queue: Vec<QueueItem>) {
        let Some(run) = self.run.upgrade() else {
            return;
        };
        self.co.touch(&run);
        let co = self.co.clone();
        self.co.track(async move { co.refresh(&run).await });
    }

    fn reverted(&self, cycle: i64) -> Fut<Result<(), String>> {
        let (co, run) = (self.co.clone(), self.run.upgrade());
        Box::pin(async move {
            let Some(run) = run else {
                return Err("the run is gone".to_owned());
            };
            co.bridge(
                &run.tab,
                &co.contracts.bridge.mark_reverted,
                json!({"cycle": cycle}),
                None,
            )
            .await
            .map(|_| ())
            .map_err(|error| error.message)
        })
    }

    fn pr_text(&self) -> Fut<Result<(String, String), String>> {
        let (co, run) = (self.co.clone(), self.run.upgrade());
        Box::pin(async move {
            let Some(run) = run else {
                return Err("the run is gone".to_owned());
            };
            let (branch, cycles) = {
                let state = run.lock();
                let cycles = state
                    .status
                    .as_ref()
                    .and_then(|status| status.get("cycles"))
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                (state.branch.clone(), cycles)
            };
            co.port
                .pr_text(branch, cycles)
                .await
                .map_err(|error| error.message)
        })
    }

    fn pr_create(&self, cwd: String, input: PrInput) -> Fut<Result<(String, i64), String>> {
        let co = self.co.clone();
        Box::pin(async move {
            co.port
                .pr_create(cwd, input)
                .await
                .map_err(|error| error.message)
        })
    }
}
