//! The main-thread hang watchdog (was `src/main/hang-watchdog.ts`'s wiring and `hang-watchdog-worker.ts`; the rules are
//! `shell_core::chrome_core::hang`). Observation only: a stall is recorded in `<userData>/logs/main-thread-hang.json`
//! and the next launch reports it as one `gui-runtime.jsonl` line. Node posts a heartbeat every second and the steps it
//! is about to run; a thread of the shell checks every second, so it keeps watching while Node is blocked. The first
//! heartbeat starts the watch (Node's client decides whether it runs: packaged or `OMP_GUI_HANG_WATCHDOG=1`, never
//! under vitest); `chrome.unwatch` (Node's `will-quit`) ends it.

use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use shell_core::atomic::{self, Ordered};
use shell_core::chrome_core::hang::{
    HANG_CHECK_INTERVAL_MS, MainPhase, Recorder, Tick, consume_marker, previous_hang_report,
};

use crate::host::Call;
use crate::log::log;
use crate::modules::Ctx;

/// The watch, and the one writer every marker goes through, in the order the transitions happened (`Recorder`).
static RECORDER: LazyLock<Recorder> =
    LazyLock::new(|| Recorder::new(Ordered::new("hang-marker", Box::new(write_marker))));

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn marker_path() -> PathBuf {
    crate::state::paths()
        .user_data
        .join("logs")
        .join("main-thread-hang.json")
}

/// Best effort: a marker that cannot be written must not stop the watchdog.
fn write_marker(path: &std::path::Path, bytes: &[u8]) {
    if atomic::write(path, bytes).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

/// A heartbeat; the first one starts the watch and its check thread.
fn heartbeat(pid: u32) {
    if let Some(generation) = RECORDER.heartbeat(pid, now_ms(), marker_path) {
        std::thread::Builder::new()
            .name("hang-watchdog".into())
            .spawn(move || watch(generation))
            .expect("hang watchdog thread");
    }
}

fn watch(generation: u64) {
    loop {
        std::thread::sleep(Duration::from_millis(HANG_CHECK_INTERVAL_MS as u64));
        match RECORDER.tick(generation, now_ms()) {
            Tick::Over => return,
            Tick::Quiet => {}
            Tick::Detected(marker) => log(
                "hang.detected",
                serde_json::json!({ "unresponsiveMs": marker.unresponsive_ms }),
            ),
        }
    }
}

/// The OS resumed from suspend (`power.rs`): wait for fresh heartbeats before judging Node.
pub fn resumed() {
    RECORDER.reset(now_ms());
}

pub fn request(_ctx: Ctx, call: Call) -> Option<Call> {
    Some(call)
}

pub fn event(_ctx: Ctx, name: &str, data: &Value) -> bool {
    match name {
        "chrome.heartbeat" => {
            // Node's own pid: the line the next launch writes names the process the other log lines came from.
            let pid = data["pid"]
                .as_u64()
                .and_then(|p| u32::try_from(p).ok())
                .filter(|p| *p > 0)
                .unwrap_or_else(std::process::id);
            heartbeat(pid);
        }
        "chrome.step" => {
            let phase = data["phase"].as_str().and_then(MainPhase::parse);
            match (phase, data["step"].as_str()) {
                (Some(phase), Some(step)) => RECORDER.step(phase, step),
                _ => log("hang.step_bad", serde_json::json!({ "data": data })),
            }
        }
        "chrome.unwatch" => RECORDER.stop(),
        _ => return false,
    }
    true
}

/// Reports (and removes) the marker the previous run left, if any, as one `main-thread-hang` line.
pub fn ready(ctx: Ctx) {
    if let Some(marker) = consume_marker(&marker_path()) {
        let report = previous_hang_report(&marker);
        // The shell's own log keeps the line too: the parity suite reads it there (Node's file is written later).
        log("chrome.runtime_log", report.clone());
        ctx.runtime_log(report, None);
    }
}

pub fn shutdown(_ctx: Ctx) {
    RECORDER.stop();
    // The app is going: the last marker reaches the disk first.
    RECORDER.flush();
}
