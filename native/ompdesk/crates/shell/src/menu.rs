//! `menu.*` (PROTOCOL.md §7): native popup menus and the application menu's accelerators. The platform code is
//! `shell_core::sys::menu` (Win32) or `shell_core::sys_mac::menu` (AppKit); the template walking is
//! `shell_core::menu_model`. Everything here runs on the UI thread.

use std::cell::Cell;

use serde_json::{Value, json};
use shell_core::menu_model::{self, Hit, Item};

use crate::host::{self, Call};
use crate::state;
use crate::ui;

#[cfg(windows)]
use shell_core::sys::menu as platform;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::menu as platform;

thread_local! {
    /// The `menuId` the application menu was installed with (Node's `Menu.setApplicationMenu`).
    static APPLICATION_MENU: Cell<u64> = const { Cell::new(0) };
}

pub fn handle(call: Call) {
    match call.method.as_str() {
        "menu.popup" => popup_request(call),
        "menu.setApplication" => set_application_request(call),
        _ => call.unsupported(),
    }
}

/// The platform's scale for pictures that belong to no window (the tray's icon).
pub fn display_scale() -> f64 {
    platform::system_scale()
}

fn menu_id(call: &Call) -> Option<u64> {
    call.params.get("menuId").and_then(Value::as_u64)
}

fn popup_request(call: Call) {
    let Some(menu_id) = menu_id(&call) else {
        return call.err("invalid", "menu.popup needs a menuId");
    };
    let items =
        match menu_model::parse_template(call.params.get("template").unwrap_or(&Value::Null)) {
            Ok(items) => items,
            Err(message) => return call.err("invalid", format!("menu.popup: {message}")),
        };
    let win_id = call.params.get("winId").and_then(Value::as_u64);
    let at = match (
        call.params.get("x").and_then(Value::as_f64),
        call.params.get("y").and_then(Value::as_f64),
    ) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    };
    ui::post(move || {
        let owner = match win_id {
            Some(id) => match window_handle(id) {
                Some(handle) => handle,
                None => return call.err("gone", format!("menu.popup: window {id} does not exist")),
            },
            None => 0,
        };
        match run_popup(menu_id, &items, owner, at) {
            Ok(item_id) => call.ok(json!({ "itemId": item_id })),
            Err(message) => call.err("failed", format!("menu.popup: {message}")),
        }
    });
}

/// The OS handle of window `id` (0 when it has none yet). The registry borrow ends here: a popup's modal loop runs
/// other tasks that borrow it.
fn window_handle(id: u64) -> Option<isize> {
    let entry = state::win(id)?;
    let handle = entry
        .borrow()
        .window
        .as_ref()
        .map_or(0, state::native_handle);
    Some(handle)
}

/// Shows `items` as a popup menu and returns the id of the chosen item (`None`: dismissed), reporting `menu.event`
/// `will-show` and `will-close` around it. `owner` is a window handle (0: none), `at` a point in DIP of its content
/// (`None`: the cursor). Blocks in the platform's menu loop until the menu closes. UI thread.
pub fn run_popup(
    menu_id: u64,
    items: &[Item],
    owner: isize,
    at: Option<(f64, f64)>,
) -> Result<Option<String>, String> {
    let popup = menu_model::build_popup(items, cfg!(target_os = "macos"));
    if popup.entries.is_empty() {
        return Ok(None);
    }
    let event = move |name: &'static str| {
        host::event("menu.event", json!({ "menuId": menu_id, "name": name }))
    };
    let chosen = platform::popup(
        owner,
        &popup.entries,
        at,
        || event("will-show"),
        || event("will-close"),
    )?;
    Ok(chosen.and_then(|cmd| popup.id_of(cmd)).map(String::from))
}

fn set_application_request(call: Call) {
    let Some(menu_id) = menu_id(&call) else {
        return call.err("invalid", "menu.setApplication needs a menuId");
    };
    let template = call.params.get("template").unwrap_or(&Value::Null);
    let items = if template.is_null() {
        None
    } else {
        match menu_model::parse_template(template) {
            Ok(items) => Some(items),
            Err(message) => return call.err("invalid", format!("menu.setApplication: {message}")),
        }
    };
    ui::post(move || {
        APPLICATION_MENU.with(|m| m.set(if items.is_some() { menu_id } else { 0 }));
        match platform::set_application(items.as_deref(), application_hit) {
            Ok(()) => call.ok(json!({})),
            Err(message) => call.err("failed", format!("menu.setApplication: {message}")),
        }
    });
}

/// An accelerator (Windows) or a menu click (macOS) of the application menu. UI thread.
fn application_hit(hit: Hit) {
    let menu_id = APPLICATION_MENU.with(Cell::get);
    let mut data = json!({ "menuId": menu_id, "itemId": hit.id });
    if let Some(checked) = hit.checked {
        data["checked"] = json!(checked);
    }
    host::event("menu.click", data);
}
