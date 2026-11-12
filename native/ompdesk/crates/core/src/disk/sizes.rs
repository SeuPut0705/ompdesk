//! Disk use of folders, measured again every run without reading every file again (was `src/main/disk/tree-sizes.ts`
//! and `usage.ts`'s `diskBytes`). What each directory held directly (its files' bytes and its child directories) is
//! kept with the directory's mtime and inode, and reused while both are unchanged and the mtime is more than
//! `RACY_MS` older than the reading that saw it (git's racy rule, for coarse timestamps). A directory's mtime moves
//! whenever an entry is added, removed or renamed in it; a file rewritten in place does not move it, so main asks
//! for a full walk at least every `FULL_WALK_EVERY_MS` (`tree-sizes.ts`).
//!
//! Bytes are what `du` counts where the system reports allocated blocks (a sparse file what it holds, a clone in
//! full), the size on Windows; a file with several hard links counts once per measured target. Nothing is followed:
//! a link (a junction on Windows) is an entry of its own size. An entry that vanishes or cannot be read counts 0, a
//! directory that cannot be listed holds nothing, as the TypeScript's `catch` had it.
//!
//! The walk runs on `WALK_THREADS` threads, and the file system calls of every walk in this process share
//! `WALK_THREADS` slots, so one measurement of many parts never has more calls in flight than that.
//!
//! A reading (`open`, `bytes` per target, `save`) lives in this process between requests, keyed by an id main holds;
//! opening a reading of a file drops any earlier reading of it, so at most one per file is kept.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};

use super::tree::{live, write_atomic};
use crate::fs::disk::{self, Kind, mtime_ms};
use crate::server::{Fault, Scope};

/// A directory is reused only when its mtime is this much older than the reading that saw it.
const RACY_MS: f64 = 2_000.0;
/// Threads one walk runs on, and file system calls in flight at once across every walk of this process (measured,
/// `native-rust.md` › 2g: 4 is where this Mac's walk of `node_modules` stops getting faster).
pub const WALK_THREADS: usize = 4;

/// One directory as last read: its mtime and inode, the bytes of its direct entries that have one link, those with
/// several (`"dev:ino"` and bytes, counted once per measured target), its child directories, and whether it must be
/// read every time (`x`: a child directory's name is not UTF-8, so the kept name could not open it again).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Node {
    m: f64,
    #[serde(deserialize_with = "lenient_u64")]
    i: u64,
    f: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    h: Option<Vec<(String, u64)>>,
    d: BTreeMap<String, Node>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    x: bool,
}

/// An inode the TypeScript wrote as a JavaScript number, past 2^53 rounded (and possibly past `u64`).
fn lenient_u64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let number = serde_json::Number::deserialize(deserializer)?;
    Ok(number
        .as_u64()
        .unwrap_or_else(|| number.as_f64().map_or(0, |value| value as u64)))
}

/// A measured target: its directory tree, or the bytes of a file (or 0 for a missing one).
#[derive(Debug, Clone, PartialEq)]
pub enum Root {
    Tree(Node),
    Bytes(u64),
}

impl Serialize for Root {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Root::Tree(node) => node.serialize(serializer),
            Root::Bytes(bytes) => serializer.serialize_u64(*bytes),
        }
    }
}

impl<'de> Deserialize<'de> for Root {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Root, D::Error> {
        struct RootVisitor;
        impl<'de> Visitor<'de> for RootVisitor {
            type Value = Root;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a directory node or a number")
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Root, E> {
                Ok(Root::Bytes(value))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Root, E> {
                Ok(Root::Bytes(value.max(0) as u64))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Root, E> {
                Ok(Root::Bytes(value as u64))
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Root, A::Error> {
                Node::deserialize(de::value::MapAccessDeserializer::new(map)).map(Root::Tree)
            }
        }
        deserializer.deserialize_any(RootVisitor)
    }
}

/// `<userData>/disk-care/sizes.json`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SizesFile {
    v: Option<f64>,
    /// When the last walk that reused nothing ran (main's clock, epoch ms).
    full_at: Option<f64>,
    /// When that reading started (the wall clock, which directory mtimes follow).
    read_at: Option<f64>,
    roots: BTreeMap<String, Root>,
}

/// What one walk read.
#[derive(Debug, Default, Serialize)]
pub struct Work {
    pub lstat: u64,
    pub readdir: u64,
}

/// One target measured.
pub struct Walked {
    pub bytes: u64,
    pub root: Root,
    pub work: Work,
}

/// A process-wide count of file system calls in flight.
struct Slots {
    free: Mutex<usize>,
    freed: Condvar,
}

static SLOTS: LazyLock<Slots> = LazyLock::new(|| Slots {
    free: Mutex::new(WALK_THREADS),
    freed: Condvar::new(),
});

/// Runs `call` holding one of the process's slots.
fn slot<T>(call: impl FnOnce() -> T) -> T {
    let mut free = SLOTS.free.lock().unwrap_or_else(PoisonError::into_inner);
    while *free == 0 {
        free = SLOTS
            .freed
            .wait(free)
            .unwrap_or_else(PoisonError::into_inner);
    }
    *free -= 1;
    drop(free);
    let result = call();
    *SLOTS.free.lock().unwrap_or_else(PoisonError::into_inner) += 1;
    SLOTS.freed.notify_one();
    result
}

/// What `lstat` says of an entry, as the walk needs it.
struct Entry {
    dir: bool,
    mtime: f64,
    ino: u64,
    dev: u64,
    links: u64,
    bytes: u64,
}

/// `lstat`: allocated blocks where the system reports them, as `du` counts.
#[cfg(unix)]
fn lstat(path: &Path) -> Option<Entry> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path).ok()?;
    Some(Entry {
        dir: meta.is_dir(),
        mtime: mtime_ms(&meta),
        ino: meta.ino(),
        dev: meta.dev(),
        links: meta.nlink(),
        bytes: meta.blocks() * 512,
    })
}

/// `lstat` as libuv does it on Windows: the entry itself opened (a reparse point never followed), its size, and the
/// volume, index and links its handle reports.
#[cfg(windows)]
fn lstat(path: &Path) -> Option<Entry> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    let (volume, index, links) = crate::sys::file_identity(&file).ok()?;
    let attributes = meta.file_attributes();
    Some(Entry {
        dir: attributes & FILE_ATTRIBUTE_DIRECTORY != 0
            && attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        mtime: mtime_ms(&meta),
        ino: index,
        dev: u64::from(volume),
        links: u64::from(links),
        bytes: if meta.is_symlink() {
            crate::sys::file_link_size(&file).ok()?
        } else {
            meta.len()
        },
    })
}

enum Done {
    Gone,
    File(u64),
    Dir {
        mtime: f64,
        ino: u64,
        files: u64,
        linked: Vec<(String, u64)>,
        unreadable_names: bool,
    },
}

struct Slot<'a> {
    parent: usize,
    name: String,
    path: PathBuf,
    old: Option<&'a Node>,
    done: Option<Done>,
}

struct Shared<'a> {
    slots: Vec<Slot<'a>>,
    queue: Vec<usize>,
    active: usize,
    failed: Option<Fault>,
}

/// What one directory read gives: its own facts and its child directories to read next.
type Visit<'a> = (Done, Vec<(String, PathBuf, Option<&'a Node>)>);

/// Measures `target`, reusing `old` (what an earlier reading kept of it) where a directory did not change since
/// `read_before` saw it. Reports nothing when cancelled: the whole walk fails.
pub fn measure(
    target: &Path,
    old: Option<&Node>,
    read_before: f64,
    scope: &Scope,
) -> Result<Walked, Fault> {
    let shared = Mutex::new(Shared {
        slots: vec![Slot {
            parent: usize::MAX,
            name: String::new(),
            path: target.to_owned(),
            old,
            done: None,
        }],
        queue: vec![0],
        active: 0,
        failed: None,
    });
    let changed = Condvar::new();
    let lstats = AtomicU64::new(0);
    let readdirs = AtomicU64::new(0);
    std::thread::scope(|threads| {
        for _ in 0..WALK_THREADS {
            threads.spawn(|| {
                loop {
                    let (index, path, old) = {
                        let mut state = shared.lock().unwrap_or_else(PoisonError::into_inner);
                        loop {
                            if state.failed.is_some() {
                                return;
                            }
                            if let Some(index) = state.queue.pop() {
                                state.active += 1;
                                let slot = &state.slots[index];
                                break (index, slot.path.clone(), slot.old);
                            }
                            if state.active == 0 {
                                return;
                            }
                            state = changed.wait(state).unwrap_or_else(PoisonError::into_inner);
                        }
                    };
                    let visited = visit(&path, old, read_before, scope, &lstats, &readdirs);
                    let mut state = shared.lock().unwrap_or_else(PoisonError::into_inner);
                    state.active -= 1;
                    match visited {
                        Ok((done, children)) => {
                            state.slots[index].done = Some(done);
                            for (name, path, old) in children {
                                let child = state.slots.len();
                                state.slots.push(Slot {
                                    parent: index,
                                    name,
                                    path,
                                    old,
                                    done: None,
                                });
                                state.queue.push(child);
                            }
                        }
                        Err(fault) => state.failed = Some(fault),
                    }
                    changed.notify_all();
                }
            });
        }
    });
    let shared = shared.into_inner().unwrap_or_else(PoisonError::into_inner);
    if let Some(fault) = shared.failed {
        return Err(fault);
    }
    let work = Work {
        lstat: lstats.into_inner(),
        readdir: readdirs.into_inner(),
    };
    Ok(assemble(shared.slots, work))
}

/// Sums what the walk read and builds the tree to keep, children (always after their parent) first.
fn assemble(slots: Vec<Slot>, work: Work) -> Walked {
    let mut bytes = 0u64;
    let mut counted: HashSet<&str> = HashSet::new();
    for slot in &slots {
        match &slot.done {
            Some(Done::File(size)) => bytes += size,
            Some(Done::Dir { files, linked, .. }) => {
                bytes += files;
                for (key, size) in linked {
                    if counted.insert(key) {
                        bytes += size;
                    }
                }
            }
            Some(Done::Gone) | None => {}
        }
    }
    let root_bytes = match slots.first().and_then(|slot| slot.done.as_ref()) {
        Some(Done::File(size)) => *size,
        _ => 0,
    };
    let mut nodes: Vec<Option<Node>> = Vec::with_capacity(slots.len());
    let mut links: Vec<(usize, String)> = Vec::with_capacity(slots.len());
    for slot in slots {
        links.push((slot.parent, slot.name));
        nodes.push(match slot.done {
            Some(Done::Dir {
                mtime,
                ino,
                files,
                linked,
                unreadable_names,
            }) => Some(Node {
                m: mtime,
                i: ino,
                f: files,
                h: (!linked.is_empty()).then_some(linked),
                d: BTreeMap::new(),
                x: unreadable_names,
            }),
            Some(Done::File(_) | Done::Gone) | None => None,
        });
    }
    for index in (1..nodes.len()).rev() {
        if let Some(node) = nodes[index].take() {
            let (parent, name) = std::mem::take(&mut links[index]);
            if let Some(Some(parent)) = nodes.get_mut(parent) {
                parent.d.insert(name, node);
            }
        }
    }
    let root = match nodes.into_iter().next().flatten() {
        Some(node) => Root::Tree(node),
        None => Root::Bytes(root_bytes),
    };
    Walked { bytes, root, work }
}

/// One entry of the walk: a file's bytes, or a directory's direct files and its children to read next.
fn visit<'a>(
    path: &Path,
    old: Option<&'a Node>,
    read_before: f64,
    scope: &Scope,
    lstats: &AtomicU64,
    readdirs: &AtomicU64,
) -> Result<Visit<'a>, Fault> {
    live(scope)?;
    lstats.fetch_add(1, Ordering::Relaxed);
    let Some(entry) = slot(|| lstat(path)) else {
        return Ok((Done::Gone, Vec::new()));
    };
    if !entry.dir {
        return Ok((Done::File(entry.bytes), Vec::new()));
    }
    let same = old.is_some_and(|old| {
        old.m == entry.mtime && old.i == entry.ino && !old.x && entry.mtime < read_before - RACY_MS
    });
    if let (true, Some(old)) = (same, old) {
        let children = old
            .d
            .iter()
            .map(|(name, child)| (name.clone(), path.join(name), Some(child)))
            .collect();
        let done = Done::Dir {
            mtime: entry.mtime,
            ino: entry.ino,
            files: old.f,
            linked: old.h.clone().unwrap_or_default(),
            unreadable_names: false,
        };
        return Ok((done, children));
    }
    readdirs.fetch_add(1, Ordering::Relaxed);
    let listed = slot(|| disk::entries(path)).unwrap_or_default();
    let mut files = 0u64;
    let mut linked = Vec::new();
    let mut children = Vec::new();
    let mut unreadable_names = false;
    for item in listed {
        let child = path.join(&item.raw);
        if item.kind == Kind::Dir {
            unreadable_names |= item.raw.to_str().is_none();
            let kept = old.and_then(|old| old.d.get(&item.name));
            children.push((item.name, child, kept));
            continue;
        }
        live(scope)?;
        lstats.fetch_add(1, Ordering::Relaxed);
        let Some(file) = slot(|| lstat(&child)) else {
            continue;
        };
        if file.links < 2 {
            files += file.bytes;
        } else {
            linked.push((format!("{}:{}", file.dev, file.ino), file.bytes));
        }
    }
    let done = Done::Dir {
        mtime: entry.mtime,
        ino: entry.ino,
        files,
        linked,
        unreadable_names,
    };
    Ok((done, children))
}

/// A reading kept between requests: what an earlier run measured (`old`, when it may be reused) and what this one
/// measured so far (`next`).
pub struct Reading {
    file: PathBuf,
    reusing: bool,
    full_at: f64,
    read_before: f64,
    read_at: f64,
    old: BTreeMap<String, Root>,
    next: Mutex<BTreeMap<String, Root>>,
}

static READINGS: LazyLock<Mutex<HashMap<u64, Arc<Reading>>>> = LazyLock::new(Mutex::default);
static NEXT_READING: AtomicU64 = AtomicU64::new(1);

fn readings() -> std::sync::MutexGuard<'static, HashMap<u64, Arc<Reading>>> {
    READINGS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn wall_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_millis() as f64)
}

/// Starts a reading of `file`: an earlier measurement that is missing, unreadable or older than `full_walk_every_ms`
/// (by main's clock `now`) makes it a full walk. Answers the reading's id and whether it reuses anything.
pub fn open(file: &Path, now: f64, full_walk_every_ms: f64) -> (u64, bool) {
    let read_at = wall_ms();
    let kept: Option<SizesFile> = std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let reusing = kept.as_ref().is_some_and(|kept| {
        kept.v == Some(1.0)
            && kept.read_at.is_some()
            && kept
                .full_at
                .is_some_and(|full_at| now - full_at < full_walk_every_ms)
    });
    let (old, full_at, read_before) = match kept {
        Some(kept) if reusing => (
            kept.roots,
            kept.full_at.unwrap_or(0.0),
            kept.read_at.unwrap_or(0.0),
        ),
        _ => (BTreeMap::new(), 0.0, 0.0),
    };
    let reading = Arc::new(Reading {
        file: file.to_owned(),
        reusing,
        full_at,
        read_before,
        read_at,
        old,
        next: Mutex::default(),
    });
    let id = NEXT_READING.fetch_add(1, Ordering::Relaxed);
    let mut open = readings();
    open.retain(|_, other| other.file != reading.file);
    open.insert(id, reading);
    (id, reusing)
}

fn reading(id: u64) -> Result<Arc<Reading>, Fault> {
    readings().get(&id).cloned().ok_or_else(|| {
        Fault::new(
            "unknown_reading",
            format!("No disk reading {id}: ompdesk-core started again since it was opened"),
        )
    })
}

/// Bytes `target` (a resolved path) takes now: with a reading, reused where nothing changed (`reuse`) and kept for
/// its save; without one, a full walk that keeps nothing.
pub fn bytes(id: Option<u64>, target: &str, reuse: bool, scope: &Scope) -> Result<Walked, Fault> {
    let Some(id) = id else {
        return measure(Path::new(target), None, 0.0, scope);
    };
    let reading = reading(id)?;
    let old = match reading.old.get(target) {
        Some(Root::Tree(node)) if reuse => Some(node),
        _ => None,
    };
    let walked = measure(Path::new(target), old, reading.read_before, scope)?;
    if reuse {
        reading
            .next
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(target.to_owned(), walked.root.clone());
    }
    Ok(walked)
}

/// Keeps what the reading measured for the next run (0600 in a 0700 folder, replaced atomically, never after a
/// cancel) and ends the reading.
pub fn save(id: u64, now: f64, scope: &Scope) -> Result<(), Fault> {
    let reading = reading(id)?;
    let roots = std::mem::take(&mut *reading.next.lock().unwrap_or_else(PoisonError::into_inner));
    let data = SizesFile {
        v: Some(1.0),
        full_at: Some(if reading.reusing {
            reading.full_at
        } else {
            now
        }),
        read_at: Some(reading.read_at),
        roots,
    };
    let json =
        serde_json::to_vec(&data).map_err(|error| Fault::new("internal", error.to_string()))?;
    write_atomic(&reading.file, &json, 0o600, 0o700, scope)?;
    readings().remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-sizes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, relative: &str, bytes: usize) {
        let path = dir.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    fn full(target: &Path) -> u64 {
        measure(target, None, 0.0, &Scope::detached())
            .unwrap()
            .bytes
    }

    /// `du -sk`, which also counts directories' own blocks (none on APFS).
    #[cfg(target_os = "macos")]
    fn du(target: &Path) -> u64 {
        let output = std::process::Command::new("du")
            .args(["-sk"])
            .arg(target)
            .output()
            .unwrap();
        let text = String::from_utf8(output.stdout).unwrap();
        text.split_whitespace()
            .next()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            * 1024
    }

    /// The entry's own allocated bytes (`lstat`'s blocks).
    #[cfg(unix)]
    fn blocks(path: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        fs::symlink_metadata(path).unwrap().blocks() * 512
    }

    #[cfg(unix)]
    #[test]
    fn counts_allocated_blocks_once_per_file_and_never_follows_a_link_out_of_the_tree() {
        let dir = tree("du");
        let root = dir.join("t");
        write(&root, "a.txt", 10_000);
        write(&root, "b/c.txt", 70_000);
        write(&root, "b/d/e.txt", 1);
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::hard_link(root.join("a.txt"), root.join("b/a-again.txt")).unwrap();
        write(&dir, "outside/big.bin", 500_000);
        std::os::unix::fs::symlink(dir.join("outside"), root.join("link-dir")).unwrap();
        std::os::unix::fs::symlink(dir.join("outside/big.bin"), root.join("link-file")).unwrap();
        fs::File::create(root.join("sparse.bin"))
            .unwrap()
            .set_len(10 * 1024 * 1024)
            .unwrap();
        let walked = measure(&root, None, 0.0, &Scope::detached()).unwrap();
        let files = [
            "a.txt",
            "b/c.txt",
            "b/d/e.txt",
            "link-dir",
            "link-file",
            "sparse.bin",
        ];
        let expected: u64 = files.iter().map(|file| blocks(&root.join(file))).sum();
        assert_eq!(
            walked.bytes, expected,
            "the hard link once, the sparse file's blocks"
        );
        #[cfg(target_os = "macos")]
        assert_eq!(walked.bytes, du(&root));
        assert!(walked.bytes < 500_000, "the link's target is not counted");
        assert_eq!(
            full(&root.join("link-dir")),
            blocks(&root.join("link-dir")),
            "a link is its own entry"
        );
        assert_eq!(full(&dir.join("nope")), 0);
        assert_eq!(
            walked.work.readdir, 4,
            "t, b, b/d and empty; no link is read"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn measures_windows_links_as_entries_and_hardlinks_once() {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let dir = tree("windows-links");
        let root = dir.join("tree");
        write(&root, "file", 10_000);
        write(&dir, "outside/big", 500_000);
        fs::hard_link(root.join("file"), root.join("again")).unwrap();
        symlink_dir(dir.join("outside"), root.join("dir-link")).unwrap();
        symlink_file(dir.join("outside/big"), root.join("file-link")).unwrap();
        let measured = measure(&root, None, 0.0, &Scope::detached()).unwrap();
        let expected = 10_000
            + dir.join("outside").to_string_lossy().len() as u64
            + dir.join("outside/big").to_string_lossy().len() as u64;
        assert_eq!(measured.bytes, expected);
        assert_eq!(measured.work.readdir, 1);
        assert_eq!(
            full(&root.join("dir-link")),
            dir.join("outside").to_string_lossy().len() as u64
        );
        crate::disk::tree::remove(&dir, false, &Scope::detached()).unwrap();
    }

    #[cfg(windows)]
    #[test]
    // Windows 11, 12 Nov 2026: node captured junction=77, directory=77, file=82, gone=14, unc=22, verbatim=82 bytes.
    // Absolute target lengths depend on this run's temp path; compare with node rather than pinning that path.
    fn measures_windows_reparse_links_as_node_does() {
        let dir = tree("node-links");
        let root = dir.join("tree");
        write(&dir, "outside/kept", 100_000);
        fs::create_dir_all(&root).unwrap();
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg(
                r#"const fs = require("node:fs"), p = require("node:path");
const root = process.argv[1], outside = p.join(root, "..", "outside");
for (const [name, target, type] of [
    ["junction", p.resolve(outside), "junction"],
    ["directory", p.resolve(outside), "dir"],
    ["file", p.resolve(outside, "kept"), "file"],
    ["gone", p.join("..", "missing-한"), "file"],
    ["verbatim", "\\\\?\\" + p.resolve(outside, "kept"), "file"],
    ["unc", "\\\\?\\UNC\\server\\share\\missing", "file"],
]) fs.symlinkSync(target, p.join(root, name), type);
console.log(JSON.stringify(Object.fromEntries(fs.readdirSync(root).map(
    name => [name, fs.lstatSync(p.join(root, name)).size]
))));"#,
            )
            .arg(&root)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let captured: BTreeMap<String, u64> = serde_json::from_slice(&output.stdout).unwrap();
        println!("Windows node lstat capture: {captured:?}");
        for (name, expected) in &captured {
            assert_eq!(full(&root.join(name)), *expected, "{name}");
        }
        let measured = measure(&root, None, 0.0, &Scope::detached()).unwrap();
        assert_eq!(measured.bytes, captured.values().sum::<u64>());
        assert_eq!(measured.work.readdir, 1, "no link target is descended");
        assert_eq!(
            fs::read(dir.join("outside/kept")).unwrap(),
            vec![b'x'; 100_000]
        );
        crate::disk::tree::remove(&dir, false, &Scope::detached()).unwrap();
    }

    /// A file system that refuses a name that is not UTF-8 (APFS answers EILSEQ) cannot hold one: nothing to measure.
    #[cfg(unix)]
    #[test]
    fn measures_names_that_are_not_utf8_and_reads_their_folder_again() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tree("names");
        let odd = dir.join(std::ffi::OsStr::from_bytes(b"odd-\xff"));
        if fs::write(&odd, vec![b'x'; 9_000]).is_err() {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let folder = odd.with_extension("d");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("in.txt"), vec![b'y'; 9_000]).unwrap();
        let walked = measure(&dir, None, 0.0, &Scope::detached()).unwrap();
        assert_eq!(walked.bytes, blocks(&odd) + blocks(&folder.join("in.txt")));
        let Root::Tree(node) = walked.root else {
            panic!("a tree")
        };
        assert!(node.x, "a folder with such a child is never reused");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn counts_nothing_for_an_entry_that_vanishes_during_the_walk() {
        let dir = tree("vanish");
        write(&dir, "kept.txt", 4_096);
        let gone = dir.join("gone.txt");
        write(&dir, "gone.txt", 4_096);
        let before = full(&dir);
        fs::remove_file(&gone).unwrap();
        let after = full(&dir);
        assert!(after < before);
        let reused = Node {
            m: 0.0,
            i: 0,
            f: 0,
            h: None,
            d: BTreeMap::from([(
                "vanished".to_owned(),
                Node {
                    m: 1.0,
                    i: 1,
                    f: 5,
                    h: None,
                    d: BTreeMap::new(),
                    x: false,
                },
            )]),
            x: false,
        };
        let entry = lstat(&dir).unwrap();
        let old = Node {
            m: entry.mtime,
            i: entry.ino,
            ..reused
        };
        let walked = measure(&dir, Some(&old), f64::MAX, &Scope::detached()).unwrap();
        assert_eq!(walked.bytes, 0, "a kept child that is gone counts 0");
        let Root::Tree(node) = walked.root else {
            panic!("a tree")
        };
        assert!(node.d.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancelled_walk_reports_nothing() {
        let dir = tree("cancel");
        for index in 0..50 {
            write(&dir, &format!("d{index}/f"), 10);
        }
        let scope = Scope::detached();
        scope.cancel();
        assert_eq!(
            measure(&dir, None, 0.0, &scope).err(),
            Some(Fault::cancelled())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reading_reuses_what_did_not_change_and_keeps_it_for_the_next() {
        let dir = tree("reading");
        let target = dir.join("t");
        write(&target, "a/one", 5_000);
        write(&target, "a/b/two", 70_000);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3_600);
        for folder in ["a/b", "a", ""] {
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.access_mode(0x100).custom_flags(0x0200_0000);
            }
            options
                .open(target.join(folder))
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        let file = dir.join("sizes.json");
        let key = target.to_string_lossy().into_owned();
        let scope = Scope::detached();
        let (first, reused) = open(&file, 1_000.0, 7.0 * 86_400_000.0);
        assert!(!reused);
        let walked = bytes(Some(first), &key, true, &scope).unwrap();
        assert_eq!(walked.work.readdir, 3);
        save(first, 1_000.0, &scope).unwrap();
        let (second, reused) = open(&file, 2_000.0, 7.0 * 86_400_000.0);
        assert!(reused);
        let again = bytes(Some(second), &key, true, &scope).unwrap();
        assert_eq!((again.bytes, again.work.readdir), (walked.bytes, 0));
        let fresh = bytes(Some(second), &key, false, &scope).unwrap();
        assert_eq!((fresh.bytes, fresh.work.readdir), (walked.bytes, 3));
        save(second, 2_000.0, &scope).unwrap();
        let kept: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            kept["fullAt"], 1_000.0,
            "a reused reading keeps its full walk's time"
        );
        let (late, reused) = open(&file, 1_000.0 + 7.0 * 86_400_000.0, 7.0 * 86_400_000.0);
        assert!(
            !reused,
            "a reading past the full-walk period reuses nothing"
        );
        assert!(bytes(Some(late + 1_000), &key, true, &scope).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_a_measurement_the_typescript_kept() {
        let kept = r#"{"v":1,"fullAt":1760000000000,"readAt":1760000000123,"roots":{"/a":{"m":1759999999999.5,"i":18446744073709551616,"f":4096,"h":[["16777231:42",8192]],"d":{"b":{"m":1,"i":2,"f":0,"d":{}}}},"/f":512}}"#;
        let file: SizesFile = serde_json::from_str(kept).unwrap();
        assert_eq!(file.roots.get("/f"), Some(&Root::Bytes(512)));
        let Some(Root::Tree(node)) = file.roots.get("/a") else {
            panic!("a tree")
        };
        assert_eq!(node.i, u64::MAX);
        assert_eq!(node.h, Some(vec![("16777231:42".to_owned(), 8192)]));
        assert!(node.d.contains_key("b"));
    }

    #[test]
    fn keeps_a_directory_time_through_the_kept_file_to_the_bit() {
        let node = |m: f64, d: BTreeMap<String, Node>| Node {
            m,
            i: 1,
            f: 0,
            h: None,
            d,
            x: false,
        };
        let times: Vec<f64> = (0..1_000_000_000_u32)
            .step_by(999_983)
            .map(|nanos| 1_762_920_000_000.0 + f64::from(nanos) / 1_000_000.0)
            .collect();
        let children = times
            .iter()
            .enumerate()
            .map(|(index, time)| (index.to_string(), node(*time, BTreeMap::new())))
            .collect();
        let file = SizesFile {
            v: Some(1.0),
            full_at: Some(0.0),
            read_at: Some(0.0),
            roots: BTreeMap::from([("/r".to_owned(), Root::Tree(node(times[101], children)))]),
        };
        let kept: SizesFile = serde_json::from_slice(&serde_json::to_vec(&file).unwrap()).unwrap();
        let Some(Root::Tree(root)) = kept.roots.get("/r") else {
            panic!("a tree")
        };
        assert_eq!(root.m.to_bits(), times[101].to_bits());
        let changed: Vec<f64> = times
            .iter()
            .enumerate()
            .filter(|(index, time)| root.d[&index.to_string()].m.to_bits() != time.to_bits())
            .map(|(_, time)| *time)
            .collect();
        assert_eq!(changed, Vec::<f64>::new(), "times that came back changed");
    }
}
