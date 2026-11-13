//! The methods that were `async` in the TypeScript. Each runs its synchronous part inside the call (so what the caller
//! reads the moment it returns is there, as before), then settles main's promise by its `token` with a `settle` item:
//! at once, or when what it waited for is done (a sidecar's answer, an omp's exit, a run's end).

use serde_json::{Map, Value, json};

use super::routes::stop_settled;
use super::state::{Ctx, R, owner_key};

impl Ctx {
    /// `stopSession`: the person's Stop of the turn the tab holding `path` runs, in any window. Settles once that
    /// tab's run has ended, never on a timer; at once when nothing runs there. Fails `session_running` if the run has
    /// not ended after `STOP_SESSION_WAIT_MS` (`stop_timeout`).
    pub(super) async fn stop_session(&self, token: u64, path: &str, device: Option<&str>) -> R<()> {
        let found = self.with(|pool| {
            pool.owner_entry(device, path)
                .filter(|entry| entry.busy())
                .map(|entry| (entry.tab_id.clone(), entry.seq))
        });
        let Some((tab, seq)) = found else {
            self.settle_ok(token, Value::Null);
            return Ok(());
        };
        self.with(|pool| Ctx::add_stop_wait(pool, token, &tab, seq));
        // The timer is main's, so its (fake) clock is the clock here too; main says how long (`STOP_SESSION_WAIT_MS`).
        let wait = self.with(|pool| pool.stop_wait_ms);
        self.push(&json!({"k": "stopTimer", "token": token, "ms": wait}));
        self.note_stopped(&tab).await?;
        self.push(&json!({"k": "turnStop", "tab": tab, "command": "abort_and_restore_queue", "by": "session-delete"}));
        // Its queued messages go too: they would start the next turn on a session about to be deleted.
        self.push(
            &json!({"k": "command", "tab": tab, "command": {"type": "abort_and_restore_queue"}}),
        );
        let done = self.with(|pool| {
            let settled = stop_settled(pool, &tab, seq);
            if settled {
                pool.stop_waits.retain(|wait| wait.token != token);
            }
            settled
        });
        if done {
            self.settle_ok(token, Value::Null);
        }
        Ok(())
    }

    /// The timer main ran for `stop_session` ended before the run did.
    pub(super) fn stop_timeout(&self, token: u64) {
        let waiting = self.with(|pool| {
            let before = pool.stop_waits.len();
            pool.stop_waits.retain(|wait| wait.token != token);
            before != pool.stop_waits.len()
        });
        if waiting {
            self.settle_err(
                token,
                Some("session_running"),
                "The session's turn did not end after Stop",
            );
        }
    }

    /// `closeSessionTab`: the session is being deleted: close the tab holding it, as a closed tab goes, and settle once
    /// no omp of this computer has the file open. False, with nothing closed, while the owner's run or compaction is
    /// in flight.
    pub(super) async fn close_session_tab(
        &self,
        token: u64,
        path: &str,
        device: Option<&str>,
    ) -> R<()> {
        let key = owner_key(device, path);
        let found = self.with(|pool| {
            pool.session_owners
                .get(&key)
                .and_then(|owner| pool.entry(&owner.tab_id))
                .map(|entry| (entry.tab_id.clone(), entry.win_id, entry.busy()))
        });
        if let Some((tab, win, busy)) = found {
            if busy {
                self.settle_ok(token, Value::from(false));
                return Ok(());
            }
            self.release_entry(&tab).await?;
            self.notify_window_tabs_changed(win).await?;
            self.send_tab_list(win, Some(std::slice::from_ref(&tab)), None)
                .await?;
        }
        let ctx = self.clone();
        super::spawn(async move {
            let waited = ctx.out.ask_later("exiting", &json!({"key": key})).await;
            match waited {
                Ok(_) => ctx.settle_ok(token, Value::from(true)),
                Err(error) => ctx.settle_err(token, Some(&error.code), &error.message),
            }
        });
        Ok(())
    }

    /// `routeSideChannel`: route a renderer side-channel response to the sidecar that raised the request (F-UI-ORIGIN),
    /// tracked by request id at forward time, not the window's active tab. The response consumes the route once the
    /// sidecar took it. False when the id is unknown. A shared tab's ask takes the first answer: `responder`'s closes
    /// the other windows' cards, and an answer from another window after it is refused (`already_answered`), even
    /// while the first is still on its way.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn route_side_channel(
        &self,
        token: u64,
        id: &str,
        frame: &Value,
        tab: Option<&str>,
        responder: Option<i64>,
        choice: &str,
        claim: Option<u64>,
    ) -> R<()> {
        // An agent's answer holds this question while its attachments go in: only the holder's answer passes.
        if let Err(held) = self.guard_ask(id, claim) {
            self.settle_err(token, Some(&held.code), &held.message);
            return Ok(());
        }
        enum Begin {
            Unknown,
            Refused,
            Go { seq: u64, tab: String, shared: bool },
        }
        let begin = self.with(|pool| {
            let entry = match tab {
                Some(tab) if !tab.is_empty() => pool.entry(tab),
                _ => pool
                    .request_owners
                    .get(&id.to_string())
                    .and_then(|seq| pool.by_seq(*seq).filter(|entry| pool.live(entry.seq)))
                    .or_else(|| {
                        pool.answered.get(&id.to_string()).and_then(|answered| {
                            pool.by_seq(answered.seq)
                                .filter(|entry| pool.live(entry.seq))
                        })
                    }),
            };
            let Some(entry) = entry else {
                return Begin::Unknown;
            };
            let (seq, tab_id) = (entry.seq, entry.tab_id.clone());
            let viewed = !entry.viewers.is_empty() || !entry.device_views.is_empty();
            if let Some(answered) = pool.answered.get(&id.to_string())
                && answered.seq == seq
                // A device's answer has no window (JavaScript's NaN): nobody's later answer is the same one.
                && (answered.win_id.is_none() || answered.win_id != responder)
            {
                return Begin::Refused;
            }
            let shared = responder.is_some()
                && viewed
                && pool.request_owners.get(&id.to_string()) == Some(&seq);
            if shared {
                pool.remember_answered(id, seq, responder);
            }
            pool.answering.insert(id.to_string());
            Begin::Go {
                seq,
                tab: tab_id,
                shared,
            }
        });
        let (seq, tab, shared) = match begin {
            Begin::Unknown => {
                self.settle_ok(token, Value::from(false));
                return Ok(());
            }
            Begin::Refused => {
                self.settle_err(
                    token,
                    Some("already_answered"),
                    "Another window already answered this request",
                );
                return Ok(());
            }
            Begin::Go { seq, tab, shared } => (seq, tab, shared),
        };
        let ctx = self.clone();
        let (id, frame, choice) = (id.to_string(), frame.clone(), choice.to_string());
        super::spawn(async move {
            // The holder's answer ends its claim whether or not it was delivered (the question reopens to anyone).
            struct EndClaim(Ctx, String, Option<u64>);
            impl Drop for EndClaim {
                fn drop(&mut self) {
                    if let Some(claim) = self.2 {
                        self.0.release_request(&self.1, claim);
                    }
                }
            }
            let _ends = EndClaim(ctx.clone(), id.clone(), claim);
            let delivered = ctx
                .out
                .ask_later("sideChannelLater", &json!({"tab": tab, "frame": frame}))
                .await;
            ctx.with(|pool| {
                if delivered.is_err() && shared {
                    // Not delivered: the card stays open everywhere and any window may answer again.
                    pool.answered.remove(&id);
                }
                pool.answering.remove(&id);
            });
            if let Err(error) = delivered {
                ctx.settle_err(token, Some(&error.code), &error.message);
                return;
            }
            match ctx
                .route_answered(seq, &id, &frame, responder, shared, &choice)
                .await
            {
                Ok(()) => ctx.settle_ok(token, Value::from(true)),
                Err(error) => ctx.settle_err(token, Some(&error.code), &error.message),
            }
        });
        Ok(())
    }

    /// What follows a delivered answer: the request closes, observers hear it, the other windows' cards close.
    async fn route_answered(
        &self,
        seq: u64,
        id: &str,
        _frame: &Value,
        responder: Option<i64>,
        shared: bool,
        choice: &str,
    ) -> R<()> {
        let open = self.with(|pool| pool.request_owners.get(&id.to_string()) == Some(&seq));
        if open {
            let (tab, title) = self.with(|pool| {
                pool.request_owners.remove(&id.to_string());
                let title = pool
                    .request_bodies
                    .get(&id.to_string())
                    .and_then(|held| held.request.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                (
                    pool.by_seq(seq)
                        .map(|entry| entry.tab_id.clone())
                        .unwrap_or_default(),
                    title,
                )
            });
            self.announce(json!({
                "type": "askClosed", "tabId": tab, "requestId": id,
                "answered": {"title": title, "choice": choice},
            }))
            .await?;
            self.on_running_change().await?;
        }
        // No window answered (an agent's `ompdesk_session_answer`): every window still shows the card, and the tab's
        // sidebar row its waiting mark, until told; stock omp sends nothing when an ask is answered.
        if shared || (open && responder.is_none()) {
            self.send_answered_elsewhere(seq, id, responder, None);
        }
        Ok(())
    }

    /// `commandForSession`: send a command to the ready tab attached to `path`, mid-run or not. Null until the owner's
    /// process is ready.
    pub(super) async fn command_for_session(
        &self,
        token: u64,
        path: &str,
        command: &Value,
        device: Option<&str>,
    ) -> R<()> {
        let tab = self.with(|pool| {
            pool.owner_entry(device, path)
                .filter(|entry| entry.status == "ready")
                .map(|entry| entry.tab_id.clone())
        });
        let Some(tab) = tab else {
            self.settle_ok(token, Value::Null);
            return Ok(());
        };
        let ctx = self.clone();
        let command = command.clone();
        super::spawn(async move {
            match ctx
                .out
                .ask_later("rpc", &json!({"tab": tab, "command": command}))
                .await
            {
                Ok(response) => ctx.settle_ok(token, response),
                Err(error) => ctx.settle_err(token, Some(&error.code), &error.message),
            }
        });
        Ok(())
    }

    /// `releaseIdle`: give a quiet tab's omp back while memory is short: checked again, then stock's own settle
    /// predicate (`isSettled`), then once more after that answer. Settles whether it went asleep.
    pub(super) async fn release_idle(&self, token: u64, tab: &str) -> R<()> {
        let facts = self.facts(&[tab.to_string()]).await?;
        let seq = self.with(|pool| pool.entry(tab).map(|entry| entry.seq));
        let (Some(seq), true) = (seq, facts[tab]["rpc"].as_bool() == Some(true)) else {
            self.settle_ok(token, Value::from(false));
            return Ok(());
        };
        if !self.quiet(tab).await? {
            self.settle_ok(token, Value::from(false));
            return Ok(());
        }
        let ctx = self.clone();
        let tab = tab.to_string();
        super::spawn(async move {
            let response = ctx
                .out
                .ask_later(
                    "rpc",
                    &json!({"tab": tab, "command": {"type": "get_state"}}),
                )
                .await;
            let state = response
                .ok()
                .filter(|response| response["success"].as_bool() == Some(true));
            let settled = state.as_ref().is_some_and(|response| {
                let data = &response["data"];
                data.is_object()
                    && data["isSettled"].as_bool() == Some(true)
                    && data["isStreaming"].as_bool() != Some(true)
            });
            let result = async {
                if !settled {
                    return Ok(false);
                }
                let same = ctx.with(|pool| pool.entry(&tab).map(|entry| entry.seq)) == Some(seq);
                if !same || !ctx.quiet(&tab).await? {
                    return Ok(false);
                }
                ctx.ask("sleep", json!({"tab": tab})).await?;
                Ok::<bool, crate::server::Fault>(true)
            }
            .await;
            match result {
                Ok(slept) => ctx.settle_ok(token, Value::from(slept)),
                Err(error) => ctx.settle_err(token, Some(&error.code), &error.message),
            }
        });
        Ok(())
    }

    /// `settleFacts`: what the settle diagnostic logs: stock's own settle predicate inputs and main's run flags.
    pub(super) async fn settle_facts(&self, token: u64, tab: &str) -> R<()> {
        if !self.with(|pool| pool.has(tab)) {
            self.settle_ok(token, json!({"gone": true}));
            return Ok(());
        }
        let ctx = self.clone();
        let tab = tab.to_string();
        super::spawn(async move {
            let response = ctx
                .out
                .ask_later(
                    "rpc",
                    &json!({"tab": tab, "command": {"type": "get_state"}}),
                )
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    ctx.settle_err(token, Some(&error.code), &error.message);
                    return;
                }
            };
            let data = response.get("data").cloned().unwrap_or(Value::Null);
            let count = |key: &str| data["queuedMessages"][key].as_array().map_or(0, Vec::len);
            let mut stock = Map::new();
            for key in [
                "isSettled",
                "isStreaming",
                "isCompacting",
                "queuedMessageCount",
                "hasPendingAsyncWork",
            ] {
                if let Some(value) = data.get(key) {
                    stock.insert(key.into(), value.clone());
                }
            }
            stock.insert(
                "queued".into(),
                json!({"steering": count("steering"), "followUp": count("followUp")}),
            );
            if let Some(value) = data.get("messageCount") {
                stock.insert("messageCount".into(), value.clone());
            }
            let facts = ctx.with(|pool| {
                let entry = pool.entry(&tab)?;
                let mut facts = Map::new();
                facts.insert("stock".into(), Value::Object(stock));
                facts.insert("run".into(), entry.tracking.run.to_value());
                facts.insert("status".into(), Value::from(entry.status.clone()));
                if let Some(reason) = entry
                    .tracking
                    .last_run
                    .as_ref()
                    .and_then(|last| last.get("stopReason"))
                {
                    facts.insert("lastRun".into(), reason.clone());
                }
                Some(Value::Object(facts))
            });
            ctx.settle_ok(token, facts.unwrap_or_else(|| json!({"gone": true})));
        });
        Ok(())
    }
}
