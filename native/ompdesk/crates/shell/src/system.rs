//! `system.*` (permission queries) and the hidden message window that feeds `power.event`, `theme.changed`,
//! `screen.changed` and `boot.*`'s `power`, `shortcut` and `online` (PROTOCOL.md §9, §15.9).

use std::time::Duration;

use serde_json::json;
use shell_core::desk_state::Msg;

use crate::host::Call;

#[cfg(windows)]
use shell_core::sys::desk as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::desk as native;

// Which of these a platform's glue uses differs (the network poll is Windows-only, the accessibility probe macOS-only).
#[allow(unused_imports)]
pub use native::{
    accessibility_trusted, cursor_point, register_hotkey, set_blockers, unregister_hotkey,
};
#[allow(unused_imports)]
pub use native::{displays, idle_seconds, on_battery, online, reduced_motion, theme};

/// Creates the hidden message window and starts the network poll. Call once on the UI thread, from
/// `on_context_initialized`. Events go to Node through `host::event`, which drops them until Node connected.
pub fn init() {
    crate::theme::init();
    crate::screen::init();
    crate::power::init();
    if let Err(error) = native::init(on_message) {
        crate::log::log("system.init_failed", json!({ "error": error }));
    }
    let mut last = native::online();
    let spawned = std::thread::Builder::new()
        .name("net-online".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(3));
                let now = native::online();
                if now != last {
                    last = now;
                    crate::modules::boot::online(now);
                }
            }
        });
    if let Err(error) = spawned {
        crate::log::log(
            "system.net_thread_failed",
            json!({ "error": error.to_string() }),
        );
    }
}

/// Runs on the UI thread, inside the message window's procedure.
fn on_message(msg: Msg) {
    match msg {
        Msg::Suspend | Msg::Resume | Msg::PowerStatus | Msg::Lock | Msg::Unlock | Msg::Shutdown => {
            crate::power::message(msg)
        }
        Msg::SettingChange => {
            crate::theme::refresh();
            crate::screen::refresh();
        }
        Msg::DisplayChange => crate::screen::refresh(),
        Msg::Hotkey(id) => crate::shortcut::fired(id),
    }
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "system.accessibilityTrusted" => {
            let prompt = call
                .params
                .get("prompt")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let trusted = native::accessibility_trusted(prompt);
            call.ok(json!({ "trusted": trusted }));
        }
        "system.mediaAccessStatus" => {
            let media_type = call.str("mediaType").unwrap_or_default();
            let status = native::media_access_status(&media_type);
            call.ok(json!({ "status": status }));
        }
        _ => call.unsupported(),
    }
}
