//! `notification.*` (PROTOCOL.md §8): desktop notifications. `show` answers `ok` whenever the request is well formed:
//! a toast that cannot be shown (notifications off, no AppUserModelID, no bundle) is reported by a `failed` event, as
//! Electron's `Notification` does, so the caller's `failed` listener sees it. The toast's own events (`click`,
//! `close`, `failed`) follow from the OS's threads through `emit`.

use serde_json::{Value, json};
use shell_core::notify_spec::ToastSpec;

use crate::host::{self, Call};
use crate::log::log;
use crate::ui;

#[cfg(windows)]
use shell_core::sys::toast as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::toast as native;

/// A toast event to Node; also what the OS's threads call through `native::show`.
fn emit(id: u64, name: &'static str, reason: Option<String>) {
    let mut data = json!({ "id": id, "name": name });
    if let Some(reason) = reason {
        data["reason"] = Value::String(reason);
    }
    host::event("notification.event", data);
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "notification.show" => {
            let Some(spec) = ToastSpec::from_json(&call.params) else {
                call.err("invalid", "notification.show needs an id");
                return;
            };
            ui::run(move || {
                let id = spec.id;
                let shown = native::show(&spec, emit);
                call.ok(json!({}));
                match shown {
                    Ok(()) => emit(id, "show", None),
                    Err(why) => {
                        log("notification.failed", json!({ "id": id, "error": why }));
                        emit(id, "failed", Some(why));
                    }
                }
            });
        }
        "notification.close" => {
            let Some(id) = call.params.get("id").and_then(Value::as_u64) else {
                call.err("invalid", "notification.close needs an id");
                return;
            };
            ui::run(move || {
                native::close(id);
                call.ok(json!({}));
            });
        }
        _ => call.unsupported(),
    }
}
