//! Who owns which session file (F-OWN), the requests tabs raised and where their answers go (F-UI-ORIGIN), what
//! observers hear of a tab (`TabActivity`), and the sign-in state of a tab.

use serde_json::{Map, Value, json};

use super::state::{
    ANSWERED_KEPT, Answered, Ctx, Entry, Held, Kinds, Owner, Pool, R, StopWait, owner_key,
};

impl Pool {
    /// `#dropSessionOwner`: the entry lets go of its file mapping when it still points at this entry.
    fn drop_session_owner(&mut self, seq: u64) {
        let Some(entry) = self.by_seq_mut(seq) else {
            return;
        };
        let Some(file) = entry.session_file.take() else {
            return;
        };
        let key = owner_key(entry.device.as_deref(), &file);
        let tab = entry.tab_id.clone();
        // Another tab may have re-registered the same file since: only the current owner may clear the mapping.
        if self
            .session_owners
            .get(&key)
            .is_some_and(|owner| owner.tab_id == tab)
        {
            self.session_owners.remove(&key);
        }
    }

    pub(super) fn trim_answered(&mut self) {
        let oldest = self.answered.first_key().cloned();
        if self.answered.len() > ANSWERED_KEPT
            && let Some(oldest) = oldest
        {
            self.answered.remove(&oldest);
        }
    }
}

impl Ctx {
    pub(super) async fn register_session_file(&self, tab: &str, file: &str) -> R<()> {
        let Some(seq) = self.with(|pool| pool.entry(tab).map(|entry| entry.seq)) else {
            return Ok(());
        };
        self.register_session_file_of(seq, file).await
    }

    /// `#registerSessionFile`: sessionFile → owner, moving the entry off any previous file.
    pub(super) async fn register_session_file_of(&self, seq: u64, file: &str) -> R<()> {
        let changed = self.with(|pool| {
            let entry = pool.by_seq(seq)?;
            let changed = entry.session_file.as_deref() != Some(file);
            if changed {
                pool.drop_session_owner(seq);
            }
            let entry = pool.by_seq_mut(seq)?;
            entry.session_file = Some(file.to_string());
            if changed {
                entry.session_generation += 1;
            }
            Some((
                changed,
                entry.tracking.run.running || entry.awaiting_connection,
                entry.tab_id.clone(),
            ))
        });
        let Some((changed, held, tab)) = changed else {
            return Ok(());
        };
        // The one place a tab's file is written (with `unregister_session_file_of`): main keeps it for a new core's seed.
        self.push(&json!({"k": "sessionFile", "tab": tab, "file": file}));
        // A run's file, and a held wait's: its continuation must not go into another session.
        if changed && held {
            self.on_running_change().await?;
        }
        self.with(|pool| {
            if let Some(entry) = pool.by_seq(seq) {
                let key = owner_key(entry.device.as_deref(), file);
                let owner = Owner {
                    tab_id: entry.tab_id.clone(),
                    win_id: entry.win_id,
                };
                pool.session_owners.insert(key, owner);
            }
        });
        if changed {
            self.on_session_files_changed().await?;
        }
        Ok(())
    }

    pub(super) async fn unregister_session_file(&self, tab: &str) -> R<()> {
        let Some(seq) = self.with(|pool| pool.entry(tab).map(|entry| entry.seq)) else {
            return Ok(());
        };
        self.unregister_session_file_of(seq).await
    }

    /// `#unregisterSessionFile`: the entry lets go of its file: the mapping goes and paired devices hear the listing
    /// may have changed.
    pub(super) async fn unregister_session_file_of(&self, seq: u64) -> R<()> {
        let held = self.with(|pool| {
            let entry = pool.by_seq(seq)?;
            entry.session_file.as_ref()?;
            let held = entry.awaiting_connection;
            let tab = entry.tab_id.clone();
            pool.drop_session_owner(seq);
            if let Some(entry) = pool.by_seq_mut(seq) {
                entry.session_generation += 1;
            }
            Some((held, tab))
        });
        let Some((held, tab)) = held else {
            return Ok(());
        };
        self.push(&json!({"k": "sessionFile", "tab": tab, "file": null}));
        self.on_session_files_changed().await?;
        // A session-id change lets the held wait's file go (another session), as a switch does.
        if held {
            self.on_running_change().await?;
        }
        Ok(())
    }

    // ---- activity -----------------------------------------------------------------------------------------------

    /// `#announce`: observers hear what a tab did; then a `stopSession` waiting on the tab looks again.
    pub(super) async fn announce(&self, activity: Value) -> R<()> {
        let tab = activity["tabId"].as_str().unwrap_or("").to_string();
        self.ask("announce", json!({"activity": activity})).await?;
        let done: Vec<u64> = self.with(|pool| {
            let waiting: Vec<(u64, String, u64)> = pool
                .stop_waits
                .iter()
                .filter(|wait| wait.tab_id == tab)
                .map(|wait| (wait.token, wait.tab_id.clone(), wait.seq))
                .collect();
            waiting
                .into_iter()
                .filter(|(_, tab, seq)| stop_settled(pool, tab, *seq))
                .map(|(token, _, _)| token)
                .collect()
        });
        for token in done {
            let removed = self.with(|pool| {
                let before = pool.stop_waits.len();
                pool.stop_waits.retain(|wait| wait.token != token);
                before != pool.stop_waits.len()
            });
            if removed {
                self.settle_ok(token, Value::Null);
            }
        }
        Ok(())
    }

    /// `#announceRun`: the tab's turn started or settled: told after the resume rules have judged it.
    pub(super) async fn announce_run(&self, tab: &str) -> R<()> {
        let activity = self.with(|pool| {
            let entry = pool.entry_any(tab)?;
            Some(if entry.busy() {
                json!({"type": "busy", "tabId": tab})
            } else {
                let mut activity = json!({"type": "idle", "tabId": tab});
                if let Some(last) = &entry.tracking.last_run {
                    activity["outcome"] = last.clone();
                }
                activity
            })
        });
        match activity {
            Some(activity) => self.announce(activity).await,
            None => Ok(()),
        }
    }

    /// `#announceAsk`: a blocking request a person has to answer (not a provider sign-in's own traffic) came to the tab.
    pub(super) async fn announce_ask(&self, tab: &str, request: &Value, kinds: Kinds) -> R<()> {
        let id = request["id"].as_str().unwrap_or("").to_string();
        let skip = self.with(|pool| !kinds.blocking || pool.sign_in_requests.contains(&id));
        if skip {
            return Ok(());
        }
        let text = request["title"].as_str().unwrap_or("");
        self.announce(json!({"type": "ask", "tabId": tab, "requestId": id, "text": text}))
            .await
    }

    /// One request the tab held is closed (answered elsewhere, withdrawn, its omp gone).
    pub(super) async fn announce_ask_closed(&self, tab: &str, id: &str) -> R<()> {
        self.announce(json!({"type": "askClosed", "tabId": tab, "requestId": id}))
            .await
    }

    // ---- requests -----------------------------------------------------------------------------------------------

    /// `#holdRequest`: route a blocking request back to the tab that raised it, keeping its body for a reloaded page.
    pub(super) fn hold_request(pool: &mut Pool, seq: u64, request: &Value, kinds: Kinds) {
        let Some(id) = request["id"].as_str().map(str::to_string) else {
            return;
        };
        pool.request_owners.insert(id.clone(), seq);
        let stale: Vec<String> = pool
            .request_bodies
            .keys()
            .filter(|key| !pool.request_owners.contains(key))
            .cloned()
            .collect();
        for key in stale {
            pool.request_bodies.remove(&key);
            pool.sign_in_requests.remove(&key);
        }
        pool.request_bodies.insert(
            id.clone(),
            Held {
                request: request.clone(),
                kinds,
            },
        );
        let active = pool.by_seq(seq).is_some_and(Entry::signin_active);
        if active && kinds.sign_in {
            pool.sign_in_requests.insert(id);
        }
    }

    /// `#signInMark`: what a page needs to give a request back to the login panel (`IpcSignIn`), or nothing when it is
    /// the chat's.
    pub(super) fn sign_in_mark(
        pool: &mut Pool,
        seq: u64,
        request: &Value,
        kinds: Kinds,
    ) -> Option<Value> {
        let id = request["id"].as_str().unwrap_or("").to_string();
        let active = pool.by_seq(seq).is_some_and(Entry::signin_active);
        let held = pool.sign_in_requests.contains(&id);
        if !(held || active && kinds.sign_in) {
            return None;
        }
        let entry = pool.by_seq_mut(seq)?;
        if active && request["method"] == "open_url" && request.get("launchUrl").is_some() {
            entry.sign_in_link = Some(request.clone());
        }
        let provider = entry
            .sign_in_providers
            .last()
            .or_else(|| entry.host_sign_ins.as_ref().and_then(|ids| ids.last()))
            .map_or(Value::Null, |id| Value::from(id.clone()));
        let mut mark = Map::new();
        mark.insert("active".into(), Value::from(active));
        mark.insert("providerId".into(), provider);
        if active && let Some(link) = &entry.sign_in_link {
            mark.insert("link".into(), link.clone());
        }
        if active && let Some(relay) = &entry.sign_in_relay {
            mark.insert("relay".into(), relay.clone());
        }
        Some(Value::Object(mark))
    }

    /// `#uiFrame`: the `EXTENSION_UI` event for a request, with the sign-in mark. A sidecar's `cancel` named
    /// `answered:<id>` closes the card as answered elsewhere.
    pub(super) fn ui_frame(
        pool: &mut Pool,
        seq: u64,
        request: &Value,
        kinds: Kinds,
    ) -> Map<String, Value> {
        let sign_in = Ctx::sign_in_mark(pool, seq, request, kinds);
        let elsewhere = request["method"] == "cancel"
            && request["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("answered:"));
        let mut frame = Map::new();
        let tab = pool
            .by_seq(seq)
            .map(|entry| entry.tab_id.clone())
            .unwrap_or_default();
        frame.insert("tabId".into(), Value::from(tab));
        frame.insert("request".into(), request.clone());
        if let Some(mark) = sign_in {
            frame.insert("signIn".into(), mark);
        }
        if elsewhere {
            frame.insert("answeredElsewhere".into(), Value::from(true));
        }
        frame
    }

    /// `#keepUiState`: a tab's latest status text, widget and title; an empty one is a clear.
    pub(super) fn keep_ui_state(entry: &mut Entry, request: &Value) {
        let method = request["method"].as_str().unwrap_or("");
        let key = match method {
            "setStatus" => format!("status:{}", js_text(request.get("statusKey"))),
            "setWidget" => format!("widget:{}", js_text(request.get("widgetKey"))),
            "setTitle" => "title".to_string(),
            _ => return,
        };
        let cleared = (method == "setStatus" && !truthy(request.get("statusText")))
            || (method == "setWidget"
                && request
                    .get("widgetLines")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty));
        let state = entry.ui_state.get_or_insert_with(Default::default);
        if cleared {
            state.remove(&key);
        } else {
            state.insert(key, request.clone());
        }
    }

    /// The synthetic `cancel` of an ask answered first by `responder` (a window) or `from` (a device's view).
    pub(super) fn send_answered_elsewhere(
        &self,
        seq: u64,
        id: &str,
        responder: Option<i64>,
        from: Option<u64>,
    ) {
        let request = json!({
            "type": "extension_ui_request",
            "id": format!("answered:{id}"),
            "method": "cancel",
            "targetId": id,
        });
        let sent = self.with(|pool| {
            let entry = pool.by_seq(seq)?;
            let mut wins = Vec::new();
            if Some(entry.win_id) != responder {
                wins.push(entry.win_id);
            }
            wins.extend(
                entry
                    .viewers
                    .iter()
                    .copied()
                    .filter(|win| Some(*win) != responder),
            );
            let views: Vec<u64> = entry
                .device_views
                .iter()
                .copied()
                .filter(|view| Some(*view) != from)
                .collect();
            Some((entry.tab_id.clone(), wins, views))
        });
        let Some((tab, wins, views)) = sent else {
            return;
        };
        let cancel = json!({"tabId": tab, "request": request, "answeredElsewhere": true});
        self.send(wins, "EXTENSION_UI", cancel);
        for view in views {
            self.push(&json!({"k": "emitView", "tab": tab, "view": view, "event": "extensionUi", "arg": request}));
        }
    }

    // ---- sign-in ------------------------------------------------------------------------------------------------

    /// `#signInEnded`: a `login` answered. Once none is left, a page that took the sign-in over is told (`error`: null =
    /// connected, a message = failed, absent = the outcome went unseen).
    pub(super) fn sign_in_ended(
        &self,
        tab: &str,
        provider: Option<String>,
        error: Option<Option<String>>,
    ) {
        let sent = self.with(|pool| {
            let entry = pool.entry_any_mut(tab)?;
            if entry.signin_active() {
                return None;
            }
            entry.sign_in_link = None;
            entry.sign_in_relay = None;
            Some(Pool::windows_of(entry))
        });
        let Some(wins) = sent else {
            return;
        };
        let mut data = Map::new();
        data.insert("tabId".into(), Value::from(tab));
        data.insert(
            "providerId".into(),
            provider.map_or(Value::Null, Value::from),
        );
        if let Some(error) = error {
            data.insert("error".into(), error.map_or(Value::Null, Value::from));
        }
        self.send(wins, "SIGN_IN_ENDED", Value::Object(data));
    }

    // ---- stopSession --------------------------------------------------------------------------------------------

    pub(super) fn add_stop_wait(pool: &mut Pool, token: u64, tab: &str, seq: u64) {
        pool.stop_waits.push(StopWait {
            token,
            tab_id: tab.to_string(),
            seq,
        });
    }
}

/// `settled()` of `stopSession`: the tab left the pool, or its run is not busy.
pub(super) fn stop_settled(pool: &Pool, tab: &str, seq: u64) -> bool {
    !pool.has(tab) || pool.by_seq(seq).is_none_or(|entry| !entry.busy())
}

/// `${value}` for a request key (`statusKey` and `widgetKey` are strings; an absent one reads `undefined`).
fn js_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => "undefined".to_string(),
    }
}

/// JavaScript truthiness of a request's field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

impl Ctx {
    pub(super) fn settle_ok(&self, token: u64, value: Value) {
        self.push(&json!({"k": "settle", "token": token, "ok": true, "value": value}));
    }

    pub(super) fn settle_err(&self, token: u64, code: Option<&str>, message: &str) {
        self.push(
            &json!({"k": "settle", "token": token, "ok": false, "code": code, "message": message}),
        );
    }
}

/// Answered-request bookkeeping shared by the two answer paths.
impl Pool {
    pub(super) fn remember_answered(&mut self, id: &str, seq: u64, win_id: Option<i64>) {
        self.answered
            .insert(id.to_string(), Answered { seq, win_id });
        self.trim_answered();
    }
}
