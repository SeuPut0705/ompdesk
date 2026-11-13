//! `app.childProcessGone` (PROTOCOL.md §3): CEF has no callback for the GPU or a utility process ending, so a thread
//! lists the shell's child processes once a second and reports a helper that was seen and is gone. The pure parts
//! (command line, Electron's type and reason words, the bookkeeping) are `shell_core::childproc`; the OS calls are
//! `sys::childproc` (Windows). macOS has no watcher yet: no event there.

#[cfg(windows)]
use std::time::Duration;

/// Starts the watcher, once; every page creation calls it, so it runs in the browser process only.
pub fn start() {
    #[cfg(windows)]
    {
        use std::sync::Once;
        static START: Once = Once::new();
        START.call_once(|| {
            let _ = std::thread::Builder::new()
                .name("child-watch".into())
                .spawn(run);
        });
    }
}

#[cfg(windows)]
fn run() {
    use std::sync::atomic::Ordering;

    use serde_json::json;
    use shell_core::childproc::{Tracker, details, watched_kind};
    use shell_core::sys::childproc::{Proc, children_of, command_line, exit_code, open};

    use crate::lifecycle::EXITING;
    use crate::{host, log::log};

    let own = std::process::id();
    let mut tracker: Tracker<Proc> = Tracker::default();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if EXITING.load(Ordering::SeqCst) {
            return;
        }
        for pid in children_of(own) {
            if tracker.knows(pid) {
                continue;
            }
            let Some(process) = open(pid) else { continue };
            match command_line(&process) {
                Some(line) => tracker.add(pid, watched_kind(&line), process),
                // Not readable yet (it is still starting): try again next time; one that already ended is not worth it.
                None if exit_code(&process).is_some() => tracker.add(pid, None, process),
                None => {}
            }
        }
        for (kind, code) in tracker.finished(|_, process| exit_code(process)) {
            // The shell is closing: its helpers end with it.
            if EXITING.load(Ordering::SeqCst) {
                return;
            }
            let data = details(&kind, code);
            log(
                "child.gone",
                json!({ "kind": kind.process_type, "details": data }),
            );
            host::event("app.childProcessGone", data);
        }
    }
}
