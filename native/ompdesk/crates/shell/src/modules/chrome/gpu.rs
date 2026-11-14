//! The GPU fallback and the launch history (was `src/main/gpu-fallback.ts`, `gpu-fallback-core.ts`, `launch-guard.ts`,
//! `launch-guard-core.ts`; the rules are `shell_core::chrome_core::{gpu, launch}`). Before CEF starts (`before_cef`)
//! the shell records the launch in `<userData>/launch-history.json`, finds a crash loop (safe mode), settles the
//! marker `<userData>/gpu-fallback.json` and decides whether hardware acceleration is off (`app.rs` appends the
//! switches). Once ready it names the GPU for the marker, hears from the shell's child watcher (`childwatch.rs`) when a GPU process ends and relaunches into software rendering as the rules
//! say. The other chrome areas use `software`.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use shell_core::atomic;
use shell_core::childproc::watched_kind_of_args;
use shell_core::chrome_core::gpu::{
    Files, Gone, GoneDetails, Gpu, LogLine, Start, gpu_args_are_software,
};
use shell_core::chrome_core::launch::STABLE_AFTER_MS;

use crate::host::{self, Call};
use crate::log::log;
use crate::modules::Ctx;

const MARKER_FILE: &str = "gpu-fallback.json";
const HISTORY_FILE: &str = "launch-history.json";

/// `<userData>` files of the launch, written as `atomic-file.ts` wrote them (both are advisory).
struct Disk {
    dir: PathBuf,
}

impl Files for Disk {
    fn marker(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join(MARKER_FILE)).ok()
    }

    fn write_marker(&mut self, text: &str) {
        // Without the marker the next launch just retries hardware acceleration.
        let _ = atomic::write(&self.dir.join(MARKER_FILE), text.as_bytes());
    }

    fn remove_marker(&mut self) -> bool {
        match std::fs::remove_file(self.dir.join(MARKER_FILE)) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        }
    }

    fn history(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join(HISTORY_FILE)).ok()
    }

    fn write_history(&mut self, text: &str) {
        // A launch that cannot record itself still starts.
        let _ = atomic::write(&self.dir.join(HISTORY_FILE), text.as_bytes());
    }
}

struct State {
    gpu: Gpu,
    disk: Disk,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// Runtime-log lines: queued until Node is connected (`ready`), then sent as they come, in order.
struct Lines {
    ctx: Option<Ctx>,
    pending: Vec<Value>,
}

static LINES: Mutex<Lines> = Mutex::new(Lines {
    ctx: None,
    pending: Vec::new(),
});

fn emit(lines: Vec<LogLine>) {
    let mut sink = LINES.lock().unwrap();
    for line in lines {
        let report = line.report();
        // The shell's own log keeps the line too: the parity suite reads it there (Node's file is written later).
        log("chrome.runtime_log", report.clone());
        match sink.ctx {
            Some(ctx) => ctx.runtime_log(report, None),
            None => sink.pending.push(report),
        }
    }
}

const TEST_SEAM_ENV: &str = "OMP_GUI_TEST_GPU_GONE";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn has_switch(args: &[String], name: &str) -> bool {
    let bare = format!("--{name}");
    args.iter()
        .any(|a| *a == bare || a.starts_with(&format!("{bare}=")))
}

/// Before CEF starts, once, after the single-instance lock is held (a second launch hands over and exits, and must not
/// count): `startLaunchGuard` then `applyGpuFallbackIfNeeded(safeMode)` of the old `index.ts`. The guard runs in a
/// packaged launch that is no test, or when `OMP_GUI_LAUNCH_GUARD=1` forces it (a dev run restarts on every edit and
/// e2e kills apps on purpose).
pub fn before_cef(user_data: &Path, packaged: bool, args: &[String]) {
    let test_launch = std::env::var("OMP_GUI_HEADLESS").is_ok_and(|v| v == "1");
    let guard_on =
        (packaged && !test_launch) || std::env::var("OMP_GUI_LAUNCH_GUARD").is_ok_and(|v| v == "1");
    let mut disk = Disk {
        dir: user_data.to_path_buf(),
    };
    let mut logs = Vec::new();
    let gpu = Gpu::start(
        &mut disk,
        Start {
            guard_on,
            enable_gpu: has_switch(args, "enable-gpu"),
            disable_gpu: has_switch(args, "disable-gpu"),
            test_launch,
            now: now_ms(),
        },
        &mut logs,
    );
    log(
        "gpu.launch",
        json!({ "software": gpu.software_launch(), "safeMode": gpu.safe_mode(), "guard": guard_on }),
    );
    *STATE.lock().unwrap() = Some(State { gpu, disk });
    emit(logs);
}

/// Runs `f` on the launch state; its log lines are sent once the state is released.
fn with_state(f: impl FnOnce(&mut Gpu, &mut Disk, &mut Vec<LogLine>)) {
    let mut logs = Vec::new();
    if let Some(state) = STATE.lock().unwrap().as_mut() {
        f(&mut state.gpu, &mut state.disk, &mut logs);
    }
    emit(logs);
}

/// This launch turned hardware acceleration off before ready (the marker, safe mode or `--disable-gpu`): `app.rs`
/// appends the switches.
pub fn software_launch() -> bool {
    STATE
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.gpu.software_launch())
}

fn safe_mode() -> bool {
    STATE
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.gpu.safe_mode())
}

/// What the latest GPU process was launched to do: 0 not seen yet, 1 hardware, 2 software.
static GPU_MODE: AtomicU8 = AtomicU8::new(0);
/// CEF is about to start a helper process with `args` (the browser-process handler, on the launcher thread). The
/// GPU process's own arguments say which mode Chromium chose for it (a blocklisted driver, no GPU, a CI runner).
pub fn child_launching(args: &[String]) {
    let is_gpu = watched_kind_of_args(args).is_some_and(|kind| kind.process_type == "gpu-process");
    if is_gpu {
        let mode = if gpu_args_are_software(args) { 2 } else { 1 };
        GPU_MODE.store(mode, Ordering::SeqCst);
    }
}

/// Whether pages composite in software now: the launch decided it, or Chromium started its GPU process in a software
/// mode (a blocklisted driver, no GPU, a CI runner).
pub fn software_now() -> bool {
    software_launch() || GPU_MODE.load(Ordering::SeqCst) == 2
}

/// Who waits on the UI thread to learn the composite mode.
type Waiter = Box<dyn FnOnce(bool)>;

thread_local! {
    static RESOLVED: Cell<Option<bool>> = const { Cell::new(None) };
    static ASKED: Cell<bool> = const { Cell::new(false) };
    static WAITERS: RefCell<Vec<Waiter>> = const { RefCell::new(Vec::new()) };
}

/// Calls `then` (UI thread) with whether pages composite in software, once the GPU process reported (asked once per
/// launch and logged). A hardware launch waits up to 5 s for Chromium to start its GPU process, the one fact CEF gives
/// of the mode it chose; a launch that turned hardware off itself knows at once.
pub fn software(then: impl FnOnce(bool) + 'static) {
    if let Some(known) = RESOLVED.get() {
        return then(known);
    }
    WAITERS.with(|w| w.borrow_mut().push(Box::new(then)));
    if ASKED.replace(true) {
        return;
    }
    std::thread::Builder::new()
        .name("gpu-rendering".into())
        .spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !software_launch()
                && GPU_MODE.load(Ordering::SeqCst) == 0
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            let software = software_now();
            let status = if software {
                "disabled_software"
            } else {
                "enabled"
            };
            emit(vec![LogLine::gpu(
                format!(
                    "gpu_compositing: {status} ({})",
                    if software { "software" } else { "hardware" }
                ),
                Some(json!({ "features": { "gpu_compositing": status } })),
            )]);
            crate::ui::post(move || {
                RESOLVED.set(Some(software));
                for waiter in WAITERS.take() {
                    waiter(software);
                }
            });
        })
        .expect("gpu rendering thread");
}

pub fn request(_ctx: Ctx, call: Call) -> Option<Call> {
    match call.method.as_str() {
        "chrome.safeMode" => {
            call.ok(json!({ "safeMode": safe_mode(), "software": software_launch() }))
        }
        "chrome.rendering" => crate::ui::run(move || {
            software(move |software| call.ok(json!({ "software": software })))
        }),
        _ => return Some(call),
    }
    None
}

/// The committed native quit, like the old `will-quit`, ends this launch's crash-loop candidate.
pub(super) fn mark_stable() {
    with_state(|gpu, disk, _| gpu.mark_stable(disk));
}

pub fn event(_ctx: Ctx, name: &str, data: &Value) -> bool {
    match name {
        // `will-quit`: a clean quit ends no crash loop.
        "chrome.stable" => mark_stable(),
        // Test seam (`OMP_GUI_TEST_GPU_GONE=1`): the exit of a GPU process, as the watcher would report it, since a
        // real GPU crash cannot be made on demand. `upMs` replaces the launch's age.
        "chrome.testGpuGone" if std::env::var_os(TEST_SEAM_ENV).is_some() => {
            let reason = data["reason"].as_str().unwrap_or("crashed");
            host::event(
                "app.childProcessGone",
                json!({ "type": "GPU", "reason": reason, "exitCode": data["exitCode"] }),
            );
            gpu_gone(
                reason,
                data["exitCode"].as_i64().unwrap_or(-1),
                data["upMs"].as_f64(),
            );
        }
        _ => return false,
    }
    true
}

pub fn ready(ctx: Ctx) {
    {
        let mut sink = LINES.lock().unwrap();
        sink.ctx = Some(ctx);
        for report in std::mem::take(&mut sink.pending) {
            ctx.runtime_log(report, None);
        }
    }
    // The GPU the crash marker compares: a changed driver brings hardware back.
    std::thread::Builder::new()
        .name("gpu-identity".into())
        .spawn(|| {
            let devices = Value::Array(crate::appops::gpu_devices());
            with_state(|gpu, disk, logs| gpu.record_identity(disk, Some(&devices), logs));
        })
        .expect("gpu identity thread");
    // A launch that ran this long, or quits cleanly sooner, ends no crash loop; a hardware trial that ran this long
    // keeps hardware. A relaunch's exit and a crash skip both.
    std::thread::Builder::new()
        .name("gpu-stable".into())
        .spawn(|| {
            std::thread::sleep(Duration::from_millis(STABLE_AFTER_MS as u64));
            with_state(|gpu, disk, logs| gpu.stable_after_delay(disk, logs));
        })
        .expect("gpu stable thread");
}

pub fn shutdown(_ctx: Ctx) {}

/// A helper process of the shell ended (`childwatch.rs`, which also tells Node `app.childProcessGone` with the same
/// `details`, Electron's shape). A GPU process that crashed asks the rules whether to relaunch into software; the
/// watcher never reports once the quit began.
pub fn child_gone(details: &Value) {
    if details["type"] != "GPU" {
        return;
    }
    let reason = details["reason"].as_str().unwrap_or("crashed");
    gpu_gone(reason, details["exitCode"].as_i64().unwrap_or(-1), None);
}

/// A GPU process ended (`reason` as Electron names it): the rules decide whether it relaunches into software.
/// `up_ms` is the launch's age (the shell's own clock when `None`).
fn gpu_gone(reason: &str, exit_code: i64, up_ms: Option<f64>) {
    let mut relaunch = false;
    with_state(|gpu, disk, logs| {
        let details = GoneDetails {
            kind: "GPU".into(),
            reason: reason.into(),
            exit_code: Some(exit_code),
        };
        let up_ms = up_ms.unwrap_or_else(|| crate::log::now_ms() as f64);
        relaunch = gpu.gone(disk, &details, now_ms(), up_ms, logs) == Gone::Relaunch;
    });
    if relaunch {
        // `app.relaunch(); app.exit(0)`: the same launch arguments, no quit sequence.
        crate::ui::post(|| {
            crate::lifecycle::set_relaunch(None);
            crate::lifecycle::request_exit(0);
        });
    }
}
