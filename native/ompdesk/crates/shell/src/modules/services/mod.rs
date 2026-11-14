//! Desktop services and the native caller API in `native`: path safety, page URL policy, clipboard and pickers.
//! The runtime admits page calls and supplies trusted caller facts. Existing OS backends own the actual effects.
//!
//! `OMP_GUI_TEST_SERVICES_DRY=1` (test seam, the parity suite): `openOrReveal` hands nothing to the OS and answers what
//! it would have done, with an open counted as done, except for a path ending in one of the extensions listed in
//! `OMP_GUI_TEST_SERVICES_NO_APP` (`.xyz,.abc`), whose open fails as when no app takes the file.

use std::sync::{Arc, LazyLock};

use serde_json::{Value, json};
use shell_core::dialog_spec::DialogCancel;
use shell_core::notify_spec::ToastSpec;

#[cfg(windows)]
use shell_core::sys::shellops;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::shellops;

use super::{Ctx, Module};
use crate::host::{self, Call};
use crate::log::log;
use crate::ui;

pub struct Services;

pub mod native;

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
        let outcome = native::open_resolved_path(&path);
        call.ok(json!({ "outcome": outcome.as_str() }));
    });
}

fn save_image(mut call: Call) {
    let Some(data) = call.bin.take() else {
        call.err("invalid", "services.saveImage needs the picture's bytes");
        return;
    };
    let name = call.str("defaultName").unwrap_or_default();
    let mime = call.str("mimeType").unwrap_or_default();
    native::save_image(win_id(&call), &name, &mime, data, move |result| {
        answer(call, result)
    });
}

/// The confirm card: a message box that closes itself after `timeoutMs` (and on Node's `{cancel: id}`), answering
/// its `cancelId` then.
fn confirm(call: Call) {
    let options = options(&call);
    let timeout = call.params.get("timeoutMs").and_then(Value::as_u64);
    let id = call.id();
    let cancel = Arc::new(DialogCancel::default());
    let on_cancel = cancel.clone();
    host::on_cancel(id, move || on_cancel.cancel());
    native::confirm(win_id(&call), &options, timeout, cancel, move |shown| {
        host::forget_cancel(id);
        answer(call, shown);
    });
}

fn page_open_external(call: Call) {
    let url = call.params.get("url").cloned().unwrap_or(Value::Null);
    ui::run(move || answer(call, native::open_external(&url).map(|()| json!({}))));
}

fn file_dialog(call: Call, save: bool) {
    let win = win_id(&call);
    let filters = call.params.get("filters").cloned().unwrap_or(Value::Null);
    if save {
        let default_path = call
            .params
            .get("defaultPath")
            .cloned()
            .unwrap_or(Value::Null);
        native::save_dialog(win, &default_path, &filters, move |result| {
            answer(call, result)
        });
    } else {
        let options = options(&call);
        native::open_dialog(win, &filters, &options, move |result| answer(call, result));
    }
}

fn clipboard(call: Call, write: bool) {
    if write {
        let Some(text) = call.str("text") else {
            call.err("invalid", "services.writeClipboard needs text");
            return;
        };
        ui::run(move || answer(call, native::write_clipboard(&text).map(|()| json!({}))));
    } else {
        ui::run(move || {
            answer(
                call,
                native::read_clipboard().map(|text| json!({ "text": text })),
            )
        });
    }
}

fn reveal_path(call: Call) {
    let Some(path) = call.str("path") else {
        call.err("invalid", "services.revealPath needs a path");
        return;
    };
    ui::run(move || answer(call, native::reveal_path(&path).map(|()| json!({}))));
}

fn trash_path(call: Call) {
    let Some(path) = call.str("path") else {
        call.err(
            "invalid",
            "services.trashPath needs a path authorized by the core",
        );
        return;
    };
    if let Err(error) = std::thread::Builder::new()
        .name("services-trash".into())
        .spawn(move || {
            answer(call, native::trash_path(&path).map(|()| json!({})));
        })
    {
        log(
            "services.trash_thread_failed",
            json!({ "error": error.to_string() }),
        );
    }
}

fn open_privacy_pane(call: Call) {
    let Some(pane) = call.str("pane") else {
        call.err("invalid", "services.openPrivacyPane needs a pane");
        return;
    };
    ui::run(move || answer(call, native::open_privacy_pane(&pane).map(|()| json!({}))));
}

fn show_notice(call: Call) {
    let Some(spec) = ToastSpec::from_json(&call.params) else {
        call.err("invalid", "services.showNotice needs an id");
        return;
    };
    ui::run(move || match native::show_notice(&spec, None) {
        Ok(()) => call.ok(json!({ "shown": true })),
        Err(error) => call.ok(json!({ "shown": false, "error": error })),
    });
}

fn close_notice(call: Call) {
    let Some(id) = call.params.get("id").and_then(Value::as_u64) else {
        call.err("invalid", "services.closeNotice needs an id");
        return;
    };
    ui::run(move || {
        native::close_notice(id);
        call.ok(json!({}));
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
            "services.openExternal" => page_open_external(call),
            "services.openDialog" => file_dialog(call, false),
            "services.saveDialog" => file_dialog(call, true),
            "services.readClipboard" => clipboard(call, false),
            "services.writeClipboard" => clipboard(call, true),
            "services.revealPath" => reveal_path(call),
            "services.trashPath" => trash_path(call),
            "services.showNotice" => show_notice(call),
            "services.closeNotice" => close_notice(call),
            "services.openPrivacyPane" => open_privacy_pane(call),
            _ => call.unsupported(),
        }
    }

    fn shutdown(&self, _ctx: Ctx) {
        native::close_all_notices();
    }
}
