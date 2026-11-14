//! A store's save that finds the disk full (`ENOSPC`): the file keeps its old bytes (`write_atomic_if` removes its
//! temp file), the caller still gets the error and keeps its state in memory, and the same content is tried again
//! here on a backoff until it lands or a newer save of that file replaces it. Main hears of it as
//! `store.saveFailed {file}` once per file and `store.saved {file}` when the file is no longer waiting for space, and
//! tells the person once (`src/main/disk-full.ts`, `core-saves.ts`). The TypeScript twin is `writeFileAtomicDeferred`
//! in `src/main/atomic-file.ts`, which waits the same 5 s doubling to a minute.
//!
//! One lock covers every write and every bookkeeping step, so a retry never lands older content over a newer save.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::json;

use super::tree::write_atomic_if;
use crate::server::{Events, Fault};

/// Waits between tries while the disk stays full; the last one repeats.
const RETRY_MS: [u64; 5] = [5_000, 10_000, 20_000, 40_000, 60_000];

type Writer = dyn Fn(&Path, &[u8], Option<u32>, u32) -> Result<bool, Fault> + Send + Sync;

/// Whether a failed write ran out of room: its message is node's `ENOSPC: no space left on device, open '…'`.
pub(crate) fn disk_full(fault: &Fault) -> bool {
    fault.message.starts_with("ENOSPC:")
}

#[derive(Clone)]
struct Kept {
    bytes: Vec<u8>,
    mode: Option<u32>,
    dir_mode: u32,
}

struct State {
    /// The files waiting for space, with what each should hold.
    kept: HashMap<PathBuf, Kept>,
    events: Option<Events>,
}

fn announce(events: &Events, event: &str, file: &Path) {
    events.send(event, &json!({"file": file.to_string_lossy()}));
}

impl State {
    fn tell(&self, event: &str, file: &Path) {
        if let Some(events) = &self.events {
            announce(events, event, file);
        }
    }
}

pub(crate) struct Saves {
    state: Mutex<State>,
    writer: Box<Writer>,
    delays: Vec<u64>,
}

impl Saves {
    fn new(writer: Box<Writer>, delays: Vec<u64>) -> Saves {
        Saves {
            state: Mutex::new(State {
                kept: HashMap::new(),
                events: None,
            }),
            writer,
            delays,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn delay(&self, tries: usize) -> Duration {
        let last = self.delays.len().saturating_sub(1);
        let ms = self.delays.get(tries.min(last)).copied().unwrap_or(60_000);
        Duration::from_millis(ms)
    }

    /// Main is listening: every file already waiting is told again, so a failure from before is not lost.
    pub(crate) fn attach(&self, events: Events) {
        let mut state = self.lock();
        for file in state.kept.keys() {
            announce(&events, "store.saveFailed", file);
        }
        state.events = Some(events);
    }

    /// Writes `bytes` to `file`. A full disk is still returned as the error, and the content is kept and tried again;
    /// any other result means the file no longer waits for space (a newer save replaced what was kept).
    pub(crate) fn write(
        self: &Arc<Self>,
        file: &Path,
        bytes: &[u8],
        mode: Option<u32>,
        dir_mode: u32,
    ) -> Result<bool, Fault> {
        let mut state = self.lock();
        let result = (self.writer)(file, bytes, mode, dir_mode);
        if matches!(&result, Err(fault) if disk_full(fault)) {
            let kept = Kept {
                bytes: bytes.to_vec(),
                mode,
                dir_mode,
            };
            if state.kept.insert(file.to_path_buf(), kept).is_none() {
                state.tell("store.saveFailed", file);
                self.retry(file);
            }
        } else if state.kept.remove(file).is_some() {
            state.tell("store.saved", file);
        }
        result
    }

    fn remove(&self, file: &Path) -> Result<(), Fault> {
        let mut state = self.lock();
        match std::fs::remove_file(file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(crate::fs::error::NodeError::new(
                    &error,
                    "unlink",
                    Some(&file.to_string_lossy()),
                )
                .fault(crate::fs::error::Codes::None));
            }
        }
        if state.kept.remove(file).is_some() {
            state.tell("store.saved", file);
        }
        Ok(())
    }

    fn retry(self: &Arc<Self>, file: &Path) {
        let saves = Arc::clone(self);
        let file = file.to_path_buf();
        std::thread::spawn(move || {
            let mut tries = 0;
            loop {
                std::thread::sleep(saves.delay(tries));
                tries += 1;
                if !saves.retry_once(&file) {
                    return;
                }
            }
        });
    }

    fn retry_once(&self, file: &Path) -> bool {
        let mut state = self.lock();
        let Some(kept) = state.kept.get(file) else {
            return false;
        };
        let result = (self.writer)(file, &kept.bytes, kept.mode, kept.dir_mode);
        if matches!(&result, Err(fault) if disk_full(fault)) {
            return true;
        }
        if let Err(fault) = result {
            eprintln!(
                "ompdesk-core: couldn't save {} after the disk was full: {}",
                file.display(),
                fault.message
            );
        }
        state.kept.remove(file);
        state.tell("store.saved", file);
        false
    }
}

static SAVES: LazyLock<Arc<Saves>> = LazyLock::new(|| {
    Arc::new(Saves::new(
        Box::new(|file, bytes, mode, dir_mode| {
            write_atomic_if(file, bytes, mode, dir_mode, &|| true)
        }),
        RETRY_MS.to_vec(),
    ))
});

/// `write_atomic_if(file, bytes, mode, dir_mode, &|| true)` for a store that keeps its state in memory and saves it on
/// every change: on a full disk the content waits and is saved when there is room (`Saves::write`).
pub(crate) fn write_kept(
    file: &Path,
    bytes: &[u8],
    mode: Option<u32>,
    dir_mode: u32,
) -> Result<bool, Fault> {
    SAVES.write(file, bytes, mode, dir_mode)
}

/// Deletes a store and withdraws a pending retry under the same lock as saves.
pub(crate) fn remove_kept(file: &Path) -> Result<(), Fault> {
    SAVES.remove(file)
}

/// Where `store.saveFailed` and `store.saved` go: the connection main speaks on.
pub(crate) fn attach(events: Events) {
    SAVES.attach(events);
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    use serde_json::Value;
    use tokio::sync::mpsc::UnboundedReceiver;

    use super::*;
    use crate::wire::Frame;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-saves-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn enospc() -> Fault {
        Fault::new("io", "ENOSPC: no space left on device, open 'x.tmp'")
    }

    /// A disk that can be full: while it is, nothing is written and the file keeps its bytes (as `write_atomic_if`
    /// leaves it); otherwise the real atomic write.
    fn disk(full: &Arc<AtomicBool>, other: Option<&'static str>) -> Box<Writer> {
        let full = Arc::clone(full);
        Box::new(move |file, bytes, mode, dir_mode| {
            if let Some(message) = other {
                return Err(Fault::new("io", message));
            }
            if full.load(Ordering::SeqCst) {
                return Err(enospc());
            }
            write_atomic_if(file, bytes, mode, dir_mode, &|| true)
        })
    }

    fn heard(frames: &mut UnboundedReceiver<Frame>) -> Vec<(String, String)> {
        let mut out = Vec::new();
        while let Ok(frame) = frames.try_recv() {
            let value: Value = serde_json::from_slice(frame.parts().0).unwrap();
            out.push((
                value["event"].as_str().unwrap().to_string(),
                value["data"]["file"].as_str().unwrap().to_string(),
            ));
        }
        out
    }

    fn until(what: &str, mut done: impl FnMut() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < Duration::from_secs(5), "{what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_full_disk_keeps_the_old_file_tells_once_and_saves_the_newest_content_when_there_is_room() {
        let dir = temp("retry");
        let file = dir.join("state.json");
        fs::write(&file, "old").unwrap();
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![10]));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);

        let first = saves.write(&file, b"new", Some(0o600), 0o700);
        assert!(first.unwrap_err().message.starts_with("ENOSPC:"));
        assert!(saves.write(&file, b"newer", Some(0o600), 0o700).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        let name = file.to_string_lossy().to_string();
        assert_eq!(
            heard(&mut frames),
            vec![("store.saveFailed".to_string(), name.clone())]
        );

        full.store(false, Ordering::SeqCst);
        until("the newest content is saved", || {
            fs::read_to_string(&file).unwrap() == "newer"
        });
        until("the file is told as saved", || {
            !saves.lock().kept.contains_key(&file)
        });
        assert_eq!(heard(&mut frames), vec![("store.saved".to_string(), name)]);
        assert!(fs::read_dir(&dir).unwrap().count() == 1, "no temp file");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_save_that_lands_is_never_overwritten_by_the_retry_of_an_older_one() {
        let dir = temp("newer");
        let file = dir.join("state.json");
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![20]));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);

        assert!(saves.write(&file, b"older", None, 0o700).is_err());
        full.store(false, Ordering::SeqCst);
        assert!(saves.write(&file, b"newer", None, 0o700).unwrap());
        assert_eq!(fs::read_to_string(&file).unwrap(), "newer");

        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(fs::read_to_string(&file).unwrap(), "newer");
        let events: Vec<String> = heard(&mut frames)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(events, ["store.saveFailed", "store.saved"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_that_is_not_a_full_disk_is_only_returned() {
        let dir = temp("other");
        let file = dir.join("state.json");
        let full = Arc::new(AtomicBool::new(false));
        let saves = Arc::new(Saves::new(
            disk(&full, Some("EACCES: permission denied, open 'x'")),
            vec![10],
        ));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);

        assert!(saves.write(&file, b"x", None, 0o700).is_err());
        assert!(heard(&mut frames).is_empty());
        assert!(saves.lock().kept.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_full_disk_save_withdraws_its_retry_without_recreating_the_file() {
        let dir = temp("remove");
        let file = dir.join("state.json");
        fs::write(&file, "old").unwrap();
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![60_000]));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);
        assert!(saves.write(&file, b"stale", None, 0o700).is_err());
        saves.remove(&file).unwrap();
        full.store(false, Ordering::SeqCst);
        assert!(!saves.retry_once(&file));
        assert!(!file.exists());
        saves.remove(&file).unwrap();
        let events: Vec<_> = heard(&mut frames)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(events, ["store.saveFailed", "store.saved"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_removal_keeps_the_pending_save_and_its_warning() {
        let dir = temp("remove-failed");
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![60_000]));
        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);
        assert!(saves.write(&dir, b"pending", None, 0o700).is_err());
        assert!(saves.remove(&dir).is_err());
        assert!(saves.lock().kept.contains_key(&dir));
        let events: Vec<_> = heard(&mut frames)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(events, ["store.saveFailed"]);
        saves.lock().kept.clear();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_that_failed_before_main_listened_is_told_when_it_does() {
        let dir = temp("attach");
        let file = dir.join("state.json");
        let full = Arc::new(AtomicBool::new(true));
        let saves = Arc::new(Saves::new(disk(&full, None), vec![60_000]));
        assert!(saves.write(&file, b"x", None, 0o700).is_err());

        let (events, _keep, mut frames) = Events::capture();
        saves.attach(events);
        let name = file.to_string_lossy().to_string();
        assert_eq!(
            heard(&mut frames),
            vec![("store.saveFailed".to_string(), name)]
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
