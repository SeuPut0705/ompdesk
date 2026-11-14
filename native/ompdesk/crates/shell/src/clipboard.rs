//! `clipboard.*` (PROTOCOL.md §8): the system clipboard as plain text.

use serde_json::json;

use crate::host::Call;
use crate::ui;

#[cfg(windows)]
use shell_core::sys::clipboard as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::clipboard as native;

pub fn handle(call: Call) {
    match call.method.as_str() {
        "clipboard.readText" => ui::run(move || match native::read_text() {
            Ok(text) => call.ok(json!({ "text": text })),
            Err(why) => call.err("failed", why),
        }),
        "clipboard.writeText" => {
            let Some(text) = call.str("text") else {
                call.err("invalid", "clipboard.writeText needs a text");
                return;
            };
            ui::run(move || match native::write_text(&text) {
                Ok(()) => call.ok(json!({})),
                Err(why) => call.err("failed", why),
            });
        }
        _ => call.unsupported(),
    }
}
