//! `power.*`: suspend/resume/lock/battery events, idle time and the blockers (`powerSaveBlocker`).

use std::cell::{Cell, RefCell};

use serde_json::json;
use shell_core::desk_state::{BlockerKind, Blockers, Msg};

use crate::host::{self, Call};
use crate::system;

thread_local! {
    static BLOCKERS: RefCell<Blockers> = RefCell::new(Blockers::default());
    static ON_BATTERY: Cell<bool> = const { Cell::new(false) };
    static SUSPENDED: Cell<bool> = const { Cell::new(false) };
}

fn event(name: &str) {
    host::event("power.event", json!({ "name": name }));
}

/// UI thread.
pub fn init() {
    ON_BATTERY.set(system::on_battery());
}

/// One message of the hidden window. UI thread.
pub fn message(msg: Msg) {
    match msg {
        Msg::Suspend => {
            SUSPENDED.set(true);
            event("suspend");
        }
        // Windows sends RESUMEAUTOMATIC and then RESUMESUSPEND on input; Electron's `resume` fires once.
        Msg::Resume => {
            if SUSPENDED.replace(false) {
                event("resume");
            }
        }
        Msg::Lock => event("lock-screen"),
        Msg::Unlock => event("unlock-screen"),
        Msg::Shutdown => event("shutdown"),
        Msg::PowerStatus => {
            let battery = system::on_battery();
            if ON_BATTERY.replace(battery) != battery {
                host::event(
                    "power.event",
                    json!({ "name": if battery { "on-battery" } else { "on-ac" }, "onBattery": battery }),
                );
            }
        }
        Msg::SettingChange | Msg::DisplayChange | Msg::Hotkey(_) => {}
    }
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "power.idleTime" => {
            let seconds = system::idle_seconds();
            call.ok(json!({ "seconds": seconds }));
        }
        "power.blockerStart" => {
            let Some(id) = call.params.get("id").map(ToString::to_string) else {
                return call.err("invalid", "power.blockerStart needs an id");
            };
            let Some(kind) = call.str("type").as_deref().and_then(BlockerKind::parse) else {
                return call.err("invalid", "power.blockerStart: type must be prevent-app-suspension or prevent-display-sleep");
            };
            crate::ui::run(move || {
                BLOCKERS.with(|b| b.borrow_mut().start(id, kind));
                apply(call);
            });
        }
        "power.blockerStop" => {
            let Some(id) = call.params.get("id").map(ToString::to_string) else {
                return call.err("invalid", "power.blockerStop needs an id");
            };
            crate::ui::run(move || {
                BLOCKERS.with(|b| b.borrow_mut().stop(&id));
                apply(call);
            });
        }
        _ => call.unsupported(),
    }
}

/// Applies the live set to the UI thread's execution state, then answers.
fn apply(call: Call) {
    let (system_on, display) = BLOCKERS.with(|b| b.borrow().wanted());
    match system::set_blockers(system_on, display) {
        Ok(()) => call.ok(json!({})),
        Err(message) => call.err("failed", message),
    }
}
