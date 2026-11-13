//! DevTools protocol through CEF's `SendDevToolsMessage` (PROTOCOL.md §4). The shim builds `capturePage`,
//! `printToPDF`, `sendInputEvent`, `executeJavaScript` and the `debugger` on this; every reply and event of a page's
//! protocol reaches the observer registered on first use.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use cef::*;
use serde_json::{Value, json};

use crate::host;
use crate::state::{WcEntry, wc};

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
            let attached = wc(self.wc_id).map(|e| e.borrow().cdp_attached).unwrap_or(false);
            if attached {
                host::event("wc.cdp.detached", json!({ "wcId": self.wc_id, "reason": "target closed" }));
            }
        }
    }
}

fn on_message(wc_id: u64, value: Value) {
    let Some(entry) = wc(wc_id) else { return };
    if let Some(id) = value.get("id").and_then(Value::as_i64) {
        let callback = entry.borrow_mut().cdp_pending.remove(&(id as i32));
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
            {
                let mut e = entry.borrow_mut();
                e.cdp_attached = false;
                e.cdp_session = None;
            }
            host::event(
                "wc.cdp.detached",
                json!({ "wcId": wc_id, "reason": "target closed" }),
            );
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
    host::event("wc.cdp.message", data);
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
    if let Some(session) = session_id {
        message["sessionId"] = json!(session);
    }
    entry.borrow_mut().cdp_pending.insert(id, Box::new(done));
    if host.send_dev_tools_message(Some(message.to_string().as_bytes())) == 0 {
        let callback = entry.borrow_mut().cdp_pending.remove(&id);
        if let Some(callback) = callback {
            callback(Err((
                "failed".into(),
                format!("{method} could not be sent"),
            )));
        }
        return;
    }
    crate::ui::post_delayed(Duration::from_secs(60).as_millis() as i64, move || {
        let callback = wc(wc_id).and_then(|e| e.borrow_mut().cdp_pending.remove(&id));
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
    {
        let mut e = entry.borrow_mut();
        if e.cdp_attached {
            return;
        }
        e.cdp_attached = true;
        e.cdp_session = None;
    }
    let opened = move |session: Option<String>| {
        let Some(entry) = wc(wc_id) else { return };
        let waiting = {
            let mut e = entry.borrow_mut();
            // Detached before the session existed: it goes at once.
            if !e.cdp_attached {
                if let Some(session) = &session {
                    send(
                        wc_id,
                        "Target.detachFromTarget",
                        Some(json!({ "sessionId": session })),
                        None,
                        |_| {},
                    );
                }
                return;
            }
            e.cdp_session = session.clone();
            std::mem::take(&mut e.cdp_waiting)
        };
        if session.is_none() {
            crate::log::log("wc.debugger_session_failed", json!({ "wcId": wc_id }));
        }
        for run in waiting {
            run(session.clone());
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
    let (waiting, session) = {
        let mut e = entry.borrow_mut();
        e.cdp_attached = false;
        (std::mem::take(&mut e.cdp_waiting), e.cdp_session.take())
    };
    for run in waiting {
        run(None);
    }
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
