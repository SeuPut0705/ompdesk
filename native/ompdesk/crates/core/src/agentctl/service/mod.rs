//! The agent-control service (`ompdesk_*` tools; was `src/main/agent-control/service.ts`, class `AgentControl`): batch
//! H3/H4a, the skeleton (9h). Built, not yet called: the TypeScript service still answers until the cutover.
//!
//! Layout:
//! - `mod`: `AgentControl`, its shared state, the wire (`agentControl.open|call|close`) and the call pipeline (`run`,
//!   `outcome`, `reconcile`, `dispatch`).
//! - `host`: the seam to main (`HostState` snapshot, asks and tells over one `Port`); `tuning`: every wait.
//! - `resolve`: how a name finds a session (`find`, `fate_of`, `stored_session`, `resolve_any`, `open`, devices and
//!   links); `state`: a session's state line, pickup, names; `schedules`: the `ScheduleSource` over main's two asks.
//! - `sessions`, `messages`, `work`: the tool bodies, one file per family worker (each file's header lists the
//!   TypeScript methods it owns; every body answers `not_ported` until that worker ports it).
//! - `text`, `wrap`, `js`, `types`, `fail`, `util`: the pure functions of `service.ts`, the shapes of the seam, the
//!   failures a call can end in and small tools.
//!
//! How a call is told apart from the TypeScript: it is a `Result<_, Fail>` (a `ToolError` is `Fail::Tool`), a
//! `ControlTab` is an owned value (`tabs` is the caller's snapshot of them, renamed titles included), the recorded
//! call scope is the task-local `CALL_KEY`, and a `Promise.all` is `util::join::all` on the calling task (never
//! `tokio::spawn`, which would drop the scope).

pub mod attach;
pub mod fail;
pub mod host;
pub mod js;
pub mod messages;
pub mod pace;
pub mod resolve;
pub mod schedules;
pub mod sessions;
pub mod state;
pub mod text;
pub mod tuning;
pub mod types;
pub mod util;
pub mod work;
pub mod wrap;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use self::fail::{Fail, R, fail, outcome_of};
use self::host::{Caps, Deadline, Host, HostState};
use self::text::{call_intent, mutates, saved_id_of_path, stored_title};
use self::tuning::Tuning;
use self::types::{
    AgentMessage, ClosedChild, ControlTab, CostSplit, OpenOne, ReleasedSession, SessionViewHandle,
    StoredSession, Target, Tool, ToolOutcome,
};
use self::util::{Flight, OrderedMap};
use crate::agentctl::journal::attachments::AttachmentStore;
use crate::agentctl::journal::call_journal::{CallBegin, CallJournal, CallRecord, CallResult};
use crate::agentctl::journal::mail_outbox::MailOutbox;
use crate::agentctl::journal::pending_cleanups::PendingCleanups;
use crate::agentctl::journal::send_outbox::SendOutbox;
use crate::agentctl::journal::session_fates::{FatedSession, SessionFates, fate_by};
use crate::agentctl::journal::{Clock, system_clock};
use crate::agentctl::rules::mail::{Deliver, Mail, Mailbox, delivery_for, mail_details, mail_text};
use crate::ports::Port;
use crate::server::{Call, Fault, Registry, Reply};

tokio::task_local! {
    /// The recorded call a piece of work belongs to (`#callScope`): an open notes each tab it makes under this key.
    static CALL_KEY: String;
}

/// The key of the recorded call the running work belongs to, if any.
pub fn call_key() -> Option<String> {
    CALL_KEY.try_with(Clone::clone).ok()
}

/// A child asked once to report after a turn that ended with neither a verdict line nor a done report.
#[derive(Clone, Debug)]
pub struct Nudge {
    /// The dispatch it was asked on.
    pub dispatch: Option<String>,
    /// The answer it had then.
    pub answer: String,
    pub ran: bool,
    /// Whether its opener has been told it still did not.
    pub told_opener: bool,
}

/// A source-side, one-use grant. The receiver never gets the caller's provenance or this receipt.
pub struct ViewAuthorizationReceipt {
    pub handle: SessionViewHandle,
    pub caller: ControlTab,
    pub person: bool,
    pub full: bool,
    pub manage: bool,
    pub expires: std::time::Instant,
}

/// The newest dispatch queued as a follow-up behind a busy child's turn, until its transcript shows it.
#[derive(Clone, Debug)]
pub struct QueuedFollowUp {
    pub n: u64,
    pub id: String,
    pub from: String,
}

/// A session's last read cost and split, which stand while its omp cannot answer.
#[derive(Clone, Debug)]
pub struct Spend {
    pub cost: f64,
    pub split: Option<CostSplit>,
}

/// A shared result of one background piece of work (a `Promise` kept in a map).
pub type Shared<T> = Flight<Result<T, Fail>>;

/// Everything the TypeScript class held in fields, but the journals (their own fields of `Inner`). One lock: take it,
/// read or change, drop it, never across an `await`.
#[derive(Default)]
pub struct Mem {
    /// Tabs each calling tab opened, for the "opened by you" marks (`#opened`).
    pub opened: HashMap<String, Vec<String>>,
    /// Tabs whose stop or close is in flight (`#closing`).
    pub closing: HashSet<String>,
    /// Children whose review item the person settled (`#reviewed`).
    pub reviewed: HashSet<String>,
    /// Files a child's last merge conflicted in, until it merges (`#conflicts`).
    pub conflicts: HashMap<String, Vec<String>>,
    /// Opened sessions whose answer the opener read since they last ran (`#collected`).
    pub collected: HashSet<String>,
    /// Children asked once to report, per tab (`#nudged`).
    pub nudged: HashMap<String, Nudge>,
    /// Callers whose `autoClose` pass is in flight (`#sweeping`).
    pub sweeping: HashSet<String>,
    /// Per child tab, the dispatch whose `done` report main sent for it (`#autoDoneFor`).
    pub auto_done_for: HashMap<String, String>,
    /// Saved sessions the last stored lists showed, by stock id (`#stored`).
    pub stored: OrderedMap<StoredSession>,
    /// Opened tabs to delete with their auto-close (`throwaway: true`); this launch only (`#throwaway`).
    pub throwaway: HashSet<String>,
    /// The tab that opened each session closed this launch, by `device\npath` (`#closedOpeners`).
    pub closed_openers: HashMap<String, String>,
    /// App actions each caller has running (`#appRuns`).
    pub app_runs: HashMap<String, usize>,
    /// The background sessions a caller's running app actions opened on other computers, by computer (`#utilityTabs`).
    pub utility_tabs: HashMap<String, HashMap<String, Shared<String>>>,
    /// Receipts of `ompdesk_session_send` by `caller|target|request_id` (`#receipts`).
    pub receipts: HashMap<String, String>,
    /// How many messages (a steer, a report, a child's card, a prompt of the person's) reached each session, by tab id
    /// (`#arrivals`): a blocking wait of that session returns when its count grows.
    pub arrivals: HashMap<String, u64>,
    /// How many blocking waits main owns each session is inside right now (`#blocked`).
    pub blocked: HashMap<String, usize>,
    /// Recorded calls still running in this process, by key: the same call made again joins it (`#calling`).
    pub calling: HashMap<String, Flight<ToolOutcome>>,
    /// Sessions (`device\npath`) whose saved name `name_untitled` already looked up (`#namesSought`).
    pub names_sought: HashSet<String>,
    /// The turn in which each session (`sender\nreceiver`) last reported done, review, a question or a blocker
    /// (`#reportedAt`): its `busySince` as main saw it at the report. The TypeScript kept the report's time and
    /// compared it with `busySince`; the core's clock and main's are two processes' (on Windows a tick apart), so
    /// "the same turn" is told by main's own stamp instead.
    pub reported_in: HashMap<String, Option<f64>>,
    /// The turn in which each session (`sender\nreceiver`) sent its last mail, the same way: a turn with another
    /// `busySince` is one it carried on with.
    pub mailed_in: HashMap<String, Option<f64>>,
    /// The newest dispatch queued as a follow-up behind each busy child's turn (`#queuedFollowUp`).
    pub queued_follow_up: HashMap<String, QueuedFollowUp>,
    /// Sends with a request id still on their way (`#inflight`).
    pub inflight: HashMap<String, Shared<String>>,
    /// The question cards of each child its opener was already told of (`#cardsTold`).
    pub cards_told: HashMap<String, HashSet<String>>,
    /// Each session's last read cost and split (`#lastSpend`).
    pub last_spend: HashMap<String, Spend>,
    /// Closed children's last turns (`familyEdits`), by device, session file and close (`#closedTurns`).
    pub closed_turns: HashMap<String, Shared<Value>>,
    pub view_authorizations: HashMap<String, ViewAuthorizationReceipt>,
}

/// A session inside a blocking wait main owns; counted until this drops, however the wait ends.
pub struct Blocked<'a>(&'a AgentControl, String);

impl Drop for Blocked<'_> {
    fn drop(&mut self) {
        let mut mem = self.0.mem();
        if let Some(count) = mem.blocked.get_mut(&self.1) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                mem.blocked.remove(&self.1);
            }
        }
    }
}

/// The service's shared state; reach it through `AgentControl`, which derefs to it.
pub struct Inner {
    pub host: Host,
    pub tuning: Tuning,
    pub clock: Clock,
    mem: Mutex<Mem>,
    /// Woken at every arrival (`arrive`), so a blocking wait notices at once.
    pub arrived: tokio::sync::Notify,
    fates: Mutex<SessionFates>,
    cleanups: Mutex<PendingCleanups>,
    calls: Option<Mutex<CallJournal>>,
    /// The send outbox, or None where main keeps none (a queued message then lives only in its omp).
    pub send_outbox: Option<SendOutbox>,
    /// Reports between sessions: dispatch ids, coalescing, the last report of each child (`#mailbox`).
    pub mailbox: Mailbox,
    /// `ompdesk_app`'s control, built at its first use over this service's own ports (`work`'s `ServicePorts`).
    pub(crate) app: std::sync::OnceLock<crate::agentctl::app::AppControl<work::ServicePorts>>,
}

/// The agent-control service of one app: cheap to clone, every clone is the same service.
#[derive(Clone)]
pub struct AgentControl(Arc<Inner>);

impl Deref for AgentControl {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    /// The maps of `Mem`.
    pub fn mem(&self) -> MutexGuard<'_, Mem> {
        lock(&self.mem)
    }

    /// `#fates`.
    pub fn fates(&self) -> MutexGuard<'_, SessionFates> {
        lock(&self.fates)
    }

    /// `#cleanups`.
    pub fn cleanups(&self) -> MutexGuard<'_, PendingCleanups> {
        lock(&self.cleanups)
    }

    /// `host.calls`: None where main records no calls.
    pub fn calls(&self) -> Option<MutexGuard<'_, CallJournal>> {
        self.calls.as_ref().map(lock)
    }

    /// `Date.now()`.
    pub fn now(&self) -> f64 {
        (self.clock)()
    }
}

/// A journal file the open request names; `file: null` keeps it in memory only.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct JournalFile {
    #[serde(default)]
    pub file: Option<PathBuf>,
}

/// The files the journals live in (`<userData>/agent-*.json`): absent `fates` and `cleanups` mean memory only, as the
/// TypeScript's `new SessionFates(null)`; absent `calls` and `sendOutbox` mean main keeps none.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Files {
    pub fates: Option<PathBuf>,
    pub cleanups: Option<PathBuf>,
    pub calls: Option<JournalFile>,
    pub send_outbox: Option<JournalFile>,
    /// Where accepted reports wait for their receiver's journal (`mail-outbox.json`); absent: none are kept.
    pub mail_outbox: Option<JournalFile>,
    /// Where the bytes of the attachments an outbox entry still owes are kept, by content; absent: in memory only.
    pub attachments: Option<PathBuf>,
}

impl AgentControl {
    /// Opens the service over `port`. `clock` is `Date.now` (a test fixes it).
    pub fn new(
        port: Arc<Port<HostState>>,
        caps: Caps,
        files: &Files,
        tuning: Tuning,
        clock: Clock,
    ) -> AgentControl {
        let mut host = Host::new(port, caps)
            .with_clock(clock.clone())
            .with_attachments(Arc::new(AttachmentStore::with_clock(
                files.attachments.clone(),
                clock.clone(),
            )));
        if let Some(outbox) = &files.mail_outbox {
            host = host.with_outbox(
                Arc::new(MailOutbox::with_clock(outbox.file.clone(), clock.clone())),
                clock.clone(),
            );
        }
        let deliver_host = host.clone();
        let deliver: Deliver = Arc::new(move |mail: Mail| {
            let host = deliver_host.clone();
            Box::pin(async move {
                host.mail_attached(
                    &mail.to,
                    &mail_text(&mail),
                    &mail_details(&mail),
                    delivery_for(mail.kind),
                    mail.attachments.as_ref(),
                )
                .await
                .map_err(|error| error.message())?;
                host.review_changed(&mail.to);
                Ok(())
            })
        });
        let mailbox =
            Mailbox::with_coalesce(deliver, Duration::from_millis(tuning.mail_coalesce_ms));
        AgentControl(Arc::new(Inner {
            host,
            tuning,
            fates: Mutex::new(SessionFates::with_clock(files.fates.clone(), clock.clone())),
            cleanups: Mutex::new(PendingCleanups::new(files.cleanups.clone())),
            calls: files.calls.as_ref().map(|journal| {
                Mutex::new(CallJournal::with_clock(journal.file.clone(), clock.clone()))
            }),
            send_outbox: files
                .send_outbox
                .as_ref()
                .map(|outbox| SendOutbox::with_clock(outbox.file.clone(), clock.clone())),
            mailbox,
            clock,
            mem: Mutex::new(Mem::default()),
            arrived: tokio::sync::Notify::new(),
            app: std::sync::OnceLock::new(),
        }))
    }

    /// A message reached `tab_id`: a blocking wait of its own ends (`#arrived`).
    pub fn arrive(&self, tab_id: &str) {
        *self.mem().arrivals.entry(tab_id.to_owned()).or_default() += 1;
        self.arrived.notify_waiters();
    }

    /// How many messages reached `tab_id` so far.
    pub fn arrivals(&self, tab_id: &str) -> u64 {
        self.mem().arrivals.get(tab_id).copied().unwrap_or(0)
    }

    /// `tab_id` stands inside a blocking tool call main owns until the guard drops (`#whileBlocked`).
    pub fn block(&self, tab_id: &str) -> Blocked<'_> {
        *self.mem().blocked.entry(tab_id.to_owned()).or_default() += 1;
        Blocked(self, tab_id.to_owned())
    }

    /// Whether `tab_id` is inside a blocking wait of main's.
    pub fn is_blocked(&self, tab_id: &str) -> bool {
        self.mem().blocked.get(tab_id).is_some_and(|n| *n > 0)
    }

    // ---- public methods of the TypeScript class ---------------------------------------------------------------------

    /// `childrenOf`: live tabs `caller_tab_id` opened.
    pub fn children_of(&self, caller_tab_id: &str) -> Vec<String> {
        let state = self.host.state();
        let Some(tabs) = state.tabs(caller_tab_id) else {
            return Vec::new();
        };
        self.opened_by(&state, caller_tab_id, &tabs)
            .into_iter()
            .filter(|id| !id.starts_with("pending:"))
            .collect()
    }

    /// `clearQueue`: drop a tab's queued steers and follow-ups; the turn that runs is left alone.
    pub async fn clear_queue(&self, tab_id: &str) -> R<()> {
        let response = self
            .host
            .command(
                tab_id,
                &json!({ "type": "queue_clear" }),
                Deadline::Ms(self.tuning.clear_queue_ms),
            )
            .await?;
        text::response_data(&response, "Clearing the queue")?;
        Ok(())
    }

    /// `released`: a tab closed. `session`: the saved session it held, when nobody closed it through the control tools
    /// (those record who did): its ids keep naming that session (`fates`).
    pub fn released(&self, tab_id: &str, session: Option<&ReleasedSession>) {
        let closing = self.mem().closing.contains(tab_id);
        if let Some(session) = session
            && !closing
        {
            let mut ids = vec![tab_id.to_owned()];
            ids.extend(session.former_ids.iter().cloned());
            ids.extend(saved_id_of_path(Some(&session.path)));
            self.fates().closed(
                FatedSession {
                    ids,
                    path: Some(session.path.clone()),
                    device: session.device.clone().filter(|device| !device.is_empty()),
                    title: if session.hidden {
                        String::new()
                    } else {
                        session.title.clone()
                    },
                    hidden: session.hidden,
                    cwd: session.cwd.clone(),
                    opened_by_session: session
                        .opened_by_session
                        .clone()
                        .filter(|opened| !opened.is_empty()),
                },
                fate_by::PERSON,
            );
        }
        self.app_released(tab_id);
        {
            let mut mem = self.mem();
            mem.opened.remove(tab_id);
            mem.collected.remove(tab_id);
            mem.sweeping.remove(tab_id);
            mem.closing.remove(tab_id);
            mem.reviewed.remove(tab_id);
            mem.conflicts.remove(tab_id);
            mem.cards_told.remove(tab_id);
            mem.last_spend.remove(tab_id);
            mem.queued_follow_up.remove(tab_id);
            mem.reported_in
                .retain(|key, _| !key.split('\n').any(|part| part == tab_id));
            mem.mailed_in
                .retain(|key, _| !key.split('\n').any(|part| part == tab_id));
        }
        self.mailbox.forget(tab_id);
    }

    /// `openTarget`: the open session `session` names for `caller_tab_id`, by the tools' own name rules, refused when
    /// hidden from agents (the control socket's waits).
    pub async fn open_target(&self, caller_tab_id: &str, session: &str) -> R<ControlTab> {
        let state = self.host.state();
        if !state.enabled {
            return fail(TURNED_OFF);
        }
        let Some(tabs) = state.tabs(caller_tab_id) else {
            return fail(TAB_GONE);
        };
        let Some(caller) = self.caller_of(&state, caller_tab_id, &tabs) else {
            return fail(TAB_GONE);
        };
        let target = self
            .open(
                &tabs,
                session,
                &caller,
                "wait for",
                resolve::OpenOptions::default(),
            )
            .await?;
        self.refuse_hidden(&target, &caller)?;
        Ok(target)
    }

    /// `run`: one control-tool call. `call` is the host tool call: its id (stock's, the same when a paired host
    /// re-sends the call after this computer relaunched) and whether the host says it re-sends one it had handed a
    /// connection before (`resent`). A call that changes something is recorded under the caller's session file and
    /// that id, so it runs at most once; a re-sent one this computer has no record of is reconciled like a pending
    /// one and never run blindly.
    pub async fn run(
        &self,
        caller_tab_id: &str,
        tool: &str,
        args: Value,
        call: Option<CallId>,
    ) -> ToolOutcome {
        let Some(known_tool) = Tool::from_name(tool) else {
            return ToolOutcome {
                text: format!("{tool} failed: no such control tool"),
                is_error: true,
            };
        };
        let mut tabs = {
            let step = async {
                let state = self.host.state();
                if !state.enabled {
                    return fail(TURNED_OFF);
                }
                let Some(tabs) = state.tabs(caller_tab_id) else {
                    return fail(TAB_GONE);
                };
                Ok(tabs)
            };
            match step.await {
                Ok(tabs) => tabs,
                Err(error) => return outcome_of(tool, &error),
            }
        };
        self.name_untitled(&mut tabs).await;
        let caller = tabs.iter().find(|tab| tab.tab_id == caller_tab_id).cloned();
        let key = match (&call, &caller) {
            (Some(call), Some(caller))
                if self.calls.is_some()
                    && caller
                        .session_path
                        .as_deref()
                        .is_some_and(|path| !path.is_empty())
                    && mutates(known_tool, &args) =>
            {
                Some((
                    format!(
                        "{}\n{}\n{}",
                        caller.device.as_deref().unwrap_or(""),
                        caller.session_path.as_deref().unwrap_or(""),
                        call.id
                    ),
                    call.resent,
                    caller.clone(),
                ))
            }
            _ => None,
        };
        let Some((key, resent, caller)) = key else {
            return self.outcome(caller_tab_id, &tabs, known_tool, args).await;
        };
        let joined = self.mem().calling.get(&key).cloned();
        if let Some(joined) = joined {
            return joined.wait().await.unwrap_or_else(|| ToolOutcome {
                text: format!("{tool} failed: the call this one joined ended without an answer"),
                is_error: true,
            });
        }
        let known = self.calls().and_then(|journal| journal.get(&key));
        if let Some(result) = known.as_ref().and_then(|record| record.result.clone()) {
            return ToolOutcome {
                text: result.text,
                is_error: result.is_error,
            };
        }
        let begin = |intent| CallBegin {
            key: key.clone(),
            tool: tool.to_owned(),
            caller_tab_id: caller_tab_id.to_owned(),
            intent,
            opened: None,
        };
        let mut record = known;
        if record.is_none() && resent {
            self.begin_call(begin(call_intent(known_tool, &args, &caller)));
            record = self.calls().and_then(|journal| journal.get(&key));
        }
        let flight = Flight::new();
        let guard = flight.guard();
        self.mem().calling.insert(key.clone(), flight.clone());
        let outcome = match record {
            Some(record) => self.reconcile(&record, &caller, &tabs).await,
            None => {
                self.begin_call(begin(call_intent(known_tool, &args, &caller)));
                CALL_KEY
                    .scope(
                        key.clone(),
                        self.outcome(caller_tab_id, &tabs, known_tool, args),
                    )
                    .await
            }
        };
        if let Some(mut journal) = self.calls()
            && let Err(error) = journal.finish(
                &key,
                CallResult {
                    text: outcome.text.clone(),
                    is_error: outcome.is_error,
                },
            )
        {
            eprintln!("[call-journal] result not saved: {error}");
        }
        flight.settle(outcome.clone());
        drop(guard);
        self.mem().calling.remove(&key);
        outcome
    }

    fn begin_call(&self, call: CallBegin) {
        if let Some(mut journal) = self.calls()
            && let Err(error) = journal.begin(call)
        {
            eprintln!("[call-journal] call not saved: {error}");
        }
    }

    async fn outcome(
        &self,
        caller_tab_id: &str,
        tabs: &[ControlTab],
        tool: Tool,
        args: Value,
    ) -> ToolOutcome {
        match self.dispatch(caller_tab_id, tabs, tool, args).await {
            Ok(text) => ToolOutcome {
                text,
                is_error: false,
            },
            Err(error) => outcome_of(tool.name(), &error),
        }
    }

    /// A call recorded as begun before this computer restarted, with no result: its effect may have happened. What the
    /// app holds now decides (the sessions it opened, the schedule it saved); it is never run a second time, and a
    /// call whose effect cannot be found answers that its outcome is unknown.
    async fn reconcile(
        &self,
        record: &CallRecord,
        caller: &ControlTab,
        tabs: &[ControlTab],
    ) -> ToolOutcome {
        let already = "This call had already run before OMPdesk restarted; it was not run again.";
        let unknown = |hint: &str| ToolOutcome {
            text: format!(
                "This {} call was started before OMPdesk restarted, and its outcome is unknown after OMPdesk restarted: it was not run again. {hint}",
                record.tool
            ),
            is_error: true,
        };
        if let Some(open) = record
            .intent
            .as_ref()
            .and_then(|intent| intent.open.as_ref())
        {
            let ids: HashSet<&str> = record.opened.iter().flatten().map(String::as_str).collect();
            let mut titles: Vec<&String> = open.iter().collect();
            let state = self.host.state();
            let mut found: Vec<&ControlTab> = Vec::new();
            for tab in tabs {
                if tab.tab_id == caller.tab_id {
                    continue;
                }
                if ids.contains(tab.tab_id.as_str())
                    || tab.former_ids.iter().any(|id| ids.contains(id.as_str()))
                {
                    found.push(tab);
                    continue;
                }
                // Opened but not noted yet (the app died in between): the caller's child opened for one of its tasks.
                let Some(task) = tab.task.as_ref().filter(|task| !task.is_empty()) else {
                    continue;
                };
                let Some(at) = titles.iter().position(|title| *title == task) else {
                    continue;
                };
                if state.parent_of(&tab.tab_id) != Some(caller.tab_id.as_str()) {
                    continue;
                }
                titles.remove(at);
                found.push(tab);
            }
            let check =
                "Check ompdesk_sessions {\"mine\":true} before opening it again with a new call.";
            if found.is_empty() {
                return unknown(check);
            }
            let mut lines: Vec<String> = found
                .iter()
                .map(|tab| {
                    format!(
                        "Opened session {} in {}{}. {already}",
                        tab.tab_id,
                        tab.cwd,
                        tab.device_name
                            .as_deref()
                            .filter(|name| !name.is_empty())
                            .map_or_else(String::new, |name| format!(" on {name}"))
                    )
                })
                .collect();
            if found.len() < open.len() {
                lines.push(format!(
                    "Whether the other {} opened is unknown after OMPdesk restarted. {check}",
                    open.len() - found.len()
                ));
            }
            return ToolOutcome {
                text: lines.join("\n"),
                is_error: false,
            };
        }
        if let Some(schedule) = record
            .intent
            .as_ref()
            .and_then(|intent| intent.schedule.as_ref())
        {
            let check = "Check ompdesk_schedule {\"action\":\"list\"} before creating it again.";
            let found = async {
                let device = match &schedule.device {
                    None => None,
                    Some(name) => self.device(name)?,
                };
                let rows =
                    match self.schedule_source(device.as_ref().map(|device| device.id.as_str())) {
                        Some(source) => source.list().await?,
                        None => Vec::new(),
                    };
                Ok::<_, Fail>(rows.into_iter().rev().find(|row| row.name == schedule.name))
            };
            return match found.await {
                Ok(Some(row)) => ToolOutcome {
                    text: format!(
                        "Scheduled “{}” {} in {}; id {}. {already}",
                        row.name,
                        wrap::describe_frequency(&row.frequency),
                        row.cwd,
                        row.id
                    ),
                    is_error: false,
                },
                _ => unknown(check),
            };
        }
        unknown("Check what it was meant to change before trying again with a new call.")
    }

    /// `#stopping`: a stop of the caller's work is in flight; nothing new may start.
    pub fn stopping(&self, caller_tab_id: &str) -> bool {
        self.mem().closing.contains(caller_tab_id) || self.host.state().is_stopping(caller_tab_id)
    }

    /// A tab with neither a title nor a task (restored by a relaunch, or reopened) reads as its saved session's name,
    /// else the task of its first message, from the session index of the computer it runs on. Looked up once per
    /// session and handed to main (`setTask`), so the sidebar, the board and every later call have it too. A tool
    /// call waits for the lookup at most `name_lookup_ms`; a later answer still reaches main.
    pub async fn name_untitled(&self, tabs: &mut [ControlTab]) {
        let key = |tab: &ControlTab| {
            format!(
                "{}\n{}",
                tab.device.as_deref().unwrap_or(""),
                tab.session_path.as_deref().unwrap_or("")
            )
        };
        let nameless: Vec<usize> = {
            let mem = self.mem();
            tabs.iter()
                .enumerate()
                .filter(|(_, tab)| {
                    tab.title.is_empty()
                        && tab.task.as_deref().is_none_or(str::is_empty)
                        && !tab.hidden
                        && tab
                            .session_path
                            .as_deref()
                            .is_some_and(|path| !path.is_empty())
                        && !mem.names_sought.contains(&key(tab))
                })
                .map(|(index, _)| index)
                .collect()
        };
        if nameless.is_empty() {
            return;
        }
        let wanted: Vec<(String, String, Option<String>, String)> = nameless
            .iter()
            .map(|index| {
                let tab = &tabs[*index];
                (
                    tab.tab_id.clone(),
                    tab.session_path.clone().unwrap_or_default(),
                    tab.device.clone(),
                    key(tab),
                )
            })
            .collect();
        {
            let mut mem = self.mem();
            for (_, _, _, key) in &wanted {
                mem.names_sought.insert(key.clone());
            }
        }
        let names: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let mut devices: Vec<Option<String>> = Vec::new();
        for (_, _, device, _) in &wanted {
            if !devices.contains(device) {
                devices.push(device.clone());
            }
        }
        let mut lookups = Vec::new();
        for device in devices {
            let host = self.host.clone();
            let names = names.clone();
            let wanted = wanted.clone();
            lookups.push(tokio::spawn(async move {
                let rows = host
                    .stored(device.as_deref(), None)
                    .await
                    .unwrap_or_default();
                for (tab_id, path, tab_device, key) in &wanted {
                    let Some(row) = rows
                        .iter()
                        .find(|row| row.path == *path && row.device == *tab_device)
                    else {
                        continue;
                    };
                    let name = if row.title.is_empty() {
                        wrap::agent_task_title(&row.first_message).unwrap_or_default()
                    } else {
                        row.title.clone()
                    };
                    if name.is_empty() {
                        continue;
                    }
                    lock(&names).insert(key.clone(), name.clone());
                    host.set_task(tab_id, &name);
                }
            }));
        }
        let all = async {
            for lookup in lookups {
                let _ = lookup.await;
            }
        };
        let _ = tokio::time::timeout(Duration::from_millis(self.tuning.name_lookup_ms), all).await;
        let names = lock(&names).clone();
        for index in nameless {
            if let Some(name) = names.get(&key(&tabs[index])) {
                tabs[index].title = name.clone();
                tabs[index].task = Some(name.clone());
            }
        }
    }

    /// `#dispatch`: validates the arguments (in TypeScript: `looseArgs` and the tool's zod schema) and routes the
    /// tool to its family function.
    async fn dispatch(
        &self,
        caller_tab_id: &str,
        tabs: &[ControlTab],
        tool: Tool,
        given: Value,
    ) -> R<String> {
        let parsed = match self.host.parse_args(tool.name(), &given, true).await? {
            Ok(parsed) => parsed,
            Err(message) => return fail(message),
        };
        let state = self.host.state();
        let Some(caller) = self.caller_of(&state, caller_tab_id, tabs) else {
            return fail(TAB_GONE);
        };
        let args = |_: Tool| -> R<Value> { Ok(parsed.clone()) };
        fn typed<T: serde::de::DeserializeOwned>(value: Value, tool: Tool) -> R<T> {
            serde_json::from_value(value).map_err(|error| {
                Fail::other(format!(
                    "{}: arguments as validated could not be read: {error}",
                    tool.name()
                ))
            })
        }
        match tool {
            Tool::List => self.list(&caller, tabs, typed(args(tool)?, tool)?).await,
            Tool::Open => {
                self.open_tool(&caller, tabs, typed(args(tool)?, tool)?)
                    .await
            }
            Tool::Send => {
                let args: types::SendArgs = typed(args(tool)?, tool)?;
                let target = self.send_target(&caller, tabs, &args.session).await?;
                self.send(&caller, &target, &args).await
            }
            Tool::Result => {
                let args: types::ResultArgs = typed(args(tool)?, tool)?;
                let several = args.sessions.is_some();
                let ids: Vec<String> = match (&args.sessions, &args.session) {
                    (Some(sessions), _) => sessions.clone(),
                    (None, Some(session)) => vec![session.clone()],
                    (None, None) => Vec::new(),
                };
                let caller_ref = &caller;
                let targets = util::join::all(
                    ids.iter()
                        .map(|id| {
                            util::join::boxed(self.resolve_any(tabs, id, caller_ref, "read", None))
                        })
                        .collect(),
                )
                .await
                .into_iter()
                .collect::<R<Vec<Target>>>()?;
                self.result(&caller, targets, args, several).await
            }
            Tool::Read => {
                let args: types::ReadArgs = typed(args(tool)?, tool)?;
                match self
                    .resolve_any(tabs, &args.session, &caller, "read", None)
                    .await?
                {
                    Target::Tab(tab) => self.read(&tab, &args).await,
                    Target::Stored(row) => self.read_stored(&row, &args).await,
                }
            }
            Tool::Answer => {
                let args: types::AnswerArgs = typed(args(tool)?, tool)?;
                let target = self
                    .open(
                        tabs,
                        &args.session,
                        &caller,
                        "answer",
                        resolve::OpenOptions::default(),
                    )
                    .await?;
                self.answer(&caller, &target, &args).await
            }
            Tool::Focus => {
                let args: types::FocusArgs = typed(args(tool)?, tool)?;
                let options = resolve::OpenOptions {
                    allow_self: true,
                    reach: false,
                };
                let target = self
                    .open(tabs, &args.session, &caller, "show", options)
                    .await?;
                self.refuse_hidden(&target, &caller)?;
                let how = args.how.as_deref().unwrap_or("focus");
                self.host.view(&caller.tab_id, &target.tab_id, how, false);
                Ok(format!("Showing {} ({how}).", text::label(&target)))
            }
            Tool::Notify => {
                let args: types::NotifyArgs = typed(args(tool)?, tool)?;
                self.host.notify(
                    &caller.tab_id,
                    &args.title,
                    args.body.as_deref().unwrap_or(""),
                );
                Ok("Notification shown.".to_owned())
            }
            Tool::Stop => {
                let args: types::StopArgs = typed(args(tool)?, tool)?;
                if let Some(view) = &args.view {
                    self.host.close_view(caller_tab_id, view).await?;
                    return Ok(format!(
                        "Closed view {} on {} (its execution, saved session and other views stay).",
                        view.tab_id, view.view_host
                    ));
                }
                let device = match &args.device {
                    None => None,
                    Some(wanted) => Some(self.device(wanted)?),
                };
                let target = match self
                    .resolve_any(tabs, &args.session, &caller, "stop", device)
                    .await
                {
                    Ok(target) => target,
                    // A second delete of what is already gone: nothing to do, and no error for the agent to read.
                    Err(Fail::Deleted { fate, .. }) if args.delete == Some(true) => {
                        return Ok(format!(
                            "\"{}\" is already deleted{}: nothing to do.",
                            text::unquoted(&args.session),
                            crate::agentctl::journal::session_fates::fate_when(fate.at, &fate.by)
                        ));
                    }
                    Err(error) => return Err(error),
                };
                match target {
                    Target::Tab(tab) => self.stop(&caller, tabs, &tab, &args).await,
                    Target::Stored(row) => self.stop_stored(&caller, &row, &args).await,
                }
            }
            Tool::Compare => {
                let args: types::CompareArgs = typed(args(tool)?, tool)?;
                self.compare(&caller, tabs, args.sessions, args.criteria)
                    .await
            }
            Tool::Report => self.report(&caller, tabs, typed(args(tool)?, tool)?).await,
            Tool::Merge => {
                let args: types::MergeArgs = typed(args(tool)?, tool)?;
                let target = self
                    .open(
                        tabs,
                        &args.session,
                        &caller,
                        "merge",
                        resolve::OpenOptions::default(),
                    )
                    .await?;
                self.merge(&caller, &target).await
            }
            Tool::Schedule => self.schedule(&caller, typed(args(tool)?, tool)?).await,
            Tool::Autopilot => {
                self.autopilot(&caller, tabs, typed(args(tool)?, tool)?)
                    .await
            }
            Tool::AppList => self.app_list(typed(args(tool)?, tool)?).await,
            Tool::App => self.app(&caller, typed(args(tool)?, tool)?).await,
        }
    }

    /// `#callerOf`: the calling tab, or the process outside OMPdesk that calls over the control socket.
    pub fn caller_of(
        &self,
        state: &HostState,
        caller_tab_id: &str,
        tabs: &[ControlTab],
    ) -> Option<ControlTab> {
        tabs.iter()
            .find(|tab| tab.tab_id == caller_tab_id)
            .cloned()
            .or_else(|| state.outside_caller(caller_tab_id))
    }

    /// `#storedTitleOf`: the name a saved session goes by in a text.
    pub fn title_of(row: &StoredSession) -> String {
        stored_title(row)
    }
}

/// A host tool call's identity.
#[derive(Clone, Debug, Deserialize)]
pub struct CallId {
    pub id: String,
    #[serde(default)]
    pub resent: bool,
}

pub const TURNED_OFF: &str = "OMPdesk control tools are turned off (Settings › Tools & extensions). Ask the user to turn them on.";
pub const TAB_GONE: &str = "This session's tab is gone.";

// ---- the wire ----------------------------------------------------------------------------------------------------

static INSTANCES: LazyLock<Mutex<HashMap<u64, AgentControl>>> = LazyLock::new(Default::default);

fn instance(port: u64) -> Result<AgentControl, Fault> {
    lock(&INSTANCES).get(&port).cloned().ok_or_else(|| {
        Fault::new(
            "no_instance",
            format!("no agent-control service on port {port}"),
        )
    })
}

#[derive(Deserialize)]
struct OpenParams {
    port: u64,
    state: Box<serde_json::value::RawValue>,
    #[serde(default)]
    files: Files,
    #[serde(default)]
    caps: Caps,
    #[serde(default)]
    tuning: Tuning,
    /// Main's own runtime (the sweep of the opened sessions, review pushes, redelivery); a bare service has none.
    #[serde(default)]
    runtime: Option<crate::agentctl::runtime::RuntimeConfig>,
}

async fn open(call: Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    let port = Port::<HostState>::open_raw(&call.events, params.port, &params.state)?;
    let control = AgentControl::new(
        port.clone(),
        params.caps,
        &params.files,
        params.tuning,
        system_clock(),
    );
    if let Some(config) = params.runtime {
        crate::agentctl::runtime::start(control.clone(), params.port, config);
    }
    lock(&INSTANCES).insert(params.port, control);
    let id = params.port;
    tokio::spawn(async move {
        port.until_closed().await;
        lock(&INSTANCES).remove(&id);
    });
    Reply::json(&())
}

#[derive(Deserialize)]
struct PortParams {
    port: u64,
}

async fn close(call: Call) -> Result<Reply, Fault> {
    let params: PortParams = call.params()?;
    if let Ok(control) = instance(params.port) {
        control.host.port().close();
    }
    lock(&INSTANCES).remove(&params.port);
    Reply::json(&())
}

/// A failure as the request's fault: `tool_error` is a `ToolError` (the message is the agent's own), `folder_missing`
/// a `SessionFolderMissing`; any other keeps main's code, else `error`.
pub fn fault_of(error: &Fail) -> Fault {
    match error {
        Fail::Tool(_) | Fail::Deleted { .. } => Fault::new("tool_error", error.message()),
        Fail::FolderMissing { .. } => Fault::new("folder_missing", error.message()),
        Fail::Other { code, message } => Fault::new(
            code.clone().unwrap_or_else(|| "error".into()),
            message.clone(),
        ),
    }
}

#[derive(Deserialize)]
struct CallParams {
    port: u64,
    method: String,
    #[serde(default)]
    args: Value,
}

fn args_of<T: serde::de::DeserializeOwned>(value: Value, method: &str) -> Result<T, Fault> {
    serde_json::from_value(value)
        .map_err(|error| Fault::new("invalid_params", format!("{method}: {error}")))
}

fn text_arg(value: &Value, key: &str, method: &str) -> Result<String, Fault> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Fault::new("invalid_params", format!("{method}: {key} is required")))
}

fn reply<T: serde::Serialize>(result: R<T>) -> Result<Reply, Fault> {
    match result {
        Ok(value) => Reply::json(&value),
        Err(error) => Err(fault_of(&error)),
    }
}

/// `agentControl.call {port, method, args}`: a public method of the TypeScript class by its name.
async fn call_method(call: Call) -> Result<Reply, Fault> {
    let params: CallParams = call.params()?;
    let control = instance(params.port)?;
    let (method, args) = (params.method.as_str(), params.args);
    match method {
        "run" => {
            let caller = text_arg(&args, "callerTabId", method)?;
            let tool = text_arg(&args, "tool", method)?;
            let call_id: Option<CallId> = match args.get("call") {
                Some(Value::Null) | None => None,
                Some(value) => Some(args_of(value.clone(), method)?),
            };
            let given = args.get("args").cloned().unwrap_or(Value::Null);
            Reply::json(&control.run(&caller, &tool, given, call_id).await)
        }
        "childrenOf" => Reply::json(&control.children_of(&text_arg(&args, "callerTabId", method)?)),
        "childAsked" => reply(
            control
                .child_asked(
                    &text_arg(&args, "openerTabId", method)?,
                    &text_arg(&args, "childTabId", method)?,
                    &text_arg(&args, "requestId", method)?,
                )
                .await,
        ),
        "clearQueue" => reply(
            control
                .clear_queue(&text_arg(&args, "tabId", method)?)
                .await,
        ),
        "released" => {
            let session: Option<ReleasedSession> = match args.get("session") {
                Some(Value::Null) | None => None,
                Some(value) => Some(args_of(value.clone(), method)?),
            };
            control.released(&text_arg(&args, "tabId", method)?, session.as_ref());
            Reply::json(&())
        }
        "openSessions" => {
            let sessions: Vec<OpenOne> =
                args_of(args.get("sessions").cloned().unwrap_or(Value::Null), method)?;
            let tag = args.get("tag").and_then(Value::as_str).map(str::to_owned);
            reply(
                control
                    .open_sessions(&text_arg(&args, "callerTabId", method)?, sessions, tag)
                    .await,
            )
        }
        "openTarget" => reply(
            control
                .open_target(
                    &text_arg(&args, "callerTabId", method)?,
                    &text_arg(&args, "session", method)?,
                )
                .await,
        ),
        "authorizeView" => {
            let view: types::ViewCloseFacts =
                args_of(args.get("view").cloned().unwrap_or(Value::Null), method)?;
            reply(
                control
                    .authorize_view(
                        &text_arg(&args, "callerTabId", method)?,
                        &view,
                        &text_arg(&args, "localViewHost", method)?,
                    )
                    .await,
            )
        }
        "validateViewAuthorization" => {
            let handle: SessionViewHandle =
                args_of(args.get("handle").cloned().unwrap_or(Value::Null), method)?;
            reply(
                control
                    .validate_view_authorization(&text_arg(&args, "receipt", method)?, &handle)
                    .await,
            )
        }
        "releaseViewAuthorization" => {
            control.release_view_authorization(&text_arg(&args, "receipt", method)?);
            Reply::json(&())
        }
        "personTyped" => {
            // The note this may send reaches main before the call answers (main does not wait on it).
            if let Some(told) = control.person_typed(&text_arg(&args, "tabId", method)?) {
                let _ = told.await;
            }
            Reply::json(&())
        }
        "redeliverSends" => reply(control.redeliver_sends().await),
        "reviewItems" => reply(
            control
                .review_items(&text_arg(&args, "callerTabId", method)?)
                .await,
        ),
        "review" => reply(
            control
                .review(&text_arg(&args, "callerTabId", method)?)
                .await,
        ),
        "familyEdits" => reply(
            control
                .family_edits(
                    &text_arg(&args, "callerTabId", method)?,
                    args.get("since").and_then(Value::as_f64),
                )
                .await,
        ),
        "liveReview" => {
            let only: Option<Vec<String>> = match args.get("only") {
                Some(Value::Null) | None => None,
                Some(value) => Some(args_of(value.clone(), method)?),
            };
            reply(
                control
                    .live_review(
                        &text_arg(&args, "callerTabId", method)?,
                        args.get("last").cloned().unwrap_or(Value::Null),
                        only,
                    )
                    .await,
            )
        }
        "autoClose" => reply(
            control
                .auto_close(&text_arg(&args, "callerTabId", method)?)
                .await,
        ),
        other => Err(Fault::new(
            "no_method",
            format!("agentControl.call: no method {other}"),
        )),
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("agentControl.open", |call| Box::pin(open(call)));
    registry.add("agentControl.call", |call| Box::pin(call_method(call)));
    registry.add("agentControl.close", |call| Box::pin(close(call)));
}

/// `AgentMessage`s of a session, as the compare and the autoClose read them (kept so a family names one type).
pub type Transcript = Vec<AgentMessage>;
/// The closed children list main keeps (`closedChildren`).
pub type ClosedChildren = Vec<ClosedChild>;
