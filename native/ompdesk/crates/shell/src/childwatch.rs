//! `app.childProcessGone` (PROTOCOL.md §3): CEF has no callback for the GPU or a utility process ending, so a thread
//! lists the shell's child processes once a second and reports a helper that was seen and is gone. The pure parts
//! (command line, Electron's type and reason words, the bookkeeping) are `shell_core::childproc`; the OS calls are
//! `sys::childproc` (Windows: the process handle's exit code) and `sys_mac::childproc` (macOS: the wait status from a
//! `kqueue`, read without reaping). A helper ending while the app quits is never reported.

#[cfg(windows)]
use std::time::Duration;

/// Starts the watcher, once; every page creation calls it, so it runs in the browser process only.
pub fn start() {
    #[cfg(any(windows, target_os = "macos"))]
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

#[cfg(target_os = "macos")]
fn run() {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use serde_json::json;
    use shell_core::childproc::{
        Tracker, details_from_wait_status, long_lived, watched_kind_of_args,
    };
    use shell_core::sys_mac::childproc::{ExitWatch, arguments, children_of};

    use crate::lifecycle::EXITING;
    use crate::{host, log::log};

    let Some(exits) = ExitWatch::new() else {
        log("child.watch_failed", json!({ "error": "kqueue" }));
        return;
    };
    let own = std::process::id();
    // A child is watched from the moment it is listed; its arguments may come a poll later (it is still starting).
    let mut tracker: Tracker<()> = Tracker::default();
    // Every pid seen, and whether its end can be read: one that ended before it could be watched has no status and is
    // never reported (no guess at a crash).
    let mut seen: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
    let mut statuses: std::collections::HashMap<u32, i32> = std::collections::HashMap::new();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if EXITING.load(Ordering::SeqCst) {
            return;
        }
        let children = children_of(own);
        seen.retain(|pid, _| {
            children.contains(pid) || statuses.contains_key(pid) || tracker.knows(*pid)
        });
        for pid in children {
            let watched = *seen.entry(pid).or_insert_with(|| exits.watch(pid));
            if !watched || tracker.knows(pid) {
                continue;
            }
            if let Some(args) = arguments(pid) {
                tracker.add(pid, watched_kind_of_args(&args).filter(long_lived), ());
            }
        }
        for (pid, status) in exits.ended() {
            statuses.insert(pid, status);
        }
        // Ended before its arguments were read: nothing to report it as.
        statuses.retain(|pid, _| tracker.knows(*pid));
        for (kind, status) in tracker.finished(|pid, _| statuses.remove(&pid).map(|s| s as u32)) {
            // The app is quitting: its helpers end with it, and Electron reports no crash then.
            if EXITING.load(Ordering::SeqCst) {
                return;
            }
            let data = details_from_wait_status(&kind, status as i32);
            log(
                "child.gone",
                json!({ "kind": kind.process_type, "details": data }),
            );
            host::event("app.childProcessGone", data);
        }
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
