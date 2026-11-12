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
    if !entry.borrow().cdp_attached {
        return;
    }
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let mut data = json!({ "wcId": wc_id, "method": method, "params": value.get("params").cloned().unwrap_or(json!({})) });
    if let Some(session) = value.get("sessionId") {
        data["sessionId"] = session.clone();
    }
    host::event("wc.cdp.message", data);
}

/// Registers the observer once per page (it stays for the page's life).
fn ensure_observer(entry: &Rc<RefCell<WcEntry>>) {
    let (browser, registered, wc_id) = {
        let e = entry.borrow();
        (e.browser.clone(), e.cdp_registration.is_some(), e.id)
    };
    if registered {
        return;
    }
    let Some(host) = browser.and_then(|b| b.host()) else {
        return;
    };
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

pub fn attach(wc_id: u64) {
    if let Some(entry) = wc(wc_id) {
        entry.borrow_mut().cdp_attached = true;
        ensure_observer(&entry);
    }
}

pub fn detach(wc_id: u64) {
    if let Some(entry) = wc(wc_id) {
        entry.borrow_mut().cdp_attached = false;
    }
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
