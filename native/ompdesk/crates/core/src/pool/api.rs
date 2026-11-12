//! The pool's public methods: what main's windows, handlers and collaborators ask of it, and the changes they make.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::split::{
    SplitNode, as_split_layout, read_remembered_splits, read_split_node, split_tab_ids,
};
use super::state::{
    Ctx, Entry, LevelKey, Owner, Pool, R, fault, highest_subagent_level, owner_key,
};

fn opt(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::from)
}

impl Ctx {
    // ---- reads ------------------------------------------------------------------------------------------------

    pub(super) fn tab_facts(&self, tab: &str) -> Value {
        self.with(|pool| {
            let Some(entry) = pool.entry(tab) else {
                return Value::Null;
            };
            let run = &entry.tracking.run;
            let mut facts = Map::new();
            facts.insert(
                "title".into(),
                Value::from(entry.title.clone().flatten().unwrap_or_default()),
            );
            facts.insert("busy".into(), Value::from(entry.busy()));
            if entry.busy()
                && let Some(since) = run.since
            {
                facts.insert("runningSince".into(), Value::from(since));
            }
            facts.insert(
                "awaitingConnection".into(),
                Value::from(entry.awaiting_connection),
            );
            facts.insert(
                "retrying".into(),
                Value::from(entry.tracking.retry.is_some()),
            );
            facts.insert(
                "scheduledRetry".into(),
                Value::from(entry.scheduled_retry.is_some()),
            );
            if let Some(opener) = &entry.opened_by {
                facts.insert("openedBy".into(), Value::from(opener.clone()));
            }
            if run.compacting == Some(true) {
                facts.insert("compacting".into(), Value::from(true));
            }
            Value::Object(facts)
        })
    }

    pub(super) fn pending_plan(&self, tab: &str) -> Value {
        self.with(|pool| {
            pool.entry(tab)
                .and_then(|entry| entry.plan_proposal.as_ref())
                .map_or(
                    Value::Null,
                    |(title, path)| json!({"title": title, "planFilePath": path}),
                )
        })
    }

    /// What an automatic update restart must wait for on this computer's tabs.
    pub(super) fn restart_holds(&self) -> Value {
        self.with(|pool| {
            let mut compacting = false;
            let mut plan_waiting = false;
            for entry in pool.entries.iter().filter(|entry| !entry.hosted_view) {
                compacting |= entry.tracking.run.compacting == Some(true);
                plan_waiting |= entry.plan_proposal.is_some();
            }
            json!({"compacting": compacting, "planWaiting": plan_waiting})
        })
    }

    /// The tabs whose omp runs a turn on this computer, for the update restart's background-work probe: main keeps
    /// the ones whose sidecar is ready and can answer a bridge request.
    pub(super) async fn running_bridges(&self) -> R<Value> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| {
                    !entry.hosted_view && entry.device.is_none() && entry.tracking.run.running
                })
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let facts = self.facts(&tabs).await?;
        let kept: Vec<&String> = tabs
            .iter()
            .filter(|tab| {
                facts[tab.as_str()]["bridge"].as_bool() == Some(true)
                    && facts[tab.as_str()]["status"].as_str() == Some("ready")
            })
            .collect();
        Ok(json!(kept))
    }

    pub(super) fn session_running(&self, path: &str, device: Option<&str>) -> bool {
        self.with(|pool| pool.owner_entry(device, path).is_some_and(Entry::busy))
    }

    pub(super) fn is_shared(&self, tab: &str) -> bool {
        self.with(|pool| {
            pool.entry(tab)
                .is_some_and(|entry| !entry.viewers.is_empty())
        })
    }

    pub(super) fn has_draft(&self, tab: &str) -> bool {
        self.with(|pool| {
            pool.entry(tab)
                .and_then(|entry| entry.drafts.get(&"set_next_prompt_draft".to_string()))
                .is_some_and(|reports| reports.values().any(|empty| !empty))
        })
    }

    /// `noteDraft`: a window reports whether its composer draft for the tab is empty. The tab's omp hears "empty" only
    /// once all of them are; the answer is what to send it.
    pub(super) fn note_draft(&self, tab: &str, win: i64, command: &str, empty: bool) -> bool {
        self.with(|pool| {
            let Some(entry) = pool.entry_mut(tab) else {
                return empty;
            };
            let key = command.to_string();
            if !entry.drafts.contains(&key) {
                entry.drafts.insert(key.clone(), Default::default());
            }
            let Some(reports) = entry.drafts.get_mut(&key) else {
                return empty;
            };
            reports.insert(win, empty);
            reports.values().all(|empty| *empty)
        })
    }

    /// `noteSubagentLevel`: the omp holds one level, while every window that shows the tab has its own: it is told the
    /// highest of them.
    pub(super) fn note_subagent_level(&self, tab: &str, key: LevelKey, level: &str) -> String {
        self.with(|pool| {
            let Some(entry) = pool.entry_any_mut(tab) else {
                return level.to_string();
            };
            let levels = entry.subagent_levels.get_or_insert_with(Vec::new);
            match levels.iter_mut().find(|(candidate, _)| *candidate == key) {
                Some((_, slot)) => *slot = level.to_string(),
                None => levels.push((key, level.to_string())),
            }
            highest_subagent_level(levels.iter().map(|(_, level)| level.as_str())).to_string()
        })
    }

    /// A window toggled a composer mode: the other windows that show the tab are told with a `config_update` frame.
    pub(super) fn note_mode_changed(&self, tab: &str, except: i64) {
        let wins = self.with(|pool| {
            let entry = pool.entry(tab)?;
            if entry.viewers.is_empty() {
                return None;
            }
            Some(entry.full.clone().unwrap_or_default())
        });
        for win in wins.unwrap_or_default() {
            if win == except {
                continue;
            }
            self.send(
                vec![win],
                "CONFIG_UPDATE",
                json!({"tabId": tab, "payload": {"type": "config_update", "modes": true}}),
            );
        }
    }

    /// A session renamed on disk while its tab holds no live omp: the tab entry, its strip and every window's session
    /// title learn the name now.
    pub(super) async fn note_session_name(&self, tab: &str, title: &str) -> R<()> {
        let wins = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            entry.title = Some(Some(title.to_string()));
            Some(entry.full.clone().unwrap_or_default())
        });
        let Some(wins) = wins else {
            return Ok(());
        };
        self.forward_status(tab).await?;
        for win in wins {
            self.send(
                vec![win],
                "SESSION_INFO_UPDATE",
                json!({"tabId": tab, "payload": {"type": "session_info_update", "title": title}}),
            );
        }
        Ok(())
    }

    // ---- window routing -----------------------------------------------------------------------------------------

    /// `entryForWindow`: the window's active tab (the first as a fallback, e.g. mid-teardown).
    fn entry_for_window(pool: &Pool, win: i64) -> Option<&Entry> {
        let active = pool
            .active_by_window
            .get(&win)
            .and_then(|tab| pool.entry(tab))
            .filter(|entry| entry.shown_in(win));
        active.or_else(|| pool.entries.iter().find(|entry| entry.shown_in(win)))
    }

    pub(super) fn tab_for_window(&self, win: i64) -> Value {
        self.with(|pool| opt(Ctx::entry_for_window(pool, win).map(|entry| entry.tab_id.clone())))
    }

    pub(super) fn tab_for_window_tab(&self, win: i64, tab: &str) -> Value {
        self.with(|pool| {
            opt(pool
                .entry(tab)
                .filter(|entry| entry.shown_in(win))
                .map(|entry| entry.tab_id.clone()))
        })
    }

    /// `tabTarget`: one tab of `win` (`tab`, or its active tab) with what a handler routes it by.
    pub(super) fn tab_target(&self, win: i64, tab: Option<&str>) -> Value {
        self.with(|pool| {
            let entry = match tab {
                Some(tab) if !tab.is_empty() => pool.entry(tab),
                _ => Ctx::entry_for_window(pool, win),
            };
            let Some(entry) = entry.filter(|entry| entry.shown_in(win)) else {
                return Value::Null;
            };
            let mut target = Map::new();
            target.insert("tabId".into(), Value::from(entry.tab_id.clone()));
            if let Some(device) = &entry.device {
                target.insert("device".into(), Value::from(device.clone()));
            }
            target.insert("winId".into(), Value::from(entry.win_id));
            target.insert("sessionFile".into(), opt(entry.session_file.clone()));
            Value::Object(target)
        })
    }

    pub(super) fn window_of_tab(&self, tab: &str) -> Value {
        self.with(|pool| {
            pool.entry(tab)
                .map_or(Value::Null, |entry| Value::from(entry.win_id))
        })
    }

    pub(super) fn windows_showing_tab(&self, tab: &str) -> Value {
        self.with(|pool| json!(pool.entry(tab).map(Pool::windows_of).unwrap_or_default()))
    }

    /// Every window that owns a live tab, in tab acquisition order.
    /// Every live tab, in acquisition order.
    pub(super) fn tab_ids(&self) -> Value {
        self.with(|pool| {
            json!(
                pool.entries
                    .iter()
                    .map(|entry| entry.tab_id.clone())
                    .collect::<Vec<_>>()
            )
        })
    }

    pub(super) fn tab_windows(&self) -> Value {
        self.with(|pool| {
            let mut wins: Vec<i64> = Vec::new();
            for entry in &pool.entries {
                if !wins.contains(&entry.win_id) {
                    wins.push(entry.win_id);
                }
            }
            json!(wins)
        })
    }

    pub(super) fn active_tab_for_window(&self, win: i64) -> Value {
        self.with(|pool| opt(pool.active_by_window.get(&win).cloned()))
    }

    /// The windows that show a tab, with the tab each shows as its active one, in the order the windows came: where
    /// app-wide state goes (the desktop slot's events, a channel of its own). A window without a tab has no use for it.
    pub(super) fn broadcast_targets(&self) -> Value {
        self.with(|pool| {
            let list: Vec<Value> = pool
                .active_by_window
                .iter()
                .filter(|(win, tab)| pool.entry(tab).is_some_and(|entry| entry.shown_in(**win)))
                .map(|(win, tab)| json!([win, tab]))
                .collect();
            Value::Array(list)
        })
    }

    /// Which tabs wait on one provider together: the tracker's snapshot, narrowed to the tabs the pool knows.
    pub(super) fn model_wait_together(&self, together: &Value) {
        let tabs: Map<String, Value> = self.with(|pool| {
            together
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|pair| {
                    let key = pair.get(0)?.as_str()?;
                    pool.has(key)
                        .then(|| (key.to_string(), pair.get(1).cloned().unwrap_or(Value::Null)))
                })
                .collect()
        });
        let wins: Vec<i64> = self.with(|pool| {
            pool.active_by_window
                .iter()
                .filter(|(win, tab)| pool.entry(tab).is_some_and(|entry| entry.shown_in(**win)))
                .map(|(win, _)| *win)
                .collect()
        });
        self.send(wins, "MODEL_WAIT_TOGETHER", json!({"tabs": tabs}));
    }

    // ---- sessions' owners ---------------------------------------------------------------------------------------

    pub(super) fn session_owner(&self, path: &str, device: Option<&str>) -> Value {
        self.with(|pool| {
            pool.session_owners.get(&owner_key(device, path)).map_or(
                Value::Null,
                |owner| json!({"tabId": owner.tab_id, "winId": owner.win_id}),
            )
        })
    }

    /// Whether the owner tab of `sessionPath` has a process holding that session in memory: a child that is still
    /// running always counts, whatever the status says.
    pub(super) async fn session_owner_is_live(&self, path: &str, device: Option<&str>) -> R<bool> {
        let found = self.with(|pool| {
            pool.owner_entry(device, path)
                .map(|entry| (entry.tab_id.clone(), entry.status.clone()))
        });
        let Some((tab, status)) = found else {
            return Ok(false);
        };
        let facts = self.facts(std::slice::from_ref(&tab)).await?;
        if facts[tab.as_str()]["processAlive"].as_bool() == Some(true) {
            return Ok(true);
        }
        Ok(!matches!(status.as_str(), "asleep" | "exited" | "error"))
    }

    /// The owner BLOCKING `tab`'s attach to `sessionPath`: the file's current owner when it is a different tab.
    pub(super) fn foreign_session_owner(&self, tab: Option<&str>, path: &str) -> Value {
        self.with(|pool| {
            let device = tab
                .and_then(|tab| pool.entry(tab))
                .and_then(|entry| entry.device.clone());
            match pool.session_owners.get(&owner_key(device.as_deref(), path)) {
                Some(owner) if Some(owner.tab_id.as_str()) != tab => {
                    json!({"tabId": owner.tab_id, "winId": owner.win_id})
                }
                _ => Value::Null,
            }
        })
    }

    pub(super) async fn note_session_file(&self, tab: &str, file: Option<&str>) -> R<()> {
        let Some((previous, win)) = self.with(|pool| {
            pool.entry(tab)
                .map(|entry| (entry.session_file.clone(), entry.win_id))
        }) else {
            return Ok(());
        };
        match file.filter(|file| !file.is_empty()) {
            Some(file) => self.register_session_file(tab, file).await?,
            None => self.unregister_session_file(tab).await?,
        }
        let changed = self.with(|pool| {
            pool.entry(tab)
                .is_some_and(|entry| entry.session_file != previous)
        });
        if changed {
            self.forward_status(tab).await?;
            self.notify_window_tabs_changed(win).await?;
        }
        Ok(())
    }

    /// Re-root a tab to its live session's cwd; true when the cwd changed.
    pub(super) async fn adopt_session_cwd(&self, tab: &str, cwd: &str) -> R<bool> {
        let Some(win) = self.with(|pool| pool.entry(tab).map(|entry| entry.win_id)) else {
            return Ok(false);
        };
        if cwd.is_empty() {
            return Ok(false);
        }
        let changed = self
            .ask("adoptCwd", json!({"tab": tab, "cwd": cwd}))
            .await?;
        if changed.as_bool() != Some(true) {
            return Ok(false);
        }
        self.forward_status(tab).await?;
        self.notify_window_tabs_changed(win).await?;
        Ok(true)
    }

    // ---- requests, for pages that loaded later -------------------------------------------------------------------

    /// Each of this window's tabs' status texts, widgets and title, for a page that loaded after they were sent.
    pub(super) fn extension_ui_state(&self, win: i64) -> Value {
        self.with(|pool| {
            let mut shown = Vec::new();
            for entry in &pool.entries {
                let Some(state) = entry.ui_state.as_ref().filter(|_| entry.shown_in(win)) else {
                    continue;
                };
                for request in state.values() {
                    shown.push(json!({"tabId": entry.tab_id, "request": request}));
                }
            }
            Value::Array(shown)
        })
    }

    /// The asks and approvals this window's tabs still wait on, for a page that loaded after they were raised.
    pub(super) fn open_requests(&self, win: i64) -> Value {
        self.with(|pool| {
            let ids: Vec<String> = pool.request_bodies.keys().cloned().collect();
            let mut open = Vec::new();
            for id in ids {
                let Some(held) = pool.request_bodies.get(&id).cloned() else {
                    continue;
                };
                let Some(owner) = pool.request_owners.get(&id).copied() else {
                    pool.request_bodies.remove(&id);
                    pool.sign_in_requests.remove(&id);
                    continue;
                };
                if !pool.by_seq(owner).is_some_and(|entry| entry.shown_in(win)) {
                    continue;
                }
                let sign_in = Ctx::sign_in_mark(pool, owner, &held.request, held.kinds);
                let tab = pool
                    .by_seq(owner)
                    .map(|entry| entry.tab_id.clone())
                    .unwrap_or_default();
                let mut item = Map::new();
                item.insert("tabId".into(), Value::from(tab));
                item.insert("request".into(), held.request);
                if let Some(sign_in) = sign_in {
                    item.insert("signIn".into(), sign_in);
                }
                open.push(Value::Object(item));
            }
            Value::Array(open)
        })
    }

    // ---- what the other computers' views read ---------------------------------------------------------------------

    pub(super) async fn resume_facts(&self) -> R<Value> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| !entry.hosted_view)
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let facts = self.facts(&tabs).await?;
        Ok(self.with(|pool| {
            let asking: HashSet<u64> = pool.request_owners.values().copied().collect();
            let list: Vec<Value> = pool
                .entries
                .iter()
                .filter(|entry| !entry.hosted_view)
                .map(|entry| {
                    let run = &entry.tracking.run;
                    let mut fact = Map::new();
                    fact.insert("tabId".into(), Value::from(entry.tab_id.clone()));
                    fact.insert("winId".into(), Value::from(entry.win_id));
                    fact.insert("cwd".into(), facts[entry.tab_id.as_str()]["cwd"].clone());
                    fact.insert("kind".into(), Value::from(entry.kind.clone()));
                    fact.insert("running".into(), Value::from(run.running));
                    fact.insert("stopped".into(), Value::from(entry.tracking.stopped));
                    fact.insert(
                        "awaitingUi".into(),
                        Value::from(asking.contains(&entry.seq)),
                    );
                    fact.insert(
                        "awaitingConnection".into(),
                        Value::from(entry.awaiting_connection),
                    );
                    if let Some(device) = entry.device.as_ref().filter(|device| !device.is_empty())
                    {
                        fact.insert("device".into(), Value::from(device.clone()));
                    }
                    if let Some(file) = entry.session_file.as_ref().filter(|file| !file.is_empty())
                    {
                        fact.insert("sessionFile".into(), Value::from(file.clone()));
                    }
                    if let Some(last) = &entry.tracking.last_run {
                        fact.insert("lastRun".into(), last.clone());
                    }
                    if let Some(retry) = &entry.tracking.retry {
                        // One object per `auto_retry_start`: main hands the same object out while this id stands.
                        fact.insert(
                            "retry".into(),
                            json!({"errorMessage": retry.error_message, "id": retry.serial}),
                        );
                    }
                    if entry.touched > 0 {
                        fact.insert("touched".into(), Value::from(entry.touched));
                    }
                    if entry.prompted > 0 {
                        fact.insert("prompted".into(), Value::from(entry.prompted));
                    }
                    if entry.exits > 0 {
                        fact.insert("exits".into(), Value::from(entry.exits));
                    }
                    if run.settling() {
                        fact.insert("settling".into(), Value::from(true));
                    }
                    if let Some(prompt) = &entry.unsaved_prompt {
                        fact.insert("unsavedPrompt".into(), Value::from(prompt.clone()));
                    }
                    if let Some(opener) =
                        entry.opened_by.as_ref().filter(|opener| !opener.is_empty())
                    {
                        fact.insert("openedBy".into(), Value::from(opener.clone()));
                    }
                    if let Some(opener) = entry
                        .opened_by_session
                        .as_ref()
                        .filter(|opener| !opener.is_empty())
                    {
                        fact.insert("openedBySession".into(), Value::from(opener.clone()));
                    }
                    Value::Object(fact)
                })
                .collect();
            Value::Array(list)
        }))
    }

    /// The sessions this computer's windows run, for the one summary builder: which ask each tab holds now. A tab on a
    /// paired host and a view of a device's tab here are left out.
    pub(super) fn summary_sources(&self) -> Value {
        self.with(|pool| {
            let mut asks: Vec<(u64, &'static str)> = Vec::new();
            for (id, owner) in pool.request_owners.iter() {
                if pool.sign_in_requests.contains(id) {
                    continue;
                }
                let approval = pool
                    .request_bodies
                    .get(id)
                    .is_some_and(|held| held.kinds.approval);
                let current = asks.iter().position(|(seq, _)| seq == owner);
                if current.is_none_or(|at| asks[at].1 != "approval") {
                    let value = if approval { "approval" } else { "input" };
                    match current {
                        Some(at) => asks[at].1 = value,
                        None => asks.push((*owner, value)),
                    }
                }
            }
            let list: Vec<Value> = pool
                .entries
                .iter()
                .filter(|entry| entry.device.is_none() && !entry.hosted_view)
                .map(|entry| {
                    let ask = asks
                        .iter()
                        .find(|(seq, _)| *seq == entry.seq)
                        .map(|(_, ask)| *ask);
                    json!({"tabId": entry.tab_id, "ask": ask})
                })
                .collect();
            Value::Array(list)
        })
    }

    /// One summary source's facts now (null once its tab is gone); `ask` is the one `summary_sources` found.
    pub(super) async fn summary_facts(&self, tab: &str, ask: Option<&str>) -> R<Value> {
        if !self.with(|pool| pool.has(tab)) {
            return Ok(Value::Null);
        }
        let cwd = self.cwd_of(tab).await?;
        Ok(self.with(|pool| {
            let Some(entry) = pool.entry(tab) else {
                return Value::Null;
            };
            let payload = Pool::tab_status(entry, &cwd);
            let ask = ask.or(entry.plan_proposal.as_ref().map(|_| "approval"));
            let mut facts = Map::new();
            facts.insert("sessionPath".into(), opt(entry.session_file.clone()));
            facts.insert("tabId".into(), Value::from(entry.tab_id.clone()));
            facts.insert("cwd".into(), payload["cwd"].clone());
            facts.insert("kind".into(), Value::from(entry.kind.clone()));
            facts.insert("status".into(), payload["status"].clone());
            for key in ["settling", "compacting"] {
                if payload.get(key).and_then(Value::as_bool) == Some(true) {
                    facts.insert(key.into(), Value::from(true));
                }
            }
            if let Some(since) = payload.get("runningSince") {
                facts.insert("since".into(), since.clone());
            }
            if let Some(ask) = ask {
                facts.insert("ask".into(), Value::from(ask));
            }
            for key in ["awaitingConnection", "sessionHeld", "queued"] {
                if payload.get(key).and_then(Value::as_bool) == Some(true) {
                    facts.insert(key.into(), Value::from(true));
                }
            }
            if let Some(failure) = &entry.failure {
                facts.insert("failure".into(), failure.clone());
            }
            if let Some(id) = &entry.session_id {
                facts.insert("sessionId".into(), Value::from(id.clone()));
            }
            if let Some(title) = entry
                .title
                .clone()
                .flatten()
                .filter(|title| !title.is_empty())
            {
                facts.insert("title".into(), Value::from(title));
            }
            if let Some(title) = entry
                .auto_title
                .clone()
                .flatten()
                .filter(|title| !title.is_empty())
            {
                facts.insert("autoTitle".into(), Value::from(title));
            }
            Value::Object(facts)
        }))
    }

    /// Who opened what in this computer's windows: child session file → its opener's file.
    pub(super) fn session_openers(&self) -> Value {
        self.with(|pool| {
            let mut openers: Vec<(String, String)> = Vec::new();
            for entry in &pool.entries {
                let Some(file) = entry.session_file.as_ref().filter(|file| !file.is_empty()) else {
                    continue;
                };
                if entry.device.is_some() || entry.hosted_view {
                    continue;
                }
                let from_tab = entry
                    .opened_by
                    .as_ref()
                    .and_then(|tab| pool.entry(tab))
                    .and_then(|opener| opener.session_file.clone());
                let opener = from_tab.or_else(|| entry.opened_by_session.clone());
                if let Some(opener) = opener.filter(|opener| !opener.is_empty() && opener != file) {
                    match openers.iter_mut().find(|(child, _)| child == file) {
                        Some((_, slot)) => *slot = opener,
                        None => openers.push((file.clone(), opener)),
                    }
                }
            }
            json!(openers)
        })
    }

    /// The tabs of this computer's windows that run on a paired device and that a session of this computer opened.
    pub(super) async fn remote_opened_tabs(&self) -> R<Value> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| {
                    entry.device.is_some() && !entry.hosted_view && entry.session_file.is_some()
                })
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let facts = self.facts(&tabs).await?;
        Ok(self.with(|pool| {
            let list: Vec<Value> = tabs
                .iter()
                .filter_map(|tab| {
                    let entry = pool.entry(tab)?;
                    let opener = entry
                        .opened_by
                        .as_ref()
                        .and_then(|opener| pool.entry(opener));
                    let opened_by = match opener {
                        Some(opener) if opener.device.is_some() => None,
                        Some(opener) => opener.session_file.clone(),
                        None => entry.opened_by_session.clone(),
                    }
                    .filter(|file| !file.is_empty())?;
                    let cwd = facts[tab.as_str()]["cwd"].as_str().unwrap_or("");
                    let payload = Pool::tab_status(entry, cwd);
                    let mut item = Map::new();
                    item.insert("tabId".into(), Value::from(entry.tab_id.clone()));
                    item.insert("device".into(), opt(entry.device.clone()));
                    item.insert("sessionPath".into(), opt(entry.session_file.clone()));
                    item.insert("cwd".into(), payload["cwd"].clone());
                    item.insert("kind".into(), Value::from(entry.kind.clone()));
                    item.insert("openedBySession".into(), Value::from(opened_by));
                    item.insert("status".into(), payload["status"].clone());
                    if let Some(title) = payload
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|title| !title.is_empty())
                    {
                        item.insert("title".into(), Value::from(title));
                    }
                    if let Some(task) = &entry.task {
                        item.insert("task".into(), Value::from(task.clone()));
                    }
                    if payload.get("compacting").and_then(Value::as_bool) == Some(true) {
                        item.insert("compacting".into(), Value::from(true));
                    }
                    if let Some(worktree) = &entry.worktree {
                        item.insert("worktree".into(), worktree.clone());
                    }
                    if let Some(last) = payload.get("lastRun") {
                        item.insert("lastRun".into(), last.clone());
                    }
                    Some(Value::Object(item))
                })
                .collect();
            Value::Array(list)
        }))
    }

    /// The session files this computer's windows' tabs hold (a phone page's included).
    pub(super) fn window_session_files(&self) -> Value {
        self.with(|pool| {
            let mut files: Vec<String> = Vec::new();
            for entry in &pool.entries {
                if entry.device.is_some() || entry.hosted_view {
                    continue;
                }
                if let Some(file) = entry.session_file.as_ref().filter(|file| !file.is_empty())
                    && !files.contains(file)
                {
                    files.push(file.clone());
                }
            }
            json!(files)
        })
    }

    pub(super) fn worktree_bindings(&self) -> Value {
        self.with(|pool| {
            let list: Vec<Value> = pool
                .entries
                .iter()
                .filter(|entry| entry.device.is_none() && !entry.hosted_view)
                .filter_map(|entry| entry.worktree.as_ref())
                .map(|worktree| {
                    json!({"path": worktree["path"], "branch": worktree["branch"], "baseCwd": worktree["baseCwd"]})
                })
                .collect();
            Value::Array(list)
        })
    }

    pub(super) fn session_file_of(&self, tab: &str) -> Value {
        self.with(|pool| opt(pool.entry(tab).and_then(|entry| entry.session_file.clone())))
    }

    pub(super) fn former_tab_ids(&self, tab: &str) -> Vec<String> {
        self.with(|pool| {
            pool.entry(tab)
                .and_then(|entry| {
                    entry
                        .former
                        .as_ref()
                        .filter(|(file, _)| Some(file) == entry.session_file.as_ref())
                        .map(|(_, ids)| ids.clone())
                })
                .unwrap_or_default()
        })
    }

    pub(super) fn tab_inventory(&self) -> Value {
        self.with(|pool| {
            let list: Vec<Value> = pool
                .entries
                .iter()
                .filter(|entry| !entry.hosted_view)
                .map(|entry| json!({"windowId": entry.win_id, "tabId": entry.tab_id, "inFlight": entry.busy()}))
                .collect();
            Value::Array(list)
        })
    }

    pub(super) async fn memory_tabs(&self) -> R<Value> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| !entry.hosted_view && entry.device.is_none())
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let mut list = Vec::new();
        let facts = self.facts(&tabs).await?;
        for tab in &tabs {
            let quiet = self.quiet(tab).await?;
            let label = self.with(|pool| {
                pool.entry(tab).map(|entry| {
                    entry
                        .title
                        .clone()
                        .flatten()
                        .filter(|title| !title.is_empty())
                        .or_else(|| {
                            entry
                                .auto_title
                                .clone()
                                .flatten()
                                .filter(|title| !title.is_empty())
                        })
                        .unwrap_or_else(|| entry.tab_id.clone())
                })
            });
            let Some(label) = label else {
                continue;
            };
            let mut item = Map::new();
            item.insert("tabId".into(), Value::from(tab.clone()));
            if let Some(pid) = facts[tab.as_str()].get("pid").filter(|pid| !pid.is_null()) {
                item.insert("pid".into(), pid.clone());
            }
            item.insert("label".into(), Value::from(label));
            item.insert("quiet".into(), Value::from(quiet));
            list.push(Value::Object(item));
        }
        Ok(Value::Array(list))
    }

    /// Nothing in the tab is live as the pool sees it (`idle-release.ts`): this computer's own ready tab on a saved
    /// session, shown in no window, split pane or device, opened by the person, with no turn, compaction, ask, plan,
    /// draft, retry, continuation, sign-in or pending restart.
    pub(super) async fn quiet(&self, tab: &str) -> R<bool> {
        let facts = self.facts(&[tab.to_string()]).await?;
        let sleepable = facts[tab]["sleep"].as_bool() == Some(true);
        Ok(self.with(|pool| {
            let Some(entry) = pool.entry(tab) else {
                return false;
            };
            if entry.hosted_view || entry.device.is_some() || entry.placeholder || entry.unstarted {
                return false;
            }
            if entry.status != "ready" || !sleepable || entry.session_file.is_none() {
                return false;
            }
            if entry.full.is_some() || !entry.device_views.is_empty() {
                return false;
            }
            if entry.busy() {
                return false;
            }
            if entry.opened_by.is_some() || entry.opened_by_session.is_some() {
                return false;
            }
            if entry.awaiting_connection || entry.plan_proposal.is_some() || entry.resuming {
                return false;
            }
            if entry.unsaved_prompt.is_some()
                || entry.scheduled_retry.is_some()
                || entry.tracking.retry.is_some()
            {
                return false;
            }
            if entry.sign_ins != 0 || entry.omp_restart_pending || entry.extension_pending.is_some()
            {
                return false;
            }
            if entry
                .drafts
                .get(&"set_next_prompt_draft".to_string())
                .is_some_and(|reports| reports.values().any(|empty| !empty))
            {
                return false;
            }
            !pool
                .request_owners
                .values()
                .any(|owner| *owner == entry.seq)
        }))
    }

    // ---- changes ----------------------------------------------------------------------------------------------

    /// `reorderWindowTabs`: put one window's tabs in `order`; other windows' tabs keep their slots.
    pub(super) async fn reorder_window_tabs(&self, win: i64, order: &[String]) -> R<bool> {
        let reordered = self.with(|pool| {
            let mine: Vec<usize> = pool
                .entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| entry.win_id == win)
                .map(|(at, _)| at)
                .collect();
            let sorted: Vec<&String> = order
                .iter()
                .filter(|id| mine.iter().any(|at| pool.entries[*at].tab_id == **id))
                .collect();
            let unique: HashSet<&&String> = sorted.iter().collect();
            if sorted.len() != mine.len() || unique.len() != mine.len() {
                return false;
            }
            let mut taken: Vec<Option<Entry>> = pool.entries.drain(..).map(Some).collect();
            let mut mine_sorted: Vec<Entry> = Vec::new();
            for id in &sorted {
                let at = taken.iter().position(|slot| {
                    slot.as_ref()
                        .is_some_and(|entry| entry.tab_id == **id && entry.win_id == win)
                });
                if let Some(entry) = at.and_then(|at| taken[at].take()) {
                    mine_sorted.push(entry);
                }
            }
            let mut sorted_iter = mine_sorted.into_iter();
            let slots: Vec<usize> = mine;
            let mut rebuilt: Vec<Entry> = Vec::new();
            let mut placeholders: Vec<Option<Entry>> = Vec::new();
            for (at, slot) in taken.into_iter().enumerate() {
                if slots.contains(&at) {
                    placeholders.push(sorted_iter.next());
                } else {
                    placeholders.push(slot);
                }
            }
            rebuilt.extend(placeholders.into_iter().flatten());
            pool.entries = rebuilt;
            true
        });
        if !reordered {
            return Ok(false);
        }
        self.notify_window_tabs_changed(win).await?;
        Ok(true)
    }

    pub(super) async fn note_stopped(&self, tab: &str) -> R<()> {
        let found = self.with(|pool| {
            pool.entry_mut(tab).map(|entry| {
                entry.tracking.stopped = true;
            })
        });
        if found.is_some() {
            self.on_running_change().await?;
        }
        Ok(())
    }

    pub(super) async fn note_unstarted(&self, tab: &str, unstarted: bool) -> R<()> {
        let win = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            if entry.unstarted == unstarted {
                return None;
            }
            entry.unstarted = unstarted;
            Some(entry.win_id)
        });
        let Some(win) = win else {
            return Ok(());
        };
        self.forward_status(tab).await?;
        self.notify_window_tabs_changed(win).await
    }

    pub(super) async fn note_counter(&self, tab: &str, touched: bool) -> R<()> {
        let found = self.with(|pool| {
            pool.entry_mut(tab).map(|entry| {
                if touched {
                    entry.touched += 1;
                } else {
                    entry.prompted += 1;
                }
            })
        });
        if found.is_some() {
            self.on_running_change().await?;
        }
        Ok(())
    }

    /// `noteSignIn`: a provider sign-in (`login`) started on, or answered from, this tab.
    pub(super) fn note_sign_in(
        &self,
        tab: &str,
        active: bool,
        login: Option<(String, Option<String>)>,
    ) {
        let ended = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            entry.sign_ins = (entry.sign_ins + if active { 1 } else { -1 }).max(0);
            if let Some((provider, _)) = &login {
                if active {
                    entry.sign_in_providers.push(provider.clone());
                } else if let Some(at) =
                    entry.sign_in_providers.iter().position(|id| id == provider)
                {
                    entry.sign_in_providers.remove(at);
                }
            }
            Some(())
        });
        if ended.is_some() && !active {
            let provider = login.as_ref().map(|(provider, _)| provider.clone());
            let error = login.and_then(|(_, error)| error);
            self.sign_in_ended(tab, provider, Some(error));
        }
    }

    pub(super) fn sign_in_active(&self, tab: &str) -> bool {
        self.with(|pool| pool.entry(tab).is_some_and(Entry::signin_active))
    }

    /// Show or clear the tab's "waiting for the internet connection" state.
    pub(super) async fn set_awaiting_connection(&self, tab: &str, awaiting: bool) -> R<()> {
        let views = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            if entry.awaiting_connection == awaiting {
                return None;
            }
            entry.awaiting_connection = awaiting;
            Some(entry.device_views.clone())
        });
        let Some(views) = views else {
            return Ok(());
        };
        self.forward_status(tab).await?;
        // The devices viewing the tab show this computer's wait too, and their Cancel comes back.
        for view in views {
            self.push(&json!({"k": "emitView", "tab": tab, "view": view, "event": "awaitingConnection", "arg": awaiting}));
        }
        Ok(())
    }

    pub(super) async fn set_resuming(&self, tab: &str, resuming: bool) -> R<()> {
        let changed = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            if entry.resuming == resuming {
                return None;
            }
            entry.resuming = resuming;
            Some(())
        });
        if changed.is_some() {
            self.forward_status(tab).await?;
        }
        Ok(())
    }

    /// Which tab a relaunch continues first: 0 the window's focused tab, 1 another pane of its split, 2 the rest.
    pub(super) fn resume_rank(&self, tab: &str) -> i64 {
        self.with(|pool| {
            let Some(entry) = pool.entry(tab) else {
                return 2;
            };
            if pool.active_by_window.get(&entry.win_id).map(String::as_str) == Some(tab) {
                return 0;
            }
            if pool
                .visible_by_window
                .get(&entry.win_id)
                .is_some_and(|visible| visible.iter().any(|id| id == tab))
            {
                1
            } else {
                2
            }
        })
    }

    /// Show (or with `None` clear) the tab's scheduled retry.
    pub(super) async fn set_scheduled_retry(&self, tab: &str, retry: Option<Value>) -> R<()> {
        let views = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            match &retry {
                None => {
                    entry.scheduled_retry.as_ref()?;
                    entry.scheduled_retry = None;
                }
                Some(retry) => entry.scheduled_retry = Some(retry.clone()),
            }
            Some((entry.device_views.clone(), entry.scheduled_retry.clone()))
        });
        let Some((views, current)) = views else {
            return Ok(());
        };
        self.forward_status(tab).await?;
        for view in views {
            self.push(&json!({"k": "emitView", "tab": tab, "view": view, "event": "scheduledRetry", "arg": current}));
        }
        Ok(())
    }

    pub(super) async fn start_tab(&self, tab: &str) -> R<bool> {
        if !self.with(|pool| pool.has(tab)) {
            return Ok(false);
        }
        self.ensure_started(tab).await?;
        Ok(true)
    }

    /// Close the tabs on `device` that a relaunch restored and nobody has shown since whose folder is in `folders`.
    pub(super) async fn close_asleep_tabs_in(
        &self,
        device: Option<&str>,
        folders: &[String],
    ) -> R<Value> {
        let candidates: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| entry.device.as_deref() == device && !entry.hosted_view)
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let facts = self.facts(&candidates).await?;
        let asleep: Vec<String> = candidates
            .into_iter()
            .filter(|tab| {
                facts[tab.as_str()]["status"].as_str() == Some("asleep")
                    && facts[tab.as_str()]["cwd"]
                        .as_str()
                        .is_some_and(|cwd| folders.iter().any(|f| f == cwd))
            })
            .collect();
        self.close_finished(&asleep).await?;
        Ok(json!(asleep))
    }

    pub(super) fn device_session_files(&self, device: &str) -> Value {
        self.with(|pool| {
            let mut files: Vec<String> = Vec::new();
            for entry in &pool.entries {
                if entry.device.as_deref() == Some(device)
                    && !entry.hosted_view
                    && let Some(file) = entry.session_file.as_ref().filter(|file| !file.is_empty())
                    && !files.contains(file)
                {
                    files.push(file.clone());
                }
            }
            json!(files)
        })
    }

    pub(super) async fn close_host_deleted_sessions(
        &self,
        device: &str,
        paths: &[String],
    ) -> R<Value> {
        for path in paths {
            self.ask("deletedAdd", json!({"sessionPath": path, "device": device}))
                .await?;
        }
        let held: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| {
                    entry.device.as_deref() == Some(device)
                        && !entry.hosted_view
                        && entry
                            .session_file
                            .as_ref()
                            .is_some_and(|file| paths.contains(file))
                })
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        self.close_finished(&held).await?;
        Ok(json!(held))
    }

    pub(super) async fn set_tab_task(&self, tab: &str, task: &str) -> R<()> {
        let changed = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            if entry.task.as_deref() == Some(task) {
                return None;
            }
            entry.task = Some(task.to_string());
            Some(())
        });
        if changed.is_some() {
            self.forward_status(tab).await?;
        }
        Ok(())
    }

    /// Record that `opener`'s agent opened `tab`: the windows nest the session under its opener.
    pub(super) async fn set_tab_opener(&self, tab: &str, opener: &str) -> R<()> {
        let win = self.with(|pool| {
            let opener_file = pool
                .entry(opener)
                .map(|opener| opener.session_file.clone())?;
            let entry = pool.entry_mut(tab)?;
            if entry.opened_by.as_deref() == Some(opener) {
                return None;
            }
            entry.opened_by = Some(opener.to_string());
            if let Some(file) = opener_file.filter(|file| !file.is_empty()) {
                entry.opened_by_session = Some(file);
            }
            Some(entry.win_id)
        });
        let Some(win) = win else {
            return Ok(());
        };
        self.forward_status(tab).await?;
        self.notify_window_tabs_changed(win).await
    }

    pub(super) async fn bind_worktree(&self, tab: &str, worktree: Value) -> R<bool> {
        let win = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            entry.worktree = Some(worktree);
            Some(entry.win_id)
        });
        let Some(win) = win else {
            return Ok(false);
        };
        self.forward_status(tab).await?;
        self.notify_window_tabs_changed(win).await?;
        Ok(true)
    }

    /// `releaseTab`: false when the tab is unknown.
    pub(super) async fn release_tab(&self, tab: &str) -> R<bool> {
        let Some(win) = self.with(|pool| pool.entry(tab).map(|entry| entry.win_id)) else {
            return Ok(false);
        };
        self.release_entry(tab).await?;
        self.notify_window_tabs_changed(win).await?;
        Ok(true)
    }

    /// `setTabView`: atomically focus one tab and wire full streams for up to four visible tabs.
    pub(super) async fn set_tab_view(
        &self,
        win: i64,
        focused: &str,
        visible: &[String],
        split: &Value,
        remembered: Option<&Value>,
    ) -> R<bool> {
        let mut ids: Vec<String> = Vec::new();
        for id in visible {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        if ids.is_empty() || ids.len() > 4 || !ids.iter().any(|id| id == focused) {
            return Ok(false);
        }
        let truthy_split = !split.is_null() && split.as_bool() != Some(false);
        let parsed = if truthy_split {
            as_split_layout(read_split_node(split, 0))
        } else {
            None
        };
        if truthy_split {
            let Some(parsed) = &parsed else {
                return Ok(false);
            };
            let parsed_ids = parsed.tab_ids();
            if parsed_ids.len() != ids.len() || !parsed_ids.iter().all(|id| ids.contains(id)) {
                return Ok(false);
            }
        }
        let accepted = self.with(|pool| {
            for id in &ids {
                if !pool.entry(id).is_some_and(|entry| entry.shown_in(win)) {
                    return false;
                }
            }
            pool.active_by_window.insert(win, focused.to_string());
            pool.visible_by_window.insert(win, ids.clone());
            match &parsed {
                Some(parsed) => pool.split_by_window.insert(win, parsed.clone()),
                None => {
                    pool.split_by_window.remove(&win);
                }
            }
            // Remembered splits never share a session with what is on screen; a plain focus switch (no list sent)
            // keeps the others as they were.
            let value = match remembered {
                Some(list) => list.clone(),
                None => Value::Array(
                    pool.remembered_by_window
                        .get(&win)
                        .map(|splits| splits.iter().map(|split| split.to_value()).collect())
                        .unwrap_or_default(),
                ),
            };
            let mut claimed: HashSet<String> = ids.iter().cloned().collect();
            let kept = read_remembered_splits(
                &value,
                &mut |tab| {
                    pool.entry(tab)
                        .filter(|entry| entry.shown_in(win))
                        .map(|entry| entry.tab_id.clone())
                },
                &mut claimed,
            );
            if kept.is_empty() {
                pool.remembered_by_window.remove(&win);
            } else {
                pool.remembered_by_window.insert(win, kept);
            }
            true
        });
        if !accepted {
            return Ok(false);
        }
        self.sync_full_wiring(win).await?;
        self.notify_window_tabs_changed(win).await?;
        Ok(true)
    }

    /// `restartOnNewOmp`: every local tab moves to the new omp; idle tabs restart now on their session file, a tab in
    /// a turn when it ends. Returns how many tabs still wait.
    pub(super) async fn restart_on_new_omp(&self) -> R<usize> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| entry.device.is_none() && !entry.hosted_view)
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let mut waiting = 0;
        for tab in tabs {
            let Some(busy) = self.with(|pool| pool.entry(&tab).map(Entry::busy)) else {
                continue;
            };
            let decision = self
                .ask("decide", json!({"kind": "omp", "tab": tab, "busy": busy}))
                .await?;
            match decision.as_str() {
                Some("skip") => continue,
                Some("wait") => {
                    self.with(|pool| {
                        if let Some(entry) = pool.entry_mut(&tab) {
                            entry.omp_restart_pending = true;
                        }
                    });
                    waiting += 1;
                }
                _ => {
                    let file = self.with(|pool| {
                        pool.entry_mut(&tab).and_then(|entry| {
                            entry.omp_restart_pending = false;
                            entry.session_file.clone()
                        })
                    });
                    self.ask("restart", json!({"tab": tab, "sessionFile": file}))
                        .await?;
                }
            }
        }
        Ok(waiting)
    }

    /// `applyExtensionUpdate`: idle ready tabs apply it now, a tab in a turn when it ends; how many still wait.
    pub(super) async fn apply_extension_update(&self, plan: &Value) -> R<usize> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| entry.device.is_none() && !entry.hosted_view)
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let mut waiting = 0;
        for tab in tabs {
            let Some((busy, seq)) =
                self.with(|pool| pool.entry(&tab).map(|entry| (entry.busy(), entry.seq)))
            else {
                continue;
            };
            let decision = self
                .ask("decide", json!({"kind": "ext", "tab": tab, "busy": busy}))
                .await?;
            match decision.as_str() {
                Some("skip") => continue,
                Some("wait") => {
                    let pending = self.with(|pool| {
                        pool.entry(&tab)
                            .and_then(|entry| entry.extension_pending.clone())
                    });
                    let merged = match pending {
                        Some(pending) => {
                            self.ask("mergePlans", json!({"a": pending, "b": plan}))
                                .await?
                        }
                        None => plan.clone(),
                    };
                    self.with(|pool| {
                        if let Some(entry) = pool.entry_mut(&tab) {
                            entry.extension_pending = Some(merged);
                        }
                    });
                    waiting += 1;
                }
                _ => self.apply_extension_plan(&tab, seq, plan).await?,
            }
        }
        Ok(waiting)
    }

    /// `workspaceDirs`: every local tab's working directory, distinct, in order (asleep tabs included).
    pub(super) async fn workspace_dirs(&self) -> R<Value> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| entry.device.is_none() && !entry.hosted_view)
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        let facts = self.facts(&tabs).await?;
        let mut dirs: Vec<String> = Vec::new();
        for tab in &tabs {
            if let Some(cwd) = facts[tab.as_str()]["cwd"].as_str()
                && !dirs.iter().any(|dir| dir == cwd)
            {
                dirs.push(cwd.to_string());
            }
        }
        Ok(json!(dirs))
    }

    /// `disposeAll`: every sidecar is let go of and the pool's maps are cleared (what the TypeScript cleared: the open
    /// request bodies, the answered-while-on-its-way set and the closers stay as they were).
    pub(super) async fn dispose_all(&self) -> R<()> {
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        self.ask("disposeSidecars", json!({"tabs": tabs})).await?;
        self.with(|pool| {
            pool.entries.clear();
            pool.active_by_window.clear();
            pool.visible_by_window.clear();
            pool.split_by_window.clear();
            pool.remembered_by_window.clear();
            pool.session_owners.clear();
            pool.request_owners.clear();
            pool.answered.clear();
            pool.restoring.clear();
        });
        Ok(())
    }

    // ---- devices' views of a tab ----------------------------------------------------------------------------------

    /// `viewForDevice`'s test: the tab of a window of this computer that holds `path` (not a hosted view's, not a host's).
    pub(super) fn view_target(&self, path: &str) -> Value {
        self.with(|pool| {
            let entry = pool
                .session_owners
                .get(&path.to_string())
                .and_then(|owner| pool.entry(&owner.tab_id))
                .filter(|entry| !entry.hosted_view && entry.device.is_none());
            opt(entry.map(|entry| entry.tab_id.clone()))
        })
    }

    pub(super) async fn device_view_added(&self, tab: &str, view: u64) -> R<()> {
        let known = self.with(|pool| {
            pool.entry_mut(tab).map(|entry| {
                if !entry.device_views.contains(&view) {
                    entry.device_views.push(view);
                }
            })
        });
        if known.is_some() {
            self.send_tab_lists(tab).await?;
        }
        Ok(())
    }

    /// A device's view left the tab (`leave`): its level no longer counts, and the windows hear the count changed.
    pub(super) async fn device_view_left(&self, tab: &str, view: u64) -> R<()> {
        let live = self.with(|pool| {
            let entry = pool.entry_any_mut(tab)?;
            entry.device_views.retain(|candidate| *candidate != view);
            Some(pool.live(entry_seq(pool, tab)))
        });
        let Some(live) = live else {
            return Ok(());
        };
        self.forget_subagent_level(tab, LevelKey::View(view))
            .await?;
        if live {
            self.send_tab_lists(tab).await?;
        }
        Ok(())
    }

    /// What a device's view of the tab is told as it joins: the asks open now, the session's meta and the run.
    pub(super) fn device_snapshot(&self, tab: &str) -> Value {
        self.with(|pool| {
            let now = pool.now;
            let Some(entry) = pool.entry_any(tab) else {
                return Value::Null;
            };
            let mut snapshot = Map::new();
            let asks: Vec<Value> = pool
                .request_owners
                .iter()
                .filter(|(_, owner)| **owner == entry.seq)
                .filter_map(|(id, _)| pool.request_bodies.get(id).map(|held| held.request.clone()))
                .collect();
            snapshot.insert("asks".into(), Value::Array(asks));
            if let Some(id) = &entry.session_id {
                snapshot.insert("sessionId".into(), Value::from(id.clone()));
            }
            if let Some(title) = entry
                .title
                .clone()
                .flatten()
                .filter(|title| !title.is_empty())
            {
                snapshot.insert("title".into(), Value::from(title));
            }
            if let Some(title) = entry
                .auto_title
                .clone()
                .flatten()
                .filter(|title| !title.is_empty())
            {
                snapshot.insert("autoTitle".into(), Value::from(title));
            }
            if entry.awaiting_connection {
                snapshot.insert("awaitingConnection".into(), Value::from(true));
            }
            if let Some(retry) = &entry.scheduled_retry {
                snapshot.insert("scheduledRetry".into(), retry.clone());
            }
            snapshot.insert("run".into(), entry.tracking.run.reading(now));
            Value::Object(snapshot)
        })
    }

    /// `#answerFromDevice`: a device's side-channel frame for a window's tab it views. The first answer to an ask
    /// wins: the windows' cards close as answered elsewhere, and their later answer is refused.
    pub(super) async fn answer_from_device(&self, tab: &str, frame: &Value, from: u64) -> R<()> {
        let id = (frame["type"] == "extension_ui_response")
            .then(|| frame["id"].as_str().map(str::to_string))
            .flatten();
        let seq = self.with(|pool| {
            let entry = pool.entry_any(tab)?;
            let seq = entry.seq;
            if let Some(id) = &id
                && pool
                    .answered
                    .get(id)
                    .is_some_and(|answered| answered.seq == seq)
            {
                return Some(Err(fault(
                    "already_answered",
                    "Another window already answered this request",
                )));
            }
            Some(Ok(seq))
        });
        let Some(seq) = seq else {
            return Ok(());
        };
        let seq = seq?;
        self.ask("sideChannel", json!({"tab": tab, "frame": frame}))
            .await?;
        let Some(id) = id else {
            return Ok(());
        };
        let owned = self.with(|pool| pool.request_owners.get(&id) == Some(&seq));
        if !owned {
            return Ok(());
        }
        self.with(|pool| pool.request_owners.remove(&id));
        self.announce_ask_closed(tab, &id).await?;
        self.on_running_change().await?;
        // No window answered it: every window's later answer is refused.
        self.with(|pool| pool.remember_answered(&id, seq, None));
        self.send_answered_elsewhere(seq, &id, None, Some(from));
        Ok(())
    }

    /// The initial facts of a layout restore are read here from the saved descriptor (`restoreLayout`).
    pub(super) async fn restore_layout(&self, win: i64, layout: &Value) -> R<usize> {
        self.with(|pool| pool.restoring.insert(win));
        let result = self.restore_tabs(win, layout).await;
        self.with(|pool| pool.restoring.remove(&win));
        let restored = result?;
        self.notify_window_tabs_changed(win).await?;
        Ok(restored)
    }

    async fn restore_tabs(&self, win: i64, layout: &Value) -> R<usize> {
        let tabs = layout["tabs"].as_array().cloned().unwrap_or_default();
        let active_index = layout["activeIndex"].as_i64();
        let mut restored_count = 0;
        let mut first: Option<String> = None;
        let mut active: Option<String> = None;
        let mut restored_ids: Vec<Option<String>> = vec![None; tabs.len()];
        for (index, tab) in tabs.iter().enumerate() {
            // One session, one tab: a session another window already holds gets no second tab, which would put a
            // second omp on its file. A paired device's window views that tab again; a second desktop window leaves it.
            let path = tab["sessionPath"].as_str().filter(|path| !path.is_empty());
            let device = tab["device"].as_str().filter(|device| !device.is_empty());
            let owner: Option<Owner> = path.and_then(|path| {
                self.with(|pool| pool.session_owners.get(&owner_key(device, path)).cloned())
            });
            let mut tab_id: Option<String> = None;
            if let Some(owner) = owner {
                let (_, web) = self.window_facts(win).await?;
                if web && self.attach_viewer(win, &owner.tab_id).await? {
                    tab_id = Some(owner.tab_id.clone());
                }
            } else {
                let fresh = self
                    .ask("snowflake", json!({}))
                    .await?
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let (created, _) = self
                    .acquire(super::windows::Acquire {
                        cwd: tab["cwd"].as_str().unwrap_or("").to_string(),
                        win,
                        tab: fresh.clone(),
                        session_path: path.map(str::to_string),
                        kind: tab["kind"].as_str().unwrap_or("agent").to_string(),
                        worktree: tab
                            .get("worktree")
                            .filter(|value| !value.is_null())
                            .cloned(),
                        fresh: path.is_none(),
                        placeholder: tab["placeholder"].as_bool() == Some(true),
                        defer_start: true,
                        title: tab["title"].as_str().map(str::to_string),
                        device: device.map(str::to_string),
                        task: None,
                        former_ids: None,
                    })
                    .await?;
                if created {
                    tab_id = Some(fresh.clone());
                }
                self.with(|pool| {
                    if let Some(entry) = pool.entry_mut(&fresh) {
                        if let Some(opener) =
                            tab["openedBy"].as_str().filter(|opener| !opener.is_empty())
                        {
                            entry.opened_by_session = Some(opener.to_string());
                        }
                        if let (Some(ids), Some(path)) = (tab["formerIds"].as_array(), path) {
                            let ids = ids
                                .iter()
                                .filter_map(|id| id.as_str().map(str::to_string))
                                .collect();
                            entry.former = Some((path.to_string(), ids));
                        }
                    }
                });
            }
            let Some(tab_id) = tab_id else {
                continue;
            };
            restored_count += 1;
            restored_ids[index] = Some(tab_id.clone());
            if first.is_none() {
                first = Some(tab_id.clone());
            }
            if active_index == i64::try_from(index).ok() {
                active = Some(tab_id);
            }
        }
        let Some(active_tab) = active.or(first) else {
            return Ok(restored_count);
        };
        let split_value = layout.get("split").filter(|split| !split.is_null());
        let restored = split_value.and_then(|split| {
            super::split::map_split_leaves(&raw_node(split), &mut |index| {
                restored_ids
                    .get(js_index(index)?)
                    .and_then(|id| id.clone())
                    .map(SplitNode::Leaf)
            })
        });
        let split = as_split_layout(restored.clone());
        let ids: Vec<String> = match &restored {
            Some(restored) => split_tab_ids(restored),
            None => vec![active_tab.clone()],
        };
        let focused = if ids.contains(&active_tab) {
            active_tab.clone()
        } else {
            ids.first().cloned().unwrap_or(active_tab.clone())
        };
        let layout_splits = layout.get("splits").cloned().unwrap_or(Value::Null);
        let mut claimed: HashSet<String> = ids.iter().cloned().collect();
        let remembered = read_remembered_splits(
            &layout_splits,
            &mut |index| restored_ids.get(js_index(index)?).and_then(|id| id.clone()),
            &mut claimed,
        );
        let remembered_value =
            Value::Array(remembered.iter().map(|split| split.to_value()).collect());
        let split_arg = split.map_or(Value::Null, |split| split.to_value());
        self.set_tab_view(win, &focused, &ids, &split_arg, Some(&remembered_value))
            .await?;
        Ok(restored_count)
    }
}

fn entry_seq(pool: &Pool, tab: &str) -> u64 {
    pool.entry_any(tab).map_or(0, |entry| entry.seq)
}

/// `Number(index)` as an array index: a non-negative whole number.
pub(super) fn js_index(index: &str) -> Option<usize> {
    let text = index.trim();
    if text.is_empty() {
        return Some(0);
    }
    let number: f64 = text.parse().ok()?;
    (number >= 0.0 && number.fract() == 0.0 && number < 4_294_967_295.0).then_some(number as usize)
}

/// A stored split as written (ratios as they are: the saved layout was validated when it was read).
pub(super) fn raw_node(value: &Value) -> SplitNode {
    use super::split::{Axis, SplitLayout};
    if let Some(tab_id) = value["tabId"].as_str() {
        return SplitNode::Leaf(tab_id.to_string());
    }
    SplitNode::Split(Box::new(SplitLayout {
        axis: if value["axis"] == "columns" {
            Axis::Columns
        } else {
            Axis::Rows
        },
        ratio: value["ratio"].as_f64().unwrap_or(0.5),
        first: raw_node(&value["first"]),
        second: raw_node(&value["second"]),
    }))
}

impl Ctx {
    /// A new core's pool is seeded with the tabs main still holds handles for (the old core was lost): each is an
    /// entry as a deferred acquire makes it, from the facts the handle can say (`SidecarPool.#reseed` lists what is
    /// lost with the old pool: run state, titles, asks, viewers, splits; the session file survives).
    pub(super) fn seed(&self, tabs: &[Value]) {
        let mut windows: Vec<i64> = Vec::new();
        for tab in tabs {
            let (Some(id), Some(win)) = (tab["tab"].as_str(), tab["win"].as_i64()) else {
                continue;
            };
            let seq = self.with(|pool| {
                let seq = pool.next_seq();
                let mut entry = Entry::new(
                    seq,
                    id.to_string(),
                    win,
                    tab["kind"].as_str().unwrap_or("agent").to_string(),
                    tab["status"].as_str().unwrap_or("asleep").to_string(),
                );
                entry.device = tab["device"].as_str().map(str::to_string);
                // The file the tab held: it owns it again (F-OWN), as at its acquire. Tabs come in acquisition order.
                if let Some(file) = tab["sessionFile"].as_str().filter(|file| !file.is_empty()) {
                    entry.session_file = Some(file.to_string());
                    let key = super::state::owner_key(entry.device.as_deref(), file);
                    pool.session_owners.insert(
                        key,
                        super::state::Owner {
                            tab_id: id.to_string(),
                            win_id: win,
                        },
                    );
                }
                entry.hosted_view = tab["hosted"].as_bool() == Some(true);
                let wired: Vec<i64> = tab["full"]
                    .as_array()
                    .map(|wins| wins.iter().filter_map(Value::as_i64).collect())
                    .unwrap_or_default();
                if !wired.is_empty() {
                    entry.full = Some(wired);
                }
                entry.device_views = tab["views"]
                    .as_array()
                    .map(|views| views.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default();
                pool.entries.push(entry);
                seq
            });
            self.when_closed(win, super::state::Closer::Entry(seq));
            if !windows.contains(&win) {
                windows.push(win);
            }
        }
        self.with(|pool| {
            for win in windows {
                if pool.active_by_window.contains(&win) {
                    continue;
                }
                let first = pool
                    .entries
                    .iter()
                    .find(|entry| entry.shown_in(win))
                    .map(|entry| entry.tab_id.clone());
                if let Some(first) = first {
                    pool.active_by_window.insert(win, first.clone());
                    pool.visible_by_window.insert(win, vec![first]);
                }
            }
        });
    }
}
