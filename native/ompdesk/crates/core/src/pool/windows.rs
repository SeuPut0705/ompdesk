//! The pool's tabs and the windows that show them: acquiring and releasing a tab, each window's view (active, visible,
//! split, remembered), the full-channel wiring that follows it, viewers, and the lists windows are told.

use serde_json::{Map, Value, json};

use super::split::{
    SplitNode, as_split_layout, forget_split_tab, map_split_leaves, remembered_split_of,
    split_tab_ids,
};
use super::state::{Closer, Ctx, Entry, Pool, R};

/// What a tab acquired for a window needs from main's side (`acquire`'s arguments).
pub(super) struct Acquire {
    pub cwd: String,
    pub win: i64,
    pub tab: String,
    pub session_path: Option<String>,
    pub kind: String,
    pub worktree: Option<Value>,
    pub fresh: bool,
    pub placeholder: bool,
    pub defer_start: bool,
    pub title: Option<String>,
    pub device: Option<String>,
    pub task: Option<String>,
    pub former_ids: Option<Vec<String>>,
    pub owner_detached: bool,
}

impl Ctx {
    // ---- the window's "closed" listeners ----------------------------------------------------------------------

    /// `#whenClosed`: one "closed" listener per window runs every tab's and viewer's closer (main registers it when
    /// the first closer of a window is added).
    pub(super) fn when_closed(&self, win: i64, closer: Closer) {
        let first = self.with(|pool| {
            let first = !pool.closers.contains(&win);
            if first {
                pool.closers.insert(win, Vec::new());
            }
            if let Some(list) = pool.closers.get_mut(&win)
                && !list.contains(&closer)
            {
                list.push(closer);
            }
            first
        });
        if first {
            self.push(&json!({"k": "listenClosed", "win": win}));
        }
    }

    pub(super) fn not_when_closed(&self, win: i64, closer: Closer) {
        self.with(|pool| {
            if let Some(list) = pool.closers.get_mut(&win) {
                list.retain(|candidate| *candidate != closer);
            }
        });
    }

    /// The window closed: every tab it owns is released and every tab it viewed is left, in the order they were added.
    pub(super) async fn window_closed(&self, win: i64) -> R<()> {
        let list = self
            .with(|pool| pool.closers.remove(&win))
            .unwrap_or_default();
        for closer in list {
            match closer {
                Closer::Entry(seq) => {
                    let tab = self.with(|pool| pool.by_seq(seq).map(|entry| entry.tab_id.clone()));
                    if let Some(tab) = tab {
                        self.release_entry(&tab).await?;
                    }
                }
                Closer::Viewer(seq, viewer) => {
                    let tab = self.with(|pool| pool.by_seq(seq).map(|entry| entry.tab_id.clone()));
                    if let Some(tab) = tab {
                        self.leave_as_viewer(&tab, viewer).await?;
                    }
                }
            }
        }
        Ok(())
    }

    // ---- starting, persisting ---------------------------------------------------------------------------------

    /// `#ensureStarted`: spawn a tab's sidecar unless one is already under way or it has already run.
    pub(super) async fn ensure_started(&self, tab: &str) -> R<()> {
        let facts = self.facts(&[tab.to_string()]).await?;
        if facts[tab]["status"].as_str() != Some("asleep") {
            return Ok(());
        }
        let session_file =
            self.with(|pool| pool.entry(tab).and_then(|entry| entry.session_file.clone()));
        self.ask("start", json!({"tab": tab, "sessionFile": session_file}))
            .await?;
        Ok(())
    }

    /// `#notifyWindowTabsChanged`: the persistence hook hears the window's layout, except while a restore builds it.
    pub(super) async fn notify_window_tabs_changed(&self, win: i64) -> R<()> {
        let skip = self.with(|pool| !pool.window_tabs_hook || pool.restoring.contains(&win));
        if skip {
            return Ok(());
        }
        let layout = self.tab_layout_for_window(win).await?;
        self.ask("onWindowTabsChanged", json!({"win": win, "layout": layout}))
            .await?;
        Ok(())
    }

    // ---- acquiring ----------------------------------------------------------------------------------------------

    /// `acquire`: true when the tab was created (main holds its sidecar then); `added` says whether the pool holds an
    /// entry even though a step after it threw, as the TypeScript's `catch` left it.
    pub(super) async fn acquire(&self, args: Acquire) -> R<(bool, bool)> {
        let blocked = self
            .ask(
                "blocked",
                json!({"sessionPath": args.session_path, "device": args.device, "cwd": args.cwd}),
            )
            .await?;
        if blocked.as_bool() == Some(true) {
            return Ok((false, false));
        }
        let tab = args.tab.clone();
        let outcome = self.acquire_inner(args).await;
        let added = self.with(|pool| pool.has(&tab));
        Ok((outcome.is_ok(), added))
    }

    async fn acquire_inner(&self, args: Acquire) -> R<()> {
        let tab = args.tab.clone();
        let spawned = self
            .ask(
                "spawn",
                json!({
                    "tab": tab, "win": args.win, "cwd": args.cwd, "kind": args.kind, "fresh": args.fresh,
                    "device": args.device, "sessionPath": args.session_path, "worktree": args.worktree,
                    "placeholder": args.placeholder, "deferStart": args.defer_start,
                    "ownerDetached": args.owner_detached,
                }),
            )
            .await?;
        let status = spawned["status"].as_str().unwrap_or("asleep").to_string();
        let seq = self.with(|pool| {
            let seq = pool.next_seq();
            let mut entry = Entry::new(seq, args.tab.clone(), args.win, args.kind.clone(), status);
            entry.device = args.device.clone();
            entry.owner_detached = args.owner_detached;
            if args.owner_detached {
                entry.view_generations.remove(&args.win);
            }
            entry.placeholder = args.placeholder;
            entry.unstarted = args.session_path.is_none();
            entry.worktree = args.worktree.clone();
            if let Some(title) = &args.title
                && !title.is_empty()
            {
                entry.title = Some(Some(title.clone()));
            }
            if let Some(task) = &args.task
                && !task.is_empty()
            {
                entry.task = Some(task.clone());
            }
            if let (Some(ids), Some(path)) = (&args.former_ids, &args.session_path)
                && !path.is_empty()
            {
                entry.former = Some((path.clone(), ids.clone()));
            }
            pool.entries.push(entry);
            seq
        });
        self.ask("acquired", json!({"tab": tab})).await?;
        // F-OWN: a spawn-with-sessionPath attaches immediately: the owner is registered before any duplicate attach
        // can slip past the IPC guard. A deferred tab registers too.
        if let Some(path) = args.session_path.as_ref().filter(|path| !path.is_empty()) {
            self.register_session_file(&tab, path).await?;
        }
        if !args.defer_start && !args.owner_detached {
            let claim = self.with(|pool| {
                if pool.active_by_window.contains(&args.win) {
                    false
                } else {
                    pool.active_by_window.insert(args.win, tab.clone());
                    pool.visible_by_window.insert(args.win, vec![tab.clone()]);
                    true
                }
            });
            if claim {
                self.sync_full_wiring(args.win).await?;
            }
        }
        if !args.owner_detached {
            self.when_closed(args.win, Closer::Entry(seq));
        }
        if !args.defer_start && !args.owner_detached {
            self.ensure_started(&tab).await?;
        }
        if !args.owner_detached {
            self.notify_window_tabs_changed(args.win).await?;
        }
        Ok(())
    }

    /// `acquireHostedView`: false when the session was deleted.
    pub(super) async fn acquire_hosted_view(
        &self,
        win: i64,
        tab: String,
        kind: String,
        status: String,
        reading: Option<Value>,
        session_path: String,
    ) -> R<bool> {
        let deleted = self
            .ask(
                "blocked",
                json!({"sessionPath": session_path, "cwd": "", "hosted": true}),
            )
            .await?;
        if deleted.as_bool() == Some(true) {
            return Ok(false);
        }
        let seq = self.with(|pool| {
            let seq = pool.next_seq();
            let mut entry = Entry::new(seq, tab.clone(), win, kind, status);
            entry.hosted_view = true;
            // The device's tab may be mid-turn as this window joins it: its events so far reached nobody here.
            if let Some(reading) = &reading {
                entry.tracking.run = super::run::RunState::from_reading(reading, None, pool.now);
            }
            pool.entries.push(entry);
            seq
        });
        self.ask("wire", json!({"tab": tab, "track": false}))
            .await?;
        self.register_session_file(&tab, &session_path).await?;
        let claim = self.with(|pool| {
            if pool.active_by_window.contains(&win) {
                false
            } else {
                pool.active_by_window.insert(win, tab.clone());
                pool.visible_by_window.insert(win, vec![tab.clone()]);
                true
            }
        });
        if claim {
            self.sync_full_wiring(win).await?;
        }
        self.when_closed(win, Closer::Entry(seq));
        self.ensure_started(&tab).await?;
        self.notify_window_tabs_changed(win).await?;
        Ok(true)
    }

    // ---- the full channel, by window --------------------------------------------------------------------------

    pub(super) async fn sync_full_wiring(&self, win: i64) -> R<()> {
        let (visible, tabs) = self.with(|pool| {
            let visible = pool
                .visible_by_window
                .get(&win)
                .cloned()
                .unwrap_or_default();
            let tabs: Vec<String> = pool
                .shown_in(win)
                .iter()
                .map(|entry| entry.tab_id.clone())
                .collect();
            (visible, tabs)
        });
        for tab in tabs {
            if !self.with(|pool| pool.entry(&tab).is_some_and(|entry| entry.shown_in(win))) {
                continue;
            }
            if visible.contains(&tab) {
                self.wire_full(&tab, win).await?;
            } else {
                self.unwire_full(&tab, win);
            }
        }
        Ok(())
    }

    /// Full-channel wiring for window `win`, attached only while the tab is visible in it. Being wired is being shown,
    /// so this is where a deferred tab's process gets spawned.
    async fn wire_full(&self, tab: &str, win: i64) -> R<()> {
        if self.with(|pool| pool.entry(tab).is_none_or(|entry| entry.wired_in(win))) {
            return Ok(());
        }
        self.ensure_started(tab).await?;
        let first = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            match &mut entry.full {
                Some(wins) => {
                    if !wins.contains(&win) {
                        wins.push(win);
                    }
                    Some(false)
                }
                None => {
                    entry.full = Some(vec![win]);
                    Some(true)
                }
            }
        });
        if let Some(first) = first {
            self.push(&json!({"k": "wireFull", "tab": tab, "win": win, "first": first}));
        }
        Ok(())
    }

    /// Stop forwarding the tab's full channel to window `win`; the last window takes the listeners off.
    pub(super) fn unwire_full(&self, tab: &str, win: i64) {
        let last = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            let wins = entry.full.as_mut()?;
            if !wins.contains(&win) {
                return None;
            }
            if wins.len() == 1 {
                entry.full = None;
                Some(true)
            } else {
                wins.retain(|candidate| *candidate != win);
                Some(false)
            }
        });
        if let Some(last) = last {
            self.push(&json!({"k": "unwireFull", "tab": tab, "win": win, "last": last}));
        }
    }

    // ---- releasing ----------------------------------------------------------------------------------------------

    /// `#releaseEntry`: listeners first, then dispose. When the active tab goes away, the oldest surviving tab of the
    /// window takes over; viewer windows lose the tab the same way and hear their list changed. False when the tab is
    /// not in the pool.
    pub(super) async fn release_entry(&self, tab: &str) -> R<bool> {
        let removed = self.with(|pool| {
            let at = pool.index(tab)?;
            let entry = pool.entries.remove(at);
            let seq = entry.seq;
            pool.detached.push(entry);
            Some(seq)
        });
        let Some(seq) = removed else {
            return Ok(false);
        };
        // The tab is gone for everyone now (`byTabId.delete`): main stops handing out its sidecar.
        self.push(&json!({"k": "gone", "tab": tab}));
        let result = self.release_detached(tab, seq).await;
        self.with(|pool| pool.detached.retain(|entry| entry.seq != seq));
        result.map(|()| true)
    }

    async fn release_detached(&self, tab: &str, seq: u64) -> R<()> {
        self.push(&json!({"k": "modelWaitForget", "tab": tab}));
        self.push(&json!({"k": "settleWatch", "op": "forget", "tab": tab}));
        self.on_running_change().await?;
        let session_file = self.with(|pool| {
            pool.by_seq(seq)
                .and_then(|entry| entry.session_file.clone())
        });
        self.unregister_session_file_of(seq).await?;
        // Drop pending request-id routes pointing at the released entry: a late renderer response must fall back,
        // never write to a dead sidecar.
        self.with(|pool| {
            pool.request_owners.retain(|_, owner| *owner != seq);
            pool.answered.retain(|_, answered| answered.seq != seq);
        });
        let (device, hosted, title, task, former, win, devices) = self.with(|pool| {
            let entry = pool.by_seq(seq).expect("a released entry is detached");
            (
                entry.device.clone(),
                entry.hosted_view,
                entry
                    .title
                    .clone()
                    .flatten()
                    .filter(|title| !title.is_empty()),
                entry.task.clone(),
                entry.former.clone(),
                entry.win_id,
                entry.device_views.clone(),
            )
        });
        let mut activity = json!({"type": "released", "tabId": tab});
        if let Some(file) = session_file.as_ref().filter(|_| !hosted) {
            let cwd = self.cwd_of(tab).await?;
            let mut session = Map::new();
            session.insert("path".into(), Value::from(file.clone()));
            if let Some(device) = device.as_ref().filter(|device| !device.is_empty()) {
                session.insert("device".into(), Value::from(device.clone()));
            }
            session.insert(
                "title".into(),
                Value::from(
                    title
                        .or(task.filter(|task| !task.is_empty()))
                        .unwrap_or_default(),
                ),
            );
            session.insert("cwd".into(), Value::from(cwd));
            let former_ids: Vec<String> = match &former {
                Some((path, ids)) if path == file => ids.clone(),
                _ => Vec::new(),
            };
            session.insert("formerIds".into(), json!(former_ids));
            activity["session"] = Value::Object(session);
        }
        self.announce(activity).await?;
        self.not_when_closed(win, Closer::Entry(seq));
        // The devices viewing it hear the tab is gone while its omp still runs.
        if !devices.is_empty() {
            self.ask("endViews", json!({"tab": tab, "views": devices}))
                .await?;
        }
        self.ask(
            "dispose",
            json!({
                "tab": tab, "device": device, "hosted": hosted,
                "sessionFile": session_file,
                "ownerKey": session_file.as_ref().map(|file| super::state::owner_key(device.as_deref(), file)),
            }),
        )
        .await?;
        self.leave_window_view(tab, win).await?;
        let viewers = self.with(|pool| {
            pool.by_seq_mut(seq)
                .map(|entry| std::mem::take(&mut entry.viewers))
                .unwrap_or_default()
        });
        for viewer in viewers {
            self.not_when_closed(viewer, Closer::Viewer(seq, viewer));
            self.leave_window_view(tab, viewer).await?;
            self.send_tab_list(viewer, None, None).await?;
            let (destroyed, _) = self.window_facts(viewer).await?;
            if !destroyed {
                self.notify_window_tabs_changed(viewer).await?;
            }
        }
        Ok(())
    }

    /// `#leaveWindowView`: `tab` is gone from window `win`'s view (released, or the window left it): its visible set,
    /// split and remembered splits forget it, and when it was the active tab the oldest other tab the window shows
    /// takes over.
    pub(super) async fn leave_window_view(&self, tab: &str, win: i64) -> R<()> {
        enum Next {
            Done,
            Sync,
            Elect,
        }
        let next = self.with(|pool| {
            if let Some(visible) = pool.visible_by_window.get_mut(&win) {
                visible.retain(|id| id != tab);
            }
            if let Some(split) = pool.split_by_window.get(&win).cloned()
                && split.contains(tab)
            {
                let node = SplitNode::Split(Box::new(split));
                let remaining = as_split_layout(map_split_leaves(&node, &mut |id| {
                    (id != tab).then(|| SplitNode::Leaf(id.to_string()))
                }));
                match remaining {
                    Some(remaining) => pool.split_by_window.insert(win, remaining),
                    None => {
                        pool.split_by_window.remove(&win);
                    }
                }
            }
            if let Some(remembered) = pool.remembered_by_window.get(&win).cloned() {
                let kept = forget_split_tab(&remembered, tab);
                if kept.is_empty() {
                    pool.remembered_by_window.remove(&win);
                } else {
                    pool.remembered_by_window.insert(win, kept);
                }
            }
            if !pool.entries.iter().any(|entry| entry.shown_in(win)) {
                pool.active_by_window.remove(&win);
                pool.visible_by_window.remove(&win);
                pool.split_by_window.remove(&win);
                pool.remembered_by_window.remove(&win);
                return Next::Done;
            }
            if pool.active_by_window.get(&win).map(String::as_str) != Some(tab) {
                return Next::Sync;
            }
            pool.active_by_window.remove(&win);
            Next::Elect
        });
        match next {
            Next::Done => Ok(()),
            Next::Sync => self.sync_full_wiring(win).await,
            Next::Elect => {
                // During window teardown every entry self-releases; activating a sibling whose window is already gone
                // would wire forwarders for nothing.
                let (destroyed, _) = self.window_facts(win).await?;
                if destroyed {
                    return Ok(());
                }
                let elected = self.with(|pool| {
                    let candidates: Vec<String> = pool
                        .shown_in(win)
                        .iter()
                        .map(|entry| entry.tab_id.clone())
                        .collect();
                    let visible = pool.visible_by_window.get(&win).cloned();
                    let candidate = candidates
                        .iter()
                        .find(|id| visible.as_ref().is_some_and(|visible| visible.contains(id)))
                        .or_else(|| candidates.first())
                        .cloned();
                    let Some(candidate) = candidate else {
                        pool.visible_by_window.remove(&win);
                        return false;
                    };
                    if visible.as_ref().is_none_or(Vec::is_empty) {
                        pool.visible_by_window.insert(win, vec![candidate.clone()]);
                    }
                    pool.active_by_window.insert(win, candidate);
                    true
                });
                if elected {
                    self.sync_full_wiring(win).await?;
                }
                Ok(())
            }
        }
    }

    pub(super) fn commit_exact_window_view(
        &self,
        win: i64,
        tab: &str,
        identity: &str,
        session_path: &str,
        web: bool,
        facts: &Value,
    ) -> Value {
        let mut committed = self.with(|pool| {
            let Some(entry) = pool.entry(tab) else {
                return Value::Null;
            };
            if entry.leave_pending
                || entry.view_identity(win).as_deref() != Some(identity)
                || entry.session_file.as_deref() != Some(session_path)
                || pool
                    .request_owners
                    .values()
                    .any(|owner| *owner == entry.seq)
            {
                return Value::Null;
            }
            let last =
                entry.viewers.len() + usize::from(!entry.owner_detached) + entry.device_views.len()
                    == 1;
            if last && entry.busy() {
                return Value::Null;
            }
            let entry = pool.entry_mut(tab).expect("entry checked above");
            let owner = !entry.owner_detached && entry.win_id == win;
            if owner {
                entry.owner_detached = true;
            } else {
                entry.viewers.retain(|viewer| *viewer != win);
            }
            entry.view_generations.remove(&win);
            entry.leave_pending = true;
            json!({"seq": entry.seq, "owner": owner, "last": last})
        });
        if let Some(result) = committed.as_object_mut() {
            result.insert("layout".into(), self.tab_layout_from_facts(win, web, facts));
        }
        committed
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn finish_exact_window_view(
        &self,
        token: u64,
        win: i64,
        tab: &str,
        seq: u64,
        owner: bool,
        last: bool,
        remote: bool,
    ) -> R<()> {
        let present = self.with(|pool| pool.entry(tab).is_some_and(|entry| entry.seq == seq));
        if !present {
            self.settle_ok(token, Value::Null);
            return Ok(());
        }
        self.not_when_closed(
            win,
            if owner {
                Closer::Entry(seq)
            } else {
                Closer::Viewer(seq, win)
            },
        );
        if owner {
            self.push(&json!({"k": "ownerDetached", "tab": tab}));
        }
        self.unwire_full(tab, win);
        self.leave_window_view(tab, win).await?;
        self.forget_drafts(tab, win).await?;
        self.forget_subagent_level(tab, super::state::LevelKey::Window(win))
            .await?;
        self.push(&json!({"k": "viewTargetChanged", "tab": tab}));
        self.on_running_change().await?;
        self.send_tab_lists(tab).await?;
        self.send_tab_list(win, Some(&[tab.to_string()]), None)
            .await?;
        self.notify_window_tabs_changed(win).await?;
        self.with(|pool| {
            if let Some(entry) = pool.entry_mut(tab).filter(|entry| entry.seq == seq) {
                entry.leave_pending = false;
            }
        });
        if last {
            self.release_hidden_if_unused(tab, !remote).await?;
        }
        self.settle_ok(token, Value::Null);
        Ok(())
    }

    pub(super) async fn release_hidden_if_unused(&self, tab: &str, require_idle: bool) -> R<()> {
        let unused = self.with(|pool| {
            pool.entry(tab).is_some_and(|entry| {
                entry.owner_detached
                    && entry.viewers.is_empty()
                    && entry.device_views.is_empty()
                    && (!require_idle
                        || (!entry.busy()
                            && !entry.awaiting_connection
                            && entry.scheduled_retry.is_none()
                            && !entry.resuming
                            && !pool
                                .request_owners
                                .values()
                                .any(|owner| *owner == entry.seq)))
            })
        });
        if unused {
            self.release_entry(tab).await?;
        }
        Ok(())
    }

    // ---- viewers ----------------------------------------------------------------------------------------------

    /// `attachViewer`: show another window's tab in `win` too. False when the tab is unknown.
    pub(super) async fn attach_viewer(
        &self,
        win: i64,
        tab: &str,
        session: Option<(&str, Option<&str>)>,
    ) -> R<bool> {
        enum Step {
            Unknown,
            Already,
            Joined(u64, bool),
        }
        let step = self.with(|pool| {
            let Some(entry) = pool.entry_mut(tab) else {
                return Step::Unknown;
            };
            if entry.leave_pending {
                return Step::Unknown;
            }
            if session.is_some_and(|(path, device)| {
                entry.session_file.as_deref() != Some(path) || entry.device.as_deref() != device
            }) {
                return Step::Unknown;
            }
            if entry.shown_in(win) {
                return Step::Already;
            }
            entry.viewers.push(win);
            entry.view_serial += 1;
            entry.view_generations.insert(win, entry.view_serial);
            let seq = entry.seq;
            let claim = !pool.active_by_window.contains(&win);
            if claim {
                pool.active_by_window.insert(win, tab.to_string());
                pool.visible_by_window.insert(win, vec![tab.to_string()]);
            }
            Step::Joined(seq, claim)
        });
        match step {
            Step::Unknown => Ok(false),
            Step::Already => Ok(true),
            Step::Joined(seq, claim) => {
                self.when_closed(win, Closer::Viewer(seq, win));
                if claim {
                    self.sync_full_wiring(win).await?;
                }
                self.send_tab_lists(tab).await?;
                // A paired device's saved layout names the tabs it views too.
                self.notify_window_tabs_changed(win).await?;
                Ok(true)
            }
        }
    }

    /// `detachViewer`: false when `win` is not a viewer of the tab.
    pub(super) async fn detach_viewer(&self, win: i64, tab: &str) -> R<bool> {
        let viewing = self.with(|pool| {
            pool.entry(tab)
                .is_some_and(|entry| entry.viewers.contains(&win))
        });
        if !viewing {
            return Ok(false);
        }
        self.leave_as_viewer(tab, win).await?;
        Ok(true)
    }

    /// `#leaveAsViewer`: window `win` stops viewing the tab: it closed it there, or the window itself closed.
    pub(super) async fn leave_as_viewer(&self, tab: &str, win: i64) -> R<()> {
        let seq = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            let at = entry.viewers.iter().position(|viewer| *viewer == win)?;
            entry.viewers.remove(at);
            entry.view_generations.remove(&win);
            Some(entry.seq)
        });
        let Some(seq) = seq else {
            return Ok(());
        };
        self.not_when_closed(win, Closer::Viewer(seq, win));
        self.unwire_full(tab, win);
        self.leave_window_view(tab, win).await?;
        self.forget_drafts(tab, win).await?;
        self.forget_subagent_level(tab, super::state::LevelKey::Window(win))
            .await?;
        self.send_tab_lists(tab).await?;
        self.send_tab_list(win, None, None).await?;
        let (destroyed, _) = self.window_facts(win).await?;
        if !destroyed {
            self.notify_window_tabs_changed(win).await?;
        }
        self.push(&json!({"k": "viewTargetChanged", "tab": tab}));
        self.release_hidden_if_unused(tab, true).await?;
        Ok(())
    }

    // ---- what windows are told --------------------------------------------------------------------------------

    /// `#sendTabLists`: `TAB_LIST_CHANGED` to every window showing the tab.
    pub(super) async fn send_tab_lists(&self, tab: &str) -> R<()> {
        let wins = self.with(|pool| {
            pool.entry_any(tab)
                .map(Pool::windows_of)
                .unwrap_or_default()
        });
        for win in wins {
            self.send_tab_list(win, None, None).await?;
        }
        Ok(())
    }

    /// `#sendTabList`: a destroyed window is skipped before its tabs are listed. `closed`: tabs of this window main
    /// itself closed, which the window drops.
    pub(super) async fn send_tab_list(
        &self,
        win: i64,
        closed: Option<&[String]>,
        shown: Option<Value>,
    ) -> R<()> {
        let (destroyed, _) = self.window_facts(win).await?;
        if destroyed {
            return Ok(());
        }
        let tabs = self.tabs_for_window(win).await?;
        let mut payload = Map::new();
        payload.insert("tabs".into(), Value::Array(tabs));
        if let Some(closed) = closed {
            payload.insert("closed".into(), json!(closed));
        }
        if let Some(shown) = shown {
            payload.insert("shown".into(), shown);
        }
        self.send(vec![win], "TAB_LIST_CHANGED", Value::Object(payload));
        Ok(())
    }

    /// `tabsForWindow`: the window's tabs in acquisition order (GET_TABS boot reconciliation).
    pub(super) async fn tabs_for_window(&self, win: i64) -> R<Vec<Value>> {
        let ids = self.with(|pool| {
            pool.shown_in(win)
                .iter()
                .map(|entry| entry.tab_id.clone())
                .collect::<Vec<_>>()
        });
        let facts = self.facts(&ids).await?;
        Ok(self.with(|pool| {
            let active = pool.active_by_window.get(&win).cloned();
            let visible = pool.visible_by_window.get(&win).cloned();
            let split = pool.split_by_window.get(&win).cloned();
            let remembered = pool
                .remembered_by_window
                .get(&win)
                .cloned()
                .unwrap_or_default();
            pool.shown_in(win)
                .into_iter()
                .map(|entry| {
                    let cwd = facts[entry.tab_id.as_str()]["cwd"].as_str().unwrap_or("");
                    let mut tab = Pool::tab_status(entry, cwd);
                    if active.as_deref() == Some(entry.tab_id.as_str()) {
                        tab.insert("active".into(), Value::from(true));
                    }
                    let is_visible = visible
                        .as_ref()
                        .is_some_and(|visible| visible.contains(&entry.tab_id));
                    if is_visible {
                        tab.insert("visible".into(), Value::from(true));
                    }
                    if let Some(split) = split.as_ref().filter(|_| is_visible) {
                        tab.insert("split".into(), split.to_value());
                    }
                    if let Some(home) = remembered_split_of(&remembered, &entry.tab_id)
                        && split_tab_ids(&SplitNode::Split(Box::new(home.clone())))
                            .first()
                            .map(String::as_str)
                            == Some(entry.tab_id.as_str())
                    {
                        tab.insert("rememberedSplit".into(), home.to_value());
                    }
                    let shared_sidecar =
                        facts[entry.tab_id.as_str()]["shared"].as_bool() == Some(true);
                    if entry.win_id != win || entry.hosted_view || shared_sidecar {
                        tab.insert("shared".into(), Value::from(true));
                    }
                    let viewer_count = entry.viewers.len() + entry.device_views.len();
                    if viewer_count > 0 {
                        tab.insert("viewerCount".into(), Value::from(viewer_count));
                    }
                    Value::Object(tab)
                })
                .collect()
        }))
    }
}
