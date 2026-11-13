//! The system tray (was `src/main/tray.ts`): Open/Hide, one update item that follows the updater, Quit. The rules and
//! the state machine are `shell_core::chrome_core::tray`; this file owns the icon (`crate::tray`), reads the world the
//! model needs (the words, the target window, the clock) and carries its effects out. Node's `chrome.tray` post brings
//! the renderer's snapshot and the updater's status; a click on the update item goes back as `chrome.updateAction`.

use std::cell::{Cell, RefCell};
use std::sync::OnceLock;
use std::time::Instant;

use serde_json::{Value, json};
use shell_core::chrome_core::tray::{
    self as core, Effects, Env, ITEM_QUIT, ITEM_TOGGLE, ITEM_UPDATE, Model, Toggle, TrayState,
};
use shell_core::labels;
use shell_core::menu_model::Item;

use super::menu::text;
use super::{quit, window};
use crate::host::Call;
use crate::modules::Ctx;
use crate::tray::{self, Listener};
use crate::ui;

// The OMPdesk mark, rasterized by scripts/gen-icons.ts. macOS status items use the monochrome template (the system
// tints it for light/dark and selected menu-bar states); Windows gets the full-colour tile, which stays visible on
// light and dark taskbars. The run status is text (the tooltip): painting it here would turn the mark into a noisy
// status dot.
// `OMPDESK_BRAND_DIR` is the absolute `resources/brand` (build.rs): the crate builds from a `subst` drive on Windows,
// where a path relative to it cannot climb out of the crate.
#[cfg(target_os = "macos")]
const ICON_1X: &[u8] = include_bytes!(concat!(env!("OMPDESK_BRAND_DIR"), "/trayTemplate.png"));
#[cfg(target_os = "macos")]
const ICON_2X: &[u8] = include_bytes!(concat!(env!("OMPDESK_BRAND_DIR"), "/trayTemplate@2x.png"));
#[cfg(not(target_os = "macos"))]
const ICON_1X: &[u8] = include_bytes!(concat!(env!("OMPDESK_BRAND_DIR"), "/tray.png"));
#[cfg(not(target_os = "macos"))]
const ICON_2X: &[u8] = include_bytes!(concat!(env!("OMPDESK_BRAND_DIR"), "/tray@2x.png"));

static CTX: OnceLock<Ctx> = OnceLock::new();
static CLOCK: OnceLock<Instant> = OnceLock::new();

thread_local! {
    static MODEL: RefCell<Model> = RefCell::new(Model::default());
    /// The menu as installed (the native tray shows it; `chrome.menuProbe` reads it with or without a native tray).
    static INSTALLED: RefCell<Vec<Item>> = const { RefCell::new(Vec::new()) };
    /// The model made its first menu (it waits for the words).
    static STARTED: Cell<bool> = const { Cell::new(false) };
    /// The model is in use: the module is ready and has not shut down.
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
}

/// The shell's tray exists (never in a headless run): a hidden window can come back from it. UI thread.
pub fn exists() -> bool {
    tray::exists()
}

/// The menu as installed now. UI thread.
pub(super) fn installed() -> Vec<Item> {
    INSTALLED.with(|items| items.borrow().clone())
}

fn now_ms() -> u64 {
    CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Runs `f` with the model and what it reads from the world.
fn with_env<R>(f: impl FnOnce(&mut Model, &Env) -> R) -> R {
    let window_visible = window::target().is_some_and(window::is_visible);
    let lang = labels::language().unwrap_or_default();
    let env = Env {
        lang: &lang,
        text: &text,
        window_visible,
        now_ms: now_ms(),
    };
    MODEL.with(|model| f(&mut model.borrow_mut(), &env))
}

fn apply(effects: Effects) {
    if let Some(tooltip) = effects.tooltip
        && exists()
    {
        tray::set_tooltip(&tooltip);
    }
    if let Some(items) = effects.menu {
        INSTALLED.with(|installed| installed.borrow_mut().clone_from(&items));
        if exists() {
            tray::set_menu(items);
        }
    }
    if let Some((generation, delay_ms)) = effects.timer {
        ui::post_delayed(delay_ms as i64, move || timer_fired(generation));
    }
}

/// Makes the first menu once the words are here.
fn start() {
    if STARTED.with(Cell::get) || labels::language().is_none() {
        return;
    }
    STARTED.with(|s| s.set(true));
    apply(with_env(|model, env| model.create(env)));
}

fn timer_fired(generation: u64) {
    if STARTED.with(Cell::get) {
        apply(with_env(|model, env| model.timer_fired(generation, env)));
    }
}

/// A window was shown, hidden, minimized, restored or closed (the Open/Hide label follows it).
fn windows_changed() {
    if STARTED.with(Cell::get) {
        apply(with_env(|model, env| model.refresh(env)));
    }
}

/// The words arrived or changed (reader thread).
fn labels_changed() {
    ui::post(|| {
        if !ACTIVE.with(Cell::get) {
            return;
        }
        if STARTED.with(Cell::get) {
            apply(with_env(|model, env| model.relabel(env)));
        } else {
            start();
        }
    });
}

fn do_toggle(what: Toggle) {
    match (what, window::target()) {
        (Toggle::Hide, Some(win)) => window::hide(win),
        (Toggle::Show, Some(win)) => window::show(win),
        _ => window::spawn(None, |_| {}),
    }
}

/// A click on an item of the tray menu (UI thread).
pub(super) fn press(id: &str) {
    match id {
        ITEM_TOGGLE => do_toggle(core::toggle(window::target().map(window::is_visible))),
        ITEM_UPDATE => {
            let action = MODEL.with(|model| model.borrow().installed_action());
            if let (Some(action), Some(ctx)) = (action, CTX.get()) {
                ctx.emit("updateAction", json!({ "action": action.wire() }));
            }
        }
        ITEM_QUIT => quit::quit(),
        _ => {}
    }
}

fn on_click() {
    do_toggle(core::click(window::target().is_some()));
}

fn on_menu_open(open: bool) {
    if open {
        MODEL.with(|model| model.borrow_mut().menu_opened());
    } else {
        apply(with_env(|model, env| model.menu_closed(env)));
    }
}

pub fn request(_ctx: Ctx, call: Call) -> Option<Call> {
    Some(call)
}

/// `chrome.tray {state?, update?}`: the renderer's snapshot (`null`: none) and/or the updater's status changed.
pub fn event(_ctx: Ctx, name: &str, data: &Value) -> bool {
    if name != "chrome.tray" {
        return false;
    }
    let state = data.get("state").map(TrayState::from_value);
    let update = data.get("update").cloned();
    ui::post(move || {
        let started = STARTED.with(Cell::get);
        if let Some(state) = state {
            let effects = with_env(|model, env| model.set_state(state, env));
            if started {
                apply(effects);
            }
        }
        if let Some(update) = update {
            let effects = with_env(|model, env| model.set_update(update, env));
            if started {
                apply(effects);
            }
        }
    });
    true
}

pub fn ready(ctx: Ctx) {
    let _ = CTX.set(ctx);
    ACTIVE.with(|a| a.set(true));
    // A headless run (the e2e) makes no tray: the menu bar is shared with the user's own OMPdesk, and a test's status
    // item once stalled this process's UI thread (MenuBarAgent never completed its scene).
    if std::env::var("OMP_GUI_HEADLESS").as_deref() != Ok("1") {
        let listener = Listener {
            click: on_click,
            chosen: press,
            menu_open: on_menu_open,
        };
        let made = tray::create(
            &[(1.0, ICON_1X), (2.0, ICON_2X)],
            cfg!(target_os = "macos"),
            "OMPdesk",
            listener,
        );
        if let Err(error) = made {
            crate::log::log("tray.create_failed", json!({ "error": error }));
        }
    }
    window::on_change(windows_changed);
    labels::on_change(labels_changed);
    start();
}

pub fn shutdown(_ctx: Ctx) {
    ACTIVE.with(|a| a.set(false));
    STARTED.with(|s| s.set(false));
    tray::destroy();
    MODEL.with(|model| model.borrow_mut().reset());
    INSTALLED.with(|items| items.borrow_mut().clear());
}
