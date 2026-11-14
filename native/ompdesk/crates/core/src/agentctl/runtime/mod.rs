//! What `AgentControlRuntime` (`src/main/agent-control/host.ts`) did over state the core now holds (9k): the sweep of
//! the opened sessions and its timers, the review board's settle-and-push, the redelivery of reports and messages
//! whose receiver's journal does not hold them, and a routine's wake-up waiting for its turn to start.
//!
//! What stays in main is what reads the pool, the windows, the preferences, the remote link or Electron: the
//! snapshot, the asks and tells of `service/host.rs`, and the few tells this module adds. Main hands the core every
//! tab activity (`agentRuntime.activity`, after pushing its snapshot, so the core reads main as it was at that
//! moment) and the core decides what it means:
//!
//! - a child's activity pushes its opener's review list after `review_settle_ms`, a finished child may close
//!   (`sweep_soon`, one `autoClose` pass per opener after `sweep_settle_ms`), a child's question card tells its
//!   opener, a released tab goes through `AgentControl::released`;
//! - every `sweep_ms` each opener with children is swept and its review read again (a merge or push outside the app
//!   is no tab activity), the mail outbox is sent again to the tabs holding its receivers' sessions, and so are the
//!   messages still owed (`redeliver_sends`).
//!
//! Tells to main: `reviewSent {tabId, review}` (to the windows showing the opener and the devices viewing it),
//! `nextPromptChildren {tabId, children}` (the opener's prompt suggestions), `closedChildren {rows}` (the list main
//! keeps after the deleted ones were dropped) and `wakeDone {runId, code, error?}`. Ask: `reach {sessionPath}`.
//!
//! Opened with the service (`agentControl.open` with a `runtime` section, which a test of the service alone leaves
//! out); the wire is `agentRuntime.*`, by the same port number.

mod activity;
mod review;
mod wake;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::journal::mail_outbox::{
    MailAnswer, MailOutbox, OutboxMail, RedeliverDeps, redeliver_mail,
};
use super::service::AgentControl;
use super::service::fail::{R, fail};
use super::service::host::{Host, HostState};
use super::service::types::{ClosedChild, ControlTab, DeviceState};
use crate::server::{Call, Fault, Registry, Reply, at_once};

pub use activity::Activity;

/// How the runtime waits; the defaults are the TypeScript's, a test shortens them.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeConfig {
    /// Opened sessions are looked at this often even without activity; 0 turns the timer off (`SWEEP_INTERVAL_MS`).
    pub sweep_ms: u64,
    /// A burst of tab activity becomes one auto-close pass after this (`SWEEP_SETTLE_MS`).
    pub sweep_settle_ms: u64,
    /// A child's activity comes in bursts; its review item is rebuilt (git runs) once it settles (`REVIEW_SETTLE_MS`).
    pub review_settle_ms: u64,
    /// A woken session that starts no turn on its routine's mail within this long fails that run (`WAKE_TURN_START_MS`).
    pub wake_turn_start_ms: u64,
}

impl Default for RuntimeConfig {
    fn default() -> RuntimeConfig {
        RuntimeConfig {
            sweep_ms: 10_000,
            sweep_settle_ms: 1_000,
            review_settle_ms: 400,
            wake_turn_start_ms: 120_000,
        }
    }
}

/// Every outside caller's id starts with this; no tab id does.
const OUTSIDE_PREFIX: &str = "outside:";

fn is_outside(id: &str) -> bool {
    id.starts_with(OUTSIDE_PREFIX)
}

/// What the runtime remembers between activities (`host.ts`' maps and sets).
#[derive(Default)]
struct Rt {
    /// Debounce timers of the review pushes, per parent tab.
    review_timers: HashMap<String, JoinHandle<()>>,
    /// The review list last sent per parent tab (JSON), so the timer pushes only what changed.
    review_sent: HashMap<String, String>,
    /// Child tab → the opener whose review list last named it: a child restored by a relaunch has its opener only in
    /// the pool, which forgets it with the tab, and its release must still reach that board.
    listed_in: HashMap<String, String>,
    /// Openers whose timer review is still reading git: the next tick skips them.
    sweep_reviews: HashSet<String>,
    /// Openers whose live read has not answered yet: a request meanwhile is dropped.
    live_reviews: HashSet<String>,
    /// Children whose running turn moved on since their last live read.
    moved: HashSet<String>,
    /// The running or waiting children last told to each parent's prompt suggestions (JSON).
    children_sent: HashMap<String, String>,
    /// Debounce timers of the auto-close passes, per opener tab.
    sweep_timers: HashMap<String, JoinHandle<()>>,
    redelivering: bool,
    /// A pass was asked for while one ran: it runs once more when that one ends.
    redeliver_again: bool,
    resending: bool,
    wakes: HashMap<String, wake::Wake>,
}

/// The runtime of one service.
pub struct Runtime {
    control: AgentControl,
    config: RuntimeConfig,
    rt: Mutex<Rt>,
}

static RUNTIMES: LazyLock<Mutex<HashMap<u64, Arc<Runtime>>>> = LazyLock::new(Default::default);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What no owed message names is swept from the attachment store this often.
const ATTACHMENT_SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);

/// Starts the runtime of `control` (opened as port `port`): its timer runs until the port closes.
pub fn start(control: AgentControl, port: u64, config: RuntimeConfig) -> Arc<Runtime> {
    let runtime = Arc::new(Runtime {
        control: control.clone(),
        config,
        rt: Mutex::new(Rt::default()),
    });
    lock(&RUNTIMES).insert(port, runtime.clone());
    let timer = runtime.clone();
    tokio::spawn(async move {
        let every = timer.config.sweep_ms;
        let ended = control.host.port().until_closed();
        tokio::pin!(ended);
        if every > 0 {
            let period = Duration::from_millis(every);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // What no owed message names any more goes: once now (a relaunch), then every hour.
            let mut sweeps = tokio::time::interval(ATTACHMENT_SWEEP_EVERY);
            sweeps.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    () = &mut ended => break,
                    _ = sweeps.tick() => {
                        let control = control.clone();
                        drop(tokio::task::spawn_blocking(move || {
                            control.sweep_attachments()
                        }));
                    }
                    _ = ticks.tick() => {
                        // What the pass reads of main is main as it is at the tick, not as it last pushed.
                        let pass = timer.clone();
                        tokio::spawn(async move {
                            let _ = pass.host().fresh().await;
                            pass.sweep_all();
                            pass.redeliver_mail();
                            pass.redeliver_sends();
                        });
                    }
                }
            }
        } else {
            ended.await;
        }
        timer.stop();
        lock(&RUNTIMES).remove(&port);
    });
    runtime
}

impl Runtime {
    fn rt(&self) -> MutexGuard<'_, Rt> {
        lock(&self.rt)
    }

    fn host(&self) -> &Host {
        &self.control.host
    }

    /// The port closed: nothing waits any more.
    fn stop(&self) {
        let mut rt = self.rt();
        for (_, timer) in rt.review_timers.drain() {
            timer.abort();
        }
        for (_, timer) in rt.sweep_timers.drain() {
            timer.abort();
        }
        for (_, wake) in rt.wakes.drain() {
            wake.cancel();
        }
    }

    // ---- redelivery -------------------------------------------------------------------------------------------------

    fn send_kept_mail(
        self: &Arc<Self>,
        outbox: Arc<MailOutbox>,
        tab: String,
        mail: OutboxMail,
    ) -> JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            if let Some(answer) = (MailTabs { host: me.host() }).send(&tab, &mail).await
                && answer.duplicate
                && answer.journaled
            {
                outbox.settle(&mail.id);
            }
        })
    }

    /// Accepted reports whose receiver's journal does not hold them yet, sent again to its live tab (`#redeliverMail`).
    pub fn redeliver_mail(self: &Arc<Self>) {
        let Some(outbox) = self.host().outbox().cloned() else {
            return;
        };
        {
            let mut rt = self.rt();
            if rt.redelivering {
                rt.redeliver_again = true;
                return;
            }
            rt.redelivering = true;
        }
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                redeliver_mail(&outbox, &MailTabs { host: me.host() }).await;
                let mut rt = me.rt();
                if !rt.redeliver_again {
                    rt.redelivering = false;
                    break;
                }
                rt.redeliver_again = false;
            }
        });
    }

    /// Messages an omp held and lost go to the omp that holds the receiver's session now (`#redeliverSends`).
    pub fn redeliver_sends(self: &Arc<Self>) {
        {
            let mut rt = self.rt();
            if rt.resending {
                return;
            }
            rt.resending = true;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let _ = me.control.redeliver_sends().await;
            me.rt().resending = false;
        });
    }

    // ---- what the opened sessions' books say ---------------------------------------------------------------------------

    /// The tabs that opened a session the auto-close pass may close, over every window (`#openers`). An outside
    /// caller has no session to collect into: its sessions stay until it closes them.
    fn openers(&self) -> Vec<String> {
        let state = self.host().state();
        let mut openers: Vec<String> = Vec::new();
        for tab in state.tabs.iter().filter(|tab| tab.auto_closable) {
            if let Some(opener) = state.parent_of(&tab.tab_id)
                && !is_outside(opener)
                && !openers.iter().any(|known| known == opener)
            {
                openers.push(opener.to_owned());
            }
        }
        openers
    }

    /// A paired page's word about its Files editor changed: a child it held back may close now, not at the next tick.
    pub fn sweep_openers(self: &Arc<Self>) {
        for opener in self.openers() {
            self.sweep_soon(&opener);
        }
    }

    /// Drops the closed record of every deleted session (`forgetDeleted`): a deleted session never comes back, and its
    /// record kept it in its opener's family. The ids its opener was given keep naming the deleted session
    /// (`session-fates`); main keeps the list, so the rest goes back to it.
    pub fn forget_deleted(&self) {
        use super::journal::session_fates::{FatedSession, fate_by};
        let state = self.host().state();
        let (gone, kept): (Vec<&ClosedChild>, Vec<&ClosedChild>) =
            state.closed_children.iter().partition(|row| {
                state
                    .deleted_at_path(&row.path, row.device.as_deref())
                    .is_some()
            });
        if gone.is_empty() {
            return;
        }
        for row in gone {
            let Some(ids) = row.tab_ids.as_ref().filter(|ids| !ids.is_empty()) else {
                continue;
            };
            self.control.fates().deleted(
                FatedSession {
                    ids: ids.clone(),
                    path: Some(row.path.clone()),
                    device: row.device.clone().filter(|device| !device.is_empty()),
                    title: row.title.clone(),
                    hidden: false,
                    cwd: row.cwd.clone(),
                    opened_by_session: Some(row.opened_by_session.clone())
                        .filter(|opened| !opened.is_empty()),
                },
                fate_by::APP,
                state.deleted_at_path(&row.path, row.device.as_deref()),
            );
        }
        self.host()
            .port()
            .tell("closedChildren", &json!({ "rows": kept }));
    }

    /// The host took the result of host call `call_id`: its record may be forgotten in time (`acknowledge`).
    pub fn acknowledge(&self, call_id: &str) {
        if let Some(mut calls) = self.control.calls()
            && let Err(error) = calls.acknowledge(call_id)
        {
            eprintln!("[call-journal] acknowledge not saved: {error}");
        }
    }
}

fn check_mail_target(state: &HostState, target: &ControlTab) -> R<()> {
    if !state.enabled {
        return fail("OMPdesk control tools are disabled.");
    }
    let Some(path) = target
        .session_path
        .as_deref()
        .filter(|path| !path.is_empty())
    else {
        return fail("The resolved mail target has no saved session path.");
    };
    let device = target.device.as_deref().filter(|device| !device.is_empty());
    if target.hidden || state.deleted_at_path(path, device).is_some() {
        return fail("The resolved mail recipient is hidden or deleted.");
    }
    if let Some(device) = device
        && !state
            .device(device)
            .is_some_and(|peer| peer.state == DeviceState::Online)
    {
        return fail("The resolved mail recipient is offline or no longer paired.");
    }
    Ok(())
}

/// The live tab holding a receiver's session, and the receiver's bridge answer to a report again (`RedeliverDeps`).
struct MailTabs<'a> {
    host: &'a Host,
}

impl RedeliverDeps for MailTabs<'_> {
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String> {
        let state = self.host.state();
        state
            .tabs
            .iter()
            .chain(state.mail_targets.iter())
            .find(|tab| {
                tab.session_path.as_deref() == Some(session_path)
                    && tab.device.as_deref().filter(|device| !device.is_empty()) == device
                    && check_mail_target(&state, tab).is_ok()
            })
            .map(|tab| tab.tab_id.clone())
    }

    async fn send(&self, tab_id: &str, mail: &OutboxMail) -> Option<MailAnswer> {
        {
            let state = self.host.state();
            let target = state
                .tabs
                .iter()
                .chain(state.mail_targets.iter())
                .find(|target| target.tab_id == tab_id)?;
            if target.session_path.as_deref() != Some(mail.session_path.as_str())
                || target.device.as_deref().filter(|device| !device.is_empty())
                    != mail.device.as_deref()
                || check_mail_target(&state, target).is_err()
            {
                return None;
            }
        }
        self.host.redeliver_mail(tab_id, mail).await
    }
}

// ---- the wire ---------------------------------------------------------------------------------------------------------

fn runtime_of(port: u64) -> Result<Arc<Runtime>, Fault> {
    lock(&RUNTIMES).get(&port).cloned().ok_or_else(|| {
        Fault::new(
            "no_runtime",
            format!("no agent-control runtime on port {port}"),
        )
    })
}

#[derive(Deserialize)]
struct PortOnly {
    port: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityParams {
    port: u64,
    activity: Activity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabParams {
    port: u64,
    tab_id: String,
    #[serde(default)]
    since: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeParams {
    port: u64,
    call_id: String,
}

fn fault_of(error: &super::service::fail::Fail) -> Fault {
    super::service::fault_of(error)
}

// The handlers below that never wait do their work in their own call, which the read loop makes as the line is read
// (`at_once`): a tab's activity and the stop of a run that follows it happen in the order main sent them.

/// `agentRuntime.activity {port, activity}`: one tab activity main saw (after the snapshot it pushed).
fn activity_call(call: &Call) -> Result<Reply, Fault> {
    let params: ActivityParams = call.params()?;
    runtime_of(params.port)?.activity(params.activity);
    Reply::json(&())
}

/// `agentRuntime.afterRun {port, tabId}`: a tool that may change what the work board shows ran for `tabId`.
fn after_run(call: &Call) -> Result<Reply, Fault> {
    let params: TabParams = call.params()?;
    let runtime = runtime_of(params.port)?;
    runtime.push_review(&params.tab_id);
    runtime.sweep_soon(&params.tab_id);
    Reply::json(&())
}

/// `agentRuntime.pushReview {port, tabId}`: what `tabId`'s work board shows changed (a child's report reached it).
fn push_review(call: &Call) -> Result<Reply, Fault> {
    let params: TabParams = call.params()?;
    runtime_of(params.port)?.push_review(&params.tab_id);
    Reply::json(&())
}

fn sweep_openers(call: &Call) -> Result<Reply, Fault> {
    let params: PortOnly = call.params()?;
    runtime_of(params.port)?.sweep_openers();
    Reply::json(&())
}

/// `agentRuntime.review {port, tabId}`: the work board's list for `tabId` (empty while the tools are off).
async fn review_call(call: Call) -> Result<Reply, Fault> {
    let params: TabParams = call.params()?;
    let runtime = runtime_of(params.port)?;
    match runtime.review(&params.tab_id).await {
        Ok(review) => Reply::json(&review),
        Err(error) => Err(fault_of(&error)),
    }
}

/// `agentRuntime.familyEdits {port, tabId, since?}`.
async fn family_edits_call(call: Call) -> Result<Reply, Fault> {
    let params: TabParams = call.params()?;
    let runtime = runtime_of(params.port)?;
    match runtime.family_edits(&params.tab_id, params.since).await {
        Ok(edits) => Reply::json(&edits),
        Err(error) => Err(fault_of(&error)),
    }
}

/// `agentRuntime.liveReview {port, tabId}`: a running child's step and cost read again, pushed when they moved.
async fn live_review_call(call: Call) -> Result<Reply, Fault> {
    let params: TabParams = call.params()?;
    runtime_of(params.port)?.live_review(&params.tab_id).await;
    Reply::json(&())
}

fn forget_deleted(call: &Call) -> Result<Reply, Fault> {
    let params: PortOnly = call.params()?;
    runtime_of(params.port)?.forget_deleted();
    Reply::json(&())
}

fn acknowledge(call: &Call) -> Result<Reply, Fault> {
    let params: AcknowledgeParams = call.params()?;
    runtime_of(params.port)?.acknowledge(&params.call_id);
    Reply::json(&())
}

pub fn register(registry: &mut Registry) {
    registry.add("agentRuntime.activity", |call| {
        at_once(activity_call(&call))
    });
    registry.add("agentRuntime.afterRun", |call| at_once(after_run(&call)));
    registry.add("agentRuntime.pushReview", |call| {
        at_once(push_review(&call))
    });
    registry.add("agentRuntime.sweepOpeners", |call| {
        at_once(sweep_openers(&call))
    });
    registry.add("agentRuntime.review", |call| Box::pin(review_call(call)));
    registry.add("agentRuntime.familyEdits", |call| {
        Box::pin(family_edits_call(call))
    });
    registry.add("agentRuntime.liveReview", |call| {
        Box::pin(live_review_call(call))
    });
    registry.add("agentRuntime.forgetDeleted", |call| {
        at_once(forget_deleted(&call))
    });
    registry.add("agentRuntime.acknowledge", |call| {
        at_once(acknowledge(&call))
    });
    wake::register(registry);
}

/// `{ items: [], usage: {} }`: what the board shows while the control tools are off.
fn no_review() -> Value {
    json!({ "items": [], "usage": {} })
}
