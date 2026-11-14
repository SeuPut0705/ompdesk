//! What each sidecar event does to its tab (the pool's `#wireLight` listeners). Main registers the listeners on the
//! sidecar, in the order the TypeScript did, and feeds each event here at the moment the sidecar emits it; the work
//! that needed a window, a hook, an observer or the sidecar itself comes back as items and asks, in order.

use serde_json::{Map, Value, json};

use super::run::RunState;
use super::state::{
    Ctx, Entry, Kinds, LevelKey, Pool, R, StartWait, fault, highest_subagent_level,
};

impl Ctx {
    pub(super) async fn feed(
        &self,
        tab: &str,
        event: &str,
        payload: &Value,
        from_link: bool,
    ) -> R<()> {
        if !self.with(|pool| pool.has(tab)) {
            return Ok(());
        }
        match event {
            "status" => self.feed_status(tab, payload, from_link).await,
            "hostRun" => self.feed_host_run(tab, payload).await,
            "sessionDeleted" => self.feed_session_deleted(tab, payload).await,
            "folderGone" => self.close_finished(&[tab.to_string()]).await,
            "shownElsewhere" => self.shown_elsewhere(tab, payload).await,
            "shared" => self.send_tab_lists(tab).await,
            "viewEnded" => self.feed_view_ended(tab).await,
            "sessionInfoUpdate" => self.feed_session_info(tab, payload).await,
            "session" => self.feed_session(tab, payload).await,
            "extensionUi" => self.feed_extension_ui(tab, payload).await,
            "openAsks" => self.feed_open_asks(tab, payload).await,
            "signIn" => self.feed_sign_in(tab, payload),
            "signInRelay" => self.feed_sign_in_relay(tab, payload),
            "settle" => {
                let settled = payload["settled"].as_bool().unwrap_or(true);
                let frame = payload["frame"]
                    .as_str()
                    .unwrap_or("session_settled")
                    .to_string();
                self.settle(tab, settled, &frame).await
            }
            "awaitingConnection" => {
                self.set_awaiting_connection(tab, payload.as_bool().unwrap_or(false))
                    .await
            }
            "scheduledRetry" => {
                let retry = (!payload.is_null()).then(|| payload.clone());
                self.set_scheduled_retry(tab, retry).await
            }
            "events" => self.feed_events(tab, payload).await,
            other => Err(fault("no_event", format!("The pool hears no `{other}`"))),
        }
    }

    async fn feed_status(&self, tab: &str, payload: &Value, from_link: bool) -> R<()> {
        let status = payload["status"].as_str().unwrap_or("").to_string();
        let session_ended = payload["sessionEnded"].as_bool() == Some(true);
        let (seq, owned_requests, host_sign_in) = self.with(|pool| {
            let Some(entry) = pool.entry_mut(tab) else {
                return (0, Vec::new(), None);
            };
            entry.status = status.clone();
            entry.session_held =
                status == "error" && payload["sessionHeld"].as_bool() == Some(true);
            entry.failure = payload
                .get("failure")
                .filter(|failure| !failure.is_null())
                .cloned();
            entry.start_wait = if status != "starting" {
                None
            } else if payload["slow"].as_bool() == Some(true) {
                Some(StartWait::Slow(
                    payload["message"].as_str().map(str::to_string),
                ))
            } else if payload["queued"].as_bool() == Some(true) {
                Some(StartWait::Queued)
            } else {
                None
            };
            let seq = entry.seq;
            let mut host_sign_in = None;
            // A restart/exit kills any in-flight run along with the process, and the asks and approvals it had
            // open: the next process never heard of them. A paired host's link blip is no such exit, and Windows
            // ending the session is neither: the next launch continues it from the marker these facts write.
            let mut owned = Vec::new();
            if status != "ready" && !session_ended {
                if !from_link && status == "starting" {
                    entry.ui_state = None;
                }
                if from_link && status == "exited" {
                    entry.tracking.run = RunState::default();
                    entry.run_across_link = false;
                } else if from_link {
                    if entry.busy() {
                        entry.run_across_link = true;
                    }
                } else {
                    // The omp died under the tab and comes back by itself: the resume rules continue what it was doing.
                    if status == "restarting" {
                        entry.exits += 1;
                    }
                    entry.tracking.run = RunState::default();
                    entry.run_across_link = false;
                }
                if !from_link {
                    host_sign_in = Some(
                        entry
                            .host_sign_ins
                            .take()
                            .and_then(|ids| ids.last().cloned()),
                    );
                    entry.plan_proposal = None;
                    owned = pool
                        .request_owners
                        .iter()
                        .filter(|(_, owner)| **owner == seq)
                        .map(|(id, _)| id.clone())
                        .collect();
                }
            } else if entry.run_across_link && !from_link {
                // An older host re-sends no run state: its turn may have ended unseen, so it reads as over.
                entry.run_across_link = false;
                entry.tracking.run = RunState::default();
            }
            (seq, owned, host_sign_in)
        });
        if seq == 0 {
            return Ok(());
        }
        for id in owned_requests {
            let removed = self.with(|pool| pool.request_owners.remove(&id).is_some());
            if removed {
                self.announce_ask_closed(tab, &id).await?;
            }
        }
        // The host's `login`s ran on that omp and died with it; their outcome went unseen.
        if let Some(Some(provider)) = host_sign_in {
            self.sign_in_ended(tab, Some(provider), None);
        }
        self.forward_status(tab).await?;
        // Every new omp starts with its subagent stream off: ask as it becomes ready, before anything can spawn a
        // subagent, whether a window shows the tab or not.
        if status == "ready" {
            let level = self.with(|pool| {
                let entry = pool.entry(tab);
                highest_subagent_level(
                    entry
                        .and_then(|entry| entry.subagent_levels.as_ref())
                        .into_iter()
                        .flatten()
                        .map(|(_, level)| level.as_str()),
                )
            });
            self.push(&json!({"k": "command", "tab": tab, "command": {"type": "set_subagent_subscription", "level": level}}));
        }
        self.on_running_change().await
    }

    /// The host's reading of the turn on a re-attach (sent before its status): what the lost link hid of its start or end.
    async fn feed_host_run(&self, tab: &str, reading: &Value) -> R<()> {
        let changed = self.with(|pool| {
            let now = pool.now;
            let entry = pool.entry_mut(tab)?;
            let was_busy = entry.busy();
            entry.run_across_link = false;
            entry.tracking.run = RunState::from_reading(reading, Some(&entry.tracking.run), now);
            Some(entry.busy() != was_busy)
        });
        if changed != Some(true) {
            return Ok(());
        }
        self.forward_status(tab).await?;
        self.on_running_change().await?;
        self.announce_run(tab).await
    }

    /// A paired host deleted this session while the tab was away: it closes here as a delete from this device would,
    /// and stays deleted for every later restore.
    async fn feed_session_deleted(&self, tab: &str, payload: &Value) -> R<()> {
        let (device, win) = self.with(|pool| {
            let entry = pool.entry(tab);
            (
                entry.and_then(|entry| entry.device.clone()),
                entry.map_or(0, |entry| entry.win_id),
            )
        });
        if let (Some(path), Some(device)) =
            (payload.as_str().filter(|path| !path.is_empty()), &device)
            && !device.is_empty()
        {
            self.ask("deletedAdd", json!({"sessionPath": path, "device": device}))
                .await?;
        }
        if !self.with(|pool| pool.has(tab)) {
            return Ok(());
        }
        self.release_entry(tab).await?;
        self.notify_window_tabs_changed(win).await?;
        self.send_tab_list(win, Some(&[tab.to_string()]), None)
            .await
    }

    async fn feed_view_ended(&self, tab: &str) -> R<()> {
        let Some(win) = self.with(|pool| pool.entry(tab).map(|entry| entry.win_id)) else {
            return Ok(());
        };
        self.release_entry(tab).await?;
        self.notify_window_tabs_changed(win).await?;
        self.send_tab_list(win, None, None).await
    }

    async fn feed_session_info(&self, tab: &str, frame: &Value) -> R<()> {
        let unregister = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            if let Some(title) = frame.get("title") {
                entry.title = Some(title.as_str().map(str::to_string));
            }
            let mut changed = false;
            if let Some(id) = frame.get("sessionId").and_then(Value::as_str) {
                let previous = entry.session_id.replace(id.to_string());
                if previous.as_deref() != Some(id) {
                    entry.session_generation += 1;
                }
                // Another session's automatic title is not this one's.
                if previous.as_deref().is_some_and(|previous| previous != id) {
                    entry.auto_title = None;
                    changed = true;
                }
            }
            Some(changed)
        });
        let Some(unregister) = unregister else {
            return Ok(());
        };
        // F-OWN: the session under this tab changed (switch / new session / crash-restart): the cached file→owner
        // mapping is stale. The first attach keeps the acquire-time registration.
        if unregister {
            self.unregister_session_file(tab).await?;
        }
        self.with(|pool| {
            if let Some(entry) = pool.entry_mut(tab)
                && let Some(auto) = frame.get("autoTitle")
            {
                entry.auto_title = Some(auto.as_str().map(str::to_string));
            }
        });
        // Session meta changes ride the light channel too, so a background tab's title/id updates without waiting
        // for a status flip.
        self.forward_status(tab).await
    }

    /// Every get_state the sidecar answers (hydrate, health check, heartbeat) reports the live session: one push, so
    /// the renderer sees one session change, not an id change followed by a path change.
    async fn feed_session(&self, tab: &str, identity: &Value) -> R<()> {
        let before = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            let previous_id = entry.session_id.clone();
            let previous_file = entry.session_file.clone();
            let previous_title = entry.title.clone();
            if let Some(id) = identity["sessionId"].as_str().filter(|id| !id.is_empty()) {
                entry.session_id = Some(id.to_string());
                if previous_id.as_deref() != Some(id) {
                    entry.session_generation += 1;
                }
            }
            // The live omp's name is the session's name. Another session now under this tab without a name drops the
            // old one's; the same session reported without one keeps it.
            if let Some(name) = identity["sessionName"]
                .as_str()
                .filter(|name| !name.is_empty())
            {
                entry.title = Some(Some(name.to_string()));
            } else if previous_id.is_some() && entry.session_id != previous_id {
                entry.title = None;
            }
            if previous_id.is_some() && entry.session_id != previous_id {
                entry.auto_title = None;
            }
            Some((previous_id, previous_file, previous_title, entry.win_id))
        });
        let Some((previous_id, previous_file, previous_title, win)) = before else {
            return Ok(());
        };
        match identity["sessionFile"]
            .as_str()
            .filter(|file| !file.is_empty())
        {
            Some(file) => self.register_session_file(tab, file).await?,
            None => self.unregister_session_file(tab).await?,
        }
        let (unchanged, file_changed) = self.with(|pool| {
            let entry = pool.entry(tab);
            (
                entry.is_some_and(|entry| {
                    entry.session_id == previous_id
                        && entry.session_file == previous_file
                        && entry.title == previous_title
                }),
                entry.is_some_and(|entry| entry.session_file != previous_file),
            )
        });
        if unchanged {
            return Ok(());
        }
        self.forward_status(tab).await?;
        if file_changed {
            self.notify_window_tabs_changed(win).await?;
        }
        Ok(())
    }

    /// Extension UI rides the light channel: a background agent's ask/confirm blocks until answered, so it must reach
    /// that tab's runtime, and widgets/status/notify set while hidden must be current when the tab comes back.
    async fn feed_extension_ui(&self, tab: &str, payload: &Value) -> R<()> {
        let request = &payload["request"];
        let kinds = Kinds::of(&payload["kinds"]);
        let seq = self.with(|pool| pool.entry(tab).map(|entry| entry.seq));
        let Some(seq) = seq else {
            return Ok(());
        };
        if kinds.blocking {
            self.with(|pool| Ctx::hold_request(pool, seq, request, kinds));
            self.on_running_change().await?;
            self.announce_ask(tab, request, kinds).await?;
        } else if request["method"] == "cancel" {
            // omp withdrew the request (timeout, abort): no response will follow.
            let target = request["targetId"].as_str().unwrap_or("").to_string();
            let owned = self.with(|pool| pool.request_owners.get(&target) == Some(&seq));
            if owned {
                self.with(|pool| pool.request_owners.remove(&target));
                self.announce_ask_closed(tab, &target).await?;
                self.on_running_change().await?;
            }
        }
        let (frame, wins) = self.with(|pool| {
            if let Some(entry) = pool.by_seq_mut(seq) {
                Ctx::keep_ui_state(entry, request);
            }
            let frame = Ctx::ui_frame(pool, seq, request, kinds);
            let wins = pool.by_seq(seq).map(Pool::windows_of).unwrap_or_default();
            (frame, wins)
        });
        self.send(wins, "EXTENSION_UI", Value::Object(frame));
        Ok(())
    }

    /// A paired host re-attached the tab: the asks its omp holds now are the tab's whole open set.
    async fn feed_open_asks(&self, tab: &str, payload: &Value) -> R<()> {
        let requests: Vec<Value> = payload["requests"].as_array().cloned().unwrap_or_default();
        let kinds: Vec<Kinds> = payload["kinds"]
            .as_array()
            .map(|list| list.iter().map(Kinds::of).collect())
            .unwrap_or_default();
        let Some(seq) = self.with(|pool| pool.entry(tab).map(|entry| entry.seq)) else {
            return Ok(());
        };
        let open: Vec<String> = requests
            .iter()
            .filter_map(|request| request["id"].as_str().map(str::to_string))
            .collect();
        let stale: Vec<String> = self.with(|pool| {
            pool.request_owners
                .iter()
                .filter(|(id, owner)| {
                    **owner == seq && !open.contains(id) && !pool.answering.contains(*id)
                })
                .map(|(id, _)| id.clone())
                .collect()
        });
        for id in stale {
            let removed = self.with(|pool| pool.request_owners.remove(&id).is_some());
            if !removed {
                continue;
            }
            self.announce_ask_closed(tab, &id).await?;
            let cancel = json!({"type": "extension_ui_request", "id": format!("withdrawn:{id}"), "method": "cancel", "targetId": id});
            let wins = self.with(|pool| pool.by_seq(seq).map(Pool::windows_of).unwrap_or_default());
            self.send(
                wins,
                "EXTENSION_UI",
                json!({"tabId": tab, "request": cancel}),
            );
        }
        for (index, request) in requests.iter().enumerate() {
            let kind = kinds.get(index).copied().unwrap_or_default();
            let id = request["id"].as_str().unwrap_or("").to_string();
            // Answered meanwhile: the list was taken before the answer reached the host.
            if self.with(|pool| pool.answering.contains(&id)) {
                continue;
            }
            // Already this tab's before the link dropped: the window notified for it then.
            let resent = self.with(|pool| pool.request_owners.get(&id) == Some(&seq));
            self.with(|pool| Ctx::hold_request(pool, seq, request, kind));
            if !resent {
                self.announce_ask(tab, request, kind).await?;
            }
            let (mut frame, wins) = self.with(|pool| {
                let frame = Ctx::ui_frame(pool, seq, request, kind);
                (
                    frame,
                    pool.by_seq(seq).map(Pool::windows_of).unwrap_or_default(),
                )
            });
            if resent {
                frame.insert("resent".into(), Value::from(true));
            }
            self.send(wins, "EXTENSION_UI", Value::Object(frame));
        }
        self.on_running_change().await
    }

    /// A paired host's tab runs `login` whether or not this window kept the link.
    fn feed_sign_in(&self, tab: &str, arg: &Value) -> R<()> {
        let active: Vec<String> = arg["active"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let before = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            let before = entry.host_sign_ins.clone().unwrap_or_default();
            entry.host_sign_ins = Some(active.clone());
            Some(before)
        });
        let Some(before) = before else {
            return Ok(());
        };
        if let Some(ended) = arg.get("ended").filter(|ended| ended.is_object()) {
            let provider = ended["providerId"].as_str().map(str::to_string);
            let error = ended
                .get("error")
                .map(|error| error.as_str().map(str::to_string));
            self.sign_in_ended(tab, provider, error);
        } else if !before.is_empty() && active.is_empty() {
            self.sign_in_ended(tab, before.last().cloned(), None);
        }
        Ok(())
    }

    /// This computer stands in for the host's sign-in callback: the login panel says how the browser comes back.
    fn feed_sign_in_relay(&self, tab: &str, relay: &Value) -> R<()> {
        let wins = self.with(|pool| {
            let entry = pool.entry_mut(tab)?;
            entry.sign_in_relay = (!relay.is_null()).then(|| relay.clone());
            Some(Pool::windows_of(entry))
        });
        if let Some(wins) = wins {
            self.send(wins, "SIGN_IN_RELAY", json!({"tabId": tab, "relay": relay}));
        }
        Ok(())
    }

    /// `prompt_result.sessionSettled` / `session_settled`.
    async fn settle(&self, tab: &str, settled: bool, frame: &str) -> R<()> {
        let changed = self.with(|pool| {
            let now = pool.now;
            let entry = pool.entry_mut(tab)?;
            let was_busy = entry.busy();
            let was_settling = entry.tracking.run.settling();
            entry.tracking.run.settle(settled, now);
            Some((
                was_busy,
                was_settling,
                entry.busy(),
                entry.tracking.run.settling(),
            ))
        });
        let Some((was_busy, was_settling, busy, settling)) = changed else {
            return Ok(());
        };
        self.push(&json!({"k": "settleWatch", "op": "frame", "tab": tab, "frame": frame, "settled": settled}));
        self.push(&json!({"k": "settleWatch", "op": "track", "tab": tab, "settling": settling}));
        if busy == was_busy {
            // Still busy, but the turn's end now reads as background work (or the other way round).
            if settling != was_settling {
                self.forward_status(tab).await?;
            }
            return Ok(());
        }
        self.forward_status(tab).await?;
        self.on_running_change().await?;
        self.announce_run(tab).await?;
        self.schedule_omp_restart(tab);
        self.schedule_extension_apply(tab);
        self.release_hidden_if_unused(tab, true).await?;
        Ok(())
    }

    /// Agent-end means one run yielded; upstream prompt/session-settled frames keep background async work
    /// represented as running until it is quiet. `events` holds only the events the rules read (`message_update`
    /// and the rest never cross: the page's forwarder has them).
    async fn feed_events(&self, tab: &str, events: &Value) -> R<()> {
        struct Seen {
            was_busy: bool,
            was_settling: bool,
            was_placeholder: bool,
            was_since: Option<i64>,
            was_saga: Option<super::run::Saga>,
            unsaved_before: Option<String>,
        }
        let list = events.as_array().cloned().unwrap_or_default();
        let (seen, run_ended, retry_started, stepped, hidden, win) = self.with(|pool| {
            let now = pool.now;
            let mut serial = pool.retry_serial;
            let mut plan_serial = pool.plan_serial;
            let Some(entry) = pool.entry_mut(tab) else {
                return (None, false, false, false, Vec::new(), 0);
            };
            let seen = Seen {
                was_busy: entry.busy(),
                was_settling: entry.tracking.run.settling(),
                was_placeholder: entry.placeholder,
                was_since: entry.tracking.run.since,
                was_saga: entry.tracking.run.saga.clone(),
                unsaved_before: entry.unsaved_prompt.clone(),
            };
            let mut run_ended = false;
            let mut retry_started = false;
            let mut stepped = false;
            let mut hidden: Vec<Value> = Vec::new();
            for event in &list {
                if entry.tracking.track(event, now, &mut serial) {
                    run_ended = true;
                }
                match event["type"].as_str() {
                    Some("agent_start") => {
                        entry.run_revision += 1;
                        entry.placeholder = false;
                        entry.unstarted = false;
                    }
                    Some("tool_execution_start" | "tool_execution_end") => stepped = true,
                    Some("auto_retry_start") => retry_started = true,
                    Some(kind @ ("plan_proposal" | "plan_proposal_resolved")) => {
                        let path = event["planFilePath"].as_str().unwrap_or("").to_string();
                        if kind == "plan_proposal" {
                            let title = event["title"].as_str().unwrap_or("").to_string();
                            entry.plan_proposal = Some((title, path));
                            // A tab a paired host runs keeps the host's own number: it is what that host's answer step
                            // compares. Only a tab of this computer is numbered here.
                            entry.plan_generation =
                                match (entry.device.is_some(), event["generation"].as_u64()) {
                                    (true, Some(host)) => host,
                                    _ => {
                                        plan_serial += 1;
                                        plan_serial
                                    }
                                };
                        } else if entry
                            .plan_proposal
                            .as_ref()
                            .is_some_and(|(_, current)| *current == path)
                        {
                            entry.plan_proposal = None;
                        }
                        hidden.push(event.clone());
                    }
                    Some("message_end") => {
                        // Stock writes a new session's file with its first assistant message: until then the prompt
                        // lives nowhere else, and a relaunch sends it again.
                        match event["message"]["role"].as_str() {
                            Some("assistant") => {
                                entry.unsaved_prompt = None;
                                stepped = true;
                            }
                            Some("user") if entry.unsaved_prompt.is_none() => {
                                if let Some(text) =
                                    event["message"]["text"].as_str().filter(|t| !t.is_empty())
                                {
                                    entry.unsaved_prompt = Some(text.to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            let win = entry.win_id;
            pool.retry_serial = serial;
            pool.plan_serial = plan_serial;
            (Some(seen), run_ended, retry_started, stepped, hidden, win)
        });
        let Some(seen) = seen else {
            return Ok(());
        };
        let (busy, settling, placeholder, since, saga, unsaved) = self.with(|pool| {
            let entry = pool.entry(tab).expect("the tab is in the pool");
            (
                entry.busy(),
                entry.tracking.run.settling(),
                entry.placeholder,
                entry.tracking.run.since,
                entry.tracking.run.saga.clone(),
                entry.unsaved_prompt.clone(),
            )
        });
        let busy_changed = busy != seen.was_busy;
        // The resume rules first: a failure they turn into a connection wait reaches the window already waiting, so
        // it never shows (or notifies) as a failure first.
        if busy_changed || run_ended || retry_started || unsaved != seen.unsaved_before {
            self.on_running_change().await?;
        }
        if busy_changed || (run_ended && !busy) {
            self.announce_run(tab).await?;
        } else if stepped && busy {
            self.announce(json!({"type": "step", "tabId": tab})).await?;
        }
        if settling != seen.was_settling {
            self.push(
                &json!({"k": "settleWatch", "op": "track", "tab": tab, "settling": settling}),
            );
        }
        if busy_changed
            || settling != seen.was_settling
            || placeholder != seen.was_placeholder
            || since != seen.was_since
            || saga != seen.was_saga
        {
            self.forward_status(tab).await?;
        }
        if busy_changed {
            self.schedule_omp_restart(tab);
            self.schedule_extension_apply(tab);
        }
        if placeholder != seen.was_placeholder {
            self.notify_window_tabs_changed(win).await?;
        }
        if !hidden.is_empty() {
            self.forward_to_hidden(
                tab,
                "EVENTS_BATCH",
                json!({"tabId": tab, "payload": hidden}),
            );
        }
        self.release_hidden_if_unused(tab, true).await?;
        Ok(())
    }

    /// Frames a hidden tab's sidebar row needs go to the windows that show the tab without its full channel.
    pub(super) fn forward_to_hidden(&self, tab: &str, channel: &str, data: Value) {
        let wins = self.with(|pool| {
            pool.entry(tab)
                .map(|entry| {
                    Pool::windows_of(entry)
                        .into_iter()
                        .filter(|win| !entry.wired_in(*win))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        });
        self.send(wins, channel, data);
    }

    /// A turn ended on a tab that waits for the new omp: one tick later (main's `setImmediate`), so every listener of
    /// the turn's last events has seen them before the process goes.
    pub(super) fn schedule_omp_restart(&self, tab: &str) {
        let pending = self.with(|pool| {
            pool.entry(tab)
                .is_some_and(|entry| entry.omp_restart_pending && !entry.busy())
        });
        if pending {
            self.push(&json!({"k": "immediate", "tab": tab, "kind": "omp"}));
        }
    }

    pub(super) fn schedule_extension_apply(&self, tab: &str) {
        let pending = self.with(|pool| {
            pool.entry(tab)
                .is_some_and(|entry| entry.extension_pending.is_some() && !entry.busy())
        });
        if pending {
            self.push(&json!({"k": "immediate", "tab": tab, "kind": "ext"}));
        }
    }

    /// The tick came: the restart or the extension apply the turn's end asked for runs if it still applies.
    pub(super) async fn immediate(&self, tab: &str, kind: &str) -> R<()> {
        let Some(seq) = self.with(|pool| pool.entry(tab).map(|entry| entry.seq)) else {
            return Ok(());
        };
        match kind {
            "omp" => {
                let go = self.with(|pool| {
                    let entry = pool.entry_mut(tab)?;
                    if !entry.omp_restart_pending || entry.busy() || entry.status != "ready" {
                        return None;
                    }
                    entry.omp_restart_pending = false;
                    Some(entry.session_file.clone())
                });
                if let Some(file) = go {
                    self.ask("restart", json!({"tab": tab, "sessionFile": file}))
                        .await?;
                }
            }
            _ => {
                let plan = self.with(|pool| {
                    let entry = pool.entry_mut(tab)?;
                    let plan = entry.extension_pending.clone()?;
                    if entry.busy() || entry.status != "ready" {
                        return None;
                    }
                    entry.extension_pending = None;
                    // A pending omp restart already carries the new files.
                    (!entry.omp_restart_pending).then_some(plan)
                });
                if let Some(plan) = plan {
                    self.apply_extension_plan(tab, seq, &plan).await?;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn apply_extension_plan(&self, tab: &str, _seq: u64, plan: &Value) -> R<()> {
        if plan["restart"].as_bool() == Some(true) {
            let file = self.with(|pool| {
                pool.entry_mut(tab).and_then(|entry| {
                    entry.extension_pending = None;
                    entry.session_file.clone()
                })
            });
            self.ask("restart", json!({"tab": tab, "sessionFile": file}))
                .await?;
        } else {
            self.push(&json!({"k": "reloadExtensions", "tab": tab, "plan": plan}));
        }
        Ok(())
    }

    /// A viewer left: the level it asked for no longer counts, and the omp drops to what the rest need.
    pub(super) async fn forget_subagent_level(&self, tab: &str, viewer: LevelKey) -> R<()> {
        let level = self.with(|pool| {
            let entry = pool.entry_any_mut(tab)?;
            let levels = entry.subagent_levels.as_mut()?;
            let at = levels.iter().position(|(key, _)| *key == viewer)?;
            levels.remove(at);
            Some(highest_subagent_level(
                levels.iter().map(|(_, level)| level.as_str()),
            ))
        });
        if let Some(level) = level {
            self.push(&json!({"k": "command", "tab": tab, "command": {"type": "set_subagent_subscription", "level": level}}));
        }
        Ok(())
    }

    /// A viewer left: its draft no longer holds the tab's timers back, so an all-empty tab says so now.
    pub(super) async fn forget_drafts(&self, tab: &str, win: i64) -> R<()> {
        let empty = self.with(|pool| {
            let entry = pool.entry_any_mut(tab)?;
            let mut said = Vec::new();
            let commands: Vec<String> = entry.drafts.keys().cloned().collect();
            for command in commands {
                let Some(reports) = entry.drafts.get_mut(&command) else {
                    continue;
                };
                if reports.get(&win) != Some(&false) {
                    reports.remove(&win);
                    continue;
                }
                reports.remove(&win);
                if reports.values().all(|empty| *empty) {
                    said.push(command);
                }
            }
            Some(said)
        });
        for command in empty.unwrap_or_default() {
            self.push(
                &json!({"k": "command", "tab": tab, "command": {"type": command, "empty": true}}),
            );
        }
        Ok(())
    }

    /// Tabs of a finished session leave their windows as a deleted session's do: released, the strip told they closed.
    pub(super) async fn close_finished(&self, tabs: &[String]) -> R<()> {
        let mut closed: Vec<(i64, Vec<String>)> = Vec::new();
        for tab in tabs {
            let Some(win) = self.with(|pool| pool.entry(tab).map(|entry| entry.win_id)) else {
                continue;
            };
            self.release_entry(tab).await?;
            match closed.iter_mut().find(|(candidate, _)| *candidate == win) {
                Some((_, list)) => list.push(tab.clone()),
                None => closed.push((win, vec![tab.clone()])),
            }
        }
        for (win, list) in closed {
            self.notify_window_tabs_changed(win).await?;
            self.send_tab_list(win, Some(&list), None).await?;
        }
        Ok(())
    }

    /// One tab per session on a paired host: the host refused the tab because a tab there holds its session
    /// (`holder`, null from a host that names none).
    async fn shown_elsewhere(&self, tab: &str, holder: &Value) -> R<()> {
        let Some((seq, device, win, file)) = self.with(|pool| {
            let entry = pool.entry(tab)?;
            Some((
                entry.seq,
                entry.device.clone()?,
                entry.win_id,
                entry.session_file.clone(),
            ))
        }) else {
            return Ok(());
        };
        let holder = holder.as_object();
        let self_device = self.ask("selfDevice", json!({})).await?;
        let ours = holder.is_none()
            || holder.is_some_and(|holder| {
                holder.get("device").and_then(Value::as_str) == self_device.as_str()
            });
        let holder_tab = holder
            .and_then(|holder| holder.get("rtab"))
            .and_then(Value::as_str);
        let owner = if ours {
            self.with(|pool| {
                let others: Vec<&Entry> = pool
                    .entries
                    .iter()
                    .filter(|other| other.seq != seq && other.device.as_ref() == Some(&device))
                    .collect();
                let by_holder = holder_tab.and_then(|rtab| {
                    others
                        .iter()
                        .find(|other| {
                            other.tab_id == rtab
                                || other
                                    .former
                                    .as_ref()
                                    .is_some_and(|(_, ids)| ids.iter().any(|id| id == rtab))
                        })
                        .copied()
                });
                by_holder
                    .or_else(|| {
                        file.as_ref().and_then(|file| {
                            others
                                .iter()
                                .find(|other| other.session_file.as_ref() == Some(file))
                                .copied()
                        })
                    })
                    .map(|owner| (owner.tab_id.clone(), owner.win_id))
            })
        } else {
            None
        };
        self.release_entry(tab).await?;
        self.notify_window_tabs_changed(win).await?;
        let closed = [tab.to_string()];
        if let Some((owner_tab, owner_win)) = &owner
            && *owner_win != win
        {
            self.send_tab_list(win, Some(&closed), None).await?;
            self.send_tab_list(*owner_win, None, Some(json!({"tabId": owner_tab})))
                .await?;
            return Ok(());
        }
        let shown = match &owner {
            Some((owner_tab, _)) => json!({"tabId": owner_tab}),
            None => {
                let mut shown = Map::new();
                shown.insert("host".into(), Value::from(device.clone()));
                if let Some(name) = holder
                    .filter(|_| !ours)
                    .and_then(|holder| holder.get("name"))
                {
                    shown.insert("holder".into(), name.clone());
                }
                Value::Object(shown)
            }
        };
        self.send_tab_list(win, Some(&closed), Some(shown)).await
    }
}
