//! `dialog.*` (PROTOCOL.md §8): message boxes and the file open / save dialogs, owned by the window `winId` names.
//!
//! On Windows a dialog runs on a thread of its own: it is modal and loops on messages until closed, and CEF's UI
//! thread must keep running tasks meanwhile (page IPC, the window state mirror, Node's other requests). The owner is
//! looked up on the UI thread; the system disables it while the dialog is open. On macOS AppKit wants the main thread,
//! so the dialog runs there.

use serde_json::{Value, json};
use shell_core::dialog_spec::{FileDialogSpec, MessageBoxSpec};

use crate::host::Call;
use crate::log::log;
use crate::{state, ui};

#[cfg(windows)]
use shell_core::sys::dialogs as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::dialogs as native;

pub fn handle(call: Call) {
    match call.method.as_str() {
        "dialog.messageBox" => run(call, |owner, options| {
            let spec = MessageBoxSpec::from_json(options);
            native::message_box(owner, &spec)
                .map(|r| json!({ "response": r.response, "checkboxChecked": r.checkbox_checked }))
        }),
        "dialog.openDialog" => run(call, |owner, options| {
            let spec = FileDialogSpec::from_json(options);
            native::open_dialog(owner, &spec).map(|chosen| match chosen {
                Some(paths) => json!({ "canceled": false, "filePaths": paths }),
                None => json!({ "canceled": true, "filePaths": [] }),
            })
        }),
        "dialog.saveDialog" => run(call, |owner, options| {
            let spec = FileDialogSpec::from_json(options);
            native::save_dialog(owner, &spec).map(|chosen| match chosen {
                Some(path) => json!({ "canceled": false, "filePath": path }),
                // Electron answers a cancelled save with an empty path, not none.
                None => json!({ "canceled": true, "filePath": "" }),
            })
        }),
        _ => call.unsupported(),
    }
}

/// The OS handle of window `win_id`; 0 (no owner) when it is unknown or already closed. UI thread only.
fn owner_handle(win_id: Option<u64>) -> isize {
    let Some(entry) = win_id.and_then(state::win) else {
        return 0;
    };
    let entry = entry.borrow();
    entry.window.as_ref().map_or(0, state::native_handle)
}

/// Answers `call` with what `show` returns: `ok` with its JSON, or `failed` with its message.
fn run(call: Call, show: impl FnOnce(isize, &Value) -> Result<Value, String> + Send + 'static) {
    let win_id = call.params.get("winId").and_then(Value::as_u64);
    let options = call.params.get("options").cloned().unwrap_or(Value::Null);
    let method = call.method.clone();
    ui::run(move || {
        let owner = owner_handle(win_id);
        let work = move || match show(owner, &options) {
            Ok(result) => call.ok(result),
            Err(why) => {
                log("dialog.failed", json!({ "method": method, "error": why }));
                call.err("failed", why);
            }
        };
        #[cfg(windows)]
        {
            if let Err(error) = std::thread::Builder::new()
                .name("dialog".into())
                .spawn(work)
            {
                log(
                    "dialog.thread_failed",
                    json!({ "error": error.to_string() }),
                );
            }
        }
        #[cfg(not(windows))]
        work();
    });
}
