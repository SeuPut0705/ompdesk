//! Native caller API. The runtime admits the channel and supplies authenticated window/path facts.
//! OS objects stay in the existing platform backends; there are no Node asks or relays here.

use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use shell_core::dialog_spec::{DialogCancel, FileDialogSpec, MessageBoxSpec};
use shell_core::notify_spec::ToastSpec;
use shell_core::services_core::notice::{NoticeRoute, NoticeRoutes};
use shell_core::services_core::reply::DialogReply;
use shell_core::services_core::{
    Outcome, external_url_allowed, image_default_name, image_extension, open_dialog_options,
    save_dialog_options,
};

#[cfg(windows)]
use shell_core::sys::{clipboard, dialogs, shellops, toast};
#[cfg(target_os = "macos")]
use shell_core::sys_mac::{clipboard, dialogs, shellops, toast};

use crate::dialog;

/// UI thread. Unlike the lower-level OS backend, page links cannot launch a custom URL handler.
pub fn open_external(url: &Value) -> Result<(), String> {
    let Some(text) = url.as_str().filter(|_| external_url_allowed(url)) else {
        return Ok(());
    };
    shellops::open_external(text)
}

/// UI thread. Resolve the page's path with `services_core::path::existing_local_path` on a worker first.
pub fn open_resolved_path(path: &str) -> Outcome {
    shell_core::services_core::open_or_reveal(path, cfg!(windows), super::open, super::reveal)
}

/// UI thread; path authority has already been checked by the runtime, as for `open_resolved_path`.
pub fn reveal_path(path: &str) -> Result<(), String> {
    shellops::show_item_in_folder(path)
}

/// Worker thread. Only pass the path the core authorized for `fs.mutate`, never a raw page path.
pub fn trash_path(path: &str) -> Result<(), String> {
    shellops::trash_item(path)
}

/// UI thread. Admission (including paired-device grants) belongs to the runtime, not the text being copied.
pub fn read_clipboard() -> Result<String, String> {
    clipboard::read_text()
}

/// UI thread.
pub fn write_clipboard(text: &str) -> Result<(), String> {
    clipboard::write_text(text)
}

/// `win_id` is only the authenticated Desktop caller's window. Web callers have none and use their host sheet.
pub fn open_dialog(
    win_id: Option<u64>,
    filters: &Value,
    options: &Value,
    answer: impl FnOnce(Result<Value, String>) + Send + 'static,
) {
    let Some(win_id) = win_id else {
        answer(Ok(Value::Null));
        return;
    };
    let spec = FileDialogSpec::from_json(&open_dialog_options(filters, options));
    let answer = DialogReply::new(answer);
    dialog::with_owner(Some(win_id), move |owner| {
        answer.finish(
            dialogs::open_dialog(owner, &spec).map(|chosen| match chosen {
                Some(paths) => json!(paths),
                None => Value::Null,
            }),
        );
    });
}

/// A cancelled picker answers null; the empty string is a valid default path, not the default session.html.
pub fn save_dialog(
    win_id: Option<u64>,
    default_path: &Value,
    filters: &Value,
    answer: impl FnOnce(Result<Value, String>) + Send + 'static,
) {
    let Some(win_id) = win_id else {
        answer(Ok(Value::Null));
        return;
    };
    let spec = FileDialogSpec::from_json(&save_dialog_options(default_path, filters));
    let answer = DialogReply::new(answer);
    dialog::with_owner(Some(win_id), move |owner| {
        answer.finish(
            dialogs::save_dialog(owner, &spec).map(|chosen| match chosen {
                Some(path) => json!(path),
                None => Value::Null,
            }),
        );
    });
}

pub fn save_image(
    win_id: Option<u64>,
    default_name: &str,
    mime_type: &str,
    data: Vec<u8>,
    answer: impl FnOnce(Result<Value, String>) + Send + 'static,
) {
    let Some(win_id) = win_id else {
        answer(Ok(json!({ "saved": false })));
        return;
    };
    let extension = image_extension(mime_type);
    let spec = FileDialogSpec::from_json(&json!({
        "defaultPath": image_default_name(default_name, &extension),
        "filters": [{ "name": "Image", "extensions": [extension] }],
    }));
    let answer = DialogReply::new(answer);
    dialog::with_owner(Some(win_id), move |owner| {
        let result = dialogs::save_dialog(owner, &spec).map(|chosen| match chosen {
            Some(path) => match std::fs::write(path, &data) {
                Ok(()) => json!({ "saved": true }),
                Err(error) => json!({ "saved": false, "error": error.to_string() }),
            },
            None => json!({ "saved": false }),
        });
        answer.finish(result);
    });
}

/// The native caller owns cancellation; no wire id or Node callback is needed here.
pub fn confirm(
    win_id: Option<u64>,
    options: &Value,
    timeout_ms: Option<u64>,
    cancel: Arc<DialogCancel>,
    answer: impl FnOnce(Result<Value, String>) + Send + 'static,
) {
    let spec = MessageBoxSpec::from_json(options);
    if let Some(ms) = timeout_ms {
        let on_timeout = cancel.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("confirm-timeout".into())
            .spawn(move || {
                std::thread::sleep(Duration::from_millis(ms));
                on_timeout.cancel();
            })
        {
            crate::log::log(
                "services.confirm_timer_failed",
                json!({ "error": error.to_string() }),
            );
            cancel.cancel();
        }
    }
    let answer = DialogReply::new(answer);
    dialog::with_owner(win_id, move |owner| {
        answer.finish(
            dialogs::message_box(owner, &spec, &cancel)
                .map(|result| json!({ "response": result.response })),
        );
    });
}

static NOTICE_ROUTES: LazyLock<Mutex<NoticeRoutes>> =
    LazyLock::new(|| Mutex::new(NoticeRoutes::default()));

fn notice_event(id: u64, name: &'static str, reason: Option<String>) {
    finish_notice(id, name, reason.as_deref());
}

fn finish_notice(id: u64, name: &str, reason: Option<&str>) {
    let route = NOTICE_ROUTES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .event(id, name);
    if let Some(route) = route {
        crate::ui::run(move || (route.activate)(route.target));
    }
    if name == "failed" {
        crate::log::log(
            "services.notification_failed",
            json!({ "id": id, "error": reason }),
        );
    }
}

/// UI thread. The runtime supplies the app icon and authenticated tab owner. No callback crosses into Node.
pub fn show_notice(spec: &ToastSpec, route: Option<NoticeRoute>) -> Result<(), String> {
    if std::env::var("OMP_GUI_HEADLESS").is_ok_and(|value| value == "1") {
        return Ok(());
    }
    if let Some(route) = route {
        NOTICE_ROUTES
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .track(spec.id, route);
    }
    let shown = toast::show(spec, notice_event);
    if let Err(reason) = &shown {
        finish_notice(spec.id, "failed", Some(reason));
    }
    shown
}

/// UI thread.
pub fn close_notice(id: u64) {
    NOTICE_ROUTES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .event(id, "close");
    toast::close(id);
}

pub fn close_all_notices() {
    let ids: Vec<_> = NOTICE_ROUTES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .drain_ids()
        .collect();
    for id in ids {
        toast::close(id);
    }
}

/// UI thread. The person must still change the permission themselves.
pub fn open_privacy_pane(pane: &str) -> Result<(), String> {
    let url = shell_core::services_core::privacy_pane_url(pane, cfg!(target_os = "macos"))?;
    shellops::open_external(&url)
}
