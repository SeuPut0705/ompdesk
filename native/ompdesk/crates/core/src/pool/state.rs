//! The pool's data: what the TypeScript kept in `PoolEntry` and in `SidecarPool`'s maps, minus the handles main holds
//! (the sidecars, the windows, the hosted views and the full-channel forwarders; they cross as ids).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use serde_json::{Map, Value, json};

use super::omap::OMap;
use super::run::Tracking;
use super::split::SplitLayout;
use crate::hub::Out;
use crate::server::Fault;

pub(super) type R<T> = Result<T, Fault>;

pub(super) fn fault(code: &'static str, message: impl Into<String>) -> Fault {
    Fault::new(code, message)
}

/// The key of a viewer in `subagentLevels`: a window by its id, a paired device's view by its handle id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LevelKey {
    Window(i64),
    View(u64),
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum StartWait {
    Queued,
    Slow(Option<String>),
}

pub(super) struct Entry {
    /// Identity: the TypeScript compared entry objects, and a tab id can come back after a release.
    pub seq: u64,
    pub tab_id: String,
    /// The owner window: it spawned the tab, persists it in its layout, and closing it releases the tab.
    pub win_id: i64,
    /// Paired host deviceId the tab runs on; none = this machine.
    pub device: Option<String>,
    /// Windows besides the owner that show the tab (multi-viewer), in the order they joined.
    pub viewers: Vec<i64>,
    pub owner_detached: bool,
    pub view_serial: u64,
    pub view_generations: OMap<i64, u64>,
    pub session_generation: u64,
    pub run_revision: u64,
    pub leave_pending: bool,
    /// Latest `setStatus` per key, `setWidget` per key and `setTitle` (keys `status:`, `widget:`, `title`).
    pub ui_state: Option<OMap<String, Value>>,
    pub hosted_view: bool,
    /// Paired devices that view this tab through their own tab on this host (handle ids, in order).
    pub device_views: Vec<u64>,
    pub kind: String,
    pub placeholder: bool,
    pub unstarted: bool,
    pub worktree: Option<Value>,
    pub status: String,
    pub tracking: Tracking,
    pub run_across_link: bool,
    pub session_id: Option<String>,
    /// `undefined` / `null` / a name.
    pub title: Option<Option<String>>,
    pub auto_title: Option<Option<String>>,
    pub task: Option<String>,
    pub opened_by: Option<String>,
    pub opened_by_session: Option<String>,
    pub former: Option<(String, Vec<String>)>,
    pub session_file: Option<String>,
    pub awaiting_connection: bool,
    pub session_held: bool,
    pub failure: Option<Value>,
    pub start_wait: Option<StartWait>,
    pub plan_proposal: Option<(String, String)>,
    /// Which proposal of the tab it is: bumped for every new one (stock rewrites one plan file for a revision).
    pub plan_generation: u64,
    pub resuming: bool,
    pub unsaved_prompt: Option<String>,
    pub scheduled_retry: Option<Value>,
    pub touched: u64,
    pub prompted: u64,
    pub exits: u64,
    pub omp_restart_pending: bool,
    pub extension_pending: Option<Value>,
    pub sign_ins: i64,
    pub sign_in_providers: Vec<String>,
    pub sign_in_link: Option<Value>,
    pub host_sign_ins: Option<Vec<String>>,
    pub sign_in_relay: Option<Value>,
    /// The windows whose full channel is wired (none = no window shows the tab).
    pub full: Option<Vec<i64>>,
    /// Each window's last draft report per draft command (`noteDraft`).
    pub drafts: OMap<String, OMap<i64, bool>>,
    pub subagent_levels: Option<Vec<(LevelKey, String)>>,
}

impl Entry {
    pub(super) fn new(
        seq: u64,
        tab_id: String,
        win_id: i64,
        kind: String,
        status: String,
    ) -> Entry {
        Entry {
            seq,
            tab_id,
            win_id,
            device: None,
            viewers: Vec::new(),
            owner_detached: false,
            view_serial: 0,
            view_generations: {
                let mut generations = OMap::default();
                generations.insert(win_id, 0);
                generations
            },
            session_generation: 0,
            run_revision: 0,
            leave_pending: false,
            ui_state: None,
            hosted_view: false,
            device_views: Vec::new(),
            kind,
            placeholder: false,
            unstarted: false,
            worktree: None,
            status,
            tracking: Tracking::default(),
            run_across_link: false,
            session_id: None,
            title: None,
            auto_title: None,
            task: None,
            opened_by: None,
            opened_by_session: None,
            former: None,
            session_file: None,
            awaiting_connection: false,
            session_held: false,
            failure: None,
            start_wait: None,
            plan_proposal: None,
            plan_generation: 0,
            resuming: false,
            unsaved_prompt: None,
            scheduled_retry: None,
            touched: 0,
            prompted: 0,
            exits: 0,
            omp_restart_pending: false,
            extension_pending: None,
            sign_ins: 0,
            sign_in_providers: Vec::new(),
            sign_in_link: None,
            host_sign_ins: None,
            sign_in_relay: None,
            full: None,
            drafts: OMap::default(),
            subagent_levels: None,
        }
    }

    /// `windowOf(entry, winId)`: whether window `win_id` shows the tab (its owner, or one of its viewers).
    pub(super) fn shown_in(&self, win_id: i64) -> bool {
        (!self.owner_detached && self.win_id == win_id) || self.viewers.contains(&win_id)
    }

    pub(super) fn visible_window(&self) -> Option<i64> {
        if self.owner_detached {
            self.viewers.first().copied()
        } else {
            Some(self.win_id)
        }
    }

    pub(super) fn view_id(&self, epoch: &str, win: i64) -> Option<String> {
        if !self.shown_in(win) {
            return None;
        }
        let generation = self.view_generations.get(&win)?;
        Some(format!("{epoch}.{:x}.{:x}", self.seq, generation))
    }

    pub(super) fn view_identity(&self, win: i64) -> Option<String> {
        if !self.shown_in(win) {
            return None;
        }
        let generation = self.view_generations.get(&win)?;
        Some(format!(
            "{:x}.{:x}.{:x}.{:x}.{:x}.{:x}.{:x}",
            self.seq,
            generation,
            self.session_generation,
            self.prompted,
            self.touched,
            self.exits,
            self.run_revision,
        ))
    }

    pub(super) fn busy(&self) -> bool {
        self.tracking.run.busy()
    }

    pub(super) fn wired_in(&self, win_id: i64) -> bool {
        self.full
            .as_ref()
            .is_some_and(|wins| wins.contains(&win_id))
    }

    pub(super) fn signin_active(&self) -> bool {
        self.sign_ins > 0
            || self
                .host_sign_ins
                .as_ref()
                .is_some_and(|ids| !ids.is_empty())
    }
}

/// What main works out of a request with its shared helpers (`BLOCKING_UI_METHODS`, `isSignInRequest`,
/// `isApprovalSelect`), handed over with the request: those classifiers are one definition, also the page's.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Kinds {
    pub blocking: bool,
    pub sign_in: bool,
    pub approval: bool,
}

impl Kinds {
    pub(super) fn of(value: &Value) -> Kinds {
        Kinds {
            blocking: value["blocking"].as_bool() == Some(true),
            sign_in: value["signIn"].as_bool() == Some(true),
            approval: value["approval"].as_bool() == Some(true),
        }
    }
}

/// A blocking request held for a reloaded page, with what main worked out of it.
#[derive(Clone, Debug)]
pub(super) struct Held {
    pub request: Value,
    pub kinds: Kinds,
}

/// What a closing window runs, in the order they were added (`#whenClosed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Closer {
    /// The owner's tab: released with the window.
    Entry(u64),
    /// A viewer's tab, by entry and window: the viewer leaves.
    Viewer(u64, i64),
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Owner {
    pub tab_id: String,
    pub win_id: i64,
}

/// A request a shared tab answered: the tab and the answering window (none for a device: nobody's later answer wins).
#[derive(Clone, Copy, Debug)]
pub(super) struct Answered {
    pub seq: u64,
    pub win_id: Option<i64>,
}

/// A `stopSession` waiting for its tab's run to end.
pub(super) struct StopWait {
    pub token: u64,
    pub tab_id: String,
    pub seq: u64,
}

#[derive(Default)]
pub(super) struct Pool {
    /// The clock of the call being served: main's `Date.now()`.
    pub now: i64,
    pub next_seq: u64,
    pub view_epoch: String,
    pub retry_serial: u64,
    /// Every live tab, in acquisition order.
    pub entries: Vec<Entry>,
    pub active_by_window: OMap<i64, String>,
    pub visible_by_window: OMap<i64, Vec<String>>,
    pub split_by_window: OMap<i64, SplitLayout>,
    pub remembered_by_window: OMap<i64, Vec<SplitLayout>>,
    pub session_owners: OMap<String, Owner>,
    pub request_owners: OMap<String, u64>,
    /// Questions an agent's answer holds while its attachments go in, by request id → the claim.
    pub claims: HashMap<String, u64>,
    /// Plans an agent's approval holds, by tab → (the proposal's generation, the claim).
    pub plan_claims: HashMap<String, (u64, u64)>,
    /// The last claim and the last plan generation handed out.
    pub claim_serial: u64,
    pub plan_serial: u64,
    pub request_bodies: OMap<String, Held>,
    pub sign_in_requests: HashSet<String>,
    pub answering: HashSet<String>,
    pub answered: OMap<String, Answered>,
    pub restoring: HashSet<i64>,
    pub closers: OMap<i64, Vec<Closer>>,
    pub stop_waits: Vec<StopWait>,
    /// Entries released but still being let go of (their asks to main are on the way): `byTabId` forgot them already.
    pub detached: Vec<Entry>,
    /// Whether main's `onWindowTabsChanged` hook is installed (no layout is computed for nobody).
    pub window_tabs_hook: bool,
    /// The saved-layout constants (`TAB_LAYOUT_VERSION`, `MAX_FORMER_TAB_IDS`), main's `tab-layout.ts` the one definition.
    pub layout_version: i64,
    pub max_former_tab_ids: usize,
    /// How long `stopSession` waits for the run to end (`STOP_SESSION_WAIT_MS`, main's one definition).
    pub stop_wait_ms: u64,
}

impl Pool {
    pub(super) fn index(&self, tab_id: &str) -> Option<usize> {
        self.entries.iter().position(|entry| entry.tab_id == tab_id)
    }

    pub(super) fn entry(&self, tab_id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.tab_id == tab_id)
    }

    pub(super) fn entry_mut(&mut self, tab_id: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|entry| entry.tab_id == tab_id)
    }

    /// A tab by its entry's identity, live or released and not yet let go of.
    pub(super) fn by_seq(&self, seq: u64) -> Option<&Entry> {
        self.entries
            .iter()
            .chain(self.detached.iter())
            .find(|entry| entry.seq == seq)
    }

    pub(super) fn by_seq_mut(&mut self, seq: u64) -> Option<&mut Entry> {
        self.entries
            .iter_mut()
            .chain(self.detached.iter_mut())
            .find(|entry| entry.seq == seq)
    }

    /// Whether the entry is in the pool (`#entries.has(entry)`).
    pub(super) fn live(&self, seq: u64) -> bool {
        self.entries.iter().any(|entry| entry.seq == seq)
    }

    /// A tab by id, also while it is being released (a view's `leave` runs then).
    pub(super) fn entry_any(&self, tab_id: &str) -> Option<&Entry> {
        self.entry(tab_id)
            .or_else(|| self.detached.iter().find(|entry| entry.tab_id == tab_id))
    }

    pub(super) fn entry_any_mut(&mut self, tab_id: &str) -> Option<&mut Entry> {
        let live = self.entries.iter().position(|entry| entry.tab_id == tab_id);
        match live {
            Some(at) => self.entries.get_mut(at),
            None => self
                .detached
                .iter_mut()
                .find(|entry| entry.tab_id == tab_id),
        }
    }

    pub(super) fn has(&self, tab_id: &str) -> bool {
        self.entry(tab_id).is_some()
    }

    /// The entry that owns `session_path` on `device` (F-OWN).
    pub(super) fn owner_entry(&self, device: Option<&str>, session_path: &str) -> Option<&Entry> {
        let owner = self.session_owners.get(&owner_key(device, session_path))?;
        self.entry(&owner.tab_id)
    }

    /// Tabs shown in window `win_id`, in acquisition order.
    pub(super) fn shown_in(&self, win_id: i64) -> Vec<&Entry> {
        self.entries
            .iter()
            .filter(|entry| entry.shown_in(win_id))
            .collect()
    }

    pub(super) fn next_seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }

    /// Windows that show the tab: its owner, then its viewers.
    pub(super) fn windows_of(entry: &Entry) -> Vec<i64> {
        let mut wins = Vec::with_capacity(entry.viewers.len() + usize::from(!entry.owner_detached));
        if !entry.owner_detached {
            wins.push(entry.win_id);
        }
        wins.extend(entry.viewers.iter().copied());
        wins
    }

    /// `TAB_STATUS` push / `GET_TABS` item: the full tab snapshot including cached session meta (`tabStatusPayload`).
    pub(super) fn tab_status(entry: &Entry, cwd: &str) -> Map<String, Value> {
        let run = &entry.tracking.run;
        let mut payload = Map::new();
        payload.insert("tabId".into(), Value::from(entry.tab_id.clone()));
        payload.insert("cwd".into(), Value::from(cwd));
        payload.insert("kind".into(), Value::from(entry.kind.clone()));
        payload.insert("placeholder".into(), Value::from(entry.placeholder));
        if entry.unstarted {
            payload.insert("unstarted".into(), Value::from(true));
        }
        payload.insert(
            "sessionPath".into(),
            entry.session_file.clone().map_or(Value::Null, Value::from),
        );
        // "running" only makes sense on a live connection: a restarting sidecar reports its connection state even
        // with a dead in-flight run.
        let status = if run.running && entry.status == "ready" {
            "running".to_string()
        } else {
            entry.status.clone()
        };
        let running = status == "running";
        payload.insert("status".into(), Value::from(status.clone()));
        // The turn ended; stock's background work (subagents, async jobs) keeps the session unsettled.
        if running && run.settling() {
            payload.insert("settling".into(), Value::from(true));
        }
        if running && let Some(since) = run.since {
            payload.insert("runningSince".into(), Value::from(since));
        }
        if let Some(compacting) = run.compacting {
            payload.insert("compacting".into(), Value::from(compacting));
        }
        if running && let Some(saga) = &run.saga {
            let mut fields = saga.fields.clone();
            fields.insert("startedAt".into(), Value::from(saga.started_at));
            payload.insert("retrySaga".into(), Value::Object(fields));
        }
        if let Some(id) = &entry.session_id {
            payload.insert("sessionId".into(), Value::from(id.clone()));
        }
        if let Some(title) = &entry.title {
            payload.insert(
                "title".into(),
                title.clone().map_or(Value::Null, Value::from),
            );
        }
        if let Some(title) = &entry.auto_title {
            payload.insert(
                "autoTitle".into(),
                title.clone().map_or(Value::Null, Value::from),
            );
        }
        if let Some(task) = &entry.task {
            payload.insert("task".into(), Value::from(task.clone()));
        }
        if let Some(opener) = &entry.opened_by {
            payload.insert("openedBy".into(), Value::from(opener.clone()));
        }
        if let Some(opener) = &entry.opened_by_session {
            payload.insert("openedBySession".into(), Value::from(opener.clone()));
        }
        if let Some(worktree) = &entry.worktree {
            payload.insert("worktree".into(), worktree.clone());
        }
        if let Some(last) = &entry.tracking.last_run {
            payload.insert("lastRun".into(), last.clone());
        }
        if entry.awaiting_connection {
            payload.insert("awaitingConnection".into(), Value::from(true));
        }
        if entry.session_held && status == "error" {
            payload.insert("sessionHeld".into(), Value::from(true));
        }
        if let Some(message) = entry
            .failure
            .as_ref()
            .and_then(|failure| failure.get("message"))
        {
            payload.insert("message".into(), message.clone());
        }
        if let Some(restart) = entry
            .failure
            .as_ref()
            .and_then(|failure| failure.get("restart"))
        {
            payload.insert("restart".into(), restart.clone());
        }
        if status == "starting"
            && let Some(wait) = &entry.start_wait
        {
            match wait {
                StartWait::Queued => {
                    payload.insert("queued".into(), Value::from(true));
                }
                StartWait::Slow(message) => {
                    payload.insert("slow".into(), Value::from(true));
                    if let Some(message) = message {
                        payload.insert("message".into(), Value::from(message.clone()));
                    }
                }
            }
        }
        if entry.resuming {
            payload.insert("resuming".into(), Value::from(true));
        }
        if let Some(retry) = &entry.scheduled_retry {
            payload.insert("scheduledRetry".into(), retry.clone());
        }
        if let Some(device) = &entry.device {
            payload.insert("device".into(), Value::from(device.clone()));
        }
        payload
    }
}

/// F-OWN key: the same path on another device is another file.
pub(super) fn owner_key(device: Option<&str>, session_path: &str) -> String {
    match device {
        Some(device) if !device.is_empty() => format!("{device}\u{0}{session_path}"),
        _ => session_path.to_string(),
    }
}

pub(super) const ANSWERED_KEPT: usize = 256;

pub(super) const SUBAGENT_LEVEL_FLOOR: &str = "progress";

fn level_rank(level: &str) -> u8 {
    match level {
        "events" => 2,
        "progress" => 1,
        _ => 0,
    }
}

/// The level that serves every window's request: the highest, never below the floor.
pub(super) fn highest_subagent_level<'a>(levels: impl Iterator<Item = &'a str>) -> &'static str {
    let mut top = SUBAGENT_LEVEL_FLOOR;
    for level in levels {
        if level_rank(level) > level_rank(top) {
            top = match level {
                "events" => "events",
                "progress" => "progress",
                _ => "off",
            };
        }
    }
    match top {
        "events" => "events",
        "off" => "off",
        _ => "progress",
    }
}

/// An instance's handle: its channel to main and its state. Cloned into every future of a method.
#[derive(Clone)]
pub(super) struct Ctx {
    pub out: Out,
    pub pool: Rc<RefCell<Pool>>,
}

impl Ctx {
    pub(super) fn with<T>(&self, work: impl FnOnce(&mut Pool) -> T) -> T {
        work(&mut self.pool.borrow_mut())
    }

    pub(super) fn push(&self, item: &Value) {
        self.out.push(item);
    }

    /// A send to the windows `wins` (one object for all of them), as `forwardToWindow` did; main skips a destroyed one.
    /// `channel` is the key of `IPC_EVENTS` (`TAB_STATUS`), which main resolves: the names stay spelled once.
    pub(super) fn send(&self, wins: Vec<i64>, channel: &str, data: Value) {
        if wins.is_empty() {
            return;
        }
        self.push(&json!({"k": "send", "wins": wins, "channel": channel, "data": data}));
    }

    pub(super) async fn ask(&self, q: &str, payload: Value) -> R<Value> {
        self.out.ask(q, &payload).await
    }

    pub(super) async fn on_running_change(&self) -> R<()> {
        self.ask("onRunningChange", json!({})).await.map(|_| ())
    }

    pub(super) async fn on_session_files_changed(&self) -> R<()> {
        self.ask("onSessionFilesChanged", json!({}))
            .await
            .map(|_| ())
    }

    /// Whether window `win_id` is destroyed (its `isDestroyed()`), and whether it is a paired web device's.
    pub(super) async fn window_facts(&self, win_id: i64) -> R<(bool, bool)> {
        let facts = self.ask("window", json!({"win": win_id})).await?;
        Ok((
            facts["destroyed"].as_bool().unwrap_or(false),
            facts["web"].as_bool().unwrap_or(false),
        ))
    }

    /// The facts main reads off each tab's sidecar: `cwd`, `status`, `processAlive`, `shared`, `pid`, `sleep`, `bridge`.
    pub(super) async fn facts(&self, tabs: &[String]) -> R<Value> {
        self.ask("facts", json!({"tabs": tabs})).await
    }

    pub(super) async fn cwd_of(&self, tab_id: &str) -> R<String> {
        let facts = self.facts(&[tab_id.to_string()]).await?;
        Ok(facts[tab_id]["cwd"].as_str().unwrap_or("").to_string())
    }

    /// `TAB_STATUS` to the owner and every viewer (`#forwardToTab`), the payload as of now.
    pub(super) async fn forward_status(&self, tab_id: &str) -> R<()> {
        let cwd = self.cwd_of(tab_id).await?;
        self.with(|pool| {
            if let Some(entry) = pool.entry(tab_id) {
                let payload = Value::Object(Pool::tab_status(entry, &cwd));
                let wins = Pool::windows_of(entry);
                self.send(wins, "TAB_STATUS", payload);
            }
        });
        Ok(())
    }
}

/// Params of a call, read with the leniency JSON.stringify gave the TypeScript (an absent key is `undefined`).
pub(super) struct P(pub Value);

impl P {
    pub(super) fn s(&self, key: &str) -> R<String> {
        self.0
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| fault("invalid_params", format!("`{key}` is not a string")))
    }

    pub(super) fn os(&self, key: &str) -> Option<String> {
        self.0.get(key).and_then(Value::as_str).map(str::to_string)
    }

    pub(super) fn i(&self, key: &str) -> R<i64> {
        self.0
            .get(key)
            .and_then(Value::as_i64)
            .ok_or_else(|| fault("invalid_params", format!("`{key}` is not an integer")))
    }

    pub(super) fn oi(&self, key: &str) -> Option<i64> {
        self.0.get(key).and_then(Value::as_i64)
    }

    pub(super) fn b(&self, key: &str) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub(super) fn v(&self, key: &str) -> Value {
        self.0.get(key).cloned().unwrap_or(Value::Null)
    }

    pub(super) fn has(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(|value| !value.is_null())
    }

    pub(super) fn strings(&self, key: &str) -> Vec<String> {
        self.0
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}
