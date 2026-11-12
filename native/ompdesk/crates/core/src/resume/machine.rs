//! Turn resume (was `TurnResume` in `src/main/turn-resume.ts`): a hub instance of kind `resume`.
//!
//! Every stretch of the TypeScript that ran without an `await` is one synchronous function here, given the pool's
//! facts and the settings it read as one `Env` (main reads them at the instant the stretch starts: `sync()` carries its
//! own, a continuation asks for it), so no other task runs inside it, as none did in the TypeScript. What was an `await`
//! is an `await` here: a question main answers later (`ask_later`: a command to a tab's omp, `movesSettled`, a
//! reachability probe) or, for a collaborator that was called synchronously and may do anything (`startTab`,
//! `openTab`, the pool's `noteStopped`), a question main answers at once (`ask`).
//!
//! Effects whose value the TypeScript did not use are items main applies in order (`setAwaiting`, `storeWrite`, …).
//! One of them changes what the next read of the pool says (`setAwaitingConnection`): the stretch's own `Env` is
//! patched with it, as the pool's would have been.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::ends::{Context, HeldFor, hold_end, persons_run};
use super::facts::{
    Action, Fact, MarkerData, Reason, RunOutcome, derive_markers, launch_action, opened_running,
    restore_summary, truthy,
};
use super::text::{
    connect_failure_host, is_limit_error, is_network_error, is_transient_error, quota_reset_at,
    quota_wait_until, retry_after_ms,
};
use super::util::{JoinAll, OrdMap, start};
use crate::hub::{self, LocalFuture, Out};
use crate::server::Fault;

type R<T> = Result<T, Fault>;

/// Everything a stretch reads from main.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Env {
    pub frozen: bool,
    pub enabled: bool,
    pub now: f64,
    /// `network.online`.
    pub online: bool,
    /// `network.shouldWait()`.
    pub should_wait: bool,
    /// `pool.resumeFacts()`, every tab (hosted views are never in it).
    pub facts: Vec<Fact>,
    /// The tab's fact (`#factFor`): non-device.
    pub fact: Option<Fact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Opts {
    /// Waits before each scheduled attempt; the last repeats.
    delays: Vec<f64>,
    limit_look_ms: f64,
    quota_fallback_ms: f64,
    command_timeout_ms: f64,
    launch_attempts: u32,
    has_resume_goal: bool,
    seed: Option<Seed>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            delays: Vec::new(),
            limit_look_ms: 0.0,
            quota_fallback_ms: 0.0,
            command_timeout_ms: 0.0,
            launch_attempts: 3,
            has_resume_goal: false,
            seed: None,
        }
    }
}

/// What a core that restarted learns from main: whatever turn resume can read again. See `src/main/turn-resume.ts`
/// › "When the core is lost".
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Seed {
    launched: bool,
    previous: Vec<MarkerData>,
    judged: Vec<u64>,
    taken_over: Vec<u64>,
    probed_retries: Vec<u64>,
    exits: HashMap<String, i64>,
}

struct Marker {
    /// One per marker object, as the WeakMap/WeakSet keys were objects.
    serial: u64,
    d: MarkerData,
}

type Mk = Rc<RefCell<Marker>>;

struct Held {
    action: Action,
    since: HeldFor,
}

struct Probe {
    serial: u64,
    since: HeldFor,
}

/// One tab's scheduled retry and what it was armed for: any of these changing calls it off.
struct Armed {
    at: f64,
    attempt: u32,
    outcome: RunOutcome,
    session_file: String,
    touched: i64,
    timer: Option<u64>,
    limit: bool,
    /// A limit wait: what the session ran on when it began; a change is worth a try.
    setup: Option<String>,
}

type Ar = Rc<RefCell<Armed>>;

impl Armed {
    fn held(&self) -> HeldFor {
        HeldFor {
            session_file: Some(self.session_file.clone()),
            touched: self.touched,
            prompted: None,
            outcome: Some(self.outcome.clone()),
            limit: self.limit,
        }
    }
}

struct Wait {
    tab: String,
    listener: Option<u64>,
    done: Option<oneshot::Sender<bool>>,
}

#[derive(Clone)]
enum Listener {
    /// A continuation waiting for its tab's omp to come up.
    Ready(u64),
    /// A failed launch continuation that tries again once its tab next reads `ready`.
    Retry {
        tab: String,
        action: Action,
        since: HeldFor,
    },
}

struct Retrying {
    marker: u64,
    listener: u64,
}

enum Timer {
    Fire(String, Ar),
    Look(String, Ar),
}

#[derive(Default)]
struct State {
    launched: bool,
    previous: Vec<Mk>,
    /// Launch markers whose turn has not started yet: kept in the file so a second crash still resumes them.
    pending: OrdMap<Mk>,
    /// Tabs holding a continuation until the connection is back, and what to run then.
    waiting: OrdMap<Held>,
    /// Failed launch continuations that try again once their tab reads `ready`.
    retrying: OrdMap<Retrying>,
    failures: HashMap<u64, u32>,
    abandoned: HashSet<u64>,
    superseded: HashSet<u64>,
    /// Tabs whose DNS failure is being probed: shown as waiting until the probe decides.
    probing: OrdMap<Probe>,
    /// Run outcomes already judged (a Cancel must not re-arm the wait), by the client's id.
    judged: HashSet<u64>,
    /// Stock auto-retries already taken over, and those whose way out was probed.
    taken_over: HashSet<u64>,
    probed_retries: HashSet<u64>,
    /// Per tab, bumped whenever its continuation is called off.
    cancels: HashMap<String, u64>,
    /// Per tab, what ends a continuation's wait for its omp to come up.
    ready_waits: OrdMap<Vec<u64>>,
    waits: HashMap<u64, Wait>,
    taken_over_runs: HashSet<String>,
    scheduled: OrdMap<Ar>,
    attempts: HashMap<String, u32>,
    own_retries: HashSet<String>,
    resuming_shown: OrdMap<()>,
    exits: HashMap<String, i64>,
    timers: HashMap<u64, Timer>,
    listeners: HashMap<u64, Listener>,
    next: u64,
    /// The stretch's reads, while one runs.
    env: Option<Env>,
}

pub struct Inst {
    out: Out,
    delays: Vec<f64>,
    limit_look_ms: f64,
    quota_fallback_ms: f64,
    command_timeout_ms: f64,
    launch_attempts: u32,
    has_resume_goal: bool,
    st: RefCell<State>,
}

thread_local! {
    static INSTANCES: RefCell<HashMap<u64, Rc<Inst>>> = RefCell::default();
}

pub fn open(id: u64, opts: &serde_json::value::RawValue, out: Out) -> Result<(), Fault> {
    let opts: Opts = hub::params(opts)?;
    let mut st = State::default();
    if let Some(seed) = opts.seed {
        st.launched = seed.launched;
        st.previous = seed
            .previous
            .into_iter()
            .map(|d| Rc::new(RefCell::new(Marker { serial: 0, d })))
            .collect();
        st.judged = seed.judged.into_iter().collect();
        st.taken_over = seed.taken_over.into_iter().collect();
        st.probed_retries = seed.probed_retries.into_iter().collect();
        st.exits = seed.exits;
    }
    let inst = Rc::new(Inst {
        out,
        delays: opts.delays,
        limit_look_ms: opts.limit_look_ms,
        quota_fallback_ms: opts.quota_fallback_ms,
        command_timeout_ms: opts.command_timeout_ms,
        launch_attempts: opts.launch_attempts,
        has_resume_goal: opts.has_resume_goal,
        st: RefCell::new(st),
    });
    INSTANCES.with(|all| all.borrow_mut().insert(id, inst));
    Ok(())
}

pub fn close(id: u64) {
    INSTANCES.with(|all| all.borrow_mut().remove(&id));
}

pub fn instance(id: u64) -> Option<Rc<Inst>> {
    INSTANCES.with(|all| all.borrow().get(&id).cloned())
}

/// Every want of a stretch that may end in a `sync()`.
const ALL: &[&str] = &["facts", "fact", "network", "enabled", "now"];

enum Target<'a> {
    Sidecar(u64),
    Tab(&'a str),
}

/// What a command to a tab's omp came to.
enum Cmd {
    Response(Value),
    /// The tab has no omp connection (no tab, or no RPC client).
    None,
    Error {
        /// `String(error)`.
        text: String,
        message: String,
        timeout: bool,
    },
}

impl Cmd {
    fn success(&self) -> bool {
        matches!(self, Cmd::Response(response) if response["success"] == true)
    }

    /// The answer's `data` when it succeeded and is an object (`{ ...data }`).
    fn data(&self) -> Option<Map<String, Value>> {
        match self {
            Cmd::Response(response) if response["success"] == true => match &response["data"] {
                Value::Object(map) => Some(map.clone()),
                Value::Array(_) => Some(Map::new()),
                _ => None,
            },
            _ => None,
        }
    }
}

/// A sidecar main handed over for a tab.
struct Sidecar {
    id: u64,
    /// `sidecar.status`.
    status: String,
    /// `sidecar.statusPayload.status` (the status itself when it has no payload), and its `sessionHeld`.
    payload_status: String,
    session_held: bool,
    rpc: bool,
}

impl Sidecar {
    /// Its omp failed (unless another omp still holds its session: the tab opens it by itself once that one lets go)
    /// or exited.
    fn ended(&self) -> bool {
        (self.payload_status == "error" && !self.session_held) || self.payload_status == "exited"
    }
}

/// What a limit wait reads from its tab's omp, with no request to a provider's model.
struct LimitReading {
    on: bool,
    setup: Option<String>,
    provider: Option<String>,
    reports: Option<Vec<Value>>,
}

/// One continuation's view of itself (the closures of `#run`).
struct RunCtx {
    tab: String,
    action: Action,
    since: HeldFor,
    generation: u64,
    own: Option<Mk>,
    person_took_over: Cell<bool>,
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

impl Inst {
    // ---- plumbing ----------------------------------------------------------------------------------------------

    fn push(&self, item: Value) {
        self.out.push(&item);
    }

    /// A promise main waits on is settled: pushed after the call that made its token has answered, so the client knows
    /// the token by then.
    fn done(&self, token: u64) {
        let out = self.out;
        hub::spawn(async move { out.push(&json!({"k": "done", "token": token})) });
    }

    fn next_id(&self) -> u64 {
        let mut st = self.st.borrow_mut();
        st.next += 1;
        st.next
    }

    async fn ask(&self, q: &str, payload: Value) -> R<Value> {
        self.out.ask(q, &payload).await
    }

    async fn ask_later(&self, q: &str, payload: Value) -> R<Value> {
        self.out.ask_later(q, &payload).await
    }

    fn parse_env(value: Value) -> R<Env> {
        serde_json::from_value(value).map_err(|error| Fault::new("bad_answer", error.to_string()))
    }

    /// Main's reads right now: the frozen flag, and what `want` names (`facts`, `fact` of `tab`, `network`, `enabled`, `now`).
    async fn look(&self, tab: Option<&str>, want: &[&str]) -> R<Env> {
        Self::parse_env(self.ask("look", json!({"tab": tab, "want": want})).await?)
    }

    /// `movesSettled(tab)`, then the reads of `look`: what `stale()` read right after its await.
    async fn settled(&self, tab: &str, want: &[&str]) -> R<Env> {
        Self::parse_env(
            self.ask_later("settled", json!({"tab": tab, "want": want}))
                .await?,
        )
    }

    fn stretch<T>(self: &Rc<Self>, env: Env, work: impl FnOnce(&Rc<Self>) -> T) -> T {
        let before = self.st.borrow_mut().env.replace(env);
        let result = work(self);
        self.st.borrow_mut().env = before;
        result
    }

    fn read_env<T>(&self, read: impl FnOnce(&Env) -> T) -> T {
        match &self.st.borrow().env {
            Some(env) => read(env),
            None => read(&Env::default()),
        }
    }

    fn frozen(&self) -> bool {
        self.read_env(|env| env.frozen)
    }

    fn enabled(&self) -> bool {
        self.read_env(|env| env.enabled)
    }

    fn now(&self) -> f64 {
        self.read_env(|env| env.now)
    }

    fn online(&self) -> bool {
        self.read_env(|env| env.online)
    }

    fn should_wait(&self) -> bool {
        self.read_env(|env| env.should_wait)
    }

    /// `pool.resumeFacts()` without the hosted tabs' mirrors (`!fact.device`).
    fn current_facts(&self) -> Vec<Fact> {
        self.read_env(|env| {
            env.facts
                .iter()
                .filter(|fact| !truthy(&fact.device))
                .cloned()
                .collect()
        })
    }

    /// `#factFor`.
    fn fact_for(&self, tab: &str) -> Option<Fact> {
        self.read_env(|env| {
            env.fact
                .as_ref()
                .filter(|fact| fact.tab_id == tab && !truthy(&fact.device))
                .or_else(|| {
                    env.facts
                        .iter()
                        .find(|fact| fact.tab_id == tab && !truthy(&fact.device))
                })
                .cloned()
        })
    }

    fn set_awaiting(&self, tab: &str, awaiting: bool) {
        self.push(json!({"k": "setAwaiting", "tab": tab, "awaiting": awaiting}));
        let mut st = self.st.borrow_mut();
        if let Some(env) = st.env.as_mut() {
            for fact in env.facts.iter_mut().chain(env.fact.iter_mut()) {
                if fact.tab_id == tab {
                    fact.awaiting_connection = awaiting;
                }
            }
        }
    }

    fn goal_settled(&self, tab: &str, outcome: &str) {
        self.push(json!({"k": "goalSettled", "tab": tab, "outcome": outcome}));
    }

    fn log(&self, message: &str, details: Map<String, Value>) {
        self.push(json!({"k": "log", "message": message, "details": details}));
    }

    fn cancel_gen(&self, tab: &str) -> u64 {
        self.st.borrow().cancels.get(tab).copied().unwrap_or(0)
    }

    fn bump_cancel(&self, tab: &str) {
        *self
            .st
            .borrow_mut()
            .cancels
            .entry(tab.to_owned())
            .or_insert(0) += 1;
    }

    fn schedule(&self, ms: f64, task: Timer) -> u64 {
        let timer = self.next_id();
        self.st.borrow_mut().timers.insert(timer, task);
        self.push(json!({"k": "schedule", "timer": timer, "ms": ms}));
        timer
    }

    fn marker(&self, d: MarkerData) -> Mk {
        Rc::new(RefCell::new(Marker {
            serial: self.next_id(),
            d,
        }))
    }

    // ---- the end table -----------------------------------------------------------------------------------------

    /// What ends the hold `check` looks at on `fact`'s tab, or `None` while it holds.
    fn ends(&self, check: &str, since: &HeldFor, fact: Option<&Fact>) -> Option<&'static str> {
        let own = fact.is_some_and(|fact| {
            let st = self.st.borrow();
            if check == "armed" {
                st.own_retries.contains(&fact.tab_id)
            } else {
                st.taken_over_runs.contains(&fact.tab_id)
            }
        });
        hold_end(
            check,
            since,
            fact,
            &Context {
                frozen: self.frozen(),
                own_run: own,
            },
        )
    }

    /// The scheduled retry this failure would arm now, held for the tab as it is: may it exist?
    fn may_retry(&self, fact: &Fact, outcome: &RunOutcome, limit: bool) -> bool {
        let since = HeldFor {
            session_file: fact.session_file.clone(),
            touched: fact.touched(),
            prompted: None,
            outcome: Some(outcome.clone()),
            limit,
        };
        self.ends("armed", &since, Some(fact)).is_none()
    }

    // ---- sync ----------------------------------------------------------------------------------------------------

    /// Every run-state change in the pool: wait on a network error, then rewrite the marker file. A paired host's tab
    /// (`device`) is not this computer's: the host writes its marker, judges the wait by its own connection and
    /// continues it, and this tab only shows that wait.
    pub fn sync(self: &Rc<Self>, env: Env) {
        self.stretch(env, |me| me.sync_inner());
    }

    fn sync_inner(self: &Rc<Self>) {
        if !self.st.borrow().launched || self.frozen() {
            return;
        }
        let facts = self.current_facts();
        for fact in &facts {
            self.judge(fact);
        }
        let current = self.current_facts();
        let present: HashSet<String> = current.iter().map(|fact| fact.tab_id.clone()).collect();
        for fact in &current {
            if fact.running {
                self.st.borrow_mut().pending.remove(&fact.tab_id);
            }
        }
        // A closed tab has nothing left to continue: its launch marker (held offline, or still waiting for its omp)
        // leaves the file now, not when the network returns, and its bookkeeping goes with it.
        let scheduled = self.st.borrow().scheduled.keys();
        for tab in scheduled.iter().filter(|tab| !present.contains(*tab)) {
            self.drop_scheduled(tab);
        }
        let waits = self.st.borrow().ready_waits.keys();
        for tab in waits.iter().filter(|tab| !present.contains(*tab)) {
            self.end_ready_waits(tab);
        }
        {
            let mut st = self.st.borrow_mut();
            st.pending.retain(|tab| present.contains(tab));
            st.waiting.retain(|tab| present.contains(tab));
            st.cancels.retain(|tab, _| present.contains(tab));
            st.taken_over_runs.retain(|tab| present.contains(tab));
            st.attempts.retain(|tab, _| present.contains(tab));
            st.own_retries.retain(|tab| present.contains(tab));
            st.exits.retain(|tab, _| present.contains(tab));
        }
        let exited = self.exited(&current);
        self.settle_retries();
        let (limited, previous) = {
            let st = self.st.borrow();
            let limited: HashSet<String> = st
                .scheduled
                .iter()
                .filter(|(_, armed)| armed.borrow().limit)
                .map(|(tab, _)| tab.clone())
                .collect();
            let previous: Vec<MarkerData> =
                st.previous.iter().map(|m| m.borrow().d.clone()).collect();
            (limited, previous)
        };
        let live: Vec<Mk> = {
            let derived = derive_markers(&current, &previous, self.now(), &limited);
            let st = self.st.borrow();
            let fresh: Vec<MarkerData> = derived
                .into_iter()
                .filter(|m| !st.pending.contains(&m.tab))
                .collect();
            drop(st);
            fresh.into_iter().map(|d| self.marker(d)).collect()
        };
        let kept: Vec<Mk> = if self.enabled() {
            let st = self.st.borrow();
            st.pending.values().cloned().chain(live).collect()
        } else {
            Vec::new()
        };
        let rows: Vec<MarkerData> = kept.iter().map(|m| m.borrow().d.clone()).collect();
        self.st.borrow_mut().previous = kept;
        self.push(json!({"k": "storeWrite", "markers": rows}));
        self.show_resuming();
        for (tab, action, since) in exited {
            if self.should_wait() {
                self.hold(&tab, action, since);
            } else {
                self.start_run(tab, action, since);
            }
        }
    }

    /// Tabs whose omp died under their work since the last look (`exits` moved; its manager starts the next one): the
    /// pool already ended the run, so the marker the tab had goes on as a launch marker, continued once the next omp is
    /// up, as a relaunch continues it. A network or limit marker is not one: its wait and marker outlive the omp. Nor
    /// is a tab whose launch continuation still waits offline. A continuation already on its way is superseded.
    fn exited(&self, current: &[Fact]) -> Vec<(String, Action, HeldFor)> {
        let mut exited = Vec::new();
        for fact in current {
            let exits = fact.exits.unwrap_or(0);
            let seen = self
                .st
                .borrow()
                .exits
                .get(&fact.tab_id)
                .copied()
                .unwrap_or(0);
            self.st
                .borrow_mut()
                .exits
                .insert(fact.tab_id.clone(), exits);
            if exits <= seen || !self.enabled() || self.st.borrow().waiting.contains(&fact.tab_id) {
                continue;
            }
            let marker = self
                .st
                .borrow()
                .previous
                .iter()
                .find(|entry| entry.borrow().d.tab == fact.tab_id)
                .map(|entry| entry.borrow().d.clone());
            let Some(marker) = marker else { continue };
            if matches!(marker.reason, Reason::Network | Reason::Limit) {
                continue;
            }
            let before = self.st.borrow().pending.get(&fact.tab_id).cloned();
            if let Some(before) = before {
                self.st
                    .borrow_mut()
                    .superseded
                    .insert(before.borrow().serial);
                self.bump_cancel(&fact.tab_id);
                self.end_ready_waits(&fact.tab_id);
            }
            let next = self.marker(marker.clone());
            self.st
                .borrow_mut()
                .pending
                .insert(fact.tab_id.clone(), next);
            let mut details = Map::new();
            details.insert("session".into(), json!(marker.session_path));
            details.insert("reason".into(), json!(marker.reason));
            details.insert("tab".into(), json!(fact.tab_id));
            details.insert("via".into(), json!("exit"));
            if marker.background {
                details.insert("background".into(), json!(true));
            }
            if let Some(peer) = marker.peer.as_ref().filter(|peer| !peer.is_empty()) {
                details.insert("peer".into(), json!(peer));
            }
            self.log("marker", details);
            exited.push((
                fact.tab_id.clone(),
                launch_action(&marker),
                HeldFor {
                    session_file: fact.session_file.clone(),
                    touched: fact.touched(),
                    ..HeldFor::default()
                },
            ));
        }
        exited
    }

    /// The "continuing" row follows the launch markers still waiting for their turn (a reopened card is not one).
    fn show_resuming(&self) {
        let resuming: Vec<String> = {
            let st = self.st.borrow();
            st.pending
                .values()
                .map(|marker| marker.borrow())
                .filter(|marker| {
                    marker.d.reason != Reason::Asking && !st.abandoned.contains(&marker.serial)
                })
                .map(|marker| marker.d.tab.clone())
                .collect()
        };
        for tab in &resuming {
            if self.st.borrow().resuming_shown.contains(tab) {
                continue;
            }
            self.st.borrow_mut().resuming_shown.insert(tab.clone(), ());
            self.push(json!({"k": "setResuming", "tab": tab, "resuming": true}));
        }
        let shown = self.st.borrow().resuming_shown.keys();
        for tab in shown {
            if resuming.contains(&tab) {
                continue;
            }
            self.st.borrow_mut().resuming_shown.remove(&tab);
            self.push(json!({"k": "setResuming", "tab": tab, "resuming": false}));
        }
    }

    /// A continuation waiting for its tab to read `ready` whose marker left `pending` (the turn started, the tab
    /// closed, a later exit replaced it) has nothing to wait for: its listener goes, and its goal hears `none` once
    /// unless the replacement continuation owns the report.
    fn settle_retries(&self) {
        let retrying: Vec<(String, u64, u64)> = self
            .st
            .borrow()
            .retrying
            .iter()
            .map(|(tab, retry)| (tab.clone(), retry.marker, retry.listener))
            .collect();
        for (tab, marker, listener) in retrying {
            let same = self
                .st
                .borrow()
                .pending
                .get(&tab)
                .is_some_and(|m| m.borrow().serial == marker);
            if same {
                continue;
            }
            self.retry_off(&tab, listener);
            if !self.st.borrow().superseded.contains(&marker) {
                self.goal_settled(&tab, "none");
            }
        }
    }

    fn retry_off(&self, tab: &str, listener: u64) {
        if self.st.borrow_mut().listeners.remove(&listener).is_some() {
            self.push(json!({"k": "unlisten", "listener": listener}));
        }
        let mut st = self.st.borrow_mut();
        if st
            .retrying
            .get(tab)
            .is_some_and(|retry| retry.listener == listener)
        {
            st.retrying.remove(tab);
        }
    }

    // ---- judging a tab -------------------------------------------------------------------------------------------

    fn judge(self: &Rc<Self>, fact: &Fact) {
        let tab = fact.tab_id.clone();
        if fact.last_run.is_some() {
            self.st.borrow_mut().taken_over_runs.remove(&tab);
        }
        self.watch_scheduled_retry(fact);
        // The person's new run, Stop on a probe, another session or branch on a held tab (the end table): the wait
        // belonged to the turn it left, so the waiting row goes and nothing continues into what the tab shows now.
        let held = self
            .st
            .borrow()
            .waiting
            .get(&tab)
            .map(|held| held.since.clone());
        let probe = self
            .st
            .borrow()
            .probing
            .get(&tab)
            .map(|probe| probe.since.clone());
        if held.is_some_and(|since| self.ends("wait", &since, Some(fact)).is_some())
            || probe.is_some_and(|since| self.ends("probe", &since, Some(fact)).is_some())
        {
            self.drop_wait(&tab, true);
        }
        self.take_over_retry(fact);
        // The outcome is the run's final one (main sets it at the last end event), even while background work keeps
        // the session unsettled: judging it now puts the wait on screen before the renderer sees the failure.
        let Some(outcome) = fact.last_run.clone() else {
            return;
        };
        {
            let mut st = self.st.borrow_mut();
            if !st.judged.insert(outcome.id) {
                return;
            }
            st.own_retries.remove(&tab);
        }
        // It ended while the wait already held it (stock's retry, taken over): nothing more to decide.
        if fact.awaiting_connection {
            return;
        }
        if outcome.stop_reason != "error" {
            self.st.borrow_mut().attempts.remove(&tab);
            return;
        }
        if is_network_error(outcome.error_message.as_deref()) {
            // Offline (or just after a wake) the connection wait owns a network failure; no second schedule.
            if self.should_wait() {
                let since = HeldFor {
                    session_file: fact.session_file.clone(),
                    touched: fact.touched(),
                    ..HeldFor::default()
                };
                self.hold(&tab, Action::Retry, since);
                return;
            }
            if let Some(host) = connect_failure_host(outcome.error_message.as_deref()) {
                self.verify_network(fact, outcome, host);
                return;
            }
        }
        self.plan_retry(fact, outcome);
    }

    /// A failed name lookup while the link says it is up (a dead DNS or route `net.isOnline()` never sees): when
    /// neither the failed host nor the default way out answers, the turn waits for the connection like an offline one
    /// and continues once the probe answers; otherwise the failure is the provider's and the scheduled retry decides.
    fn verify_network(self: &Rc<Self>, fact: &Fact, outcome: RunOutcome, host: String) {
        let tab = fact.tab_id.clone();
        let serial = self.next_id();
        let since = HeldFor {
            session_file: fact.session_file.clone(),
            touched: fact.touched(),
            prompted: None,
            outcome: Some(outcome.clone()),
            limit: false,
        };
        self.st.borrow_mut().probing.insert(
            tab.clone(),
            Probe {
                serial,
                since: since.clone(),
            },
        );
        self.set_awaiting(&tab, true);
        let me = Rc::clone(self);
        start(async move {
            let _ = me.verified(tab, serial, since, outcome, host).await;
        });
    }

    async fn verified(
        self: Rc<Self>,
        tab: String,
        serial: u64,
        since: HeldFor,
        outcome: RunOutcome,
        host: String,
    ) -> R<()> {
        let reachable = self.verify_answer(&host).await;
        let env = self.look(Some(&tab), ALL).await?;
        self.stretch(env, |me| {
            // Cancel, a new run or another failure since: whoever ended this probe also cleared its row.
            if me
                .st
                .borrow()
                .probing
                .get(&tab)
                .is_none_or(|probe| probe.serial != serial)
            {
                return;
            }
            me.st.borrow_mut().probing.remove(&tab);
            // Stop, a closed tab, or another session or branch on the tab since the failure: nothing to continue.
            let holds = me
                .ends("probeAnswer", &since, me.fact_for(&tab).as_ref())
                .is_none();
            if holds && !reachable {
                me.hold(&tab, Action::Retry, since.clone());
                // The marker says `network` now, so a crash during the wait still retries.
                me.sync_inner();
                return;
            }
            me.set_awaiting(&tab, false);
            let after = if holds { me.fact_for(&tab) } else { None };
            if let Some(after) = after {
                me.plan_retry(&after, outcome.clone());
            }
            me.sync_inner();
        });
        Ok(())
    }

    /// `network.verify(host)`: false for a probe that failed to answer.
    async fn verify_answer(&self, host: &str) -> bool {
        let host = (!host.is_empty()).then_some(host);
        match self.ask_later("verify", json!({"host": host})).await {
            Ok(value) => value.as_bool().unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Every call-off of an armed retry (the end table `armed`); the person's new run also starts its chain over.
    fn watch_scheduled_retry(&self, fact: &Fact) {
        let tab = &fact.tab_id;
        let armed = self.st.borrow().scheduled.get(tab).cloned();
        if let Some(armed) = armed {
            let held = armed.borrow().held();
            if self.ends("armed", &held, Some(fact)).is_some() {
                self.drop_scheduled(tab);
            }
        }
        if persons_run(fact, self.st.borrow().own_retries.contains(tab)) {
            self.st.borrow_mut().attempts.remove(tab);
        }
    }

    /// Stock retries a transport failure up to `retry.maxRetries` times with its own backoff (minutes on a real omp:
    /// each refused attempt takes tens of seconds), toasting every attempt. While this computer is offline none of
    /// them can succeed, so the wait takes over at the first one: stock's pending retry is cancelled (`abort_retry`,
    /// the turn then ends failed) and stock `retry` runs once the connection is back. Right after a wake the network
    /// may already be up, so stock's own retry is left to run. A failed connection while the link reads up is probed
    /// first: a probe that finds nothing reachable takes the state offline, and the takeover follows.
    fn take_over_retry(self: &Rc<Self>, fact: &Fact) {
        let Some(retry) = &fact.retry else { return };
        if self.st.borrow().taken_over.contains(&retry.id) {
            return;
        }
        if self.online() {
            self.probe_retry(retry.id, &retry.error_message);
            return;
        }
        if !is_network_error(Some(&retry.error_message)) {
            return;
        }
        {
            let mut st = self.st.borrow_mut();
            st.taken_over.insert(retry.id);
            st.taken_over_runs.insert(fact.tab_id.clone());
        }
        if !fact.awaiting_connection {
            let since = HeldFor {
                session_file: fact.session_file.clone(),
                touched: fact.touched(),
                ..HeldFor::default()
            };
            self.hold(&fact.tab_id, Action::Retry, since);
        }
        self.push(json!({"k": "abortRetry", "tab": fact.tab_id}));
    }

    /// Probe the way out once for stock's retry of a failed connection; nothing reachable puts the takeover through.
    fn probe_retry(self: &Rc<Self>, id: u64, message: &str) {
        let Some(host) = connect_failure_host(Some(message)) else {
            return;
        };
        if !self.st.borrow_mut().probed_retries.insert(id) {
            return;
        }
        let me = Rc::clone(self);
        start(async move {
            if !me.verify_answer(&host).await {
                let _ = me.sync_now().await;
            }
        });
    }

    /// `sync()` from a continuation: the reads as they are now.
    async fn sync_now(self: &Rc<Self>) -> R<()> {
        let env = self.look(None, ALL).await?;
        self.sync(env);
        Ok(())
    }

    // ---- holds and flush -----------------------------------------------------------------------------------------

    fn hold(self: &Rc<Self>, tab: &str, action: Action, since: HeldFor) {
        self.st
            .borrow_mut()
            .waiting
            .insert(tab.to_owned(), Held { action, since });
        self.set_awaiting(tab, true);
        if self.online() {
            self.flush_started(true);
        }
    }

    /// The start of `flush()`, which runs in place: every held tab leaves the wait. `online` false: nothing is held
    /// on to. Returns what each of them goes on to run.
    fn flush_prefix(&self, online: bool) -> Vec<(String, Held)> {
        if !online {
            return Vec::new();
        }
        let held = self.st.borrow_mut().waiting.drain();
        for (tab, _) in &held {
            self.st.borrow_mut().taken_over_runs.remove(tab);
            self.set_awaiting(tab, false);
        }
        held
    }

    fn runs(self: &Rc<Self>, held: Vec<(String, Held)>) -> JoinAll {
        JoinAll {
            futures: held
                .into_iter()
                .map(|(tab, held)| {
                    let me = Rc::clone(self);
                    let since = self.baseline(&tab, held.since);
                    Some(Box::pin(async move {
                        let _ = me.run(tab, held.action, since).await;
                    }) as LocalFuture<()>)
                })
                .collect(),
        }
    }

    /// `void this.flush()`.
    fn flush_started(self: &Rc<Self>, online: bool) {
        let held = self.flush_prefix(online);
        if !held.is_empty() {
            let all = self.runs(held);
            start(all);
        }
    }

    /// The network is back (or already was): run every held continuation. The token is the promise main waits on.
    pub fn flush(self: &Rc<Self>, env: Env) -> Option<u64> {
        let online = env.online;
        self.stretch(env, |me| {
            let held = me.flush_prefix(online);
            if held.is_empty() {
                return None;
            }
            let token = me.next_id();
            let all = me.runs(held);
            let done = Rc::clone(me);
            start(async move {
                all.await;
                done.done(token);
            });
            Some(token)
        })
    }

    // ---- continuing ----------------------------------------------------------------------------------------------

    /// `void this.#run(…)`.
    /// A continuation counts the person's prompts from the instant it starts (`held.prompted ?? factFor(tab)?.prompted ??
    /// 0`); one that runs again keeps its first count. Read here, in the stretch that starts it, so the task itself asks
    /// nothing before its first wait on main.
    fn baseline(&self, tab: &str, since: HeldFor) -> HeldFor {
        let prompted = since
            .prompted
            .or_else(|| self.fact_for(tab).and_then(|fact| fact.prompted))
            .unwrap_or(0);
        HeldFor {
            prompted: Some(prompted),
            ..since
        }
    }

    fn start_run(self: &Rc<Self>, tab: String, action: Action, since: HeldFor) {
        let since = self.baseline(&tab, since);
        let me = Rc::clone(self);
        start(async move {
            let _ = me.run(tab, action, since).await;
        });
    }

    fn superseded(&self, ctx: &RunCtx) -> bool {
        ctx.own
            .as_ref()
            .is_some_and(|own| self.st.borrow().superseded.contains(&own.borrow().serial))
    }

    fn called_off(&self, ctx: &RunCtx) -> bool {
        self.cancel_gen(&ctx.tab) != ctx.generation || ctx.person_took_over.get()
    }

    /// A failed try (the omp failed to start, or no command got an answer) keeps the marker: the next `ready` of the
    /// tab tries again, up to the attempt bound, and past that the marker still waits in the file for the next launch.
    /// A try someone called off, a superseded one or one whose marker already left `pending` fails nothing.
    fn failed_try(&self, ctx: &RunCtx) -> Option<(u32, bool)> {
        let own = ctx.own.as_ref()?;
        let still = self
            .st
            .borrow()
            .pending
            .get(&ctx.tab)
            .is_some_and(|pending| Rc::ptr_eq(pending, own));
        if self.superseded(ctx) || self.called_off(ctx) || !still {
            return None;
        }
        let serial = own.borrow().serial;
        let mut st = self.st.borrow_mut();
        let attempt = st.failures.get(&serial).copied().unwrap_or(0) + 1;
        st.failures.insert(serial, attempt);
        Some((attempt, attempt < self.launch_attempts))
    }

    /// Also waits for a move whose command is on its way: its `touched` counts only once it answered. A move's
    /// call-off bumps the generation, so the end of this run reports `cancelled` (to Autopilot too).
    async fn stale(self: &Rc<Self>, ctx: &RunCtx) -> R<bool> {
        let env = self.settled(&ctx.tab, &["fact"]).await?;
        Ok(self.stretch(env, |me| {
            let fact = me.fact_for(&ctx.tab);
            match me.ends("continuing", &ctx.since, fact.as_ref()) {
                Some("moved") => me.drop_wait(&ctx.tab, false),
                Some("personsPrompt") => ctx.person_took_over.set(true),
                _ => {}
            }
            me.called_off(ctx)
        }))
    }

    /// Hands a tab's sidecar over (`pool.startTab`); with `listen` a status listener is attached at once when the omp
    /// is not ready yet and has not failed, which is `whenReady`'s own look at it.
    async fn start_tab(&self, tab: &str, listen: bool) -> R<Option<(Sidecar, Option<u64>)>> {
        let listener = listen.then(|| self.next_id());
        // A question main answers with a promise: what it wakes continues in the microtasks of its answer, wherever the
        // task that asks started.
        let answer = self
            .ask_later("startTab", json!({"tab": tab, "listener": listener}))
            .await?;
        let Some(map) = object(&answer) else {
            return Ok(None);
        };
        let sidecar = Sidecar {
            id: map.get("sidecar").and_then(Value::as_u64).unwrap_or(0),
            status: map
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            payload_status: map
                .get("payloadStatus")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            session_held: map
                .get("sessionHeld")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            rpc: map.get("rpc").and_then(Value::as_bool).unwrap_or(false),
        };
        let listening = map
            .get("listening")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(Some((sidecar, listening.then_some(listener).flatten())))
    }

    /// Resolves once the omp can take commands; false when it fails or exits, has already failed, or the wait is ended
    /// from outside (`end_ready_waits`). It carries no deadline: a spawn held by a worktree's `onStart` hook or a busy
    /// machine is slow, not failed, and the continuation goes on when the tab reads `ready`.
    async fn when_ready(&self, tab: &str, sidecar: &Sidecar, listener: Option<u64>) -> R<bool> {
        if sidecar.status == "ready" {
            return Ok(true);
        }
        // No further status comes on its own (`startTab` starts only an asleep tab), except for a session another omp
        // still holds: the tab opens it by itself once that omp lets go, so the continuation waits on.
        if sidecar.ended() {
            return Ok(false);
        }
        let (done, finished) = oneshot::channel();
        let wait = self.next_id();
        {
            let mut st = self.st.borrow_mut();
            st.waits.insert(
                wait,
                Wait {
                    tab: tab.to_owned(),
                    listener,
                    done: Some(done),
                },
            );
            if let Some(listener) = listener {
                st.listeners.insert(listener, Listener::Ready(wait));
            }
            let mut ids = st.ready_waits.get(tab).cloned().unwrap_or_default();
            ids.push(wait);
            st.ready_waits.insert(tab.to_owned(), ids);
        }
        Ok(finished.await.unwrap_or(false))
    }

    fn finish_wait(&self, wait: u64, ready: bool) {
        let Some(mut found) = self.st.borrow_mut().waits.remove(&wait) else {
            return;
        };
        if let Some(listener) = found.listener {
            self.st.borrow_mut().listeners.remove(&listener);
            self.push(json!({"k": "unlisten", "listener": listener}));
        }
        {
            let mut st = self.st.borrow_mut();
            if let Some(ids) = st.ready_waits.get(&found.tab).cloned() {
                let rest: Vec<u64> = ids.into_iter().filter(|id| *id != wait).collect();
                if rest.is_empty() {
                    st.ready_waits.remove(&found.tab);
                } else {
                    st.ready_waits.insert(found.tab.clone(), rest);
                }
            }
        }
        if let Some(done) = found.done.take() {
            let _ = done.send(ready);
        }
    }

    /// The tab closed or its continuation was called off: whatever still waits for its omp stops waiting.
    fn end_ready_waits(&self, tab: &str) {
        let waits = self
            .st
            .borrow()
            .ready_waits
            .get(tab)
            .cloned()
            .unwrap_or_default();
        for wait in waits {
            self.finish_wait(wait, false);
        }
    }

    async fn command(&self, target: Target<'_>, command: Value, timeout_ms: Option<f64>) -> R<Cmd> {
        let mut payload = json!({"command": command});
        match target {
            Target::Sidecar(id) => payload["sidecar"] = json!(id),
            Target::Tab(tab) => payload["tab"] = json!(tab),
        }
        if let Some(ms) = timeout_ms {
            payload["timeoutMs"] = json!(ms);
        }
        let answer = self.ask_later("command", payload).await?;
        Ok(if let Some(response) = answer.get("response") {
            Cmd::Response(response.clone())
        } else if answer.get("error").is_some() {
            Cmd::Error {
                text: answer["text"].as_str().unwrap_or_default().to_owned(),
                message: answer["error"].as_str().unwrap_or_default().to_owned(),
                timeout: answer["timeout"] == true,
            }
        } else {
            Cmd::None
        })
    }

    async fn run(self: Rc<Self>, tab: String, action: Action, held: HeldFor) -> R<bool> {
        let generation = self.cancel_gen(&tab);
        // The launch marker this continuation runs for; once a later exit of the tab's omp replaced it, the
        // continuation of the replacement owns the marker and the goal report.
        let own = self.st.borrow().pending.get(&tab).cloned();
        // A continuation held for one session and branch looks again when it starts and before every command it
        // sends: a change no sync() saw, one made while the omp started, or while a command took its minutes, ends it.
        let since = held;
        let ctx = RunCtx {
            tab: tab.clone(),
            action,
            since,
            generation,
            own,
            person_took_over: Cell::new(false),
        };
        let sidecar = if self.stale(&ctx).await? {
            None
        } else {
            self.start_tab(&tab, true).await?
        };
        let ready = match &sidecar {
            Some((sidecar, listener)) => self.when_ready(&tab, sidecar, *listener).await?,
            None => false,
        };
        if ready {
            self.stale(&ctx).await?;
        }
        if sidecar.is_none() || !ready || self.called_off(&ctx) {
            return self
                .not_continued(&ctx, sidecar.map(|(sidecar, _)| sidecar.id), ready)
                .await;
        }
        let Some((sidecar, _)) = sidecar else {
            return Ok(false);
        };
        // Whether any command got an answer, a refusal included: a continuation nothing answered failed, one omp
        // answered with nothing to continue is over.
        let mut answered = false;
        // Why a command did not answer: kept for the `continue` log line, never swallowed.
        let mut failures = Map::new();
        // omp outlives a killed OMPdesk long enough to close the turn itself: its RPC client is gone (stdin EOF), so a
        // pending ask or approval fails and the run ends aborted, journaled. Stock `restoreSession` then finds nothing
        // unfinished; stock `retry` replays that failed tool batch or the aborted reply. A turn that had ended
        // (`revive`) is never retried.
        let restored = if action == Action::Retry {
            None
        } else {
            self.send(
                &ctx,
                &sidecar,
                "restore_interrupted",
                &mut failures,
                &mut answered,
            )
            .await?
        };
        let retried = action != Action::Revive
            && !continues(restored.as_ref())
            && continues(
                self.send(&ctx, &sidecar, "retry", &mut failures, &mut answered)
                    .await?
                    .as_ref(),
            );
        let mut started = continues(restored.as_ref()) || retried;
        // A new session's first turn cut off before stock wrote its file left nothing to restore (its tab starts a
        // fresh session in the same folder): the prompt runs again. It leaves the marker before it is sent, so no
        // later continuation of this tab sends it a second time.
        let pending = self.st.borrow().pending.get(&tab).cloned();
        let unsaved_prompt = pending
            .as_ref()
            .and_then(|p| p.borrow().d.prompt.clone())
            .filter(|p| !p.is_empty());
        let mut prompt_sent = false;
        if let (Some(pending), Some(prompt)) = (&pending, &unsaved_prompt)
            && !started
            && !self.stale(&ctx).await?
        {
            pending.borrow_mut().d.prompt = None;
            let response = self
                .command(
                    Target::Sidecar(sidecar.id),
                    json!({"type": "prompt", "message": prompt}),
                    None,
                )
                .await?;
            prompt_sent = response.success();
            started = prompt_sent;
            // Unanswered and not a timeout (omp may have taken it): the prompt was not sent and goes on with the marker.
            match &response {
                Cmd::Response(_) => answered = true,
                Cmd::Error { timeout: true, .. } => answered = true,
                _ => pending.borrow_mut().d.prompt = Some(prompt.clone()),
            }
        }
        // Stock pauses an active goal when its session loads; one the restart cut off goes on, after the restored turn
        // (the goal's continuation waits for the session to be idle).
        let mut goal_resumed = false;
        if restored
            .as_ref()
            .and_then(|data| data.get("goalPausedByExit"))
            == Some(&Value::Bool(true))
            && !self.stale(&ctx).await?
        {
            match self.resume_goal(&tab).await? {
                Ok(()) => {
                    started = true;
                    goal_resumed = true;
                }
                Err(text) => self.push(
                    json!({"k": "warn", "message": format!("[resume] goal resume failed for {tab}: {text}")}),
                ),
            }
        }
        let env = self.look(Some(&tab), ALL).await?;
        let unanswered = if started || answered {
            None
        } else {
            self.stretch(env.clone(), |me| me.failed_try(&ctx))
        };
        Ok(self.stretch(env, |me| {
            let opened = opened_running(&me.read_env(|env| env.facts.clone()), &tab);
            let mut details = Map::new();
            details.insert("tab".into(), json!(tab));
            details.insert("action".into(), json!(action.name()));
            details.insert(
                "restored".into(),
                json!(if action == Action::Retry {
                    "skipped".to_owned()
                } else {
                    restore_summary(restored.as_ref())
                }),
            );
            details.insert("retried".into(), json!(retried));
            details.insert("prompt".into(), json!(prompt_sent));
            details.insert("goal".into(), json!(goal_resumed));
            details.insert("started".into(), json!(started));
            if restored.as_ref().and_then(|data| data.get("followUp")) == Some(&Value::Bool(true)) {
                details.insert("followUp".into(), json!(true));
            }
            // The bridge closed a turn stock's journal showed ended before its model call.
            if restored
                .as_ref()
                .and_then(|data| data.get("cutBeforeRequest"))
                == Some(&Value::Bool(true))
            {
                details.insert("cutBeforeRequest".into(), json!(true));
            }
            // What the restore judged when nothing went on: the journal's last message and exit record.
            if !started
                && let Some(journal) = restored
                    .as_ref()
                    .and_then(|data| data.get("journal"))
                    .filter(|j| j.is_string())
            {
                details.insert("journal".into(), journal.clone());
            }
            if opened > 0 {
                details.insert("opened".into(), json!(opened));
            }
            details.extend(failures);
            if let Some((attempt, retrying)) = unanswered {
                details.insert("attempt".into(), json!(attempt));
                details.insert("retrying".into(), json!(retrying));
            }
            if me.called_off(&ctx) {
                details.insert("cancelled".into(), json!(true));
            }
            if me.superseded(&ctx) {
                details.insert("superseded".into(), json!(true));
            }
            me.log("continue", details);
            if me.superseded(&ctx) {
                return false;
            }
            if let (Some((_, retrying)), Some(own)) = (unanswered, &ctx.own) {
                me.keep_failed(&tab, own, action, &ctx.since, sidecar.id, retrying);
                return false;
            }
            me.goal_settled(
                &tab,
                if goal_resumed {
                    "resumed"
                } else if me.called_off(&ctx) {
                    "cancelled"
                } else {
                    "none"
                },
            );
            // Nothing left to continue: the marker has nothing more to say.
            if !started {
                me.st.borrow_mut().pending.remove(&tab);
            }
            me.sync_inner();
            started
        }))
    }

    /// The continuation ended before it sent anything: the tab is gone, its omp failed to start, or it was called off.
    async fn not_continued(
        self: &Rc<Self>,
        ctx: &RunCtx,
        sidecar: Option<u64>,
        ready: bool,
    ) -> R<bool> {
        let env = self.look(Some(&ctx.tab), ALL).await?;
        Ok(self.stretch(env, |me| {
            let failed = if sidecar.is_some() && !ready {
                me.failed_try(ctx)
            } else {
                None
            };
            let mut details = Map::new();
            details.insert("tab".into(), json!(ctx.tab));
            details.insert("action".into(), json!(ctx.action.name()));
            details.insert("ready".into(), json!(ready));
            details.insert("cancelled".into(), json!(me.called_off(ctx)));
            if let Some((attempt, retrying)) = failed {
                details.insert("attempt".into(), json!(attempt));
                details.insert("retrying".into(), json!(retrying));
            }
            if me.superseded(ctx) {
                details.insert("superseded".into(), json!(true));
            }
            me.log("continue", details);
            if me.superseded(ctx) {
                return false;
            }
            if let (Some(sidecar), Some(own), Some((_, retrying))) = (sidecar, &ctx.own, failed) {
                me.keep_failed(&ctx.tab, own, ctx.action, &ctx.since, sidecar, retrying);
                return false;
            }
            me.st.borrow_mut().pending.remove(&ctx.tab);
            me.goal_settled(
                &ctx.tab,
                if me.called_off(ctx) {
                    "cancelled"
                } else {
                    "none"
                },
            );
            me.sync_inner();
            false
        }))
    }

    /// A launch continuation that failed keeps its marker (so `sync()` keeps writing it and the next launch finds it):
    /// it runs again once the tab's omp next reads `ready`, or, its attempts used up, is left for the next launch. Its
    /// goal hears nothing while it waits; an abandoned one tells `none` and its "continuing" row goes.
    fn keep_failed(
        self: &Rc<Self>,
        tab: &str,
        marker: &Mk,
        action: Action,
        since: &HeldFor,
        sidecar: u64,
        retrying: bool,
    ) {
        if retrying {
            let listener = self.next_id();
            let serial = marker.borrow().serial;
            {
                let mut st = self.st.borrow_mut();
                st.listeners.insert(
                    listener,
                    Listener::Retry {
                        tab: tab.to_owned(),
                        action,
                        since: since.clone(),
                    },
                );
                st.retrying.insert(
                    tab.to_owned(),
                    Retrying {
                        marker: serial,
                        listener,
                    },
                );
            }
            self.push(json!({"k": "listen", "listener": listener, "sidecar": sidecar}));
        } else {
            self.st
                .borrow_mut()
                .abandoned
                .insert(marker.borrow().serial);
            self.goal_settled(tab, "none");
        }
        self.sync_inner();
    }
}

/// Something goes on: the cut-off turn, a revived subagent (the bridge tells an idle session about it in one follow-up
/// turn), the agent told about the background jobs the restart stopped, a cut-off turn stock's retry cannot see (the
/// bridge continues it with that follow-up), or stock's retry.
fn continues(data: Option<&Map<String, Value>>) -> bool {
    let Some(data) = data else { return false };
    let listed =
        |key: &str| matches!(data.get(key), Some(Value::Array(items)) if !items.is_empty());
    data.get("turn") == Some(&Value::Bool(true))
        || data.get("retried") == Some(&Value::Bool(true))
        || data.get("followUp") == Some(&Value::Bool(true))
        || listed("subagents")
        || listed("jobs")
}

// ---- commands to a tab's omp ---------------------------------------------------------------------------------------

impl Inst {
    /// One of the continuation's commands (`restore_interrupted`, `retry`): `None` when a move or a call-off came
    /// first, or the command did not answer; the answer's data otherwise.
    async fn send(
        self: &Rc<Self>,
        ctx: &RunCtx,
        sidecar: &Sidecar,
        kind: &str,
        failures: &mut Map<String, Value>,
        answered: &mut bool,
    ) -> R<Option<Map<String, Value>>> {
        if self.stale(ctx).await? {
            return Ok(None);
        }
        let key = if kind == "retry" { "retry" } else { "restore" };
        let response = self
            .command(
                Target::Sidecar(sidecar.id),
                json!({"type": kind}),
                Some(self.command_timeout_ms),
            )
            .await?;
        match &response {
            Cmd::Error { message, .. } => {
                failures.insert(format!("{key}Error"), json!(message));
                return Ok(None);
            }
            Cmd::None => {
                failures.insert(
                    format!("{key}Error"),
                    json!("the tab has no omp connection"),
                );
            }
            Cmd::Response(reply) => {
                *answered = true;
                if reply["success"] != true {
                    failures.insert(format!("{key}Error"), reply["error"].clone());
                    if reply["code"].as_str().is_some_and(|code| !code.is_empty()) {
                        failures.insert(format!("{key}Code"), reply["code"].clone());
                    }
                }
            }
        }
        Ok(response.data())
    }

    /// Resumes a goal stock paused at startup although it was active when the last process ended: the injected
    /// `resumeGoal`, else stock's own resume through the tab's `set_goal`. The error is what `String(error)` said.
    async fn resume_goal(&self, tab: &str) -> R<Result<(), String>> {
        if self.has_resume_goal {
            let answer = self.ask_later("resumeGoal", json!({"tab": tab})).await?;
            return Ok(match answer.get("error") {
                Some(text) => Err(text.as_str().unwrap_or_default().to_owned()),
                None => Ok(()),
            });
        }
        Ok(
            match self
                .command(
                    Target::Tab(tab),
                    json!({"type": "set_goal", "action": "resume"}),
                    None,
                )
                .await?
            {
                Cmd::Response(reply) if reply["success"] == true => Ok(()),
                Cmd::Response(reply) => Err(format!(
                    "Error: {}",
                    reply["error"].as_str().unwrap_or("the tab is gone")
                )),
                Cmd::None => Err("Error: the tab is gone".to_owned()),
                Cmd::Error { text, .. } => Err(text),
            },
        )
    }

    /// Stock's own `retry.enabled` (the user's switch for retrying): unreadable or off means we do not retry either.
    async fn stock_retry_on(&self, tab: &str) -> R<bool> {
        let answer = self
            .command(
                Target::Tab(tab),
                json!({"type": "get_settings", "paths": ["retry.enabled"]}),
                None,
            )
            .await?;
        Ok(answer
            .data()
            .and_then(|data| data.get("values").cloned())
            .is_some_and(|values| values["retry.enabled"] == true))
    }

    /// What a limit wait reads from its tab's omp, none of it a request to a provider's model: stock's retry switch
    /// and fallback chains, the session's model, and stock's cached usage reports. `None` when the tab is gone.
    async fn read_limit(&self, tab: &str) -> R<Option<LimitReading>> {
        let Some((sidecar, _)) = self.start_tab(tab, false).await? else {
            return Ok(None);
        };
        if !sidecar.rpc {
            return Ok(None);
        }
        let (me, id) = (self, sidecar.id);
        let read = |command: Value| async move {
            // A command that failed or did not answer says nothing.
            me.command(Target::Sidecar(id), command, None)
                .await
                .map(|answer| answer.data())
        };
        let (settings, state, usage) = tokio::join!(
            read(
                json!({"type": "get_settings", "paths": ["retry.enabled", "retry.fallbackChains"]})
            ),
            read(json!({"type": "get_state", "brief": true})),
            read(json!({"type": "get_usage"})),
        );
        let (settings, state, usage) = (settings?, state?, usage?);
        let values = settings
            .as_ref()
            .and_then(|data| data.get("values"))
            .cloned()
            .unwrap_or(Value::Null);
        let model = state
            .as_ref()
            .and_then(|data| data.get("model"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut reading = LimitReading {
            on: values["retry.enabled"] == true,
            setup: None,
            provider: model["provider"].as_str().map(str::to_owned),
            reports: usage
                .as_ref()
                .and_then(|data| data.get("reports"))
                .and_then(Value::as_array)
                .cloned(),
        };
        // A read that failed says nothing about the setup: never a change.
        if settings.is_some() && state.is_some() {
            let chains = values
                .get("retry.fallbackChains")
                .cloned()
                .unwrap_or(Value::Null);
            reading.setup = Some(
                Value::Array(vec![
                    model.get("provider").cloned().unwrap_or(Value::Null),
                    model.get("id").cloned().unwrap_or(Value::Null),
                    chains,
                ])
                .to_string(),
            );
        }
        Ok(Some(reading))
    }
}

// ---- scheduled retries ---------------------------------------------------------------------------------------------

impl Inst {
    fn is_scheduled(&self, tab: &str, armed: &Ar) -> bool {
        self.st
            .borrow()
            .scheduled
            .get(tab)
            .is_some_and(|found| Rc::ptr_eq(found, armed))
    }

    /// The tab as it is once stock answered, if the retry may still be armed for it.
    fn still_owed(
        &self,
        tab: &str,
        outcome: &RunOutcome,
        limit: bool,
        generation: u64,
        on: bool,
    ) -> Option<Fact> {
        let current = self.fact_for(tab)?;
        if !on || self.cancel_gen(tab) != generation {
            return None;
        }
        if self.st.borrow().scheduled.contains(tab) || !self.may_retry(&current, outcome, limit) {
            return None;
        }
        Some(current)
    }

    /// The tab's failed turn ended: arm the next backoff attempt when the failure is transient, or the wait for a
    /// provider's limit (never one another owner waits out), and nothing says no.
    fn plan_retry(self: &Rc<Self>, fact: &Fact, outcome: RunOutcome) {
        let tab = fact.tab_id.clone();
        let message = outcome.error_message.as_deref();
        let limit = is_limit_error(message) && !fact.limit_held;
        if !limit && !is_transient_error(message) {
            self.st.borrow_mut().attempts.remove(&tab);
            return;
        }
        let used = self.st.borrow().attempts.get(&tab).copied().unwrap_or(0);
        if !self.may_retry(fact, &outcome, limit) {
            return;
        }
        let generation = self.cancel_gen(&tab);
        let failed_at = self.now();
        let me = Rc::clone(self);
        start(async move {
            let _ = me
                .planned(tab, outcome, used, generation, failed_at, limit)
                .await;
        });
    }

    async fn planned(
        self: Rc<Self>,
        tab: String,
        outcome: RunOutcome,
        used: u32,
        generation: u64,
        failed_at: f64,
        limit: bool,
    ) -> R<()> {
        if !limit {
            let on = self.stock_retry_on(&tab).await?;
            let env = self.look(Some(&tab), &["fact", "now"]).await?;
            self.stretch(env, |me| {
                if let Some(current) = me.still_owed(&tab, &outcome, false, generation, on) {
                    me.arm(&current, &outcome, used, None);
                }
            });
            return Ok(());
        }
        let reading = self.read_limit(&tab).await?;
        let env = self.look(Some(&tab), ALL).await?;
        self.stretch(env, |me| {
            let current = me.still_owed(
                &tab,
                &outcome,
                true,
                generation,
                reading.as_ref().is_some_and(|r| r.on),
            );
            let (Some(current), Some(reading)) = (current, reading.as_ref()) else {
                return;
            };
            // The wait the provider named counts from the failure; without one, its first reset, else a short fallback.
            let reports = reading.reports.clone().unwrap_or_default();
            let hinted = retry_after_ms(outcome.error_message.as_deref());
            let now = me.now();
            let reset = quota_reset_at(&reports, reading.provider.as_deref(), now);
            let at = match hinted {
                Some(hint) => failed_at + hint,
                None => quota_wait_until(
                    &reports,
                    reading.provider.as_deref(),
                    now,
                    me.quota_fallback_ms,
                ),
            };
            if !me.arm(&current, &outcome, used, Some((at, reading.setup.clone()))) {
                return;
            }
            let mut details = Map::new();
            details.insert("tab".into(), json!(tab));
            details.insert(
                "session".into(),
                json!(current.session_file.clone().unwrap_or_default()),
            );
            details.insert("wait".into(), json!("armed"));
            details.insert(
                "by".into(),
                json!(if hinted.is_some() {
                    "retry-after"
                } else if reset.is_some() {
                    "usage"
                } else {
                    "fallback"
                }),
            );
            details.insert("ms".into(), json!((at - failed_at).max(0.0)));
            if let Some(peer) = current.peer.as_ref().filter(|peer| !peer.is_empty()) {
                details.insert("peer".into(), json!(peer));
            }
            me.log("limit", details);
            // The marker says `limit` now, so a relaunch during the wait takes the turn up again.
            me.sync_inner();
        });
        Ok(())
    }

    /// Arm the tab's retry: the next backoff step, or with `limit` the wait until a provider's limit is expected
    /// gone, which looks earlier whether it lifted (`look_task`). False when the tab has no session file.
    fn arm(
        &self,
        fact: &Fact,
        outcome: &RunOutcome,
        used: u32,
        limit: Option<(f64, Option<String>)>,
    ) -> bool {
        // Past the last listed wait the last one repeats: no attempt is the final one.
        let Some(delay) = self
            .delays
            .get((used as usize).min(self.delays.len().saturating_sub(1)))
            .copied()
        else {
            return false;
        };
        let Some(session_file) = fact.session_file.clone() else {
            return false;
        };
        let tab = fact.tab_id.clone();
        let armed = Rc::new(RefCell::new(Armed {
            at: limit.as_ref().map_or(self.now() + delay, |(at, _)| *at),
            attempt: used + 1,
            outcome: outcome.clone(),
            session_file,
            touched: fact.touched(),
            timer: None,
            limit: false,
            setup: None,
        }));
        if let Some((_, setup)) = &limit {
            {
                let mut armed = armed.borrow_mut();
                armed.limit = true;
                if setup.is_some() {
                    armed.setup = setup.clone();
                }
            }
            self.await_look(&tab, &armed, false);
        } else {
            let timer = self.schedule(delay, Timer::Fire(tab.clone(), Rc::clone(&armed)));
            armed.borrow_mut().timer = Some(timer);
        }
        let (at, attempt, is_limit) = {
            let armed = armed.borrow();
            (armed.at, armed.attempt, armed.limit)
        };
        self.st.borrow_mut().scheduled.insert(tab.clone(), armed);
        let mut retry = json!({"at": at, "attempt": attempt});
        if is_limit {
            retry["limit"] = json!(true);
        }
        self.push(json!({"k": "setScheduled", "tab": tab, "retry": retry}));
        true
    }

    /// A limit wait's timer: its time when that is near, else the next look. `again`: the wait is due but cannot be
    /// tried yet (the tab is busy), so it looks again a pace later, never at once.
    fn await_look(&self, tab: &str, armed: &Ar, again: bool) {
        let pace = self.limit_look_ms;
        let until_due = armed.borrow().at - self.now();
        let ms = if until_due > 0.0 {
            until_due.min(pace)
        } else if again {
            pace
        } else {
            0.0
        };
        let timer = self.schedule(ms, Timer::Look(tab.to_owned(), Rc::clone(armed)));
        // The look that just ran leaves its timer behind, as the TypeScript dropped a handle it replaced: main may let go.
        let before = armed.borrow_mut().timer.replace(timer);
        if let Some(before) = before {
            self.push(json!({"k": "forgetTimer", "timer": before}));
        }
    }

    /// A limit wait's timer ran. At its time the retry fires. Before it this is a look: the tab's omp is read, and the
    /// retry fires early when stock's usage reports no longer say the provider is limited or the session's model or
    /// fallback chains changed. Otherwise nothing changes but the timer. While the failed turn's background work
    /// keeps the tab running, the wait holds too and looks again.
    async fn look_task(self: Rc<Self>, tab: String, armed: Ar) -> R<()> {
        if !self.is_scheduled(&tab, &armed) {
            return Ok(());
        }
        enum Step {
            Done,
            Read,
            Fire,
        }
        // The first wait of a task a timer starts: a question answered with a promise, so what it wakes continues in
        // the microtasks of its answer (a plain answer inside the timer's call would wake it in a later turn).
        let env = Self::parse_env(
            self.ask_later("look", json!({"tab": tab, "want": ALL}))
                .await?,
        )?;
        let step = self.stretch(env, |me| {
            // What ends the wait without a sync of its own (another session file on an idle tab) ends it at the next look.
            me.sync_inner();
            if !me.is_scheduled(&tab, &armed) {
                return Step::Done;
            }
            if me.fact_for(&tab).is_some_and(|fact| fact.running) {
                me.await_look(&tab, &armed, true);
                return Step::Done;
            }
            if me.now() < armed.borrow().at {
                Step::Read
            } else {
                Step::Fire
            }
        });
        let mut why = "due";
        match step {
            Step::Done => return Ok(()),
            Step::Fire => {}
            Step::Read => {
                let reading = self.read_limit(&tab).await?;
                let env = self.look(Some(&tab), &["now"]).await?;
                let decided = self.stretch(env, |me| {
                    // Called off while the omp answered: whoever ended the wait also ended its timer.
                    if !me.is_scheduled(&tab, &armed) {
                        return None;
                    }
                    let setup = reading.as_ref().and_then(|reading| reading.setup.clone());
                    {
                        let mut armed = armed.borrow_mut();
                        if armed.setup.is_none() && setup.is_some() {
                            armed.setup = setup.clone();
                        }
                    }
                    // Only a read that names the session's provider can say its limit is gone.
                    let lifted = reading.as_ref().is_some_and(|reading| {
                        reading.provider.is_some()
                            && reading.reports.as_ref().is_some_and(|reports| {
                                quota_reset_at(reports, reading.provider.as_deref(), me.now())
                                    .is_none()
                            })
                    });
                    if setup.is_some() && setup != armed.borrow().setup {
                        Some("setup")
                    } else if lifted {
                        Some("usage")
                    } else {
                        me.await_look(&tab, &armed, false);
                        None
                    }
                });
                let Some(reason) = decided else { return Ok(()) };
                why = reason;
            }
        }
        let mut details = Map::new();
        details.insert("tab".into(), json!(tab));
        details.insert("session".into(), json!(armed.borrow().session_file));
        details.insert(
            "wait".into(),
            json!(if why == "due" { "due" } else { "lifted" }),
        );
        if why != "due" {
            details.insert("by".into(), json!(why));
        }
        self.log("limit", details);
        self.fire(tab, armed).await
    }

    fn still_holds(&self, tab: &str, armed: &Ar) -> bool {
        self.is_scheduled(tab, armed)
            && self
                .ends(
                    "firing",
                    &armed.borrow().held(),
                    self.fact_for(tab).as_ref(),
                )
                .is_none()
    }

    /// The armed retry's timer: re-check everything, then send stock `retry` (or hand it to the connection wait when
    /// offline).
    async fn fire(self: Rc<Self>, tab: String, armed: Ar) -> R<()> {
        if !self.is_scheduled(&tab, &armed) {
            return Ok(());
        }
        let env = self.settled(&tab, &["fact"]).await?;
        let mut proceed: Option<Env> = None;
        if self.stretch(env, |me| me.still_holds(&tab, &armed)) && self.stock_retry_on(&tab).await?
        {
            let env = self.look(Some(&tab), ALL).await?;
            if self.stretch(env.clone(), |me| me.still_holds(&tab, &armed)) {
                proceed = Some(env);
            }
        }
        let Some(env) = proceed else {
            if self.is_scheduled(&tab, &armed) {
                self.drop_scheduled(&tab);
                // A limit wait's marker goes with it: the relaunch must not retry a turn that was let go.
                if armed.borrow().limit {
                    self.sync_now().await?;
                }
            }
            return Ok(());
        };
        let held = self.stretch(env, |me| {
            me.release_scheduled(&tab);
            {
                let mut st = me.st.borrow_mut();
                st.attempts.insert(tab.clone(), armed.borrow().attempt);
                st.own_retries.insert(tab.clone());
            }
            let since = {
                let armed = armed.borrow();
                HeldFor {
                    session_file: Some(armed.session_file.clone()),
                    touched: armed.touched,
                    ..HeldFor::default()
                }
            };
            if me.online() {
                return Some(me.baseline(&tab, since));
            }
            me.hold(&tab, Action::Retry, since);
            // The marker says `network` now, so a crash during the wait still retries.
            me.sync_inner();
            None
        });
        let Some(since) = held else { return Ok(()) };
        // Stock has nothing to retry (or the call failed): the chain is over. A move while its omp comes up calls it off.
        if !Rc::clone(&self)
            .run(tab.clone(), Action::Retry, since)
            .await?
        {
            let mut st = self.st.borrow_mut();
            st.own_retries.remove(&tab);
            st.attempts.remove(&tab);
        }
        Ok(())
    }

    fn release_scheduled(&self, tab: &str) {
        let armed = self.st.borrow().scheduled.get(tab).cloned();
        let Some(armed) = armed else { return };
        let timer = armed.borrow().timer;
        if let Some(timer) = timer {
            self.st.borrow_mut().timers.remove(&timer);
            self.push(json!({"k": "cancelTimer", "timer": timer}));
        }
        self.st.borrow_mut().scheduled.remove(tab);
        self.push(json!({"k": "setScheduled", "tab": tab, "retry": null}));
    }

    /// Call the tab's armed retry off: its timer, its row, and any attempt already on its way.
    fn drop_scheduled(&self, tab: &str) {
        if !self.st.borrow().scheduled.contains(tab) {
            return;
        }
        self.bump_cancel(tab);
        self.release_scheduled(tab);
        self.st.borrow_mut().attempts.remove(tab);
    }

    /// A timer main ran: the armed retry's, or a limit wait's look.
    pub fn on_timer(self: &Rc<Self>, timer: u64) {
        let task = self.st.borrow_mut().timers.remove(&timer);
        let me = Rc::clone(self);
        match task {
            Some(Timer::Fire(tab, armed)) => start(async move {
                let _ = me.fire(tab, armed).await;
            }),
            Some(Timer::Look(tab, armed)) => start(async move {
                let _ = me.look_task(tab, armed).await;
            }),
            None => {}
        }
    }
}

// ---- public methods ------------------------------------------------------------------------------------------------

impl Inst {
    /// Call a tab's wait off: its probe, its held continuation, its scheduled retry. A held launch continuation (a
    /// marker in `pending` with its wait) ends for Autopilot's goal too (`cancelled`): the run waited on this very
    /// continuation. `report_goal` false for a call-off inside the continuation's own `run`, which reports when it ends.
    fn drop_wait(&self, tab: &str, report_goal: bool) {
        let retry = self
            .st
            .borrow()
            .retrying
            .get(tab)
            .map(|retry| retry.listener);
        if let Some(listener) = retry {
            self.retry_off(tab, listener);
        }
        let held_launch = {
            let st = self.st.borrow();
            (st.waiting.contains(tab) || retry.is_some()) && st.pending.contains(tab)
        };
        self.bump_cancel(tab);
        self.end_ready_waits(tab);
        {
            let mut st = self.st.borrow_mut();
            st.waiting.remove(tab);
            st.probing.remove(tab);
            st.taken_over_runs.remove(tab);
            st.pending.remove(tab);
            st.own_retries.remove(tab);
        }
        self.release_scheduled(tab);
        self.set_awaiting(tab, false);
        if held_launch && report_goal {
            self.goal_settled(tab, "cancelled");
        }
    }

    /// The user's Cancel on the waiting row: the failure shows as it would have, nothing resumes.
    pub async fn cancel_wait(self: &Rc<Self>, tab: &str) -> R<()> {
        self.drop_wait(tab, true);
        self.sync_now().await
    }

    /// The resuming row's Stop: abort what this launch resumed on the tab, drop what still waits. Answers the token
    /// of the abort's promise.
    pub async fn stop_resumed(self: &Rc<Self>, tab: &str) -> R<u64> {
        // The pool's hook runs the rules' `sync()` inside it, as `onRunningChange` does.
        self.ask("noteStopped", json!({"tab": tab})).await?;
        self.cancel_wait(tab).await?;
        self.push(json!({"k": "turnStop", "tab": tab}));
        let token = self.next_id();
        let me = Rc::clone(self);
        let tab = tab.to_owned();
        start(async move {
            let _ = me
                .command(Target::Tab(&tab), json!({"type": "abort"}), None)
                .await;
            me.done(token);
        });
        Ok(token)
    }

    /// How a tab whose omp came up with work running in its journal goes on: after this launch's continuation of its
    /// cut-off turn (a launch marker waits for it, `goalSettled` follows), at once, or not at all.
    pub fn relaunch_continuation(&self, tab: &str, enabled: bool) -> &'static str {
        let st = self.st.borrow();
        if let Some(pending) = st.pending.get(tab)
            && !st.abandoned.contains(&pending.borrow().serial)
        {
            return "after_restore";
        }
        if enabled { "now" } else { "off" }
    }

    /// A status event of a sidecar main listens to for this instance.
    pub async fn on_status(
        self: &Rc<Self>,
        listener: u64,
        status: &str,
        session_held: bool,
    ) -> R<()> {
        let kind = self.st.borrow().listeners.get(&listener).cloned();
        match kind {
            None => Ok(()),
            Some(Listener::Ready(wait)) => {
                if status == "ready" {
                    self.finish_wait(wait, true);
                } else if (status == "error" && !session_held) || status == "exited" {
                    self.finish_wait(wait, false);
                }
                Ok(())
            }
            Some(Listener::Retry { tab, action, since }) => {
                if status != "ready" {
                    return Ok(());
                }
                self.retry_off(&tab, listener);
                let env = self.look(None, ALL).await?;
                self.stretch(env, |me| {
                    if me.frozen() {
                        return;
                    }
                    if !me.enabled() {
                        me.st.borrow_mut().pending.remove(&tab);
                        me.goal_settled(&tab, "none");
                        me.sync_inner();
                        return;
                    }
                    me.start_run(tab.clone(), action, since.clone());
                });
                Ok(())
            }
        }
    }

    /// Once per launch, after the saved windows exist: continue what the last process left running. Markers keep
    /// their file until their turns start.
    pub async fn launch(self: &Rc<Self>) -> R<()> {
        let read = self.ask("launchRead", json!({})).await?;
        let all: Vec<MarkerData> =
            serde_json::from_value(read["markers"].clone()).unwrap_or_default();
        let deleted: Vec<bool> =
            serde_json::from_value(read["deleted"].clone()).unwrap_or_default();
        let enabled = read["enabled"] == true;
        // A session the user deleted is not continued, not even into a fresh tab in its folder; its marker goes. A
        // never-written session (a first turn cut off before its file) has no tombstone and still continues below.
        let markers: Vec<MarkerData> = all
            .iter()
            .enumerate()
            .filter(|(at, _)| !deleted.get(*at).copied().unwrap_or(false))
            .map(|(_, marker)| marker.clone())
            .collect();
        if markers.len() != all.len() {
            self.push(json!({"k": "storeWrite", "markers": markers}));
        }
        self.st.borrow_mut().launched = true;
        self.log(
            "launch",
            [
                ("markers".to_owned(), json!(markers.len())),
                ("enabled".to_owned(), json!(enabled)),
            ]
            .into_iter()
            .collect(),
        );
        if !enabled {
            self.push(json!({"k": "storeWrite", "markers": []}));
            return Ok(());
        }
        let mut resumable: Vec<(String, Action)> = Vec::new();
        for marker in &markers {
            let action = launch_action(marker);
            let found = self
                .ask(
                    "tabForSession",
                    json!({"session": marker.session_path, "peer": marker.peer}),
                )
                .await?
                .as_str()
                .filter(|tab| !tab.is_empty())
                .map(str::to_owned);
            let unwritten = if found.is_none() {
                self.unwritten_session_tab(marker).await?
            } else {
                None
            };
            let tab_id = match found.clone().or_else(|| unwritten.clone()) {
                Some(tab) => Some(tab),
                None => self
                    .ask("openTab", json!({"marker": marker}))
                    .await?
                    .as_str()
                    .filter(|tab| !tab.is_empty())
                    .map(str::to_owned),
            };
            let mut details = Map::new();
            details.insert("session".into(), json!(marker.session_path));
            details.insert("reason".into(), json!(marker.reason));
            details.insert(
                "tab".into(),
                json!(tab_id.clone().unwrap_or_else(|| "none".to_owned())),
            );
            details.insert(
                "via".into(),
                json!(if found.is_some() {
                    "layout"
                } else if unwritten.is_some() {
                    "unwritten"
                } else if tab_id.is_some() {
                    "opened"
                } else {
                    "none"
                }),
            );
            if let Some(peer) = marker.peer.as_ref().filter(|peer| !peer.is_empty()) {
                details.insert("peer".into(), json!(peer));
            }
            self.log("marker", details);
            let Some(tab) = tab_id else { continue };
            resumable.push((tab.clone(), action));
            let next = self.marker(MarkerData {
                tab: tab.clone(),
                ..marker.clone()
            });
            self.st.borrow_mut().pending.insert(tab, next);
        }
        let (previous, rows) = {
            let st = self.st.borrow();
            let previous: Vec<Mk> = st.pending.values().cloned().collect();
            let rows: Vec<MarkerData> = previous.iter().map(|m| m.borrow().d.clone()).collect();
            (previous, rows)
        };
        self.st.borrow_mut().previous = previous;
        self.push(json!({"k": "storeWrite", "markers": rows}));
        self.show_resuming();
        let tabs: Vec<&String> = resumable.iter().map(|(tab, _)| tab).collect();
        let ranks: Vec<f64> =
            serde_json::from_value(self.ask("resumeRank", json!({"tabs": tabs})).await?)
                .unwrap_or_default();
        let mut ordered: Vec<(f64, String, Action)> = resumable
            .into_iter()
            .enumerate()
            .map(|(at, (tab, action))| (ranks.get(at).copied().unwrap_or(0.0), tab, action))
            .collect();
        ordered.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (_, tab, action) in ordered {
            // The continuation holds for the session the tab shows now (the marker's file; none yet for a first turn
            // stock never wrote) and its `touched`, so a session or branch change before the connection is back, or
            // while the omp comes up and the restore runs, ends it as it ends a failed turn's wait.
            let env = self.look(Some(&tab), &["fact", "network"]).await?;
            self.stretch(env, |me| {
                let fact = me.fact_for(&tab);
                let since = HeldFor {
                    session_file: match &fact {
                        Some(fact) => fact.session_file.clone(),
                        None => me
                            .st
                            .borrow()
                            .pending
                            .get(&tab)
                            .map(|m| m.borrow().d.session_path.clone()),
                    },
                    touched: fact.as_ref().map_or(0, Fact::touched),
                    ..HeldFor::default()
                };
                if me.should_wait() {
                    me.hold(&tab, action, since);
                } else {
                    me.start_run(tab.clone(), action, since);
                }
            });
        }
        Ok(())
    }

    /// The tab the saved layout restored for a session stock never wrote (a first turn cut off before its first
    /// assistant message): the layout drops a missing path, so that tab came back as a fresh session in the same
    /// folder. It is an unclaimed local tab there with no session file yet and nothing running; `None` when there is
    /// none, and `openTab` opens one.
    async fn unwritten_session_tab(&self, marker: &MarkerData) -> R<Option<String>> {
        if truthy(&marker.peer) || std::path::Path::new(&marker.session_path).exists() {
            return Ok(None);
        }
        let env = self.look(None, &["facts"]).await?;
        let candidates: Vec<Fact> = env
            .facts
            .into_iter()
            .filter(|fact| {
                !truthy(&fact.device)
                    && !truthy(&fact.peer)
                    && fact.session_file.is_none()
                    && !fact.running
                    && fact.kind == marker.kind
                    && !self.st.borrow().pending.contains(&fact.tab_id)
            })
            .collect();
        if candidates.is_empty() {
            return Ok(None);
        }
        let mut paths = vec![marker.cwd.clone()];
        paths.extend(candidates.iter().map(|fact| fact.cwd.clone()));
        let canonical: Vec<String> =
            serde_json::from_value(self.ask("canonical", json!({"paths": paths})).await?)
                .unwrap_or_default();
        let Some(wanted) = canonical.first() else {
            return Ok(None);
        };
        Ok(candidates
            .iter()
            .enumerate()
            .find(|(at, _)| canonical.get(at + 1) == Some(wanted))
            .map(|(_, fact)| fact.tab_id.clone()))
    }
}
