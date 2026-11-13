//! The quit (was `src/main/app-quit.ts`, `quit-watchdog.ts` and the rules of `quit-guard.ts`): the approval, the
//! confirmation dialogs and the exit watchdog. Node keeps its own teardown and mirrors the approval (`chrome.approved`).
//! The other chrome areas use the functions below; they work from any thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use cef::ImplWindow;
use serde_json::{Value, json};
use shell_core::chrome_core::quit::{
    ActivateAction, BackgroundWork, Confirmation, QUIT_EXIT_TIMEOUT_MS, QuitFacts, Reason,
    Watchdog, activate_action, confirm_quit as quit_plan, confirm_update_restart as update_plan,
    needs_background_work, watchdog_report,
};

use super::window;
use crate::host::Call;
use crate::log::log;
use crate::modules::Ctx;
use crate::{lifecycle, state, ui};

/// Test seam: the watchdog's countdown in milliseconds, so a parity case need not wait 30 s.
const WATCHDOG_ENV: &str = "OMP_GUI_TEST_QUIT_WATCHDOG_MS";
/// Test seam: the button a confirmation answers with, after `TEST_DIALOG_MS`, without opening a native box (a headless
/// run cannot click one). The options it would have shown go to the shell log as `quit.test_dialog`.
const DIALOG_ENV: &str = "OMP_GUI_TEST_QUIT_DIALOG";
const TEST_DIALOG_MS: u64 = 300;
/// How long Node gets to run its forced-exit hooks before the shell exits regardless.
const FORCED_EXIT_ASK: Duration = Duration::from_secs(2);
/// A forced exit that still has not ended the process after this long ends it from here.
const FORCED_EXIT_GRACE: Duration = Duration::from_secs(20);

static CTX: OnceLock<Ctx> = OnceLock::new();
static APPROVED: AtomicBool = AtomicBool::new(false);
/// One native confirmation at a time: a second ⌘Q (or restart click) while one is open must not queue a second modal.
static ASKING: AtomicBool = AtomicBool::new(false);
static WATCHDOG: Mutex<Watchdog> = Mutex::new(Watchdog::new());

/// A quit is approved (windows close instead of hiding; nothing spawns a window).
pub fn approved() -> bool {
    APPROVED.load(Ordering::SeqCst)
}

/// A quit nobody approved yet (the tray's Quit, the last window on Windows, ⌘Q): asks first when running work would
/// stop, then approves it and tells Node to quit (`chrome.approved {run: true}`).
pub fn quit() {
    match CTX.get() {
        Some(ctx) => quit_then(*ctx, |_| {}),
        // Before the module is up nobody could be asked.
        None => lifecycle::request_exit(0),
    }
}

/// `requestQuit()`: the caller already asked (a restart prompt). With `relaunch`, the app starts again afterwards.
pub fn approve_and_quit(relaunch: bool) {
    if relaunch {
        lifecycle::set_relaunch(None);
    }
    match CTX.get() {
        Some(ctx) => approve(*ctx),
        None => lifecycle::request_exit(0),
    }
}

/// macOS Dock click (or the app opened again while running): opens a window when none is left and brings a hidden one
/// back; once a quit is approved it does neither (`activate_action`). Main thread (the UI thread).
pub fn activate() {
    if CTX.get().is_none() {
        // Before the module is up there is no window to open or show.
        return;
    }
    ui::run(|| {
        let windows = window::app_windows();
        let any_visible = windows.iter().any(|win| window::is_visible(*win));
        match activate_action(approved(), windows.len(), any_visible) {
            ActivateAction::Spawn => window::spawn(None, |_| {}),
            ActivateAction::Show => {
                if let Some(win) = window::target().or_else(|| windows.first().copied()) {
                    window::show(win);
                }
            }
            ActivateAction::Ignore => {}
        }
    });
}

fn approve(ctx: Ctx) {
    APPROVED.store(true, Ordering::SeqCst);
    ctx.emit("approved", json!({ "run": true }));
}

fn quit_then(ctx: Ctx, then: impl FnOnce(bool) + Send + 'static) {
    if approved() {
        // Node's mirror may not have heard yet (a quit approved by the shell the instant before).
        approve(ctx);
        return then(true);
    }
    confirm_quit(ctx, move |ok| {
        if ok {
            approve(ctx);
        }
        then(ok);
    });
}

fn say(key: &str, params: &[(&str, &str)]) -> String {
    shell_core::labels::label(key, params).unwrap_or_else(|| key.to_string())
}

/// `chrome.quitFacts`: what a quit would stop. None when Node cannot say: the quit then goes ahead, as Node's own
/// `app.quit()` would have.
fn read_facts(ctx: Ctx, then: impl FnOnce(Option<QuitFacts>) + Send + 'static) {
    ctx.ask("quitFacts", json!({}), None, move |answer, _| {
        let facts = match answer {
            Ok(value) => QuitFacts::from_json(&value),
            Err(error) => {
                log("quit.facts_failed", json!({ "error": error.message }));
                None
            }
        };
        then(facts)
    });
}

/// True when nothing would stop or the person chose to quit anyway.
fn confirm_quit(ctx: Ctx, then: impl FnOnce(bool) + Send + 'static) {
    read_facts(ctx, move |facts| match facts {
        Some(facts) => present(quit_plan(&facts, &say), then),
        None => then(true),
    });
}

fn confirm_update_restart(ctx: Ctx, then: impl FnOnce(bool) + Send + 'static) {
    read_facts(ctx, move |facts| {
        let Some(facts) = facts else {
            return then(true);
        };
        if !needs_background_work(facts.resumes) {
            return present(update_plan(&facts, None, &say), then);
        }
        ctx.ask(
            "backgroundWork",
            json!({}),
            None,
            move |answer, _| match answer
                .ok()
                .and_then(|value| BackgroundWork::from_json(&value))
            {
                Some(work) => present(update_plan(&facts, Some(&work), &say), then),
                None => {
                    log("quit.background_work_failed", json!({}));
                    then(true)
                }
            },
        );
    });
}

fn present(plan: Confirmation, then: impl FnOnce(bool) + Send + 'static) {
    match plan {
        Confirmation::Proceed => then(true),
        Confirmation::Ask(options) => ask_once(options, then),
    }
}

/// One native confirm at a time: true when the first button was chosen; false for the second, a dismissal, a failure
/// or a prompt already open. The owner is the focused window.
fn ask_once(options: Value, then: impl FnOnce(bool) + Send + 'static) {
    if ASKING.swap(true, Ordering::SeqCst) {
        return then(false);
    }
    if let Ok(button) = std::env::var(DIALOG_ENV) {
        log("quit.test_dialog", json!({ "options": options }));
        let spawned = std::thread::Builder::new()
            .name("quit-test-dialog".into())
            .spawn(move || {
                std::thread::sleep(Duration::from_millis(TEST_DIALOG_MS));
                ASKING.store(false, Ordering::SeqCst);
                then(button.parse::<u64>() == Ok(0));
            });
        if let Err(error) = spawned {
            ASKING.store(false, Ordering::SeqCst);
            log(
                "quit.test_dialog_thread_failed",
                json!({ "error": error.to_string() }),
            );
        }
        return;
    }
    ui::run(move || {
        let params = json!({ "winId": focused_window(), "options": options });
        crate::dialog::handle(Call::local(
            "dialog.messageBox",
            params,
            move |answer, _| {
                ASKING.store(false, Ordering::SeqCst);
                then(answer.is_ok_and(|result| result["response"].as_u64() == Some(0)));
            },
        ));
    });
}

/// The app window that has the focus (`BrowserWindow.getFocusedWindow()`); UI thread.
fn focused_window() -> Option<u64> {
    let windows: Vec<_> = state::ui_state(|ui| ui.windows.values().cloned().collect());
    windows.into_iter().find_map(|entry| {
        let entry = entry.borrow();
        let window = entry.window.as_ref()?;
        (!entry.offscreen && !entry.destroyed && window.is_active() != 0).then_some(entry.id)
    })
}

fn timeout_ms() -> u64 {
    std::env::var(WATCHDOG_ENV)
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(QUIT_EXIT_TIMEOUT_MS)
}

/// The teardown committed (⌘Q, tray, an update restart or `before-quit-for-update`): from here nothing may keep the
/// process alive. A wedged teardown leaves the windows gone but the process running, and the updater's swap helper
/// waits for this process to exit before it replaces the bundle.
fn arm(ctx: Ctx, reason: Reason) {
    let Some(generation) = WATCHDOG.lock().unwrap().arm(reason) else {
        return;
    };
    let timeout = timeout_ms();
    let spawned = std::thread::Builder::new()
        .name("quit-watchdog".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(timeout));
            let fired = WATCHDOG.lock().unwrap().expire(generation);
            if let Some(reason) = fired {
                force_exit(ctx, reason, timeout);
            }
        });
    if let Err(error) = spawned {
        log(
            "quit.watchdog_thread_failed",
            json!({ "error": error.to_string() }),
        );
    }
}

fn force_exit(ctx: Ctx, reason: Reason, timeout: u64) {
    ctx.runtime_log(watchdog_report(reason, timeout), None);
    // `app.exit` skips `will-quit`, so whatever hangs off it (the relaunch swap) runs in Node's hooks first. A wedged
    // Node never answers: the shell exits on its own after the wait.
    let (tx, rx) = std::sync::mpsc::channel();
    ctx.ask(
        "forcedExit",
        json!({ "reason": reason.as_str(), "timeoutMs": timeout }),
        None,
        move |_, _| {
            let _ = tx.send(());
        },
    );
    let _ = rx.recv_timeout(FORCED_EXIT_ASK);
    lifecycle::force_exit(0, FORCED_EXIT_GRACE);
}

pub fn request(ctx: Ctx, call: Call) -> Option<Call> {
    match call.method.as_str() {
        // Node's `before-quit` saw a quit nobody approved.
        "chrome.quit" => quit_then(ctx, move |ok| call.ok(json!({ "approved": ok }))),
        "chrome.confirmQuit" => confirm_quit(ctx, move |ok| call.ok(json!({ "ok": ok }))),
        // A Dock click, asked for by the e2e (macOS gives no other way to press the Dock icon from a test).
        "chrome.activate" => {
            activate();
            call.ok(json!({}));
        }
        "chrome.confirmUpdateRestart" => {
            confirm_update_restart(ctx, move |ok| call.ok(json!({ "ok": ok })));
        }
        _ => return Some(call),
    }
    None
}

pub fn event(ctx: Ctx, name: &str, data: &Value) -> bool {
    match name {
        // `requestQuit()`: the caller approved it (Node's mirror is set already).
        "chrome.approve" => APPROVED.store(true, Ordering::SeqCst),
        "chrome.committed" => match data["reason"].as_str().and_then(Reason::parse) {
            Some(reason) => arm(ctx, reason),
            None => log("quit.committed_bad", json!({ "data": data })),
        },
        "chrome.disarm" => WATCHDOG
            .lock()
            .unwrap()
            .disarm(data["reason"].as_str().and_then(Reason::parse)),
        _ => return false,
    }
    true
}

pub fn ready(ctx: Ctx) {
    let _ = CTX.set(ctx);
}

pub fn shutdown(_ctx: Ctx) {}
