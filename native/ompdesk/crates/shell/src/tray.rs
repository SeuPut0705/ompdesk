//! The shell's tray icon (Windows notification area, macOS menu bar) through the `tray-icon` crate, made and driven by
//! `modules/chrome/tray.rs`. The menu is shown by `menu::popup_with`, the native popup, so the menu is a modal loop on
//! the UI thread: what changes meanwhile is the module's to hold back. `tray-icon` delivers its mouse events through one
//! global handler on whatever thread it likes; they hop to the UI thread with `ui::post`. Everything runs on the UI
//! thread.

use std::cell::RefCell;
use std::sync::Once;

use serde_json::json;
use shell_core::menu_model::Item;
use shell_core::tray_image;
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::menu;
use crate::ui;

/// What the tray reports back to its module.
#[derive(Clone, Copy)]
pub struct Listener {
    /// A plain click on the icon (Windows left click; macOS when there is no menu).
    pub click: fn(),
    /// An item of the menu was chosen, by id; the menu has closed.
    pub chosen: fn(&str),
    /// The menu opened (`true`) or closed (`false`).
    pub menu_open: fn(bool),
}

struct Tray {
    icon: TrayIcon,
    menu: Option<Vec<Item>>,
    listener: Listener,
}

thread_local! {
    static TRAY: RefCell<Option<Tray>> = const { RefCell::new(None) };
}

static HANDLER: Once = Once::new();

/// The icon of an image's bytes (PNG or ICO) at the display `scale`.
fn icon_from(bytes: &[u8], scale: f64) -> Result<Icon, String> {
    let image = tray_image::decode_image(bytes, (16.0 * scale).round() as u32)?;
    Icon::from_rgba(image.data, image.width, image.height)
        .map_err(|e| format!("the tray image is unusable: {e}"))
}

/// Makes the tray: `icons` are `(scale factor, image bytes)` (the one closest to the display scale is used),
/// `template` marks a macOS template image. Its menu is set with `set_menu`; clicks and choices go to `listener`.
pub fn create(
    icons: &[(f64, &[u8])],
    template: bool,
    tooltip: &str,
    listener: Listener,
) -> Result<(), String> {
    if exists() {
        return Err("the shell's tray exists".into());
    }
    let scales: Vec<f64> = icons.iter().map(|(scale, _)| *scale).collect();
    let scale = menu::display_scale();
    let index = tray_image::pick(&scales, scale).ok_or("a tray needs an image")?;
    let icon = icon_from(icons[index].1, scale)?;
    ensure_handler();
    let builder = TrayIconBuilder::new().with_icon(icon).with_tooltip(tooltip);
    #[cfg(target_os = "macos")]
    let builder = builder.with_icon_as_template(template);
    #[cfg(not(target_os = "macos"))]
    let _ = template;
    let icon = builder.build().map_err(|e| e.to_string())?;
    TRAY.with(|t| {
        *t.borrow_mut() = Some(Tray {
            icon,
            menu: None,
            listener,
        })
    });
    Ok(())
}

/// The tray exists (never in a headless run).
pub fn exists() -> bool {
    TRAY.with(|t| t.borrow().is_some())
}

pub fn set_tooltip(text: &str) {
    TRAY.with(|t| {
        if let Some(tray) = t.borrow().as_ref()
            && let Err(error) = tray.icon.set_tooltip(Some(text))
        {
            crate::log::log("tray.tooltip_failed", json!({ "error": error.to_string() }));
        }
    });
}

/// Replaces the menu the next click shows. One that is open is not touched (its loop runs on this thread).
pub fn set_menu(items: Vec<Item>) {
    TRAY.with(|t| {
        if let Some(tray) = t.borrow_mut().as_mut() {
            tray.menu = Some(items);
        }
    });
}

/// Removes the tray from the notification area (dropping the `TrayIcon` does it).
pub fn destroy() {
    TRAY.with(|t| t.borrow_mut().take());
}

fn ensure_handler() {
    HANDLER.call_once(|| {
        TrayIconEvent::set_event_handler(Some(|event: TrayIconEvent| {
            ui::post(move || on_event(event))
        }));
    });
}

/// A mouse event of the tray icon. UI thread.
fn on_event(event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button,
        button_state: MouseButtonState::Up,
        ..
    } = event
    else {
        return;
    };
    let Some(listener) = TRAY.with(|t| t.borrow().as_ref().map(|t| t.listener)) else {
        return;
    };
    match button {
        // Windows: a left click is a plain click and never the menu. macOS: the menu-bar item shows its menu on a
        // click, and is a plain click only without one.
        MouseButton::Left => {
            if cfg!(target_os = "macos") && has_menu() {
                show_menu(listener);
            } else {
                (listener.click)();
            }
        }
        MouseButton::Right => {
            if cfg!(windows) {
                show_menu(listener);
            }
        }
        MouseButton::Middle => {}
    }
}

fn has_menu() -> bool {
    TRAY.with(|t| t.borrow().as_ref().is_some_and(|t| t.menu.is_some()))
}

/// Shows the menu at the cursor. The tray is not borrowed while it is open (its loop runs other tasks, which may change
/// the tray).
fn show_menu(listener: Listener) {
    let Some(items) = TRAY.with(|t| t.borrow().as_ref().and_then(|t| t.menu.clone())) else {
        return;
    };
    let chosen = menu::popup_with(
        &items,
        0,
        None,
        || (listener.menu_open)(true),
        || (listener.menu_open)(false),
    );
    match chosen {
        Ok(Some(id)) => (listener.chosen)(&id),
        Ok(None) => {}
        Err(message) => crate::log::log("tray.menu_failed", json!({ "error": message })),
    }
}
