//! `power.*`: suspend/resume/lock/battery events and idle time; the idle-sleep blockers keep-awake holds (`boot.*`'s
//! `awakeStart`/`awakeStop`, PROTOCOL.md §15.9).

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

/// `power.event` for the shim's `powerMonitor`, and `boot.power` (with the lid policy's AC input).
fn event(name: &str, on_battery: Option<bool>) {
    let mut data = json!({ "name": name });
    if let Some(battery) = on_battery {
        data["onBattery"] = json!(battery);
    }
    host::event("power.event", data);
    crate::modules::boot::power(name);
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
            event("suspend", None);
        }
        // Windows sends RESUMEAUTOMATIC and then RESUMESUSPEND on input; Electron's `resume` fires once.
        Msg::Resume => {
            if SUSPENDED.replace(false) {
                event("resume", None);
                crate::modules::chrome::hang::resumed();
            }
        }
        Msg::Lock => event("lock-screen", None),
        Msg::Unlock => event("unlock-screen", None),
        Msg::Shutdown => event("shutdown", None),
        Msg::PowerStatus => {
            let battery = system::on_battery();
            if ON_BATTERY.replace(battery) != battery {
                event(if battery { "on-battery" } else { "on-ac" }, Some(battery));
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
        _ => call.unsupported(),
    }
}

/// Holds `prevent-app-suspension` for `id` until `release(id)`. UI thread.
pub fn hold(id: String) -> Result<(), String> {
    BLOCKERS.with(|b| b.borrow_mut().start(id, BlockerKind::AppSuspension));
    apply()
}

/// UI thread.
pub fn release(id: &str) -> Result<(), String> {
    BLOCKERS.with(|b| b.borrow_mut().stop(id));
    apply()
}

/// Any blocker is held. UI thread.
pub fn held() -> bool {
    BLOCKERS.with(|b| b.borrow().wanted().0)
}

/// Applies the live set to the UI thread's execution state.
fn apply() -> Result<(), String> {
    let (system_on, display) = BLOCKERS.with(|b| b.borrow().wanted());
    system::set_blockers(system_on, display)
}
