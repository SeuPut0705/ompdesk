//! `shell.*` (PROTOCOL.md §8): hand a URL or a path to the system, reveal an item in the file manager, move an item
//! to the trash, beep. `openPath` never fails as a request: Electron answers its error as text.

use serde_json::json;

use crate::host::Call;
use crate::log::log;
use crate::ui;

#[cfg(windows)]
use shell_core::sys::shellops as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::shellops as native;

pub fn handle(call: Call) {
    match call.method.as_str() {
        "shell.openExternal" => {
            let Some(url) = call.str("url") else {
                call.err("invalid", "shell.openExternal needs a url");
                return;
            };
            ui::run(move || match native::open_external(&url) {
                Ok(()) => call.ok(json!({})),
                Err(why) => {
                    log("shell.open_external_failed", json!({ "error": why }));
                    call.err("failed", why);
                }
            });
        }
        "shell.openPath" => {
            let path = call.str("path").unwrap_or_default();
            ui::run(move || {
                let error = native::open_path(&path).err().unwrap_or_default();
                call.ok(json!({ "error": error }));
            });
        }
        "shell.showItemInFolder" => {
            let Some(path) = call.str("path") else {
                call.err("invalid", "shell.showItemInFolder needs a path");
                return;
            };
            ui::run(move || match native::show_item_in_folder(&path) {
                Ok(()) => call.ok(json!({})),
                Err(why) => call.err("failed", why),
            });
        }
        "shell.trashItem" => {
            let Some(path) = call.str("path") else {
                call.err("invalid", "shell.trashItem needs a path");
                return;
            };
            // Moving a large folder to the Recycle Bin can take a while: not on the UI thread.
            let work = move || match native::trash_item(&path) {
                Ok(()) => call.ok(json!({})),
                Err(why) => call.err("failed", why),
            };
            if let Err(error) = std::thread::Builder::new().name("trash".into()).spawn(work) {
                log(
                    "shell.trash_thread_failed",
                    json!({ "error": error.to_string() }),
                );
            }
        }
        "shell.beep" => ui::run(move || {
            native::beep();
            call.ok(json!({}));
        }),
        _ => call.unsupported(),
    }
}
