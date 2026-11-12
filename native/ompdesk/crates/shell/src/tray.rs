//! `tray.*` (PROTOCOL.md §7): the notification-area icon (Windows) or menu-bar item (macOS) through the `tray-icon`
//! crate. The icon's context menu is shown by `menu::run_popup`, the same native popup as `menu.popup`, so a choice
//! comes back as `menu.click {menuId, itemId}` and the menu reports `will-show` / `will-close`. `tray-icon` delivers
//! its mouse events through one global handler on whatever thread it likes; they hop to the UI thread with
//! `ui::post`. Everything else runs on the UI thread.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Once;

use serde_json::{Value, json};
use shell_core::menu_model::{self, Item};
use shell_core::tray_image;
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::host::{self, Call};
use crate::menu;
use crate::ui;

/// The context menu a tray shows: its `menuId` and the template, whose checkbox and radio state is kept here (the
/// template is sent once; a click changes what the next showing must draw).
struct ContextMenu {
    menu_id: u64,
    items: Vec<Item>,
}

struct Tray {
    icon: TrayIcon,
    menu: Option<ContextMenu>,
}

thread_local! {
    static TRAYS: RefCell<HashMap<u64, Tray>> = RefCell::new(HashMap::new());
}

static HANDLER: Once = Once::new();

pub fn handle(call: Call) {
    match call.method.as_str() {
        "tray.create" => ui::post(move || create(call)),
        "tray.op" => ui::post(move || op(call)),
        _ => call.unsupported(),
    }
}

fn tray_id(call: &Call) -> Option<u64> {
    call.params.get("trayId").and_then(Value::as_u64)
}

/// The icon for `images` (`[{scaleFactor, dataURL}]`): the representation closest to the display scale, decoded.
/// `Ok(None)` for an empty list (an empty `NativeImage`: the tray keeps no picture).
fn icon_of(images: &Value) -> Result<Option<Icon>, String> {
    let Some(list) = images.as_array().filter(|l| !l.is_empty()) else {
        return Ok(None);
    };
    let scales: Vec<f64> = list
        .iter()
        .map(|r| r.get("scaleFactor").and_then(Value::as_f64).unwrap_or(1.0))
        .collect();
    let scale = menu::display_scale();
    let Some(index) = tray_image::pick(&scales, scale) else {
        return Ok(None);
    };
    let url = list[index]
        .get("dataURL")
        .and_then(Value::as_str)
        .ok_or("a tray image has no dataURL")?;
    let bytes = tray_image::data_url_bytes(url)?;
    let image = tray_image::decode_image(&bytes, (16.0 * scale).round() as u32)?;
    Icon::from_rgba(image.data, image.width, image.height)
        .map(Some)
        .map_err(|e| format!("the tray image is unusable: {e}"))
}

fn create(call: Call) {
    let Some(id) = tray_id(&call) else {
        return call.err("invalid", "tray.create needs a trayId");
    };
    let icon = match icon_of(call.params.get("images").unwrap_or(&Value::Null)) {
        Ok(icon) => icon,
        Err(message) => return call.err("failed", format!("tray.create: {message}")),
    };
    if TRAYS.with(|t| t.borrow().contains_key(&id)) {
        return call.err("invalid", format!("tray.create: tray {id} exists"));
    }
    ensure_handler();
    let mut builder = TrayIconBuilder::new().with_id(id.to_string());
    if let Some(icon) = icon {
        builder = builder.with_icon(icon);
    }
    if let Some(tooltip) = call
        .params
        .get("tooltip")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    {
        builder = builder.with_tooltip(tooltip);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.with_icon_as_template(
            call.params
                .get("template")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
    }
    match builder.build() {
        Ok(icon) => {
            TRAYS.with(|t| t.borrow_mut().insert(id, Tray { icon, menu: None }));
            call.ok(json!({}));
        }
        Err(error) => call.err("failed", format!("tray.create: {error}")),
    }
}

fn op(call: Call) {
    let Some(id) = tray_id(&call) else {
        return call.err("invalid", "tray.op needs a trayId");
    };
    let Some(name) = call.str("op") else {
        return call.err("invalid", "tray.op needs an op");
    };
    let args = call.params.get("args").cloned().unwrap_or(Value::Null);
    if !TRAYS.with(|t| t.borrow().contains_key(&id)) {
        return call.err("gone", format!("tray.op: tray {id} does not exist"));
    }
    let result = match name.as_str() {
        "setToolTip" => with_tray(id, |tray| {
            let text = args.get("text").and_then(Value::as_str).unwrap_or("");
            tray.icon.set_tooltip(Some(text)).map_err(|e| e.to_string())
        }),
        "setImage" => icon_of(args.get("images").unwrap_or(&Value::Null)).and_then(|icon| {
            with_tray(id, |tray| {
                #[cfg(target_os = "macos")]
                tray.icon.set_icon_as_template(
                    args.get("template")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
                tray.icon.set_icon(icon).map_err(|e| e.to_string())
            })
        }),
        "setContextMenu" => set_context_menu(id, &args),
        "destroy" => {
            // Dropping the `TrayIcon` removes it from the notification area.
            TRAYS.with(|t| t.borrow_mut().remove(&id));
            Ok(())
        }
        other => {
            return call.err(
                "unsupported",
                format!("tray.op {other} is not implemented by this shell"),
            );
        }
    };
    match result {
        Ok(()) => call.ok(json!({})),
        Err(message) => call.err("failed", format!("tray.op {name}: {message}")),
    }
}

fn with_tray<R>(id: u64, f: impl FnOnce(&mut Tray) -> Result<R, String>) -> Result<R, String> {
    TRAYS.with(|t| match t.borrow_mut().get_mut(&id) {
        Some(tray) => f(tray),
        None => Err(format!("tray {id} does not exist")),
    })
}

fn set_context_menu(id: u64, args: &Value) -> Result<(), String> {
    let template = args.get("template").unwrap_or(&Value::Null);
    let menu = if template.is_null() {
        None
    } else {
        let menu_id = args
            .get("menuId")
            .and_then(Value::as_u64)
            .ok_or("setContextMenu needs a menuId")?;
        Some(ContextMenu {
            menu_id,
            items: menu_model::parse_template(template)?,
        })
    };
    with_tray(id, |tray| {
        tray.menu = menu;
        Ok(())
    })
}

fn ensure_handler() {
    HANDLER.call_once(|| {
        TrayIconEvent::set_event_handler(Some(|event: TrayIconEvent| {
            ui::post(move || on_event(event))
        }));
    });
}

fn emit(tray_id: u64, name: &str) {
    host::event("tray.event", json!({ "trayId": tray_id, "name": name }));
}

/// A mouse event of a tray icon. UI thread.
fn on_event(event: TrayIconEvent) {
    match event {
        TrayIconEvent::Click {
            id,
            button,
            button_state: MouseButtonState::Up,
            ..
        } => {
            let Ok(tray) = id.0.parse::<u64>() else {
                return;
            };
            match button {
                // Windows: a left click is the `click` event and never the menu. macOS: the menu-bar item shows
                // its menu on a click, and is a plain click only without one.
                MouseButton::Left => {
                    if cfg!(target_os = "macos") && has_menu(tray) {
                        show_menu(tray);
                    } else {
                        emit(tray, "click");
                    }
                }
                MouseButton::Right => {
                    emit(tray, "right-click");
                    if cfg!(windows) {
                        show_menu(tray);
                    }
                }
                MouseButton::Middle => {}
            }
        }
        TrayIconEvent::DoubleClick {
            id,
            button: MouseButton::Left,
            ..
        } => {
            if let Ok(tray) = id.0.parse::<u64>() {
                emit(tray, "double-click");
            }
        }
        _ => {}
    }
}

fn has_menu(tray: u64) -> bool {
    TRAYS.with(|t| t.borrow().get(&tray).is_some_and(|t| t.menu.is_some()))
}

/// Shows the tray's context menu at the cursor and reports the choice as `menu.click`. The registry is not borrowed
/// while the menu is open (its modal loop runs other tasks, which may change the tray).
fn show_menu(tray: u64) {
    let Some((menu_id, items)) = TRAYS.with(|t| {
        t.borrow()
            .get(&tray)
            .and_then(|t| t.menu.as_ref().map(|m| (m.menu_id, m.items.clone())))
    }) else {
        return;
    };
    let chosen = match menu::run_popup(menu_id, &items, 0, None) {
        Ok(chosen) => chosen,
        Err(message) => {
            return crate::log::log(
                "tray.menu_failed",
                json!({ "trayId": tray, "error": message }),
            );
        }
    };
    let Some(item_id) = chosen else { return };
    // What the click did to the item's own state, kept for the next showing (when the menu is still the same one).
    let checked = TRAYS.with(|t| {
        let mut trays = t.borrow_mut();
        let current = trays
            .get_mut(&tray)?
            .menu
            .as_mut()
            .filter(|m| m.menu_id == menu_id)?;
        menu_model::activate(&mut current.items, &item_id).flatten()
    });
    let mut data = json!({ "menuId": menu_id, "itemId": item_id });
    if let Some(checked) = checked {
        data["checked"] = json!(checked);
    }
    host::event("menu.click", data);
}
