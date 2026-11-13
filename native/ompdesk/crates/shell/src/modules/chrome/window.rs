//! The app windows (was `src/main/window.ts`): the shell makes every app window (ids from `state.rs`, 2^32 up), the
//! shim adopts it (`win.adopted`, PROTOCOL.md §15.4 rule 4), and this area owns its life: geometry, chrome, first
//! show, close to tray, crash recovery, the editable context menu, links and the run progress. The other chrome areas
//! use the `pub` functions (UI thread unless a function says otherwise). Rules: `shell_core::chrome_core::window`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use shell_core::chrome_core::window::{
    self as rules, Failure, Identity, LastClose, OpenFacts, Platform, Rect,
};
use shell_core::labels::label;

use super::{gpu, menu, quit, tray};
use cef::{ImplView, ImplWindow};

use crate::host::Call;
use crate::modules::Ctx;
use crate::state;

struct Record {
    wc_id: u64,
    cwd: String,
    slot: u32,
    presence: Option<String>,
    /// The first show happened (`ready-to-show` or the first load, whichever came first).
    shown: bool,
    /// The page finished loading and has not started another load since.
    loaded: bool,
    waiting: Vec<Box<dyn FnOnce()>>,
    /// Pages composite in software: the page marks itself still after every load.
    software: bool,
    last_recovery_at: f64,
    crash_offered: bool,
}

thread_local! {
    /// The app windows by id: ids grow, so the map's order is the windows' age.
    static RECORDS: RefCell<BTreeMap<u64, Record>> = const { RefCell::new(BTreeMap::new()) };
    static LISTENERS: RefCell<Vec<fn()>> = const { RefCell::new(Vec::new()) };
}

static CTX: OnceLock<Ctx> = OnceLock::new();
/// Settings › General › Window: only an explicit `false` turns it off (`closeToTrayEnabled`).
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
/// The renderer entry's identity when this run started (packaged runs: an update replaces it).
static LAUNCH_IDENTITY: OnceLock<Option<Identity>> = OnceLock::new();
/// One restart prompt per run, even when declined: stale resources keep failing.
static RESTART_SCHEDULED: AtomicBool = AtomicBool::new(false);

fn ctx() -> Option<Ctx> {
    CTX.get().copied()
}

fn headless() -> bool {
    std::env::var("OMP_GUI_HEADLESS").as_deref() == Ok("1")
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn win_op(win_id: u64, op: &str, args: Value) {
    crate::window::op(Call::fire(
        "win.op",
        json!({ "winId": win_id, "op": op, "args": args }),
    ));
}

fn wc_op(wc_id: u64, op: &str, args: Value) {
    crate::wc::op(Call::fire(
        "wc.op",
        json!({ "wcId": wc_id, "op": op, "args": args }),
    ));
}

fn cef_window(win_id: u64) -> Option<cef::Window> {
    state::win(win_id).and_then(|e| e.borrow().window.clone())
}

fn page_url_now(wc_id: u64) -> String {
    state::wc(wc_id)
        .map(|w| w.borrow().state.url.clone())
        .unwrap_or_default()
}

fn notify_change() {
    let listeners = LISTENERS.with(|l| l.borrow().clone());
    for listener in listeners {
        listener();
    }
}

// ------------------------------------------------------------------ the other areas' API

/// The live app windows, oldest first.
pub fn app_windows() -> Vec<u64> {
    RECORDS.with(|r| r.borrow().keys().copied().collect())
}

/// An app window (the close and the page hooks of `crate::window` and `crate::wc` ask).
pub fn owns(win_id: u64) -> bool {
    RECORDS.with(|r| r.borrow().contains_key(&win_id))
}

fn window_of_page(wc_id: u64) -> Option<u64> {
    RECORDS.with(|r| {
        r.borrow()
            .iter()
            .find(|(_, record)| record.wc_id == wc_id)
            .map(|(id, _)| *id)
    })
}

/// An app window's page. UI thread; false elsewhere.
pub fn owns_page(wc_id: u64) -> bool {
    crate::ui::on_ui_thread() && window_of_page(wc_id).is_some()
}

/// The window user actions go to: the focused app window, else the oldest (`getTargetWindow`).
pub fn target() -> Option<u64> {
    let windows = app_windows();
    windows
        .iter()
        .copied()
        .find(|id| cef_window(*id).is_some_and(|w| w.is_active() != 0))
        .or_else(|| windows.first().copied())
}

/// Shown and not minimized (`isVisible`).
pub fn is_visible(win_id: u64) -> bool {
    cef_window(win_id).is_some_and(|w| w.is_visible() != 0 && w.is_minimized() == 0)
}

/// Restores a minimized window, shows and focuses it (a hidden-to-tray window comes back too: on Windows a focus alone
/// does nothing for a hidden window).
pub fn show(win_id: u64) {
    if cef_window(win_id).is_some_and(|w| w.is_minimized() != 0) {
        win_op(win_id, "restore", json!({}));
    }
    win_op(win_id, "show", json!({}));
    win_op(win_id, "focus", json!({}));
}

pub fn hide(win_id: u64) {
    win_op(win_id, "hide", json!({}));
}

/// Closes the window as the person would (the close rules apply: close to tray, the quit).
pub fn close(win_id: u64) {
    if let Some(window) = cef_window(win_id) {
        window.close();
    }
}

/// The window's project folder (`chrome.cwd` keeps it current).
pub fn cwd(win_id: u64) -> Option<String> {
    RECORDS.with(|r| r.borrow().get(&win_id).map(|record| record.cwd.clone()))
}

/// The window's page.
pub fn wc_of(win_id: u64) -> Option<u64> {
    RECORDS.with(|r| r.borrow().get(&win_id).map(|record| record.wc_id))
}

/// Runs `f` once the window's page finished loading: now when it has, else after its next `did-finish-load`. Dropped
/// when the window closes first.
pub fn when_loaded(win_id: u64, f: impl FnOnce() + 'static) {
    let f: Box<dyn FnOnce()> = Box::new(f);
    let ready = RECORDS.with(|r| {
        let mut records = r.borrow_mut();
        let record = records.get_mut(&win_id)?;
        let loading = state::wc(record.wc_id).is_some_and(|w| w.borrow().state.loading);
        if record.loaded && !loading {
            return Some(f);
        }
        record.waiting.push(f);
        None
    });
    // Run outside the borrow: `f` may open or close windows.
    if let Some(f) = ready {
        f();
    }
}

/// Asks Node for a window with its tab (`chrome.spawn`; `cwd` None: the saved layout or the default workspace).
/// `then` runs on the UI thread with the new window, or None (a quit is underway, the tab could not start). Any thread.
pub fn spawn(cwd: Option<String>, then: impl FnOnce(Option<u64>) + Send + 'static) {
    let Some(ctx) = ctx() else {
        return crate::ui::post(move || then(None));
    };
    let params = match &cwd {
        Some(cwd) => json!({ "cwd": cwd }),
        None => json!({}),
    };
    ctx.ask("spawn", params, None, move |answer, _| {
        let win_id = match answer {
            Ok(value) => value.get("winId").and_then(Value::as_u64),
            Err(error) => {
                crate::log::log("chrome.spawn_failed", json!({ "error": error.message }));
                None
            }
        };
        crate::ui::post(move || then(win_id.filter(|id| owns(*id))));
    });
}

/// Calls `f` on the UI thread after any app window was shown, hidden, minimized, restored or closed.
pub fn on_change(f: fn()) {
    LISTENERS.with(|l| l.borrow_mut().push(f));
}

// ------------------------------------------------------------------ hooks from `crate::window` and `crate::wc`

/// `push_state` saw an app window shown, hidden, minimized or restored.
pub fn changed(win_id: u64) {
    if owns(win_id) {
        notify_change();
    }
}

/// An app window's OS window is gone (after `win.event closed` went to Node).
pub fn destroyed(win_id: u64) {
    let removed = RECORDS.with(|r| r.borrow_mut().remove(&win_id));
    if removed.is_some() {
        notify_change();
    }
}

/// An app window is closing (UI thread, from Views' `can_close`): the geometry is saved on every close; one nobody
/// approved yet (the person's) is decided here. True: let it close.
pub fn can_close(win_id: u64, approved: bool) -> bool {
    persist(win_id);
    if approved {
        return true;
    }
    let other_visible = app_windows()
        .into_iter()
        .any(|other| other != win_id && is_visible(other));
    let close_to_tray = tray::exists() && CLOSE_TO_TRAY.load(Ordering::Relaxed);
    let last = rules::last_window_close(Platform::current(), quit::approved(), close_to_tray);
    match rules::on_close(other_visible, last) {
        LastClose::Close => true,
        LastClose::Hide => {
            hide(win_id);
            if let Some(ctx) = ctx() {
                ctx.emit("hiddenToTray", json!({ "winId": win_id }));
            }
            false
        }
        // The quit asks first; an approved quit then closes every window, this one included.
        LastClose::Quit => {
            quit::quit();
            false
        }
    }
}

/// A popup an app window's page asked for: http(s) opens in the system browser, nothing else opens anywhere (OSC 8
/// anchors and `target=_blank` must not launch arbitrary protocols).
pub fn window_open(url: &str) {
    let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
    if url.contains("://") && (scheme == "http" || scheme == "https") {
        crate::shellops::handle(Call::fire("shell.openExternal", json!({ "url": url })));
    }
}

/// A page event (`crate::wc::emit`); an app window's page is this area's to watch. Any thread.
pub fn page_event(wc_id: u64, name: &str, args: &Value) {
    if !matches!(
        name,
        "did-start-loading"
            | "dom-ready"
            | "did-finish-load"
            | "did-fail-load"
            | "preload-error"
            | "render-process-gone"
            | "unresponsive"
            | "console-message"
            | "context-menu"
    ) {
        return;
    }
    let (name, args) = (name.to_string(), args.clone());
    crate::ui::run(move || {
        if let Some(win_id) = window_of_page(wc_id) {
            on_page_event(win_id, wc_id, &name, &args);
        }
    });
}

// ------------------------------------------------------------------ the page's life

fn on_page_event(win_id: u64, wc_id: u64, name: &str, args: &Value) {
    match name {
        "did-start-loading" => {
            with_record(win_id, |r| r.loaded = false);
        }
        "dom-ready" if with_record(win_id, |r| r.software).unwrap_or(false) => {
            mark_software(wc_id);
        }
        "did-finish-load" => finished_load(win_id),
        "did-fail-load" => {
            let code = args[0].as_i64().unwrap_or(0);
            let main = args[3].as_bool().unwrap_or(false);
            if code == -3 {
                return;
            }
            if restart_for_changed_resources(
                win_id,
                &Failure::LoadFailure { main_frame: main },
                "load-failure",
            ) {
                return;
            }
            if !main {
                return;
            }
            log(
                win_id,
                json!({
                    "source": "renderer-load",
                    "message": format!("Renderer failed to load: {}", args[1].as_str().unwrap_or("")),
                    "url": args[2],
                    "details": { "errorCode": code, "frameProcessId": args[4], "frameRoutingId": args[5] },
                }),
            );
        }
        "preload-error" => log(
            win_id,
            json!({
                "source": "preload",
                "message": args[1]["message"],
                "stack": args[1]["stack"],
                "url": args[0],
            }),
        ),
        "render-process-gone" => process_gone(win_id, wc_id, &args[0]),
        "unresponsive" => log(
            win_id,
            json!({ "source": "renderer-unresponsive", "message": "Renderer stopped responding", "url": page_url_now(wc_id) }),
        ),
        "console-message" => {
            let details = &args[0];
            if details["level"] == "error" {
                log(
                    win_id,
                    json!({
                        "source": "renderer-console",
                        "message": details["message"],
                        "url": details["sourceId"],
                        "line": details["lineNumber"],
                    }),
                );
            }
        }
        "context-menu" => menu::context_menu(win_id, wc_id, &args[0]),
        _ => {}
    }
}

fn with_record<R>(win_id: u64, f: impl FnOnce(&mut Record) -> R) -> Option<R> {
    RECORDS.with(|r| r.borrow_mut().get_mut(&win_id).map(f))
}

fn finished_load(win_id: u64) {
    let (first, presence, waiting) = with_record(win_id, |r| {
        r.loaded = true;
        let first = !std::mem::replace(&mut r.shown, true);
        (first, r.presence.take(), std::mem::take(&mut r.waiting))
    })
    .unwrap_or((false, None, Vec::new()));
    if first && let Some(op) = rules::first_show(presence.as_deref(), headless()) {
        win_op(win_id, op, json!({}));
    }
    for f in waiting {
        f();
    }
}

fn mark_software(wc_id: u64) {
    wc_op(
        wc_id,
        "executeJavaScript",
        json!({ "code": "document.documentElement.dataset.gpu = \"software\"" }),
    );
}

fn log(win_id: u64, report: Value) {
    let Some(ctx) = ctx() else { return };
    let (wc_id, cwd) = RECORDS.with(|r| {
        r.borrow()
            .get(&win_id)
            .map(|record| (record.wc_id, record.cwd.clone()))
            .unwrap_or_default()
    });
    // `windowId` is the page's id, as window.ts' `record.id` (`win.webContents.id`) was.
    ctx.runtime_log_in(report, wc_id, &cwd);
}

fn load_page(win_id: u64) {
    let Some((wc_id, slot, mica)) = RECORDS.with(|r| {
        r.borrow()
            .get(&win_id)
            .map(|record| (record.wc_id, record.slot, mica_of(win_id)))
    }) else {
        return;
    };
    let dev = std::env::var("ELECTRON_RENDERER_URL").ok();
    let styleguide = std::env::var("OMP_GUI_STYLEGUIDE").as_deref() == Ok("1");
    let url = rules::page_url(dev.as_deref(), slot, mica, styleguide);
    wc_op(wc_id, "loadURL", json!({ "url": url }));
}

fn mica_of(win_id: u64) -> bool {
    state::win(win_id).is_some_and(|e| {
        e.borrow()
            .options
            .get("backgroundMaterial")
            .and_then(Value::as_str)
            == Some("mica")
    })
}

fn process_gone(win_id: u64, wc_id: u64, details: &Value) {
    let reason = details["reason"].as_str().unwrap_or("crashed").to_string();
    let now = now_ms();
    let last = with_record(win_id, |r| r.last_recovery_at).unwrap_or(0.0);
    let reload = rules::should_reload_renderer(&reason, last, now);
    let changed = resources_changed_since_launch();
    if reload && !changed {
        with_record(win_id, |r| r.last_recovery_at = now);
    }
    log(
        win_id,
        json!({
            "source": "renderer-process",
            "message": format!("Renderer process exited: {reason}"),
            "url": page_url_now(wc_id),
            "details": {
                "reason": reason,
                "exitCode": details["exitCode"],
                "automaticReload": reload && !changed,
                "resourcesChanged": changed,
            },
        }),
    );
    if restart_for_changed_resources(
        win_id,
        &Failure::ProcessGone { reloadable: reload },
        "process-gone",
    ) {
        return;
    }
    if reload {
        crate::ui::post(move || {
            if owns(win_id) {
                load_page(win_id);
            }
        });
    } else if !changed {
        // Repeated crash inside the cooldown: the window would sit black, and a dead page cannot show a dialog.
        offer_crash_recovery(win_id);
    }
}

// ------------------------------------------------------------------ resources an update replaced

fn entry_identity() -> Option<Identity> {
    let paths = state::paths();
    if !paths.packaged {
        return None;
    }
    let metadata = std::fs::metadata(paths.renderer_dir.join("index.html")).ok()?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    // Windows: no stable inode in std; a replaced file gets a new creation time.
    #[cfg(not(unix))]
    let (device, inode) = (
        0,
        metadata
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos() as u64),
    );
    Some(Identity {
        device,
        inode,
        size: metadata.len(),
        modified_at,
    })
}

fn resources_changed_since_launch() -> bool {
    let launch = LAUNCH_IDENTITY.get().cloned().flatten();
    rules::resources_changed(launch.as_ref(), entry_identity().as_ref())
}

fn restart_for_changed_resources(win_id: u64, failure: &Failure, trigger: &str) -> bool {
    if !rules::should_restart_for_changed_resources(failure) {
        return false;
    }
    let launch = LAUNCH_IDENTITY.get().cloned().flatten();
    let current = entry_identity();
    if !rules::resources_changed(launch.as_ref(), current.as_ref()) {
        return false;
    }
    if RESTART_SCHEDULED.swap(true, Ordering::Relaxed) {
        return true;
    }
    let inode = |i: &Option<Identity>| i.as_ref().map_or(-1, |i| i.inode as i64);
    let size = |i: &Option<Identity>| i.as_ref().map_or(-1, |i| i.size as i64);
    let wc_id = wc_of(win_id).unwrap_or(0);
    log(
        win_id,
        json!({
            "source": "application-resources",
            "message": "Packaged application resources changed while omp was running; asking to restart",
            "url": page_url_now(wc_id),
            "details": {
                "trigger": trigger,
                "launchInode": inode(&launch),
                "currentInode": inode(&current),
                "launchSize": size(&launch),
                "currentSize": size(&current),
            },
        }),
    );
    confirm_restart_for_changed_resources(win_id);
    true
}

fn text(key: &str, params: &[(&str, &str)]) -> String {
    label(key, params).unwrap_or_else(|| key.to_string())
}

/// One native message box; `then` gets the chosen button (None: dismissed or failed). Any thread.
fn message_box(
    owner: Option<u64>,
    options: Value,
    then: impl FnOnce(Option<i64>) + Send + 'static,
) {
    let mut params = json!({ "options": options });
    if let Some(owner) = owner {
        params["winId"] = json!(owner);
    }
    crate::dialog::handle(Call::local(
        "dialog.messageBox",
        params,
        move |answer, _| {
            then(
                answer
                    .ok()
                    .and_then(|v| v.get("response").and_then(Value::as_i64)),
            );
        },
    ));
}

fn confirm_restart_for_changed_resources(win_id: u64) {
    let Some(ctx) = ctx() else { return };
    ctx.ask("quitFacts", json!({}), None, move |answer, _| {
        let facts = answer.unwrap_or_else(|_| json!({}));
        let working = facts["workingTabs"].as_u64().unwrap_or(0).to_string();
        let total = facts["totalTabs"].as_u64().unwrap_or(0).to_string();
        let options = json!({
            "type": "question",
            "buttons": [text("restart.now", &[]), text("restart.later", &[])],
            "defaultId": 0,
            "cancelId": 1,
            "message": text("restart.title", &[]),
            "detail": text("restart.body", &[("working", &working), ("total", &total)]),
        });
        crate::ui::post(move || {
            let owner = owns(win_id).then_some(win_id);
            message_box(owner, options, |response| {
                // The prompt carries the approval: the quit guard never asks again about the same sessions.
                if response == Some(0) {
                    crate::ui::post(|| quit::approve_and_quit(true));
                }
            });
        });
    });
}

fn offer_crash_recovery(win_id: u64) {
    // One dialog per window: a page that keeps dying would queue one per crash.
    if with_record(win_id, |r| std::mem::replace(&mut r.crash_offered, true)).unwrap_or(true) {
        return;
    }
    let log_path = state::paths()
        .user_data
        .join("logs")
        .join("gui-runtime.jsonl")
        .display()
        .to_string();
    let options = json!({
        "type": "error",
        "buttons": [text("restart.now", &[]), text("crash.close", &[])],
        "defaultId": 0,
        "cancelId": 1,
        "message": text("crash.title", &[]),
        "detail": text("crash.body", &[("logPath", &log_path)]),
    });
    message_box(Some(win_id), options, |response| {
        if response == Some(0) {
            crate::ui::post(|| quit::approve_and_quit(true));
        }
    });
}

// ------------------------------------------------------------------ making a window

fn store_path() -> std::path::PathBuf {
    state::paths().user_data.join("window-state.json")
}

fn persist(win_id: u64) {
    let Some(window) = cef_window(win_id) else {
        return;
    };
    let bounds = window.bounds();
    let saved = rules::Saved {
        x: Some(f64::from(bounds.x)),
        y: Some(f64::from(bounds.y)),
        width: f64::from(bounds.width),
        height: f64::from(bounds.height),
        is_maximized: Some(window.is_maximized() != 0),
    };
    let path = store_path();
    let previous = std::fs::read_to_string(&path).ok();
    let text = rules::store_text(previous.as_deref(), &saved);
    if let Err(error) = shell_core::atomic::write(&path, text.as_bytes()) {
        crate::log::log(
            "chrome.window_state_failed",
            json!({ "error": error.to_string() }),
        );
    }
}

fn work_areas() -> Vec<Rect> {
    let (displays, primary) = crate::system::displays();
    let area = |d: &Value| Rect {
        x: d["workArea"]["x"].as_f64().unwrap_or(0.0),
        y: d["workArea"]["y"].as_f64().unwrap_or(0.0),
        width: d["workArea"]["width"].as_f64().unwrap_or(0.0),
        height: d["workArea"]["height"].as_f64().unwrap_or(0.0),
    };
    let mut areas: Vec<Rect> = displays
        .iter()
        .filter(|d| d["id"].as_i64() == Some(primary))
        .map(area)
        .collect();
    areas.extend(displays.iter().map(area));
    areas
}

pub fn icon_path() -> String {
    let paths = state::paths();
    let path = if paths.packaged {
        paths.resources.join("app-icon.png")
    } else {
        paths
            .app_dir
            .join("resources")
            .join("brand")
            .join("app-icon.png")
    };
    path.display().to_string()
}

fn mica_supported() -> bool {
    #[cfg(windows)]
    let release = shell_core::sys::system::os_release();
    #[cfg(not(windows))]
    let release = String::new();
    rules::mica_supported(Platform::current(), &release)
}

/// The state `win.adopted` carries before the OS window exists (the shim's `initialState`).
fn initial_state(options: &Value) -> Value {
    let rect = json!({
        "x": options.get("x").cloned().unwrap_or(json!(0)),
        "y": options.get("y").cloned().unwrap_or(json!(0)),
        "width": options.get("width").cloned().unwrap_or(json!(800)),
        "height": options.get("height").cloned().unwrap_or(json!(600)),
    });
    json!({
        "bounds": rect, "normalBounds": rect, "contentBounds": rect, "visible": false, "focused": false,
        "minimized": false, "maximized": false, "fullscreen": false, "title": "", "opacity": 1,
    })
}

/// `chrome.open` (UI thread).
fn open(ctx: Ctx, call: Call) {
    let cwd = call.str("cwd").unwrap_or_default();
    let presence = call.str("presence");
    let saved = rules::parse_saved(std::fs::read_to_string(store_path()).ok().as_deref());
    let areas = work_areas();
    let icon = icon_path();
    let opening = rules::opening(&OpenFacts {
        saved,
        open: RECORDS.with(|r| r.borrow().len()),
        work_areas: &areas,
        platform: Platform::current(),
        dark: crate::theme::dark(),
        mica_supported: mica_supported(),
        headless: headless(),
        icon: Some(&icon),
    });
    let slot = rules::free_slot(&RECORDS.with(|r| {
        r.borrow()
            .values()
            .map(|record| record.slot)
            .collect::<Vec<_>>()
    }));
    let (win_id, wc_id) = (state::next_win_id(), state::next_wc_id());
    crate::host::event(
        "win.adopted",
        json!({ "winId": win_id, "wcId": wc_id, "options": opening.options, "state": initial_state(&opening.options) }),
    );
    if let Err(message) = crate::window::make(win_id, wc_id, opening.options.clone()) {
        crate::host::event(
            "win.event",
            json!({ "winId": win_id, "name": "closed", "args": [] }),
        );
        return call.err("failed", message);
    }
    RECORDS.with(|r| {
        r.borrow_mut().insert(
            win_id,
            Record {
                wc_id,
                cwd,
                slot,
                presence,
                shown: false,
                loaded: false,
                waiting: Vec::new(),
                software: false,
                last_recovery_at: 0.0,
                crash_offered: false,
            },
        )
    });
    // The page's context menu and its console errors are this area's (`page_event`).
    if let Some(page) = state::wc(wc_id) {
        let mut page = page.borrow_mut();
        page.watch_events.insert("context-menu".into());
        page.watch_events.insert("console-message".into());
    }
    if opening.maximize {
        win_op(win_id, "maximize", json!({}));
    }
    load_page(win_id);
    // Software compositing: the page draws its looping cues still (`html[data-gpu="software"]`), set again after
    // each load (the page starts without it).
    gpu::software(move |software| {
        if !software || with_record(win_id, |r| r.software = true).is_none() {
            return;
        }
        if !state::wc(wc_id).is_some_and(|w| w.borrow().state.loading) {
            mark_software(wc_id);
        }
    });
    let _ = ctx;
    call.ok(json!({ "winId": win_id, "wcId": wc_id, "slot": slot, "mica": opening.mica }));
}

fn run_progress(state: &str) {
    let (badge, value) = rules::run_progress(state);
    crate::appops::handle(Call::fire("app.setBadge", json!({ "text": badge })));
    for win_id in app_windows() {
        win_op(win_id, "setProgressBar", json!({ "value": value }));
    }
}

// ------------------------------------------------------------------ the wire

pub fn request(ctx: Ctx, call: Call) -> Option<Call> {
    match call.method.as_str() {
        "chrome.open" => crate::ui::run(move || open(ctx, call)),
        _ => return Some(call),
    }
    None
}

pub fn event(_ctx: Ctx, name: &str, data: &Value) -> bool {
    match name {
        "chrome.cwd" => {
            let (Some(win_id), Some(cwd)) = (
                data["winId"].as_u64(),
                data["cwd"].as_str().map(String::from),
            ) else {
                return true;
            };
            crate::ui::run(move || {
                with_record(win_id, |r| r.cwd = cwd);
            });
        }
        "chrome.runProgress" => {
            let state = data["state"].as_str().unwrap_or("idle").to_string();
            crate::ui::run(move || run_progress(&state));
        }
        "chrome.closeToTray" => {
            CLOSE_TO_TRAY.store(data["on"].as_bool() != Some(false), Ordering::Relaxed)
        }
        _ => return false,
    }
    true
}

pub fn ready(ctx: Ctx) {
    let _ = CTX.set(ctx);
    let _ = LAUNCH_IDENTITY.set(entry_identity());
}

pub fn shutdown(_ctx: Ctx) {}
