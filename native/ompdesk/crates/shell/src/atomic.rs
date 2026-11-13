//! A file the shell replaces in one step (`src/main/atomic-file.ts` `writeFileAtomicSync`'s rule): written beside
//! the target, then renamed over it. On Windows the rename fails (`ERROR_ACCESS_DENIED`, a sharing violation) while
//! any process (a virus scan, a backup, an indexer) has the target open, so it is retried on a short backoff (under
//! 0.6 s in all) before the write gives up.
//!
//! Each write has a temp file of its own, so two threads writing one path never share it. That alone does not order
//! them: a writer whose writes must land in the order it decided them sends them through one `Ordered`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

const RETRY_MS: [u64; 6] = [10, 30, 60, 100, 150, 220];

/// Numbers the temp files of this process: one per write.
static TEMPS: AtomicU64 = AtomicU64::new(0);

pub fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMPS.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let mut last = std::fs::rename(&temp, path);
        for ms in RETRY_MS {
            if last.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(ms));
            last = std::fs::rename(&temp, path);
        }
        last
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// What an `Ordered` writer does with each file it is handed.
pub type WriteFn = Box<dyn Fn(&Path, &[u8]) + Send>;

enum Job {
    Write(PathBuf, Vec<u8>),
    Flush(Sender<()>),
}

/// One thread that writes the files it is handed, one after another, in the order they were handed in. `submit`
/// never waits for the disk, so a caller can submit while holding the lock its decision was made under: the order of
/// the decisions is then the order of the writes, whichever thread decided.
pub struct Ordered {
    jobs: Sender<Job>,
}

impl Ordered {
    /// `name` is the thread's; `write` does each write (`write` above, plus whatever the file needs after it).
    pub fn new(name: &str, write: WriteFn) -> Self {
        let (jobs, queue) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                for job in queue {
                    match job {
                        Job::Write(path, bytes) => write(&path, &bytes),
                        Job::Flush(done) => {
                            let _ = done.send(());
                        }
                    }
                }
            })
            .expect("ordered writer thread");
        Self { jobs }
    }

    pub fn submit(&self, path: PathBuf, bytes: Vec<u8>) {
        let _ = self.jobs.send(Job::Write(path, bytes));
    }

    /// Waits until every write submitted before it has been done.
    pub fn flush(&self) {
        let (done, wait) = mpsc::channel();
        if self.jobs.send(Job::Flush(done)).is_ok() {
            let _ = wait.recv();
        }
    }
}

/// Waits between tries while the disk stays full; the last one repeats (`DISK_FULL_RETRY_MS` in
/// `src/main/atomic-file.ts`, `RETRY_MS` in the core's `disk/saves.rs`).
pub const DISK_FULL_RETRY_MS: [i64; 5] = [5_000, 10_000, 20_000, 40_000, 60_000];

/// What a save asks its owner to do.
#[derive(Debug)]
pub enum Outcome {
    /// Written; `cleared` when it ended a wait for space (tell main the file was saved).
    Saved { cleared: bool },
    /// The disk is full (`ENOSPC`, or the quota: `EDQUOT`): the content waits here. `first` when the file just started waiting (tell main, and
    /// schedule `retry` after `next_delay`); a retry that finds the disk still full schedules the next one.
    Kept { first: bool },
    /// Another failure: nothing waits any more (`cleared` when something did).
    Failed {
        cleared: bool,
        error: std::io::Error,
    },
}

/// One file a store saves whole, which a full disk does not lose: the content that could not be written waits here,
/// answers reads, and is tried again until it lands or a newer save replaces it (`src/main/safe-store.ts`'s rule for
/// electron-store files). The owner times the retries and tells main.
pub struct KeptFile {
    path: PathBuf,
    kept: Option<Vec<u8>>,
    tries: usize,
}

impl KeptFile {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            kept: None,
            tries: 0,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// What the file holds for a reader: what waits for space, else the file.
    pub fn read(&self) -> Option<String> {
        match &self.kept {
            Some(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            None => std::fs::read_to_string(&self.path).ok(),
        }
    }

    pub fn save(
        &mut self,
        bytes: Vec<u8>,
        write: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
    ) -> Outcome {
        match write(&self.path, &bytes) {
            Ok(()) => Outcome::Saved {
                cleared: self.settle(),
            },
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
                ) =>
            {
                let first = self.kept.replace(bytes).is_none();
                if first {
                    self.tries = 0;
                }
                Outcome::Kept { first }
            }
            Err(error) => Outcome::Failed {
                cleared: self.settle(),
                error,
            },
        }
    }

    /// Tries what waits again; `None` when nothing waits (a newer save landed meanwhile).
    pub fn retry(
        &mut self,
        write: impl Fn(&Path, &[u8]) -> std::io::Result<()>,
    ) -> Option<Outcome> {
        let bytes = self.kept.clone()?;
        Some(match self.save(bytes, write) {
            Outcome::Kept { .. } => Outcome::Kept { first: false },
            other => other,
        })
    }

    /// The wait before the next retry.
    pub fn next_delay(&mut self) -> i64 {
        let delay = DISK_FULL_RETRY_MS[self.tries.min(DISK_FULL_RETRY_MS.len() - 1)];
        self.tries += 1;
        delay
    }

    fn settle(&mut self) -> bool {
        self.kept.take().is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shell-atomic-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn replaces_the_file_and_leaves_no_temp() {
        let dir = scratch("replace");
        let path = dir.join("nested").join("state.json");
        super::write(&path, b"one").unwrap();
        super::write(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Two threads of one process used to share `.<name>.<pid>.tmp`: one could truncate the other's half-written file
    /// and rename it into place.
    #[test]
    fn threads_writing_one_path_at_once_leave_one_whole_file() {
        let dir = scratch("race");
        let path = dir.join("marker.json");
        let payloads: Vec<Vec<u8>> = (0..8u8).map(|n| vec![b'a' + n; 64 * 1024]).collect();
        let start = Arc::new(Barrier::new(payloads.len()));
        let threads: Vec<_> = payloads
            .iter()
            .cloned()
            .map(|bytes| {
                let (path, start) = (path.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    super::write(&path, &bytes)
                })
            })
            .collect();
        for thread in threads {
            // On Windows a rename can lose to another writer's open handle past the retries; the file stays whole.
            let _ = thread.join().unwrap();
        }
        let left = std::fs::read(&path).unwrap();
        assert!(
            payloads.contains(&left),
            "the file is one writer's whole payload"
        );
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "no temp file left"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_ordered_writer_writes_in_submission_order_even_when_the_first_write_is_slow() {
        let dir = scratch("ordered");
        let path = dir.join("marker.json");
        // The first write waits until the second was submitted: the race of a slow write and a newer one.
        let second_submitted = Arc::new(Barrier::new(2));
        let gate = second_submitted.clone();
        let writes = std::sync::atomic::AtomicUsize::new(0);
        let writer = super::Ordered::new(
            "test-ordered",
            Box::new(move |path, bytes| {
                if writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    gate.wait();
                }
                super::write(path, bytes).unwrap();
            }),
        );
        writer.submit(path.clone(), b"older".to_vec());
        writer.submit(path.clone(), b"newer".to_vec());
        second_submitted.wait();
        writer.flush();
        assert_eq!(std::fs::read(&path).unwrap(), b"newer");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The disk fills, a newer save comes while the first waits, the disk frees: the newest content lands once, reads
    /// saw it all along, and main is told the file waits once and is saved once.
    #[test]
    fn a_full_disk_keeps_the_newest_save_and_retries_it_until_it_lands() {
        use super::{KeptFile, Outcome};
        use std::cell::{Cell, RefCell};
        let dir = scratch("kept");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("window-state.json");
        std::fs::write(&path, "old").unwrap();
        let full = Cell::new(true);
        let written = RefCell::new(Vec::<String>::new());
        let write = |p: &std::path::Path, bytes: &[u8]| {
            if full.get() {
                return Err(std::io::Error::from(std::io::ErrorKind::StorageFull));
            }
            written
                .borrow_mut()
                .push(String::from_utf8_lossy(bytes).into_owned());
            super::write(p, bytes)
        };
        let mut file = KeptFile::new(path.clone());

        assert!(matches!(
            file.save(b"one".to_vec(), write),
            Outcome::Kept { first: true }
        ));
        assert_eq!(
            file.read().as_deref(),
            Some("one"),
            "a reader sees what waits, not the old file"
        );
        assert_eq!(file.next_delay(), 5_000);
        assert!(matches!(
            file.save(b"two".to_vec(), write),
            Outcome::Kept { first: false }
        ));
        assert!(matches!(
            file.retry(write),
            Some(Outcome::Kept { first: false })
        ));
        assert_eq!(file.next_delay(), 10_000);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");

        full.set(false);
        assert!(matches!(
            file.retry(write),
            Some(Outcome::Saved { cleared: true })
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        assert!(file.retry(write).is_none(), "nothing waits once it landed");
        assert!(matches!(
            file.save(b"three".to_vec(), write),
            Outcome::Saved { cleared: false }
        ));
        assert_eq!(*written.borrow(), ["two", "three"]);

        // Another failure ends the wait (the notice clears) instead of retrying forever.
        full.set(true);
        assert!(matches!(
            file.save(b"four".to_vec(), write),
            Outcome::Kept { first: true }
        ));
        let denied = |_: &std::path::Path, _: &[u8]| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        };
        assert!(matches!(
            file.retry(denied),
            Some(Outcome::Failed { cleared: true, .. })
        ));
        assert_eq!(file.read().as_deref(), Some("three"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
