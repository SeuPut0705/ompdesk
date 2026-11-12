//! `win.*` (PROTOCOL.md §3): frameless Views windows holding the app's page and the Preview's views, their state
//! mirror, the close handshake and the Windows caption buttons.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use cef::*;
use serde_json::{Value, json};
use shell_core::color::{self, Rgba};

use crate::host::{self, Call};
use crate::log::log;
use crate::state::{self, Overlay, Role, WinEntry, rect_json, ui_state, win};
use crate::{view, wc};

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

fn num(v: &Value, key: &str) -> Option<i32> {
    v.get(key).and_then(Value::as_f64).map(|n| n.round() as i32)
}

// ------------------------------------------------------------------ state mirror

/// The OS window handle as an integer: Windows' `HWND` is a struct around the pointer, macOS' `NSView*` is the pointer.
fn native_handle(window: &Window) -> isize {
    #[cfg(windows)]
    return window.window_handle().0 as isize;
    #[cfg(not(windows))]
    return window.window_handle() as isize;
}

/// A window that cannot take focus (`setFocusable(false)`) never reports focus.
fn focusable(window: &Window) -> bool {
    #[cfg(windows)]
    return shell_core::sys::winops::is_focusable(native_handle(window));
    #[cfg(not(windows))]
    return {
        let _ = window;
        true
    };
}

fn rect_of(r: &Rect) -> Value {
    rect_json(r.x, r.y, r.width, r.height)
}

/// What `win.state` needs of an entry, copied out so no `RefCell` borrow is held while CEF is called (a CEF call can
/// call a delegate back synchronously).
struct Snap {
    id: u64,
    window: Option<Window>,
    title: String,
    opacity: f64,
    options: Value,
}

fn snap(entry: &WinEntry) -> Snap {
    Snap {
        id: entry.id,
        window: entry.window.clone(),
        title: entry.title.clone(),
        opacity: entry.opacity,
        options: entry.options.clone(),
    }
}

/// `WinState` (+ `winId`) as the window is now.
fn state_json(entry: &Snap) -> Value {
    let size = entry
        .options
        .get("width")
        .and_then(Value::as_i64)
        .unwrap_or(800);
    let Some(window) = &entry.window else {
        let b = rect_json(
            num(&entry.options, "x").unwrap_or(0),
            num(&entry.options, "y").unwrap_or(0),
            size as i32,
            entry
                .options
                .get("height")
                .and_then(Value::as_i64)
                .unwrap_or(600) as i32,
        );
        return json!({
            "winId": entry.id, "bounds": b, "normalBounds": b, "contentBounds": b, "visible": false, "focused": false,
            "minimized": false, "maximized": false, "fullscreen": false, "title": entry.title, "opacity": entry.opacity,
        });
    };
    let minimized = window.is_minimized() != 0;
    let maximized = window.is_maximized() != 0;
    let fullscreen = window.is_fullscreen() != 0;
    let bounds = window.bounds();
    #[cfg(windows)]
    let normal = shell_core::sys::winops::normal_rect(native_handle(window))
        .map(|(x, y, w, h)| rect_json(x, y, w, h));
    #[cfg(not(windows))]
    let normal = None;
    let content = window.client_area_bounds_in_screen();
    json!({
        "winId": entry.id,
        "bounds": rect_of(&bounds),
        "normalBounds": normal.unwrap_or_else(|| rect_of(&bounds)),
        "contentBounds": rect_of(&content),
        "visible": window.is_visible() != 0,
        "focused": window.is_active() != 0 && focusable(window),
        "minimized": minimized,
        "maximized": maximized,
        "fullscreen": fullscreen,
        "title": entry.title,
        "opacity": entry.opacity,
    })
}

/// Pushes `win.state` when it changed, and the `win.event`s the change means.
pub fn push_state(win_id: u64) {
    let Some(entry) = win(win_id) else { return };
    let (snapshot, before) = {
        let e = entry.borrow();
        if e.destroyed {
            return;
        }
        (snap(&e), e.sent_state.clone())
    };
    let now = state_json(&snapshot);
    if before.as_ref() == Some(&now) {
        return;
    }
    entry.borrow_mut().sent_state = Some(now.clone());
    let flags = |v: &Value| {
        (
            v["visible"].as_bool().unwrap_or(false),
            v["focused"].as_bool().unwrap_or(false),
            v["minimized"].as_bool().unwrap_or(false),
            v["maximized"].as_bool().unwrap_or(false),
            v["fullscreen"].as_bool().unwrap_or(false),
        )
    };
    let (v1, f1, mi1, ma1, fs1) = flags(&now);
    let (v0, f0, mi0, ma0, fs0) = before
        .as_ref()
        .map(flags)
        .unwrap_or((false, false, false, false, false));
    host::event("win.state", now.clone());
    let event = |name: &str| {
        host::event(
            "win.event",
            json!({ "winId": win_id, "name": name, "args": [] }),
        )
    };
    if v1 != v0 {
        event(if v1 { "show" } else { "hide" });
    }
    if mi1 != mi0 {
        event(if mi1 { "minimize" } else { "restore" });
    }
    if ma1 != ma0 {
        event(if ma1 { "maximize" } else { "unmaximize" });
    }
    if fs1 != fs0 {
        event(if fs1 {
            "enter-full-screen"
        } else {
            "leave-full-screen"
        });
    }
    if before.is_some() {
        let size = |v: &Value| (v["bounds"]["width"].clone(), v["bounds"]["height"].clone());
        let pos = |v: &Value| (v["bounds"]["x"].clone(), v["bounds"]["y"].clone());
        if let Some(b) = &before {
            if size(b) != size(&now) {
                event("resize");
            }
            if pos(b) != pos(&now) {
                event("move");
            }
        }
    }
    if f1 != f0 {
        event(if f1 { "focus" } else { "blur" });
    }
}

// ------------------------------------------------------------------ layout

fn relayout(win_id: u64, cw: i32, ch: i32) {
    let Some(entry) = win(win_id) else { return };
    let (page, views) = {
        let e = entry.borrow();
        (wc_view(e.wc_id), e.views.clone())
    };
    if let Some(page) = page {
        page.set_bounds(Some(&Rect {
            x: 0,
            y: 0,
            width: cw,
            height: ch,
        }));
    }
    for view_id in views {
        view::apply_bounds(view_id);
    }
}

fn wc_view(wc_id: u64) -> Option<BrowserView> {
    state::wc(wc_id).and_then(|e| e.borrow().view.clone())
}

wrap_panel_delegate! {
    struct ContainerDelegate {
        win_id: u64,
    }
    impl ViewDelegate {
        fn on_layout_changed(&self, _view: Option<&mut View>, new_bounds: Option<&Rect>) {
            if let Some(b) = new_bounds {
                relayout(self.win_id, b.width, b.height);
            }
        }
    }
    impl PanelDelegate {}
}

// ------------------------------------------------------------------ the window delegate

fn caption_colors(overlay: &Overlay, dark_fallback: bool) -> shell_core::sys::caption::Colors {
    let (bg, fg) = if dark_fallback {
        (Rgba(0x21, 0x21, 0x24, 255), Rgba(255, 255, 255, 255))
    } else {
        (Rgba(0xf6, 0xf6, 0xf5, 255), Rgba(0x1c, 0x1c, 0x1f, 255))
    };
    let bg = color::parse_css(&overlay.color).unwrap_or(bg);
    let fg = color::parse_css(&overlay.symbol_color).unwrap_or(fg);
    shell_core::sys::caption::Colors {
        background: bg.colorref(),
        symbol: fg.colorref(),
        hover: bg.blend(fg, 0.12).colorref(),
        height: if overlay.height > 0 {
            overlay.height
        } else {
            48
        },
    }
}

wrap_window_delegate! {
    struct ShellWindowDelegate {
        win_id: u64,
    }
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            let entry = win(self.win_id);
            let (w, h) = entry
                .map(|e| {
                    let e = e.borrow();
                    (num(&e.options, "width").unwrap_or(800), num(&e.options, "height").unwrap_or(600))
                })
                .unwrap_or((800, 600));
            Size { width: w, height: h }
        }

        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            let (w, h) = win(self.win_id).map(|e| e.borrow().min_size).unwrap_or((0, 0));
            Size { width: w, height: h }
        }

        fn maximum_size(&self, _view: Option<&mut View>) -> Size {
            let (w, h) = win(self.win_id).map(|e| e.borrow().max_size).unwrap_or((0, 0));
            Size { width: w, height: h }
        }
    }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { return };
            let win_id = self.win_id;
            let Some(entry) = win(win_id) else { return };
            window.set_to_fill_layout();
            let mut container_delegate = ContainerDelegate::new(win_id);
            let container = panel_create(Some(&mut container_delegate));
            let (page, wc_id) = {
                let e = entry.borrow();
                (wc_view(e.wc_id), e.wc_id)
            };
            if let Some(container) = &container {
                if let Some(page) = page {
                    container.add_child_view(Some(&mut View::from(&page)));
                }
                window.add_child_view(Some(&mut View::from(container)));
            }
            {
                let mut e = entry.borrow_mut();
                e.window = Some(window.clone());
                e.container = container;
            }
            let (has_xy, w, h, title, icon, overlay) = {
                let e = entry.borrow();
                (
                    e.options.get("x").is_some() && e.options.get("y").is_some(),
                    num(&e.options, "width").unwrap_or(800),
                    num(&e.options, "height").unwrap_or(600),
                    e.title.clone(),
                    e.options.get("icon").and_then(Value::as_str).map(String::from),
                    e.overlay.clone(),
                )
            };
            if !has_xy {
                window.center_window(Some(&Size { width: w, height: h }));
            }
            window.set_title(Some(&cs(&title)));
            #[cfg(windows)]
            {
                let hwnd = window.window_handle().0 as isize;
                if let Some(icon) = icon {
                    shell_core::sys::winops::set_icon(hwnd, &icon);
                }
                if let Some(overlay) = overlay {
                    let colors = caption_colors(&overlay, false);
                    let caption = shell_core::sys::caption::attach(hwnd, colors);
                    entry.borrow_mut().caption = caption;
                }
                let material = entry.borrow().options.get("backgroundMaterial").and_then(Value::as_str).map(String::from);
                if material.as_deref() == Some("mica") {
                    shell_core::sys::winops::set_mica(hwnd, true);
                }
            }
            #[cfg(not(windows))]
            let _ = (icon, overlay);
            log("window.created", json!({ "winId": win_id, "wcId": wc_id }));
            #[cfg(target_os = "macos")]
            crate::platform::traffic_lights(window, &entry.borrow().options);
            push_state(win_id);
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            window_destroyed(self.win_id);
        }

        fn on_window_activation_changed(&self, _window: Option<&mut Window>, _active: i32) {
            push_state(self.win_id);
        }

        fn on_window_bounds_changed(&self, window: Option<&mut Window>, _bounds: Option<&Rect>) {
            #[cfg(target_os = "macos")]
            if let (Some(window), Some(e)) = (window, win(self.win_id)) {
                crate::platform::traffic_lights(window, &e.borrow().options);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = window;
            #[cfg(windows)]
            if let Some(e) = win(self.win_id) {
                let caption = e.borrow().caption;
                shell_core::sys::caption::reposition(caption);
            }
            push_state(self.win_id);
        }

        fn on_window_fullscreen_transition(&self, window: Option<&mut Window>, completed: i32) {
            #[cfg(target_os = "macos")]
            if let (Some(window), true, Some(e)) = (window, completed != 0, win(self.win_id)) {
                crate::platform::traffic_lights(window, &e.borrow().options);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, completed);
            push_state(self.win_id);
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let Some(entry) = win(self.win_id) else { return 1 };
            let (approved, pending, exiting) = {
                let e = entry.borrow();
                (e.close_approved, e.close_pending, ui_state(|u| u.exiting))
            };
            if approved || exiting {
                return 1;
            }
            if !pending {
                entry.borrow_mut().close_pending = true;
                ask_close(self.win_id);
            }
            0
        }

        fn initial_bounds(&self, _window: Option<&mut Window>) -> Rect {
            let e = win(self.win_id);
            let (x, y, w, h) = e
                .map(|e| {
                    let e = e.borrow();
                    (num(&e.options, "x").unwrap_or(0), num(&e.options, "y").unwrap_or(0), num(&e.options, "width").unwrap_or(800), num(&e.options, "height").unwrap_or(600))
                })
                .unwrap_or((0, 0, 800, 600));
            Rect { x, y, width: w, height: h }
        }

        fn is_frameless(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn with_standard_window_buttons(&self, _window: Option<&mut Window>) -> i32 {
            i32::from(cfg!(target_os = "macos"))
        }

        fn titlebar_height(&self, _window: Option<&mut Window>, height: Option<&mut f32>) -> i32 {
            // macOS hiddenInset: the traffic lights are centred in this height; 46 puts a 12 px button's top at
            // y = 17 (Electron's trafficLightPosition {x: 18, y: 17}). UNVERIFIED on a Mac.
            if let Some(h) = height {
                *h = 46.0;
            }
            i32::from(cfg!(target_os = "macos"))
        }

        fn can_resize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn window_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

/// The person closed the window: Node's `close` listeners decide (5 s, then the window closes).
fn ask_close(win_id: u64) {
    host::request(
        "win.closeRequested",
        json!({ "winId": win_id }),
        None,
        move |answer, _| {
            let prevent = answer
                .ok()
                .and_then(|v| v.get("prevent").and_then(Value::as_bool))
                .unwrap_or(false);
            crate::ui::post(move || {
                let Some(entry) = win(win_id) else { return };
                entry.borrow_mut().close_pending = false;
                if prevent {
                    return;
                }
                close_approved(win_id);
            });
        },
    );
    // No answer within 5 s counts as not prevented.
    crate::ui::post_delayed(Duration::from_secs(5).as_millis() as i64, move || {
        let Some(entry) = win(win_id) else { return };
        let pending = entry.borrow().close_pending;
        if pending {
            entry.borrow_mut().close_pending = false;
            close_approved(win_id);
        }
    });
}

/// Closes a window whose `close` listeners ran: its views' browsers first, then the window.
pub fn close_approved(win_id: u64) {
    let Some(entry) = win(win_id) else { return };
    let (window, views, wc_id, offscreen) = {
        let mut e = entry.borrow_mut();
        e.close_approved = true;
        (e.window.clone(), e.views.clone(), e.wc_id, e.offscreen)
    };
    for view_id in views {
        if let Some(v) = state::view(view_id) {
            wc::close(v.borrow().wc_id);
        }
    }
    if offscreen {
        wc::close(wc_id);
        window_destroyed(win_id);
        return;
    }
    if let Some(window) = window {
        window.close();
    }
}

fn window_destroyed(win_id: u64) {
    let Some(entry) = ui_state(|u| u.windows.remove(&win_id)) else {
        return;
    };
    let (caption, wc_id) = {
        let mut e = entry.borrow_mut();
        e.destroyed = true;
        (e.caption, e.wc_id)
    };
    #[cfg(windows)]
    shell_core::sys::caption::destroy(caption);
    #[cfg(not(windows))]
    let _ = caption;
    // The page and the views close with the window (Views destroys their browsers; the page entry may linger).
    let views = std::mem::take(&mut entry.borrow_mut().views);
    for view_id in views {
        if let Some(v) = ui_state(|u| u.views.remove(&view_id)) {
            wc::close(v.borrow().wc_id);
        }
    }
    wc::close(wc_id);
    host::event(
        "win.event",
        json!({ "winId": win_id, "name": "closed", "args": [] }),
    );
}

#[cfg(windows)]
fn on_caption_click(top: isize, action: &'static str) {
    crate::ui::post(move || {
        if let Some(win_id) = state::win_by_handle(top) {
            window_action(win_id, action);
        }
    });
}

#[cfg(windows)]
pub fn init_caption() {
    shell_core::sys::caption::set_action_handler(on_caption_click);
}

#[cfg(not(windows))]
pub fn init_caption() {}

fn window_action(win_id: u64, action: &str) {
    let Some(entry) = win(win_id) else { return };
    let Some(window) = entry.borrow().window.clone() else {
        return;
    };
    match action {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized() != 0 {
                window.restore()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        _ => {}
    }
    schedule_state(win_id);
}

/// A window's state settles a moment after a change (minimize animations): push now and twice after.
fn schedule_state(win_id: u64) {
    push_state(win_id);
    for ms in [60, 250] {
        crate::ui::post_delayed(ms, move || push_state(win_id));
    }
}

// ------------------------------------------------------------------ hooks from pages

pub fn page_title_changed(wc_id: u64, title: &str) {
    let found = ui_state(|u| {
        u.windows
            .values()
            .find(|w| w.borrow().wc_id == wc_id)
            .cloned()
    });
    if let Some(entry) = found {
        let window = {
            let mut e = entry.borrow_mut();
            e.title = title.to_string();
            e.window.clone()
        };
        if let Some(window) = window {
            window.set_title(Some(&cs(title)));
        }
        let id = entry.borrow().id;
        push_state(id);
    }
}

pub fn page_first_load(wc_id: u64) {
    let found = ui_state(|u| {
        u.windows
            .values()
            .find(|w| w.borrow().wc_id == wc_id)
            .map(|w| w.borrow().id)
    });
    if let Some(win_id) = found {
        host::event(
            "win.event",
            json!({ "winId": win_id, "name": "ready-to-show", "args": [] }),
        );
    }
}

pub fn page_destroyed(_wc_id: u64) {}

pub fn set_draggable_regions(wc_id: u64, regions: Option<&[DraggableRegion]>) {
    let found = ui_state(|u| {
        u.windows
            .values()
            .find(|w| w.borrow().wc_id == wc_id)
            .cloned()
    });
    if let Some(window) = found.and_then(|e| e.borrow().window.clone()) {
        window.set_draggable_regions(regions);
    }
}

// ------------------------------------------------------------------ win.create / win.op

/// `win.create` (UI thread). Node assigns the ids; a missing one is taken from the shell's counters.
pub fn create(call: Call) {
    let win_id = call
        .params
        .get("winId")
        .and_then(Value::as_u64)
        .unwrap_or_else(state::next_win_id);
    let wc_id = call
        .params
        .get("wcId")
        .and_then(Value::as_u64)
        .unwrap_or_else(state::next_wc_id);
    let options = call
        .params
        .get("options")
        .cloned()
        .unwrap_or_else(|| json!({}));
    crate::ui::run(move || create_on_ui(call, win_id, wc_id, options));
}

fn create_on_ui(call: Call, win_id: u64, wc_id: u64, options: Value) {
    let prefs = options
        .get("webPreferences")
        .cloned()
        .unwrap_or(Value::Null);
    let partition = prefs
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or("app")
        .to_string();
    let offscreen = prefs
        .get("offscreen")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut entry = WinEntry::new(win_id, wc_id, options.clone());
    entry.offscreen = offscreen;
    entry.min_size = (
        num(&options, "minWidth").unwrap_or(0),
        num(&options, "minHeight").unwrap_or(0),
    );
    if let Some(overlay) = options.get("titleBarOverlay").filter(|o| o.is_object()) {
        entry.overlay = Some(Overlay {
            color: overlay
                .get("color")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            symbol_color: overlay
                .get("symbolColor")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            height: num(overlay, "height").unwrap_or(48),
        });
    }
    let entry = Rc::new(RefCell::new(entry));
    ui_state(|u| u.windows.insert(win_id, entry.clone()));
    if offscreen {
        let (w, h) = (
            num(&options, "width").unwrap_or(1280),
            num(&options, "height").unwrap_or(720),
        );
        if !wc::create_offscreen(wc_id, &partition, w, h) {
            ui_state(|u| u.windows.remove(&win_id));
            return call.err("failed", "CEF could not create an offscreen browser");
        }
        let state = state_json(&snap(&entry.borrow()));
        return call.ok(json!({ "winId": win_id, "wcId": wc_id, "state": state }));
    }
    let Some(_page) = wc::create_view(wc_id, Role::Page, &partition) else {
        ui_state(|u| u.windows.remove(&win_id));
        return call.err("failed", "CEF could not create the page");
    };
    if let Some(w) = state::wc(wc_id) {
        w.borrow_mut().win_id = Some(win_id);
    }
    let mut delegate = ShellWindowDelegate::new(win_id);
    window_create_top_level(Some(&mut delegate));
    let state = state_json(&snap(&entry.borrow()));
    call.ok(json!({ "winId": win_id, "wcId": wc_id, "state": state }));
}

fn parse_rect(v: &Value) -> Option<Rect> {
    Some(Rect {
        x: num(v, "x")?,
        y: num(v, "y")?,
        width: num(v, "width")?,
        height: num(v, "height")?,
    })
}

/// `win.op` (UI thread).
pub fn op(call: Call) {
    let Some(win_id) = call.params.get("winId").and_then(Value::as_u64) else {
        return call.err("invalid", "winId is missing");
    };
    let name = call.str("op").unwrap_or_default();
    let args = call.params.get("args").cloned().unwrap_or(Value::Null);
    crate::ui::run(move || run_op(call, win_id, &name, &args));
}

fn run_op(call: Call, win_id: u64, name: &str, args: &Value) {
    let Some(entry) = win(win_id) else {
        return call.err("gone", format!("no window {win_id}"));
    };
    let (window, offscreen, wc_id) = {
        let e = entry.borrow();
        (e.window.clone(), e.offscreen, e.wc_id)
    };
    #[cfg(windows)]
    let hwnd = window.as_ref().map(native_handle).unwrap_or(0);
    // An offscreen window has no OS window: only what makes sense for a page.
    if offscreen {
        return match name {
            "setContentSize" | "setSize" => {
                let (w, h) = (
                    num(args, "width").unwrap_or(1280),
                    num(args, "height").unwrap_or(720),
                );
                if let Some(page) = state::wc(wc_id) {
                    page.borrow_mut().view_size = (w, h);
                    if let Some(host) = page.borrow().browser.as_ref().and_then(|b| b.host()) {
                        host.was_resized();
                    }
                }
                call.ok(json!({}))
            }
            "close" | "destroy" => {
                close_approved(win_id);
                call.ok(json!({}))
            }
            _ => call.ok(json!({})),
        };
    }
    let Some(window) = window else {
        // Created but the OS window is not there yet (Views creates it a moment later): run again shortly.
        return crate::ui::post_delayed(20, move || ui_retry(call, win_id, 1));
    };
    match name {
        "show" => {
            // A window that cannot take focus (the e2e harness's) is shown without activation too.
            #[cfg(windows)]
            if !shell_core::sys::winops::is_focusable(hwnd) {
                window.show();
            } else {
                window.show();
                window.activate();
                window.bring_to_top();
            }
            #[cfg(not(windows))]
            {
                window.show();
                window.activate();
                window.bring_to_top();
            }
        }
        "showInactive" => {
            // Views' own `show` activates; with WS_EX_NOACTIVATE held for the call it does not, and Views still
            // records the window as visible.
            #[cfg(windows)]
            {
                let was = shell_core::sys::winops::is_focusable(hwnd);
                shell_core::sys::winops::set_focusable(hwnd, false);
                window.show();
                shell_core::sys::winops::set_focusable(hwnd, was);
            }
            #[cfg(not(windows))]
            window.show();
        }
        "hide" => window.hide(),
        "close" => {
            let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
            if force {
                entry.borrow_mut().close_approved = true;
            }
            window.close();
        }
        "destroy" => close_approved(win_id),
        "focus" => {
            window.activate();
            window.bring_to_top();
        }
        "blur" => window.deactivate(),
        "minimize" => window.minimize(),
        "maximize" => window.maximize(),
        "unmaximize" | "restore" => window.restore(),
        "setFullScreen" => window.set_fullscreen(i32::from(
            args.get("on").and_then(Value::as_bool).unwrap_or(false),
        )),
        "setBounds" => {
            if let Some(r) = args.get("bounds").and_then(parse_rect) {
                window.set_bounds(Some(&r));
            }
        }
        "setSize" | "setContentSize" => {
            let b = window.bounds();
            let (w, h) = (
                num(args, "width").unwrap_or(b.width),
                num(args, "height").unwrap_or(b.height),
            );
            window.set_bounds(Some(&Rect {
                x: b.x,
                y: b.y,
                width: w,
                height: h,
            }));
        }
        "setPosition" => {
            let b = window.bounds();
            window.set_bounds(Some(&Rect {
                x: num(args, "x").unwrap_or(b.x),
                y: num(args, "y").unwrap_or(b.y),
                width: b.width,
                height: b.height,
            }));
        }
        "center" => {
            let b = window.bounds();
            window.center_window(Some(&Size {
                width: b.width,
                height: b.height,
            }));
        }
        "setMinimumSize" => {
            entry.borrow_mut().min_size = (
                num(args, "width").unwrap_or(0),
                num(args, "height").unwrap_or(0),
            );
            window.invalidate_layout();
        }
        "setMaximumSize" => {
            entry.borrow_mut().max_size = (
                num(args, "width").unwrap_or(0),
                num(args, "height").unwrap_or(0),
            );
            window.invalidate_layout();
        }
        "setTitle" => {
            let title = args
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            window.set_title(Some(&cs(&title)));
            entry.borrow_mut().title = title;
        }
        "setAlwaysOnTop" => window.set_always_on_top(i32::from(
            args.get("flag").and_then(Value::as_bool).unwrap_or(false),
        )),
        "setBackgroundColor" => {
            if let Some(c) = args
                .get("color")
                .and_then(Value::as_str)
                .and_then(color::parse_css)
            {
                if let Some(page) = wc_view(wc_id) {
                    page.set_background_color(c.argb());
                }
            }
        }
        "setTitleBarOverlay" => {
            let overlay = Overlay {
                color: args
                    .get("color")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                symbol_color: args
                    .get("symbolColor")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                height: num(args, "height").unwrap_or(48),
            };
            #[cfg(windows)]
            {
                let caption = entry.borrow().caption;
                if caption != 0 {
                    shell_core::sys::caption::set_colors(caption, caption_colors(&overlay, false));
                }
            }
            entry.borrow_mut().overlay = Some(overlay);
        }
        "setMenuBarVisibility"
        | "setAutoHideMenuBar"
        | "setBackgroundMaterial"
        | "setProgressBar" => {}
        #[cfg(windows)]
        "setOpacity" => {
            let value = args.get("value").and_then(Value::as_f64).unwrap_or(1.0);
            shell_core::sys::winops::set_opacity(hwnd, value);
            entry.borrow_mut().opacity = value;
        }
        #[cfg(windows)]
        "setIgnoreMouseEvents" => shell_core::sys::winops::set_ignore_mouse(
            hwnd,
            args.get("ignore").and_then(Value::as_bool).unwrap_or(false),
        ),
        #[cfg(windows)]
        "setSkipTaskbar" => shell_core::sys::winops::set_skip_taskbar(
            hwnd,
            args.get("skip").and_then(Value::as_bool).unwrap_or(false),
        ),
        #[cfg(windows)]
        "setFocusable" => shell_core::sys::winops::set_focusable(
            hwnd,
            args.get("focusable")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        ),
        #[cfg(windows)]
        "setIcon" => {
            if let Some(path) = args.get("path").and_then(Value::as_str) {
                shell_core::sys::winops::set_icon(hwnd, path);
            }
        }
        #[cfg(target_os = "macos")]
        "setOpacity" | "setIgnoreMouseEvents" | "setSkipTaskbar" | "setFocusable" | "setIcon" => {
            crate::platform::window_op(&window, name, args)
        }
        other => {
            return call.err(
                "unsupported",
                format!("win.op {other} is not implemented by this shell"),
            );
        }
    }
    schedule_state(win_id);
    call.ok(json!({}));
}

/// The OS window is created a moment after `win.create` returns (Views makes it on its own turn): an op that
/// arrives before waits for it, at most 1.2 s.
fn ui_retry(call: Call, win_id: u64, attempt: u32) {
    let name = call.str("op").unwrap_or_default();
    let args = call.params.get("args").cloned().unwrap_or(Value::Null);
    let ready = win(win_id)
        .map(|e| e.borrow().window.is_some())
        .unwrap_or(true);
    if !ready && attempt < 40 {
        return crate::ui::post_delayed(30, move || ui_retry(call, win_id, attempt + 1));
    }
    if !ready {
        return call.err("failed", format!("window {win_id} was never created"));
    }
    run_op(call, win_id, &name, &args);
}

/// Every open window's views and pages are closed and the windows with them: the quit path (`app.exit`).
pub fn close_all_for_exit() {
    let ids: Vec<u64> = ui_state(|u| u.windows.keys().copied().collect());
    for id in ids {
        close_approved(id);
    }
}
