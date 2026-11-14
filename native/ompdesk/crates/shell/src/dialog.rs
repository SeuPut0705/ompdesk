//! `dialog.*` (PROTOCOL.md §8): message boxes and the file open / save dialogs, owned by the window `winId` names.
//!
//! On Windows a dialog runs on a thread of its own: it is modal and loops on messages until closed, and CEF's UI
//! thread must keep running tasks meanwhile (page IPC, the window state mirror, Node's other requests). The owner is
//! looked up on the UI thread; the system disables it while the dialog is open. On macOS AppKit wants the main thread,
//! so the dialog runs there.
//!
//! A message box Node cancels (`{cancel: id}`, Electron's `signal`) closes as if the person backed out and is still
//! answered, with its `cancelId`: the shim waits for that answer, as Electron's promise resolves with it.

use std::sync::Arc;

use serde_json::{Value, json};
use shell_core::dialog_spec::{DialogCancel, FileDialogSpec, MessageBoxSpec};

use crate::host::{self, Call};
use crate::log::log;
use crate::{state, ui};

#[cfg(windows)]
use shell_core::sys::dialogs as native;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::dialogs as native;

pub fn handle(call: Call) {
    match call.method.as_str() {
        "dialog.messageBox" => {
            let id = call.id();
            let cancel = Arc::new(DialogCancel::default());
            let on_cancel = cancel.clone();
            host::on_cancel(id, move || on_cancel.cancel());
            run(call, move |owner, options| {
                let spec = MessageBoxSpec::from_json(options);
                let shown = native::message_box(owner, &spec, &cancel);
                host::forget_cancel(id);
                shown.map(
                    |r| json!({ "response": r.response, "checkboxChecked": r.checkbox_checked }),
                )
            })
        }
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
    with_owner(win_id, move |owner| match show(owner, &options) {
        Ok(result) => call.ok(result),
        Err(why) => {
            log("dialog.failed", json!({ "method": method, "error": why }));
            call.err("failed", why);
        }
    });
}

/// Runs `show` where a dialog owned by window `win_id` may run, with the owner's OS handle (0 for none): on Windows a
/// thread of its own, on macOS the UI thread. When no thread can be made, `show` is dropped unrun (a `Call` it holds
/// then answers `failed`).
pub fn with_owner(win_id: Option<u64>, show: impl FnOnce(isize) + Send + 'static) {
    ui::run(move || {
        let owner = owner_handle(win_id);
        let work = move || show(owner);
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
