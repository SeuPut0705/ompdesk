//! The application menu and the text field's context menu (were `src/main/menu.ts`, `editable-context-menu.ts`). The
//! template, the accelerators' chord rule and what each item does are `shell_core::chrome_core::menu`; this file
//! installs the menu (once the words and the accelerators are here, and again on a language change), shows the context
//! menu and carries the actions out through the windows, pages and the quit.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use cef::ImplWindow;
use serde_json::{Value, json};
use shell_core::chrome_core::menu::{
    self as core, Accelerators, Action, ContextAction, ContextParams, Role,
};
use shell_core::labels;
use shell_core::menu_model::{Hit, Item};

use super::{quit, tray, window};
use crate::host::Call;
use crate::log::log;
use crate::modules::Ctx;
use crate::{state, ui};

#[cfg(windows)]
use shell_core::sys::shellops as native_shell;
#[cfg(target_os = "macos")]
use shell_core::sys_mac::shellops as native_shell;

const MAC: bool = cfg!(target_os = "macos");

static CTX: OnceLock<Ctx> = OnceLock::new();
/// Node's `chrome.menu`: the app's name and the chords of `shared/hotkeys.ts`.
static FACTS: Mutex<Option<(String, Accelerators)>> = Mutex::new(None);
static READY: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// The items of the application menu as installed (`chrome.menuProbe` reads them).
    static INSTALLED: RefCell<Vec<Item>> = const { RefCell::new(Vec::new()) };
}

/// The words of `key`; an empty string before Node pushed any (nothing is built then: `install` waits for them).
pub(super) fn text(key: &str, params: &[(&str, &str)]) -> String {
    labels::label(key, params).unwrap_or_default()
}

/// An app window's page asked for a context menu (`params`: Electron's `context-menu` details, PROTOCOL.md §4): shows
/// the editable menu when it has items. Any thread.
pub fn context_menu(win_id: u64, wc_id: u64, params: &Value) {
    let params = ContextParams::from_value(params);
    // Not inside the handler that reported the click: the native menu runs its own loop until it closes.
    ui::post(move || show_context(win_id, wc_id, &params));
}

fn show_context(win_id: u64, wc_id: u64, params: &ContextParams) {
    if labels::language().is_none() {
        return;
    }
    let items = core::context_template(params, &text, MAC);
    if items.is_empty() {
        return;
    }
    match crate::menu::popup_in_window(win_id, &items) {
        Ok(Some(id)) => {
            if let Some(action) = core::context_action(params, &id) {
                run_context(win_id, wc_id, action);
            }
        }
        Ok(None) => {}
        Err(error) => log("menu.context_failed", json!({ "error": error })),
    }
}

fn run_context(win_id: u64, wc_id: u64, action: ContextAction) {
    match action {
        ContextAction::ReplaceMisspelling(word) => {
            wc_op(wc_id, "replaceMisspelling", json!({ "text": word }));
        }
        ContextAction::AddToDictionary(word) => {
            wc_op(wc_id, "addWordToDictionary", json!({ "word": word }));
        }
        ContextAction::CopyImageAt(x, y) => wc_op(wc_id, "copyImageAt", json!({ "x": x, "y": y })),
        ContextAction::Role(role) => run_role(role, Some(win_id), Some(wc_id)),
    }
}

/// A `wc.op` of the shell's own page handler (the same code Node's `webContents` calls reach).
fn wc_op(wc_id: u64, op: &str, args: Value) {
    crate::wc::op(Call::fire(
        "wc.op",
        json!({ "wcId": wc_id, "op": op, "args": args }),
    ));
}

fn win_op(win_id: u64, op: &str, args: Value) {
    crate::window::op(Call::fire(
        "win.op",
        json!({ "winId": win_id, "op": op, "args": args }),
    ));
}

fn zoom_factor(wc_id: u64) -> f64 {
    let factor = state::wc(wc_id).map_or(1.0, |entry| entry.borrow().state.zoom_factor);
    if factor > 0.0 { factor } else { 1.0 }
}

fn devtools_open(wc_id: u64) -> bool {
    state::wc(wc_id).is_some_and(|entry| entry.borrow().state.devtools_opened)
}

fn full_screen(win_id: u64) -> bool {
    state::win(win_id)
        .and_then(|entry| {
            entry
                .borrow()
                .window
                .as_ref()
                .map(|w| w.is_fullscreen() != 0)
        })
        .unwrap_or(false)
}

/// What an Electron role does (`ROLES` of the shim's menu): on the window's page or the window, as the focused window
/// would; nothing when there is none.
fn run_role(role: Role, win_id: Option<u64>, wc_id: Option<u64>) {
    match role {
        Role::Quit => return quit::quit(),
        Role::Minimize => {
            if let Some(win) = win_id {
                win_op(win, "minimize", json!({}));
            }
            return;
        }
        Role::ToggleFullScreen => {
            if let Some(win) = win_id {
                win_op(win, "setFullScreen", json!({ "on": !full_screen(win) }));
            }
            return;
        }
        _ => {}
    }
    let Some(wc) = wc_id else { return };
    match role {
        Role::Undo | Role::Redo | Role::Cut | Role::Copy | Role::Paste | Role::SelectAll => {
            wc_op(wc, role.name(), json!({}));
        }
        Role::Reload => wc_op(wc, "reload", json!({})),
        Role::ForceReload => wc_op(wc, "reloadIgnoringCache", json!({})),
        Role::ToggleDevTools => {
            let op = if devtools_open(wc) {
                "closeDevTools"
            } else {
                "openDevTools"
            };
            wc_op(wc, op, json!({}));
        }
        Role::ResetZoom => wc_op(wc, "setZoomFactor", json!({ "factor": 1 })),
        Role::ZoomIn => {
            let factor = core::zoom_in(zoom_factor(wc));
            wc_op(wc, "setZoomFactor", json!({ "factor": factor }));
        }
        Role::ZoomOut => {
            let factor = core::zoom_out(zoom_factor(wc));
            wc_op(wc, "setZoomFactor", json!({ "factor": factor }));
        }
        Role::Quit | Role::Minimize | Role::ToggleFullScreen => {}
    }
}

/// An item of the page: a `chrome.menuAction` to the target window. With none open (macOS keeps running) a window is
/// opened and the action is delivered once its page loaded, instead of dropping it silently.
fn send_page(action: &str) {
    let Some(ctx) = CTX.get().copied() else {
        return;
    };
    let action = action.to_string();
    match window::target() {
        Some(win) => ctx.emit("menuAction", json!({ "winId": win, "action": action })),
        None => window::spawn(None, move |created| {
            if let Some(win) = created {
                window::when_loaded(win, move || {
                    ctx.emit("menuAction", json!({ "winId": win, "action": action }));
                });
            }
        }),
    }
}

fn show_about() {
    // Windows has no About panel: Electron's `showAboutPanel` does nothing there either.
    #[cfg(target_os = "macos")]
    shell_core::sys_mac::app::show_about_panel();
}

fn open_external(url: &str) {
    if let Err(error) = native_shell::open_external(url) {
        log("shell.open_external_failed", json!({ "error": error }));
    }
}

/// Runs what an application-menu item does (UI thread).
fn run(action: Action) {
    match action {
        Action::Page(page) => send_page(&page),
        // A parallel window in the target window's project (its sidecar keeps running untouched). With no project to
        // inherit, none is asked for: that is the request for the GUI-owned workspace, whereas the process's folder
        // is "/" for an app launched from the Dock.
        Action::NewWindow => window::spawn(window::target().and_then(window::cwd), |_| {}),
        Action::CloseWindow => {
            if let Some(win) = window::target() {
                window::close(win);
            }
        }
        Action::About => show_about(),
        Action::Documentation => open_external(core::DOCUMENTATION_URL),
        Action::Role(role) => {
            let win = window::target();
            run_role(role, win, win.and_then(window::wc_of));
        }
    }
}

/// A choice or an accelerator of the application menu (UI thread).
fn on_hit(hit: Hit) {
    if let Some(action) = core::action_of(&hit.id) {
        run(action);
    }
}

/// Installs the menu for the current words; waits until both they and the accelerators are here.
fn install() {
    let Some((name, accelerators)) = FACTS.lock().unwrap().clone() else {
        return;
    };
    if labels::language().is_none() {
        return;
    }
    let items = core::application_template(MAC, &name, &text, &accelerators);
    match crate::menu::install_application(&items, on_hit) {
        Ok(()) => INSTALLED.with(|installed| *installed.borrow_mut() = items),
        Err(error) => log("menu.install_failed", json!({ "error": error })),
    }
}

/// Node pushed the words again (a language change): the menu is built again from them (reader thread).
fn labels_changed() {
    if READY.load(Ordering::Acquire) {
        ui::post(install);
    }
}

/// `chrome.menuProbe`: what the menu named by `menu` (`application`, `tray`, `context` with `params`) shows now, and
/// with `click` an item's id, what choosing it does. The parity suites' way to look at and press a native menu.
fn probe(call: Call) {
    let menu = call.str("menu").unwrap_or_default();
    let click = call.str("click");
    let params = call.params.get("params").cloned().unwrap_or(Value::Null);
    ui::post(move || {
        let items = match menu.as_str() {
            "application" => INSTALLED.with(|installed| installed.borrow().clone()),
            "tray" => tray::installed(),
            "context" => core::context_template(&ContextParams::from_value(&params), &text, MAC),
            other => return call.err("invalid", format!("chrome.menuProbe: no menu {other}")),
        };
        let wire = core::to_wire(&items);
        if let Some(id) = click {
            match menu.as_str() {
                "application" => match core::action_of(&id) {
                    Some(action) => run(action),
                    None => return call.err("invalid", format!("{id} has no action of its own")),
                },
                "tray" => tray::press(&id),
                _ => return call.err("invalid", "a context menu cannot be pressed"),
            }
        }
        call.ok(json!({ "items": wire }));
    });
}

pub fn request(_ctx: Ctx, call: Call) -> Option<Call> {
    if call.method != "chrome.menuProbe" {
        return Some(call);
    }
    probe(call);
    None
}

pub fn event(_ctx: Ctx, name: &str, data: &Value) -> bool {
    if name != "chrome.menu" {
        return false;
    }
    // The macOS menu bar names the first menu after the app (`app.name`).
    let app_name = data.get("appName").and_then(Value::as_str);
    match app_name.zip(Accelerators::from_value(data)) {
        Some((app_name, accelerators)) => {
            *FACTS.lock().unwrap() = Some((app_name.to_string(), accelerators));
            if READY.load(Ordering::Acquire) {
                ui::post(install);
            }
        }
        None => log("chrome.menu_invalid", json!({ "data": data })),
    }
    true
}

pub fn ready(ctx: Ctx) {
    let _ = CTX.set(ctx);
    labels::on_change(labels_changed);
    READY.store(true, Ordering::Release);
    install();
}

pub fn shutdown(_ctx: Ctx) {}
