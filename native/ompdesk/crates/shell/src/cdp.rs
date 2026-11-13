//! DevTools protocol through CEF's `SendDevToolsMessage` (PROTOCOL.md §4). The shim builds `capturePage`,
//! `printToPDF`, `sendInputEvent`, `executeJavaScript` and the `debugger` on this; every reply and event of a page's
//! protocol reaches the observer registered on first use.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use cef::*;
use serde_json::{Value, json};

use crate::host;
use crate::state::{CdpCallback, WcEntry, wc};

type Failure = (String, String);

wrap_dev_tools_message_observer! {
    struct Observer {
        wc_id: u64,
    }
    impl DevToolsMessageObserver {
        fn on_dev_tools_message(&self, _browser: Option<&mut Browser>, message: Option<&[u8]>) -> i32 {
            let Some(bytes) = message else { return 0 };
            let Ok(value) = serde_json::from_slice::<Value>(bytes) else { return 0 };
            on_message(self.wc_id, value);
            1
        }

        fn on_dev_tools_agent_detached(&self, _browser: Option<&mut Browser>) {
            agent_detached(self.wc_id);
        }
    }
}

/// What a debugger's session saw: Node's (`wc.cdp.message`) for the shim's pages, the Preview module's own relay for a
/// page of its own (the agent's browsing never leaves the shell).
fn debugger_message(wc_id: u64, data: Value) {
    if wc(wc_id).is_some_and(|e| e.borrow().module_owned) {
        let session = data.get("sessionId").and_then(Value::as_str);
        let method = data
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = data.get("params").cloned().unwrap_or(Value::Null);
        crate::modules::preview::debugger_event(wc_id, method, &params, session);
    } else {
        host::event("wc.cdp.message", data);
    }
}

/// The debugger's session ended: DevTools took the page, or it went away.
fn debugger_detached(wc_id: u64) {
    if wc(wc_id).is_some_and(|e| e.borrow().module_owned) {
        crate::modules::preview::debugger_detached(wc_id, "target closed");
    } else {
        host::event(
            "wc.cdp.detached",
            json!({ "wcId": wc_id, "reason": "target closed" }),
        );
    }
}

/// What closing the debugger's session ends, taken out of the page's entry: whether it was attached, its session, the
/// commands waiting for it and the debugger's commands in flight. The borrow has ended when this returns, so the caller
/// may run them.
struct Ended {
    attached: bool,
    session: Option<String>,
    waiting: Vec<Box<dyn FnOnce(Option<String>)>>,
    in_flight: Vec<CdpCallback>,
}

fn end_debugger(entry: &Rc<RefCell<WcEntry>>, every_command: bool) -> Ended {
    let mut e = entry.borrow_mut();
    let ids: Vec<i32> = if every_command {
        e.cdp_pending.keys().copied().collect()
    } else {
        e.cdp_debugger_pending.iter().copied().collect()
    };
    e.cdp_debugger_pending.clear();
    let in_flight = ids
        .iter()
        .filter_map(|id| e.cdp_pending.remove(id))
        .collect();
    let attached = std::mem::replace(&mut e.cdp_attached, false);
    Ended {
        attached,
        session: e.cdp_session.take(),
        waiting: std::mem::take(&mut e.cdp_waiting),
        in_flight,
    }
}

impl Ended {
    /// Every waiting and in-flight command of the debugger fails, as Electron's debugger rejects them on detach.
    fn fail_commands(self) -> (bool, Option<String>) {
        for run in self.waiting {
            run(None);
        }
        for callback in self.in_flight {
            callback(Err((
                "gone".into(),
                "target closed while handling command".into(),
            )));
        }
        (self.attached, self.session)
    }
}

/// The page's DevTools agent went away: CEF delivers none of the answers still pending and drops every session and
/// subscription on it (the debugger's, the input watch's binding and script). The next command attaches a new agent.
fn agent_detached(wc_id: u64) {
    let Some(entry) = wc(wc_id) else { return };
    let (attached, _) = end_debugger(&entry, true).fail_commands();
    if attached {
        debugger_detached(wc_id);
    }
    let rearm = wc(wc_id).is_some_and(|e| {
        let e = e.borrow();
        !e.closing && (e.module_owned || e.watch_events.contains("input-event"))
    });
    if rearm {
        // Not from inside CEF's own callback: the next turn of the UI thread attaches the new agent.
        crate::ui::post(move || watch_input(wc_id));
    }
}

fn on_message(wc_id: u64, value: Value) {
    let Some(entry) = wc(wc_id) else { return };
    if let Some(id) = value.get("id").and_then(Value::as_i64) {
        let callback = {
            let mut e = entry.borrow_mut();
            e.cdp_debugger_pending.remove(&(id as i32));
            e.cdp_pending.remove(&(id as i32))
        };
        if let Some(callback) = callback {
            callback(match value.get("error") {
                Some(error) => Err((
                    "cdp".to_string(),
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("DevTools protocol error")
                        .to_string(),
                )),
                None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
            });
        }
        return;
    }
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = value.get("params").cloned().unwrap_or(json!({}));
    // The input watch's binding is the shell's own: never a debugger's to see.
    if let Some(kind) = shell_core::input_watch::input_event(method, &params) {
        crate::wc::emit(wc_id, "input-event", json!([{ "type": kind }]));
        return;
    }
    let session = value.get("sessionId").and_then(Value::as_str);
    let (attached, debugger) = {
        let e = entry.borrow();
        (e.cdp_attached, e.cdp_session.clone())
    };
    // The page's own session is the shell's (its input watch, captures, scripts): a debugger never sees it, except
    // for the end of the debugger's session there.
    let Some(session) = session else {
        let ended = method == "Target.detachedFromTarget"
            && debugger.is_some()
            && params.get("sessionId").and_then(Value::as_str) == debugger.as_deref();
        if ended && attached {
            end_debugger(&entry, false).fail_commands();
            debugger_detached(wc_id);
        }
        return;
    };
    if !attached {
        return;
    }
    // The debugger's session is its page; the sessions under it (its frames and workers) keep their ids.
    let mut data = json!({ "wcId": wc_id, "method": method, "params": params });
    if debugger.as_deref() != Some(session) {
        data["sessionId"] = json!(session);
    }
    debugger_message(wc_id, data);
}

/// Registers the observer once per page (it stays for the page's life).
fn ensure_observer(entry: &Rc<RefCell<WcEntry>>) {
    let (browser, registered, wc_id) = {
        let e = entry.borrow();
        (e.browser.clone(), e.cdp_observer_added, e.id)
    };
    if registered {
        return;
    }
    let Some(host) = browser.and_then(|b| b.host()) else {
        return;
    };
    entry.borrow_mut().cdp_observer_added = true;
    let mut observer = Observer::new(wc_id);
    let registration = host.add_dev_tools_message_observer(Some(&mut observer));
    entry.borrow_mut().cdp_registration = registration;
}

/// Sends one protocol command; `done` runs on the UI thread with the result or `(code, message)`. A reply that never
/// comes ends after 60 s with `timeout`.
pub fn send(
    wc_id: u64,
    method: &str,
    params: Option<Value>,
    session_id: Option<String>,
    done: impl FnOnce(Result<Value, Failure>) + 'static,
) {
    let Some(entry) = wc(wc_id) else {
        return done(Err(("gone".into(), format!("no page {wc_id}"))));
    };
    let Some(host) = entry.borrow().browser.clone().and_then(|b| b.host()) else {
        return done(Err((
            "gone".into(),
            format!("page {wc_id} has no browser yet"),
        )));
    };
    ensure_observer(&entry);
    let method = method.to_string();
    let id = {
        let mut e = entry.borrow_mut();
        e.cdp_next_id += 1;
        e.cdp_next_id
    };
    let mut message =
        json!({ "id": id, "method": &method, "params": params.unwrap_or_else(|| json!({})) });
    // Only the debugger sends on a session (its own, or one under it).
    let debugger = session_id.is_some();
    if let Some(session) = session_id {
        message["sessionId"] = json!(session);
    }
    {
        let mut e = entry.borrow_mut();
        e.cdp_pending.insert(id, Box::new(done));
        if debugger {
            e.cdp_debugger_pending.insert(id);
        }
    }
    if host.send_dev_tools_message(Some(message.to_string().as_bytes())) == 0 {
        let callback = {
            let mut e = entry.borrow_mut();
            e.cdp_debugger_pending.remove(&id);
            e.cdp_pending.remove(&id)
        };
        if let Some(callback) = callback {
            callback(Err((
                "failed".into(),
                format!("{method} could not be sent"),
            )));
        }
        return;
    }
    crate::ui::post_delayed(Duration::from_secs(60).as_millis() as i64, move || {
        let callback = wc(wc_id).and_then(|e| {
            let mut e = e.borrow_mut();
            e.cdp_debugger_pending.remove(&id);
            e.cdp_pending.remove(&id)
        });
        if let Some(callback) = callback {
            callback(Err((
                "timeout".into(),
                format!("{method} was not answered"),
            )));
        }
    });
}

/// `debugger.attach`: a DevTools session of the debugger's own, attached flat to this page's target, so what it sets
/// ends with it (as Electron's debugger, a client of its own). Commands sent meanwhile wait for it (`send_debugger`).
pub fn attach(wc_id: u64) {
    let Some(entry) = wc(wc_id) else { return };
    let attempt = {
        let mut e = entry.borrow_mut();
        if e.cdp_attached {
            return;
        }
        e.cdp_attached = true;
        e.cdp_session = None;
        e.cdp_attempt += 1;
        e.cdp_attempt
    };
    let opened = move |session: Option<String>| {
        let Some(entry) = wc(wc_id) else { return };
        let waiting = {
            let mut e = entry.borrow_mut();
            if !e.cdp_attached || e.cdp_attempt != attempt {
                None
            } else {
                e.cdp_session = session.clone();
                // No session: the debugger is not attached after all, so a later command fails at once and a new
                // attach is not refused.
                e.cdp_attached = session.is_some();
                Some(std::mem::take(&mut e.cdp_waiting))
            }
        };
        // Detached (or detached and attached again) before this session existed: it goes at once. `send` borrows the
        // page's entry, so the borrow above has ended.
        let Some(waiting) = waiting else {
            if let Some(session) = session {
                send(
                    wc_id,
                    "Target.detachFromTarget",
                    Some(json!({ "sessionId": session })),
                    None,
                    |_| {},
                );
            }
            return;
        };
        for run in waiting {
            run(session.clone());
        }
        if session.is_none() {
            crate::log::log("wc.debugger_session_failed", json!({ "wcId": wc_id }));
            debugger_detached(wc_id);
        }
    };
    crate::wc::with_browser(wc_id, move |_| {
        send(wc_id, "Target.getTargetInfo", None, None, move |info| {
            let Some(target) = info.ok().and_then(|i| {
                i.pointer("/targetInfo/targetId")
                    .and_then(Value::as_str)
                    .map(String::from)
            }) else {
                return opened(None);
            };
            let params = json!({ "targetId": target, "flatten": true });
            send(
                wc_id,
                "Target.attachToTarget",
                Some(params),
                None,
                move |attached| {
                    opened(attached.ok().and_then(|a| {
                        a.get("sessionId").and_then(Value::as_str).map(String::from)
                    }));
                },
            );
        });
    });
}

/// `debugger.detach`: its session ends, and with it everything it set on the page.
pub fn detach(wc_id: u64) {
    let Some(entry) = wc(wc_id) else { return };
    let (_, session) = end_debugger(&entry, false).fail_commands();
    if let Some(session) = session {
        send(
            wc_id,
            "Target.detachFromTarget",
            Some(json!({ "sessionId": session })),
            None,
            |_| {},
        );
    }
}

/// A debugger's command (`debugger.sendCommand`): on its own session, or on `session_id`, one of the sessions under it.
pub fn send_debugger(
    wc_id: u64,
    method: &str,
    params: Option<Value>,
    session_id: Option<String>,
    done: impl FnOnce(Result<Value, Failure>) + 'static,
) {
    if session_id.is_some() {
        return send(wc_id, method, params, session_id, done);
    }
    let Some(entry) = wc(wc_id) else {
        return done(Err(("gone".into(), format!("no page {wc_id}"))));
    };
    let method = method.to_owned();
    let run = move |session: Option<String>| match session {
        Some(session) => send(wc_id, &method, params, Some(session), done),
        None => done(Err((
            "failed".into(),
            "Debugger is not attached to the target.".into(),
        ))),
    };
    let (attached, session) = {
        let e = entry.borrow();
        (e.cdp_attached, e.cdp_session.clone())
    };
    match (attached, session) {
        (true, Some(session)) => run(Some(session)),
        (true, None) => entry.borrow_mut().cdp_waiting.push(Box::new(run)),
        (false, _) => run(None),
    }
}

/// Arms the page's `input-event` (`shell_core::input_watch`) once CEF created its browser.
pub fn watch_input(wc_id: u64) {
    crate::wc::with_browser(wc_id, move |_| {
        for (method, params) in shell_core::input_watch::arm_commands() {
            send(wc_id, method, Some(params), None, move |result| {
                if let Err((code, message)) = result {
                    crate::log::log(
                        "wc.input_watch_failed",
                        json!({ "wcId": wc_id, "method": method, "code": code, "message": message }),
                    );
                }
            });
        }
    });
}

/// `executeJavaScript`: `Runtime.evaluate` by value, a promise awaited; a throw is `failed` with the page's message.
pub fn evaluate(
    wc_id: u64,
    code: &str,
    user_gesture: bool,
    done: impl FnOnce(Result<Value, Failure>) + 'static,
) {
    let params = json!({
        "expression": code,
        "returnByValue": true,
        "awaitPromise": true,
        "userGesture": user_gesture,
        "allowUnsafeEvalBlockedByCSP": true,
    });
    send(
        wc_id,
        "Runtime.evaluate",
        Some(params),
        None,
        move |result| {
            done(result.and_then(|answer| {
            if let Some(details) = answer.get("exceptionDetails") {
                let message = details
                    .pointer("/exception/description")
                    .or_else(|| details.pointer("/exception/value"))
                    .or_else(|| details.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("script failed")
                    .to_string();
                return Err(("failed".to_string(), message));
            }
            Ok(json!({ "result": answer.pointer("/result/value").cloned().unwrap_or(Value::Null) }))
        }));
        },
    );
}
