//! Deep links and launch paths (was `src/main/deep-link.ts`): `omp://new` and `omp://session/<id>` (a click in another
//! app, `open url`, the registered protocol of Windows), a folder handed to the app (`open -a omp ~/code/x`, a second
//! launch's argument) and a bare second launch. Arrivals wait until Node says its startup windows exist
//! (`chrome.linksReady`), then each goes through `chrome_core::deep_link::plan` and the window area.

use std::sync::{Mutex, OnceLock};

use serde_json::{Value, json};
use shell_core::chrome_core::deep_link::{Arrival, Flavor, PROTOCOL, Plan, Shown, Windows, plan};

use super::window;
use crate::host::Call;
use crate::log::log;
use crate::modules::Ctx;
use crate::{appops, ui};

/// More than this many arrivals before the windows exist is a loop, not a launch.
const HELD_MAX: usize = 64;

static CTX: OnceLock<Ctx> = OnceLock::new();
static STATE: Mutex<State> = Mutex::new(State {
    ready: false,
    held: Vec::new(),
});

struct State {
    ready: bool,
    held: Vec<Arrived>,
}

enum Arrived {
    #[cfg(target_os = "macos")]
    Url(String),
    #[cfg(target_os = "macos")]
    File(String),
    /// A refused second launch's whole argv.
    Second(Vec<String>),
}

/// macOS `kAEGetURL`. Any thread.
#[cfg(target_os = "macos")]
pub fn open_url(url: String) {
    arrive(Arrived::Url(url));
}

/// macOS `kAEOpenDocuments`: `open -a omp ~/code/x`. Any thread.
#[cfg(target_os = "macos")]
pub fn open_file(path: String) {
    arrive(Arrived::File(path));
}

/// Another launch of the same user-data folder handed its argv over and exited (Windows protocol launches too). Any
/// thread.
pub fn second_instance(argv: Vec<String>) {
    arrive(Arrived::Second(argv));
}

fn arrive(item: Arrived) {
    {
        let mut state = STATE.lock().unwrap();
        if !state.ready {
            if state.held.len() < HELD_MAX {
                state.held.push(item);
            }
            return;
        }
    }
    ui::post(move || handle(item));
}

/// Node's startup windows exist: register the protocol (not in a test run: that entry belongs to the person's own
/// OMPdesk) and replay what arrived meanwhile, in order.
fn links_ready(register: bool) {
    if register && !appops::register_protocol(PROTOCOL) {
        log(
            "deep_link.register_refused",
            json!({ "protocol": PROTOCOL }),
        );
    }
    let held = {
        let mut state = STATE.lock().unwrap();
        state.ready = true;
        std::mem::take(&mut state.held)
    };
    ui::post(move || {
        for item in held {
            handle(item);
        }
    });
}

/// The drive a Windows path rooted without one resolves on: the process's own.
fn current_drive() -> char {
    std::env::current_dir()
        .ok()
        .and_then(|dir| dir.to_string_lossy().chars().next())
        .filter(char::is_ascii_alphabetic)
        .unwrap_or('C')
}

/// UI thread.
fn handle(item: Arrived) {
    let Some(ctx) = CTX.get() else { return };
    let windows = window::app_windows();
    let cwds: Vec<Option<String>> = windows.iter().map(|id| window::cwd(*id)).collect();
    let target = window::target().and_then(|id| windows.iter().position(|w| *w == id));
    let arrival = match &item {
        #[cfg(target_os = "macos")]
        Arrived::Url(url) => Arrival::OpenUrl(url),
        #[cfg(target_os = "macos")]
        Arrived::File(path) => Arrival::OpenFile(path),
        Arrived::Second(argv) => Arrival::SecondInstance(argv),
    };
    let planned = plan(
        &arrival,
        &Windows {
            cwds: &cwds,
            target,
        },
        Flavor::HOST,
        current_drive(),
    );
    execute(*ctx, planned, &windows);
}

fn execute(ctx: Ctx, planned: Plan, windows: &[u64]) {
    let Plan {
        spawn,
        show,
        deliver,
    } = planned;
    match (spawn, show) {
        (Some(cwd), show) => window::spawn(cwd, move |spawned| {
            if let (Some(win), Some(Shown::Spawned)) = (spawned, show) {
                present(ctx, win, deliver);
            }
        }),
        (None, Some(Shown::Window(index))) => {
            if let Some(win) = windows.get(index) {
                present(ctx, *win, deliver);
            }
        }
        (None, _) => {}
    }
}

/// Brings the window forward (a window hidden to the tray comes back too) and, once its page loaded (a cold start:
/// the page subscribes only after load), hands it the link.
fn present(ctx: Ctx, win: u64, link: Option<shell_core::chrome_core::deep_link::Link>) {
    window::show(win);
    if let Some(link) = link {
        window::when_loaded(win, move || {
            ctx.emit(
                "deepLink",
                json!({ "winId": win, "payload": link.to_json() }),
            );
        });
    }
}

pub fn request(_ctx: Ctx, call: Call) -> Option<Call> {
    Some(call)
}

pub fn event(_ctx: Ctx, name: &str, data: &Value) -> bool {
    match name {
        "chrome.linksReady" => links_ready(data["register"].as_bool().unwrap_or(false)),
        _ => return false,
    }
    true
}

pub fn ready(ctx: Ctx) {
    let _ = CTX.set(ctx);
}

pub fn shutdown(_ctx: Ctx) {}
