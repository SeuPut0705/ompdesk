//! `services.*` (PROTOCOL.md §15.7, batch SX3): the desktop services of `ipc.ts` that carried rules of their own.
//! Opening a path a reply names (a launcher is only revealed), saving a picture a page hands over (its extension and
//! the write), and the control socket's confirm card with its own deadline. The rules are `shell_core::services_core`;
//! this side carries them out with the shell's own dialog and shell operations. A plain hand-over (reveal, trash, the
//! system browser, the file pickers) stays on the shim's `shell.*`/`dialog.*`, which are this shell's already.
//!
//! `OMP_GUI_TEST_SERVICES_DRY=1` (test seam, the parity suite): `openOrReveal` hands nothing to the OS and answers what
//! it would have done, with an open counted as done, except for a path ending in one of the extensions listed in
//! `OMP_GUI_TEST_SERVICES_NO_APP` (`.xyz,.abc`), whose open fails as when no app takes the file.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde_json::{Value, json};
use shell_core::dialog_spec::{DialogCancel, FileDialogSpec, MessageBoxSpec};
use shell_core::services_core::{image_default_name, image_extension, open_or_reveal};

#[cfg(windows)]
use shell_core::sys::{dialogs, shellops};
#[cfg(target_os = "macos")]
use shell_core::sys_mac::{dialogs, shellops};

use super::{Ctx, Module};
use crate::host::{self, Call};
use crate::log::log;
use crate::{dialog, ui};

pub struct Services;

static DRY: LazyLock<bool> =
    LazyLock::new(|| std::env::var("OMP_GUI_TEST_SERVICES_DRY").is_ok_and(|v| v == "1"));

/// Under the dry seam, the extensions (`.xyz,.abc`) no app takes: their open fails as the OS's would.
static DRY_NO_APP: LazyLock<Vec<String>> = LazyLock::new(|| {
    std::env::var("OMP_GUI_TEST_SERVICES_NO_APP")
        .unwrap_or_default()
        .split(',')
        .map(|ext| ext.trim().to_lowercase())
        .filter(|ext| !ext.is_empty())
        .collect()
});

fn open(path: &str) -> Result<(), String> {
    if !*DRY {
        return shellops::open_path(path);
    }
    let lower = path.to_lowercase();
    match DRY_NO_APP.iter().find(|ext| lower.ends_with(ext.as_str())) {
        Some(_) => Err("no application".into()),
        None => Ok(()),
    }
}

fn reveal(path: &str) {
    if *DRY {
        return;
    }
    if let Err(why) = shellops::show_item_in_folder(path) {
        log("services.reveal_failed", json!({ "error": why }));
    }
}

fn win_id(call: &Call) -> Option<u64> {
    call.params.get("winId").and_then(Value::as_u64)
}

fn options(call: &Call) -> Value {
    call.params.get("options").cloned().unwrap_or(Value::Null)
}

/// Answers `call` from a dialog's result; a dialog that could not be shown is `failed` with its reason.
fn answer(call: Call, shown: Result<Value, String>) {
    match shown {
        Ok(result) => call.ok(result),
        Err(why) => {
            log(
                "services.dialog_failed",
                json!({ "method": call.method, "error": why }),
            );
            call.err("failed", why);
        }
    }
}

fn open_or_reveal_path(call: Call) {
    let Some(path) = call.str("path") else {
        call.err("invalid", "services.openOrReveal needs a path");
        return;
    };
    ui::run(move || {
        let outcome = open_or_reveal(&path, cfg!(windows), open, reveal);
        call.ok(json!({ "outcome": outcome.as_str() }));
    });
}

fn save_image(mut call: Call) {
    let Some(data) = call.bin.take() else {
        call.err("invalid", "services.saveImage needs the picture's bytes");
        return;
    };
    let mime_type = call.str("mimeType").unwrap_or_default();
    let extension = image_extension(&mime_type);
    let options = json!({
        "defaultPath": image_default_name(&call.str("defaultName").unwrap_or_default(), &extension),
        "filters": [{ "name": "Image", "extensions": [extension] }],
    });
    let spec = FileDialogSpec::from_json(&options);
    dialog::with_owner(win_id(&call), move |owner| {
        match dialogs::save_dialog(owner, &spec) {
            Ok(Some(path)) => match std::fs::write(&path, &data) {
                Ok(()) => call.ok(json!({ "saved": true })),
                Err(error) => call.ok(json!({ "saved": false, "error": error.to_string() })),
            },
            Ok(None) => call.ok(json!({ "saved": false })),
            Err(why) => answer(call, Err(why)),
        }
    });
}

/// The confirm card: a message box that closes itself after `timeoutMs` (and on Node's `{cancel: id}`), answering
/// its `cancelId` then.
fn confirm(call: Call) {
    let spec = MessageBoxSpec::from_json(&options(&call));
    let timeout = call.params.get("timeoutMs").and_then(Value::as_u64);
    let id = call.id();
    let cancel = Arc::new(DialogCancel::default());
    let on_cancel = cancel.clone();
    host::on_cancel(id, move || on_cancel.cancel());
    if let Some(ms) = timeout {
        let on_timeout = cancel.clone();
        let started = std::thread::Builder::new()
            .name("confirm-timeout".into())
            .spawn(move || {
                std::thread::sleep(Duration::from_millis(ms));
                on_timeout.cancel();
            });
        if let Err(error) = started {
            log(
                "services.confirm_timer_failed",
                json!({ "error": error.to_string() }),
            );
        }
    }
    dialog::with_owner(win_id(&call), move |owner| {
        let shown = dialogs::message_box(owner, &spec, &cancel);
        host::forget_cancel(id);
        answer(call, shown.map(|r| json!({ "response": r.response })));
    });
}

impl Module for Services {
    fn namespace(&self) -> &'static str {
        "services"
    }

    fn request(&self, _ctx: Ctx, call: Call) {
        match call.method.as_str() {
            "services.openOrReveal" => open_or_reveal_path(call),
            "services.saveImage" => save_image(call),
            "services.confirm" => confirm(call),
            _ => call.unsupported(),
        }
    }
}
