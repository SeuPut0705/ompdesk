//! `theme.setSource` and `theme.changed`: the OS colour scheme with Electron's `themeSource` override on top. CEF pages
//! follow the OS scheme on their own; the override is Node's mirror only (the cef crate has no per-browser colour-scheme
//! setter, so `prefers-color-scheme` in a page keeps following the OS).

use std::cell::RefCell;

use serde_json::{Value, json};
use shell_core::desk_state::{ThemeSource, effective_theme};

use crate::host::{self, Call};
use crate::system;

#[derive(Default)]
struct State {
    source: ThemeSource,
    last: Option<Value>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// `{dark, highContrast, inverted, reducedMotion}` for `source`.
fn snapshot(source: ThemeSource) -> Value {
    let mut value = effective_theme(&system::theme(), source);
    value["reducedMotion"] = json!(system::reduced_motion());
    value
}

/// UI thread.
pub fn init() {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.last = Some(snapshot(s.source));
    });
}

/// Pushes `theme.changed` when the effective values moved. UI thread.
pub fn refresh() {
    let changed = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let now = snapshot(s.source);
        (s.last.as_ref() != Some(&now)).then(|| {
            s.last = Some(now.clone());
            now
        })
    });
    if let Some(now) = changed {
        host::event("theme.changed", now);
    }
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "theme.setSource" => {
            let Some(source) = call.str("source").as_deref().and_then(ThemeSource::parse) else {
                return call.err(
                    "invalid",
                    "theme.setSource: source must be system, light or dark",
                );
            };
            crate::ui::run(move || {
                STATE.with(|s| s.borrow_mut().source = source);
                refresh();
                let now = snapshot(source);
                call.ok(json!({ "dark": now["dark"], "highContrast": now["highContrast"], "inverted": now["inverted"] }));
            });
        }
        _ => call.unsupported(),
    }
}
