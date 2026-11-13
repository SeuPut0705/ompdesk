//! The shell's startup hand-offs and its exit: what the boot thread waits for before CEF starts, and the quit
//! sequence Node starts with `app.exit`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};

use crate::host::Call;
use crate::log::log;
use crate::state::ui_state;

pub enum Boot {
    /// `app.init`, answered once CEF's settings are in place.
    Init(Call),
    /// `app.exit` before CEF ran.
    Exit(i32),
    /// Node ended on its own.
    NodeGone,
}

static BOOT: OnceLock<Mutex<Sender<Boot>>> = OnceLock::new();

pub fn boot_channel() -> Receiver<Boot> {
    let (tx, rx) = channel();
    let _ = BOOT.set(Mutex::new(tx));
    rx
}

pub fn boot_send(message: Boot) {
    if let Some(tx) = BOOT.get() {
        let _ = tx.lock().unwrap().send(message);
    }
}

pub static EXITING: AtomicBool = AtomicBool::new(false);
static CEF_RUNNING: AtomicBool = AtomicBool::new(false);

pub struct ExitRequest {
    pub code: i32,
    /// `Some(None)` relaunches with the shell's own arguments, `Some(Some(args))` with these.
    pub relaunch: Option<Option<Vec<String>>>,
}

static EXIT: Mutex<ExitRequest> = Mutex::new(ExitRequest {
    code: 0,
    relaunch: None,
});

pub fn cef_started() {
    CEF_RUNNING.store(true, Ordering::SeqCst);
}

pub fn take_exit() -> ExitRequest {
    let mut guard = EXIT.lock().unwrap();
    ExitRequest {
        code: guard.code,
        relaunch: guard.relaunch.take(),
    }
}

/// `app.relaunch {args}` (an event): the last call wins.
pub fn set_relaunch(args: Option<Vec<String>>) {
    EXIT.lock().unwrap().relaunch = Some(args);
}

/// `app.exit {code}` (an event): Node ran its quit sequence; close every window without asking and end the loop.
pub fn request_exit(code: i32) {
    EXIT.lock().unwrap().code = code;
    EXITING.store(true, Ordering::SeqCst);
    log("app.exit", json!({ "code": code }));
    if !CEF_RUNNING.load(Ordering::SeqCst) {
        boot_send(Boot::Exit(code));
        return;
    }
    crate::ui::post(|| {
        ui_state(|u| u.exiting = true);
        crate::modules::shutdown();
        crate::window::close_all_for_exit();
        if ui_state(|u| u.browsers) == 0 {
            cef::quit_message_loop();
            return;
        }
        // Browsers that do not close in time do not hold the quit.
        crate::ui::post_delayed(
            Duration::from_secs(4).as_millis() as i64,
            cef::quit_message_loop,
        );
    });
}

/// A quit that did not finish in time (the quit watchdog): `app.exit`'s sequence, and when the process still lives
/// after `grace` (a window that never closes, a wedged UI thread) Node is stopped and the process ends from here.
pub fn force_exit(code: i32, grace: Duration) {
    request_exit(code);
    let spawned = std::thread::Builder::new()
        .name("forced-exit".into())
        .spawn(move || {
            std::thread::sleep(grace);
            log("app.forced_exit", json!({ "code": code }));
            crate::node::stop(Duration::from_secs(1));
            std::process::exit(code);
        });
    if let Err(error) = spawned {
        log(
            "app.forced_exit_thread_failed",
            json!({ "error": error.to_string() }),
        );
    }
}

/// Node's connection ended or Node exited: unless the shell is already quitting, that is a crash.
pub fn node_gone(code: Option<i32>) {
    if EXITING.load(Ordering::SeqCst) {
        return;
    }
    log("node.gone", json!({ "code": code }));
    eprintln!(
        "[shell] the Node process ended unexpectedly (exit code {code:?}); the shell exits with 1"
    );
    if CEF_RUNNING.load(Ordering::SeqCst) {
        // CEF cannot be left from this thread: end the process; its helpers follow their parent.
        std::process::exit(1);
    }
    boot_send(Boot::NodeGone);
}

pub fn on_event(name: &str, data: Value, _bin: Option<Vec<u8>>) {
    match name {
        "app.exit" => request_exit(data.get("code").and_then(Value::as_i64).unwrap_or(0) as i32),
        "app.relaunch" => set_relaunch(data.get("args").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })),
        _ => {}
    }
}

/// Used by the host's request handler for `app.init`.
pub fn init(call: Call) {
    boot_send(Boot::Init(call));
}

pub fn answer_init(call: Call) {
    call.ok(json!({}));
}

pub fn exit_code() -> i32 {
    EXIT.lock().unwrap().code
}
