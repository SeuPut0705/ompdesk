//! Where a tree's raw changes come from: one recursive watch of the whole tree by the operating system, never one
//! per folder. libuv's macOS backend keeps one FSEvents stream for all its watches and recreates it, from "now",
//! whenever a watched folder is added or removed, so a watch per folder dropped the new and removed session files of
//! the whole tree that the old stream had not delivered yet.
//!
//! - Windows: `ReadDirectoryChangesW` on the root (`sys.rs`), read by one thread.
//! - macOS: one FSEvents stream on the root (the `notify` crate), file events, no latency.
//! - Anything else (Linux, where the core is built only for the tests CI runs there): the three levels the index
//!   looks at are read again every 300 ms and compared.

use std::io;
use std::path::Path;

/// What a source says.
pub enum Raw {
    /// Entries that changed, relative to the root, the system's separator between segments; the empty name is the
    /// root itself.
    Names(Vec<String>),
    /// The system dropped changes: anything may have changed. (A scan drops none.)
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    Anything,
    /// The source stopped by itself, and why.
    Ended(String),
}

#[cfg(windows)]
pub use tree::start;

#[cfg(target_os = "macos")]
pub use fsevents::start;

#[cfg(not(any(windows, target_os = "macos")))]
pub use scan::start;

#[cfg(windows)]
mod tree {
    use std::thread::JoinHandle;

    use super::{Path, Raw, io};
    use crate::sys::{DirChange, DirChanges, StopDirChanges};

    /// Room for about 800 changed names between two reads; 64 KiB is also the most a network volume takes.
    const BUFFER_BYTES: usize = 64 * 1024;

    /// A running watch; dropping it stops its thread.
    pub struct Source {
        stop: StopDirChanges,
        thread: Option<JoinHandle<()>>,
    }

    /// Watches `root`. Once this returned, every change under it is named, or reported as `Anything`.
    pub fn start(root: &Path, raw: impl Fn(Raw) + Send + 'static) -> io::Result<Source> {
        let (mut changes, stop) = DirChanges::open(root, BUFFER_BYTES)?;
        let thread = std::thread::Builder::new()
            .name("sessions watch".into())
            .spawn(move || {
                loop {
                    match changes.next() {
                        Ok(DirChange::Names(names)) => raw(Raw::Names(names)),
                        Ok(DirChange::Overflow) => raw(Raw::Anything),
                        Ok(DirChange::Stopped) => break,
                        Err(error) => {
                            raw(Raw::Ended(error.to_string()));
                            break;
                        }
                    }
                }
            })?;
        Ok(Source {
            stop,
            thread: Some(thread),
        })
    }

    impl Drop for Source {
        fn drop(&mut self) {
            self.stop.stop();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod fsevents {
    use notify::{RecursiveMode, Watcher};

    use super::{Path, Raw, io, relative};

    /// A running watch; dropping it ends its stream.
    pub struct Source {
        _watcher: notify::RecommendedWatcher,
    }

    /// Watches `root` with one FSEvents stream. The stream starts delivering a moment after this returned.
    pub fn start(root: &Path, raw: impl Fn(Raw) + Send + 'static) -> io::Result<Source> {
        let given = root.to_path_buf();
        // FSEvents names what changed by its real path (`/private/var/…` for a root given as `/var/…`).
        let real = std::fs::canonicalize(root)?;
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
                Ok(event) if event.need_rescan() => raw(Raw::Anything),
                Ok(event) => {
                    let names: Vec<String> = event
                        .paths
                        .iter()
                        .filter_map(|path| relative(path, &real, &given))
                        .collect();
                    if !names.is_empty() {
                        raw(Raw::Names(names));
                    }
                }
                Err(error) => raw(Raw::Ended(error.to_string())),
            })
            .map_err(io::Error::other)?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| match error.kind {
                notify::ErrorKind::PathNotFound => io::Error::from(io::ErrorKind::NotFound),
                notify::ErrorKind::Io(inner) => inner,
                other => io::Error::other(format!("{other:?}")),
            })?;
        Ok(Source { _watcher: watcher })
    }
}

/// `path` relative to the root, which the system may name by its real path or as it was given.
#[cfg(any(target_os = "macos", test))]
fn relative(path: &Path, real: &Path, given: &Path) -> Option<String> {
    let name = path
        .strip_prefix(real)
        .or_else(|_| path.strip_prefix(given))
        .ok()?;
    Some(name.to_string_lossy().into_owned())
}

#[cfg(any(test, not(any(windows, target_os = "macos"))))]
mod scan {
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::JoinHandle;
    use std::time::{Duration, SystemTime};

    use super::super::rules;
    use super::{Path, Raw, io};

    const EVERY: Duration = Duration::from_millis(300);

    /// Each looked-at entry's modification time and size.
    type Seen = HashMap<String, (Option<SystemTime>, u64)>;

    /// A running scan; dropping it stops its thread.
    pub struct Source {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    /// Reads the tree now and again every 300 ms, and names what differs. A root that cannot be read ends it.
    pub fn start(root: &Path, raw: impl Fn(Raw) + Send + 'static) -> io::Result<Source> {
        let mut seen = scan(root)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let root = root.to_path_buf();
        let thread = std::thread::Builder::new()
            .name("sessions scan".into())
            .spawn(move || {
                loop {
                    std::thread::park_timeout(EVERY);
                    if stopped.load(Ordering::Acquire) {
                        break;
                    }
                    let now = match scan(&root) {
                        Ok(now) => now,
                        Err(error) => {
                            raw(Raw::Ended(error.to_string()));
                            break;
                        }
                    };
                    let names = changed(&seen, &now);
                    seen = now;
                    if !names.is_empty() {
                        raw(Raw::Names(names));
                    }
                }
            })?;
        Ok(Source {
            stop,
            thread: Some(thread),
        })
    }

    impl Drop for Source {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                thread.thread().unpark();
                let _ = thread.join();
            }
        }
    }

    fn scan(root: &Path) -> io::Result<Seen> {
        let mut seen = Seen::new();
        for entry in fs::read_dir(root)? {
            look(&entry?, "", &mut seen);
        }
        Ok(seen)
    }

    fn look(entry: &fs::DirEntry, parent: &str, seen: &mut Seen) {
        let name = format!("{parent}{}", entry.file_name().to_string_lossy());
        let Ok(meta) = entry.metadata() else {
            return;
        };
        if meta.is_dir() && name.split('/').count() < rules::SESSION_FILE_SEGMENTS {
            let inside = format!("{name}/");
            for child in fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                look(&child, &inside, seen);
            }
        }
        if rules::watched(&name) {
            seen.insert(name, (meta.modified().ok(), meta.len()));
        }
    }

    /// The names that are new, differ or are gone.
    fn changed(before: &Seen, now: &Seen) -> Vec<String> {
        let differs = now
            .iter()
            .filter(|(name, signature)| before.get(*name) != Some(signature))
            .map(|(name, _)| name.clone());
        let gone = before
            .keys()
            .filter(|name| !now.contains_key(*name))
            .cloned();
        differs.chain(gone).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    #[test]
    fn names_a_path_under_the_real_or_the_given_root() {
        let real = Path::new("/private/var/t/sessions");
        let given = Path::new("/var/t/sessions");
        let name = |path: &str| relative(Path::new(path), real, given);
        assert_eq!(
            name("/private/var/t/sessions/p/a.jsonl").map(PathBuf::from),
            Some(PathBuf::from("p").join("a.jsonl"))
        );
        assert_eq!(
            name("/var/t/sessions/p").map(PathBuf::from),
            Some(PathBuf::from("p"))
        );
        assert_eq!(name("/private/var/t/sessions").as_deref(), Some(""));
        assert_eq!(name("/private/var/t/other/a.jsonl"), None);
    }

    #[test]
    fn the_scan_names_what_appeared_changed_and_went() {
        let root = std::env::temp_dir().join(format!("ompdesk-core-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("p").join("s")).unwrap();
        std::fs::write(root.join("p").join("old.jsonl"), "{}\n").unwrap();
        let (names, seen) = mpsc::channel();
        let source = scan::start(&root, move |raw| {
            let _ = names.send(raw);
        })
        .unwrap();
        let next = || match seen.recv_timeout(Duration::from_secs(20)).unwrap() {
            Raw::Names(mut names) => {
                names.sort();
                names
            }
            Raw::Anything => panic!("a scan drops nothing"),
            Raw::Ended(why) => panic!("ended: {why}"),
        };
        // A new folder with a session written at once, a subagent's session, and files the index never looks at.
        std::fs::create_dir(root.join("q")).unwrap();
        std::fs::write(root.join("q").join("new.jsonl"), "{}\n").unwrap();
        std::fs::write(root.join("p").join("s").join("sub.jsonl"), "{}\n").unwrap();
        std::fs::write(root.join("p").join("s").join("plan.md"), "plan\n").unwrap();
        std::fs::create_dir(root.join("p").join("s").join("deep")).unwrap();
        std::fs::write(
            root.join("p").join("s").join("deep").join("x.jsonl"),
            "{}\n",
        )
        .unwrap();
        let mut named = Vec::new();
        while !["q", "q/new.jsonl", "p/s/sub.jsonl"]
            .iter()
            .all(|name| named.iter().any(|seen| seen == name))
        {
            named.extend(next());
        }
        assert!(
            !named
                .iter()
                .any(|name| name.ends_with("plan.md") || name.contains("deep")),
            "{named:?}"
        );
        std::fs::remove_file(root.join("p").join("old.jsonl")).unwrap();
        let mut named = Vec::new();
        while !named.iter().any(|name| name == "p/old.jsonl") {
            named.extend(next());
        }
        // The root going ends the scan.
        std::fs::remove_dir_all(&root).unwrap();
        loop {
            match seen.recv_timeout(Duration::from_secs(20)).unwrap() {
                Raw::Ended(_) => break,
                Raw::Names(_) => {}
                Raw::Anything => panic!("a scan drops nothing"),
            }
        }
        drop(source);
    }
}
