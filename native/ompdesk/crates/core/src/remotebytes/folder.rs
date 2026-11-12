//! A cache folder under a byte bound, the least recently read leaving first: what `transcript-cache.ts` and
//! `image-blob-cache.ts` each carried (`#grew`, `#measure`, `#entries`, `#trim`), one copy for both. Nothing here is
//! ever authoritative: a file that cannot be written, read or removed is the host's to send again.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::disk::tree::write_atomic_if;

/// A trim takes the folder down to this share of the bound, so it does not run again at the next write.
const TRIM_TO: f64 = 0.75;

pub struct Folder {
    pub dir: PathBuf,
    state: Mutex<Counted>,
    /// One read of a key at a time (`#serialized`): two windows on one tab never append the same segment twice.
    turns: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Blobs being read, by reference: concurrent reads of one blob share one request.
    pub loading: Mutex<HashMap<String, Vec<tokio::sync::oneshot::Sender<Option<String>>>>>,
}

#[derive(Default)]
struct Counted {
    /// Bytes in the folder, measured at the first write; None until then.
    size: Option<u64>,
    trimming: bool,
}

static FOLDERS: LazyLock<Mutex<HashMap<PathBuf, Arc<Folder>>>> = LazyLock::new(Mutex::default);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The one `Folder` of `dir` in this process (main makes one cache per folder).
pub fn folder(dir: &Path) -> Arc<Folder> {
    locked(&FOLDERS)
        .entry(dir.to_path_buf())
        .or_insert_with(|| {
            Arc::new(Folder {
                dir: dir.to_path_buf(),
                state: Mutex::default(),
                turns: Mutex::default(),
                loading: Mutex::default(),
            })
        })
        .clone()
}

/// A key's turn: held while its read runs; the key is forgotten once nobody waits for it.
pub struct Turn {
    folder: Arc<Folder>,
    key: String,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut turns = locked(&self.folder.turns);
        // The map's and this turn's own: nobody else holds or waits for the key.
        if turns
            .get(&self.key)
            .is_some_and(|lock| Arc::strong_count(lock) <= 2)
        {
            turns.remove(&self.key);
        }
    }
}

/// When a file was last read, for the least recently read to go first.
struct Entry {
    file: PathBuf,
    size: u64,
    read: f64,
}

impl Folder {
    /// Waits for the reads of `key` before this one (in the order asked), then holds the key.
    pub async fn turn(self: &Arc<Self>, key: &str) -> Turn {
        let lock = locked(&self.turns)
            .entry(key.to_owned())
            .or_default()
            .clone();
        Turn {
            folder: self.clone(),
            key: key.to_owned(),
            _guard: lock.lock_owned().await,
        }
    }

    /// Through the shared atomic writer (Windows retries a held rename): a reader never sees part of a file. False
    /// when the disk refused it (full, read-only).
    pub fn write(self: &Arc<Self>, file: &Path, bytes: &[u8], limit: u64) -> bool {
        let written = write_atomic_if(file, bytes, None, 0o777, &|| true).is_ok();
        if written {
            self.grew(bytes.len() as u64, limit);
        }
        written
    }

    /// One more line at the end of `file` (made if missing); false when it could not be written.
    pub fn append(self: &Arc<Self>, file: &Path, bytes: &[u8], limit: u64) -> bool {
        use std::io::Write;
        let appended = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(file)
            .and_then(|mut opened| opened.write_all(bytes))
            .is_ok();
        if appended {
            self.grew(bytes.len() as u64, limit);
        }
        appended
    }

    /// The first write measures the folder (this one included); later ones add theirs. A trim measures it again and
    /// runs beside the request, as the TypeScript's `void this.#trim()` did.
    fn grew(self: &Arc<Self>, bytes: u64, limit: u64) {
        let over = {
            let mut state = locked(&self.state);
            let size = match state.size {
                None => entries(&self.dir).iter().map(|entry| entry.size).sum(),
                Some(size) => size + bytes,
            };
            state.size = Some(size);
            size > limit
        };
        if over {
            let folder = self.clone();
            tokio::task::spawn_blocking(move || folder.trim(limit));
        }
    }

    /// Removes the least recently read files (and any temporary file left by a crash) until the folder fits again.
    /// A file it cannot remove (Windows: one being read) stays and counts.
    fn trim(&self, limit: u64) {
        {
            let mut state = locked(&self.state);
            if state.trimming {
                return;
            }
            state.trimming = true;
        }
        let mut kept = entries(&self.dir);
        kept.sort_by(|a, b| a.read.total_cmp(&b.read));
        let mut total: u64 = kept.iter().map(|entry| entry.size).sum();
        for entry in kept {
            if total as f64 <= limit as f64 * TRIM_TO {
                break;
            }
            if remove(&entry.file) {
                total -= entry.size;
            }
        }
        let mut state = locked(&self.state);
        state.size = Some(total);
        state.trimming = false;
    }
}

/// `rm(file, { force: true })`: a file already gone counts as removed.
pub fn remove(file: &Path) -> bool {
    match fs::remove_file(file) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Read again: the least recently read go first when the folder is full (`utimes(file, now, now)`).
pub fn touch(file: &Path) {
    let now = SystemTime::now();
    if let Ok(opened) = fs::OpenOptions::new().write(true).open(file) {
        let _ = opened.set_times(fs::FileTimes::new().set_accessed(now).set_modified(now));
    }
}

fn entries(dir: &Path) -> Vec<Entry> {
    let Ok(names) = fs::read_dir(dir) else {
        return Vec::new();
    };
    names
        .flatten()
        .filter_map(|name| {
            let file = name.path();
            let info = fs::metadata(&file).ok()?;
            if !info.is_file() {
                return None;
            }
            let read = info
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0.0, |since| since.as_secs_f64() * 1000.0);
            Some(Entry {
                file,
                size: info.len(),
                read,
            })
        })
        .collect()
}
