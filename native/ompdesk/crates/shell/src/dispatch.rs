//! Routes Node's requests and events to the module that owns the namespace: the Electron shim's namespaces here, a
//! moved subsystem's through `modules` (PROTOCOL.md §15).

use serde_json::Value;

use crate::host::Call;
use crate::{ipc, lifecycle, protocol};

pub fn request(call: Call) {
    let method = call.method.clone();
    if std::env::var_os("OMPDESK_SHELL_TRACE").is_some() {
        let mut params = call.params.to_string();
        params.truncate(300);
        crate::log::log(
            "host.request",
            serde_json::json!({ "method": method, "params": params }),
        );
    }
    match method.as_str() {
        "app.init" => lifecycle::init(call),
        m if m.starts_with("app.") => crate::appops::handle(call),
        "win.create" => crate::window::create(call),
        "win.op" => crate::window::op(call),
        "wc.op" => crate::wc::op(call),
        "wc.cdp.attach" | "wc.cdp.detach" | "wc.cdp.send" | "wc.frame" => {
            crate::wc::cdp_request(call)
        }
        "session.create" => crate::session::create(call),
        "session.op" => crate::session::op(call),
        m if m.starts_with("menu.") => crate::menu::handle(call),
        m if m.starts_with("tray.") => crate::tray::handle(call),
        m if m.starts_with("dialog.") => crate::dialog::handle(call),
        m if m.starts_with("clipboard.") => crate::clipboard::handle(call),
        m if m.starts_with("shell.") => crate::shellops::handle(call),
        m if m.starts_with("notification.") => crate::notification::handle(call),
        m if m.starts_with("screen.") => crate::screen::handle(call),
        m if m.starts_with("theme.") => crate::theme::handle(call),
        m if m.starts_with("power.") => crate::power::handle(call),
        m if m.starts_with("shortcut.") => crate::shortcut::handle(call),
        m if m.starts_with("net.") => crate::net::handle(call),
        m if m.starts_with("system.") => crate::system::handle(call),
        _ => crate::modules::request(call),
    }
}

pub fn event(name: &str, data: Value, bin: Option<Vec<u8>>) {
    let id = |key: &str| data.get(key).and_then(Value::as_u64);
    match name {
        "app.exit" | "app.relaunch" => lifecycle::on_event(name, data, bin),
        "wc.send" => {
            if let (Some(wc_id), Some(channel)) =
                (id("wcId"), data.get("channel").and_then(Value::as_str))
            {
                ipc::push(wc_id, channel, data.get("args").unwrap_or(&Value::Null));
            }
        }
        "protocol.chunk" => {
            if let Some(stream_id) = id("streamId") {
                protocol::on_chunk(stream_id, bin.unwrap_or_default());
            }
        }
        "protocol.end" => {
            if let Some(stream_id) = id("streamId") {
                protocol::on_end(
                    stream_id,
                    data.get("error").and_then(Value::as_str).map(String::from),
                );
            }
        }
        "net.cancel" => crate::net::cancel(data),
        "i18n.labels" => {
            if let Err(problem) = shell_core::labels::set(&data) {
                crate::log::log("i18n.labels", serde_json::json!({ "error": problem }));
            }
        }
        other => crate::modules::event(other, data, bin),
    }
}
