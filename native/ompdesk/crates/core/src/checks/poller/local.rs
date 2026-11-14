//! The real `LocalSource`: this computer's heavy-slot pool and disk (`ompdesk heavy status --json` plus the queue's
//! ticket files), each paired computer's pool as it last reported it, and the `ompdesk check` journals with their flaky
//! record. It decides nothing; it reports facts with the time they were read.
//!
//! The journals are read as files, never through the checks crate (`crates/core` does not depend on it): the shapes
//! below are private mirrors that take only the fields this side needs and ignore the rest, so a field the checks crate
//! adds later never breaks the listing, and a journal of another shape is skipped.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio::process::Command;

use crate::checks::contract::{DeviceId, ForeignLoad, Os, Timestamp};
use crate::checks::hub::Fut;
use crate::checks::local_run::{LocalFailure, LocalResult};
use crate::checks::sources::{
    LocalFlaky, LocalPool, LocalRun, LocalSource, LocalVolume, SourceError,
};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
/// How long `ompdesk heavy status --json` may take; it only reads a few files and one disk probe per volume.
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
/// The device id of this computer.
const LOCAL: &str = "local";

pub fn this_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Macos
    } else if cfg!(target_os = "windows") {
        Os::Windows
    } else {
        Os::Linux
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The stdout of `ompdesk heavy status --json` on this computer.
pub trait HeavyStatus: Send + Sync {
    fn read(&self) -> Fut<'_, Result<String, SourceError>>;
}

/// `ompdesk heavy status --json`, run as a child process.
pub struct HeavyCli {
    pub bin: PathBuf,
    pub cwd: PathBuf,
}

impl HeavyStatus for HeavyCli {
    fn read(&self) -> Fut<'_, Result<String, SourceError>> {
        Box::pin(async move {
            let mut command = Command::new(&self.bin);
            command
                .args(["heavy", "status", "--json"])
                .current_dir(&self.cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let child = command.spawn().map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    SourceError::new("missing", format!("{}: {error}", self.bin.display()))
                } else {
                    SourceError::new("failed", format!("{}: {error}", self.bin.display()))
                }
            })?;
            // Dropping the wait on a timeout drops the child, which `kill_on_drop` ends.
            let output = tokio::time::timeout(STATUS_TIMEOUT, child.wait_with_output())
                .await
                .map_err(|_| SourceError::new("failed", "heavy status timed out"))?
                .map_err(|error| SourceError::new("failed", error.to_string()))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let line = stderr.lines().next().unwrap_or("").trim();
                return Err(SourceError::new(
                    "failed",
                    if line.is_empty() {
                        format!("heavy status exited with {}", output.status)
                    } else {
                        line.to_owned()
                    },
                ));
            }
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        })
    }
}

// What `heavy::Status` serializes (`crates/checks/src/heavy.rs`), the fields read here.
#[derive(Deserialize)]
struct StatusShape {
    dir: String,
    size: u32,
    slots: Vec<SlotShape>,
    queue: Vec<u32>,
    disk: Vec<DiskShape>,
}

#[derive(Deserialize)]
struct SlotShape {
    held: bool,
    #[serde(default)]
    owner: Option<OwnerShape>,
}

#[derive(Deserialize)]
struct OwnerShape {
    pid: u32,
}

#[derive(Deserialize)]
struct DiskShape {
    path: String,
    free: u64,
    total: u64,
    need: u64,
}

fn parse_status(status_json: &str) -> Result<StatusShape, SourceError> {
    serde_json::from_str(status_json)
        .map_err(|error| SourceError::new("failed", format!("heavy status: {error}")))
}

/// The pool folder and the pids of the live waiters, from a status.
pub fn waiters_of(status_json: &str) -> Result<(PathBuf, Vec<u32>), SourceError> {
    let status = parse_status(status_json)?;
    Ok((PathBuf::from(status.dir), status.queue))
}

/// The processes holding a slot, from a status: whatever runs under them is the pool's own work.
pub fn holders_of(status_json: &str) -> Result<Vec<u32>, SourceError> {
    let status = parse_status(status_json)?;
    Ok(status
        .slots
        .iter()
        .filter(|slot| slot.held)
        .filter_map(|slot| slot.owner.as_ref().map(|owner| owner.pid))
        .collect())
}

/// A pool from a status, the waiters' ages and the clock. Pure.
pub fn pool_of(
    status_json: &str,
    queue_ages_ms: &[u64],
    device: &str,
    os: Os,
    now: Timestamp,
) -> Result<LocalPool, SourceError> {
    let status = parse_status(status_json)?;
    Ok(LocalPool {
        device: device.to_owned(),
        os,
        slots: status.size,
        held: status.slots.iter().filter(|slot| slot.held).count() as u32,
        queued: status.queue.len() as u32,
        oldest_wait_ms: queue_ages_ms.iter().copied().max().unwrap_or(0),
        volumes: status
            .disk
            .iter()
            .map(|disk| LocalVolume {
                path: disk.path.clone(),
                free_gb: disk.free as f64 / GIB,
                total_gb: disk.total as f64 / GIB,
                low: disk.free < disk.need,
            })
            .collect(),
        as_of: now,
        offline: false,
        check_store_bytes: None,
        foreign: Vec::new(),
    })
}

fn ms_of(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// How long each live waiter has queued: `now` minus the mtime of its ticket `<dir>/queue/<number>.<pid>`. A ticket
/// whose pid is not in `live` belongs to a waiter that died (whoever finds it removes it); a missing folder is no
/// waiters.
pub fn queue_ages_blocking(dir: &Path, live: &[u32], now: Timestamp) -> Vec<u64> {
    let Ok(entries) = fs::read_dir(dir.join("queue")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let (number, pid) = name.to_str()?.split_once('.')?;
            number.parse::<u64>().ok()?;
            let pid: u32 = pid.parse().ok()?;
            if !live.contains(&pid) {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some(now.saturating_sub(ms_of(modified)))
        })
        .collect()
}

pub async fn queue_ages(dir: PathBuf, live: Vec<u32>, now: Timestamp) -> Vec<u64> {
    tokio::task::spawn_blocking(move || queue_ages_blocking(&dir, &live, now))
        .await
        .unwrap_or_default()
}

/// The pools of the paired computers, each as that computer computed it. A lost link keeps the last pool and flags it
/// `offline`: zero capacity, never an empty pool and never dropped.
#[derive(Clone, Default)]
pub struct PairedPools {
    pools: Arc<Mutex<BTreeMap<DeviceId, LocalPool>>>,
}

impl PairedPools {
    pub fn set(&self, pool: LocalPool) {
        locked(&self.pools).insert(pool.device.clone(), pool);
    }

    pub fn offline(&self, device: &str) {
        if let Some(pool) = locked(&self.pools).get_mut(device) {
            pool.offline = true;
        }
    }

    /// The computer was unpaired.
    pub fn forget(&self, device: &str) {
        locked(&self.pools).remove(device);
    }

    pub fn all(&self) -> Vec<LocalPool> {
        locked(&self.pools).values().cloned().collect()
    }
}

/// The `ompdesk` binary beside the core's own: `heavy status` and `check` are its commands.
pub fn ompdesk_bin() -> PathBuf {
    let binary = if cfg!(windows) {
        "ompdesk.exe"
    } else {
        "ompdesk"
    };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(binary)))
        .unwrap_or_else(|| PathBuf::from(binary))
}

/// The checks store, resolved as `crates/checks/src/store.rs` `store_dir` does: `OMPDESK_CHECKS_DIR`, else `checks`
/// beside the heavy pool's folder as `heavy::pool_dir` finds it without `OMPDESK_HEAVY_DIR` (`$XDG_CACHE_HOME` only
/// when absolute, else `~/.cache`; Windows `%LOCALAPPDATA%`, else `%USERPROFILE%\AppData\Local`).
pub fn store_root(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(dir) = env("OMPDESK_CHECKS_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let cache = if cfg!(windows) {
        match env("LOCALAPPDATA").filter(|dir| !dir.is_empty()) {
            Some(local) => PathBuf::from(local),
            None => PathBuf::from(env("USERPROFILE")?)
                .join("AppData")
                .join("Local"),
        }
    } else {
        env("XDG_CACHE_HOME")
            .filter(|dir| dir.starts_with('/'))
            .map_or_else(
                || env("HOME").map(|home| Path::new(&home).join(".cache")),
                |xdg| Some(PathBuf::from(xdg)),
            )?
    };
    Some(cache.join("ompdesk").join("checks"))
}

// What `store::Run` serializes (`crates/checks/src/store.rs`), the fields read here. `state` stays a word: a state this
// side does not know is passed on as it is.
#[derive(Deserialize)]
struct RunShape {
    id: String,
    cwd: String,
    argv: Vec<String>,
    state: String,
    started: u64,
    ended: Option<u64>,
    head: Option<String>,
    inputs: Option<String>,
    failed: usize,
    #[serde(default)]
    flaky: Vec<String>,
    saved_ms: u64,
}

// What `flaky::Book` and `flaky::Test` serialize (`crates/checks/src/flaky.rs`), the fields read here.
#[derive(Deserialize)]
struct BookShape {
    tests: BTreeMap<String, TestShape>,
}

#[derive(Deserialize)]
struct TestShape {
    name: String,
    passed: u32,
    failed: u32,
    quarantined: bool,
    streak: u32,
}

fn finished(state: &str) -> bool {
    !matches!(state, "starting" | "waiting" | "running")
}

/// Whether the runner still holds `runs/<id>/alive` (`Store::runner_alive`): a journal that says running while the lock
/// is free belongs to a runner that died.
fn runner_alive(run_dir: &Path) -> bool {
    match File::open(run_dir.join("alive")) {
        Ok(file) => matches!(file.try_lock(), Err(fs::TryLockError::WouldBlock)),
        Err(_) => false,
    }
}

/// The tests the verdict failed on, from the run's `results.jsonl`: the last line per test wins and a status other than
/// `passed`, `skipped` or `flaky` fails (`check::failing`); a file's own record is not a test.
fn failed_names(run_dir: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(run_dir.join("results.jsonl")) else {
        return Vec::new();
    };
    let mut last: BTreeMap<String, (bool, String)> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("end").is_some() || value.get("kind").and_then(|k| k.as_str()) == Some("file")
        {
            continue;
        }
        let text_of = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or("");
        let titles: Vec<&str> = value
            .get("titles")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
            .unwrap_or_default();
        let name = if titles.is_empty() {
            text_of("file").to_owned()
        } else {
            titles.join(" > ")
        };
        let key = format!(
            "{}|{}|{}|{name}",
            text_of("runner"),
            text_of("project"),
            text_of("file")
        );
        let failing = !matches!(text_of("status"), "passed" | "skipped" | "flaky");
        if last.insert(key.clone(), (failing, name)).is_none() {
            order.push(key);
        }
    }
    order
        .into_iter()
        .filter_map(|key| last.remove(&key))
        .filter(|(failing, _)| *failing)
        .map(|(_, name)| name)
        .collect()
}

/// A run's journal as `LocalRun`, when it is still going or ended at or after `since`: an older run is not read past
/// its `run.json`.
fn read_run(run_dir: &Path, since: Timestamp) -> Option<LocalRun> {
    let text = fs::read_to_string(run_dir.join("run.json")).ok()?;
    let run: RunShape = serde_json::from_str(&text).ok()?;
    let state = if !finished(&run.state) && run.state != "starting" && !runner_alive(run_dir) {
        "killed".to_owned()
    } else {
        run.state
    };
    if finished(&state) && run.ended.unwrap_or(run.started) < since {
        return None;
    }
    let failed = if run.failed > 0 {
        failed_names(run_dir)
    } else {
        Vec::new()
    };
    Some(LocalRun {
        id: run.id,
        device: LOCAL.to_owned(),
        cwd: run.cwd,
        argv: run.argv,
        state,
        started: run.started,
        ended: run.ended,
        head: run.head,
        digest: run.inputs.unwrap_or_default(),
        failed,
        flaky: run.flaky,
        saved_ms: run.saved_ms,
        // The journal does not record the session that started the run.
        session_tag: None,
    })
}

/// The `ompdesk check` journals of this computer.
pub struct Journals {
    pub root: PathBuf,
}

impl Journals {
    /// One run's journal by its id, however long ago it ended.
    pub fn active_in_checkout(&self, checkout: &Path) -> Result<Vec<String>, String> {
        let entries = match fs::read_dir(self.root.join("runs")) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let checkout = fs::canonicalize(checkout).unwrap_or_else(|_| checkout.to_path_buf());
        let mut active = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let Ok(text) = fs::read_to_string(path.join("run.json")) else {
                continue;
            };
            let Ok(run) = serde_json::from_str::<RunShape>(&text) else {
                continue;
            };
            let cwd = fs::canonicalize(&run.cwd).unwrap_or_else(|_| PathBuf::from(&run.cwd));
            if cwd != checkout {
                continue;
            }
            match File::open(path.join("alive")) {
                Ok(file) => match file.try_lock() {
                    Ok(()) => {}
                    Err(fs::TryLockError::WouldBlock) => active.push(run.id),
                    Err(error) => return Err(error.to_string()),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(active)
    }
    pub fn result_blocking(&self, id: &str) -> Option<LocalResult> {
        let run = self.run_blocking(id)?;
        let path = self.root.join("runs").join(id).join("verdict.json");
        let failed = fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<serde_json::Value>>(&bytes).ok())
            .and_then(|rows| {
                rows.iter().try_fold(Vec::new(), |mut failed, row| {
                    let key = row.get("key")?.as_str()?;
                    let countable = row
                        .get("countable")
                        .and_then(|value| value.as_bool())
                        .unwrap_or_else(|| {
                            let prefix = key
                                .strip_prefix("vitest file|")
                                .map(|rest| format!("vitest|{rest}|"))
                                .or_else(|| {
                                    key.strip_prefix("jest file|")
                                        .map(|rest| format!("jest|{rest}|"))
                                });
                            !prefix.is_some_and(|prefix| {
                                rows.iter().any(|other| {
                                    other
                                        .get("key")
                                        .and_then(|value| value.as_str())
                                        .is_some_and(|key| key.starts_with(&prefix))
                                })
                            })
                        });
                    let status = row.get("status")?.as_str()?;
                    if countable
                        && !matches!(status, "passed" | "skipped")
                        && (status != "flaky" || run.state == "failed")
                    {
                        failed.push(LocalFailure {
                            name: row.get("name")?.as_str()?.to_owned(),
                            first_error: row
                                .get("first_error")
                                .and_then(|value| value.as_str())
                                .map(crate::checks::results::reports::headline)
                                .filter(|text| !text.is_empty()),
                            known_flaky: row.get("quarantined")?.as_bool()?,
                        });
                    }
                    Some(failed)
                })
            });
        Some(LocalResult { run, failed })
    }

    pub fn run_blocking(&self, id: &str) -> Option<LocalRun> {
        read_run(&self.root.join("runs").join(id), 0)
    }

    /// Every run not ended, and those ended at or after `since`. A journal half written or of another shape is skipped.
    pub fn runs_blocking(&self, since: Timestamp) -> Vec<LocalRun> {
        let Ok(entries) = fs::read_dir(self.root.join("runs")) else {
            return Vec::new();
        };
        let mut runs: Vec<LocalRun> = entries
            .flatten()
            .filter_map(|entry| read_run(&entry.path(), since))
            .collect();
        runs.sort_by(|a, b| a.started.cmp(&b.started).then_with(|| a.id.cmp(&b.id)));
        runs
    }

    pub fn flaky_blocking(&self) -> Vec<LocalFlaky> {
        let Ok(entries) = fs::read_dir(self.root.join("flaky")) else {
            return Vec::new();
        };
        let mut rows = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(check) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(book) = serde_json::from_str::<BookShape>(&text) else {
                continue;
            };
            rows.extend(book.tests.into_values().map(|test| LocalFlaky {
                check: check.to_owned(),
                name: test.name,
                passed: test.passed,
                failed: test.failed,
                quarantined: test.quarantined,
                streak: test.streak,
            }));
        }
        rows.sort_by(|a, b| (&a.check, &a.name).cmp(&(&b.check, &b.name)));
        rows
    }
}

/// This computer's pool and journals, and the paired computers' pools.
pub struct HeavyLocal {
    heavy: Arc<dyn HeavyStatus>,
    paired: PairedPools,
    journals: Option<Journals>,
    os: Os,
    /// The foreign heavy work the last listing of this computer's processes saw.
    foreign: Mutex<Vec<ForeignLoad>>,
}

impl HeavyLocal {
    pub fn new(
        heavy: Arc<dyn HeavyStatus>,
        paired: PairedPools,
        journals: Option<Journals>,
        os: Os,
    ) -> HeavyLocal {
        HeavyLocal {
            heavy,
            paired,
            journals,
            os,
            foreign: Mutex::default(),
        }
    }

    async fn own_pool(&self) -> Result<LocalPool, SourceError> {
        let status = self.heavy.read().await?;
        let (dir, live) = waiters_of(&status)?;
        let holders = holders_of(&status)?;
        let now = crate::clock::now_ms();
        let ages = queue_ages(dir, live, now).await;
        // A listing that fails keeps what the last one saw.
        if let Ok(procs) = super::foreign::list().await {
            *locked(&self.foreign) = super::foreign::foreign(&procs, &holders, std::process::id());
        }
        let mut pool = pool_of(&status, &ages, LOCAL, self.os, now)?;
        pool.foreign = locked(&self.foreign).clone();
        Ok(pool)
    }
}

impl LocalSource for HeavyLocal {
    fn pools(&self) -> Fut<'_, Result<Vec<LocalPool>, SourceError>> {
        Box::pin(async move {
            let mut pools = vec![self.own_pool().await?];
            pools.extend(self.paired.all());
            Ok(pools)
        })
    }

    fn runs(&self, since: Timestamp) -> Fut<'_, Result<Vec<LocalRun>, SourceError>> {
        Box::pin(async move {
            let Some(journals) = &self.journals else {
                return Ok(Vec::new());
            };
            let root = journals.root.clone();
            tokio::task::spawn_blocking(move || Journals { root }.runs_blocking(since))
                .await
                .map_err(|error| SourceError::new("failed", error.to_string()))
        })
    }

    fn flaky(&self) -> Fut<'_, Result<Vec<LocalFlaky>, SourceError>> {
        Box::pin(async move {
            let Some(journals) = &self.journals else {
                return Ok(Vec::new());
            };
            let root = journals.root.clone();
            tokio::task::spawn_blocking(move || Journals { root }.flaky_blocking())
                .await
                .map_err(|error| SourceError::new("failed", error.to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-core-checks-local-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const GB: u64 = 1024 * 1024 * 1024;

    // As `heavy::Status` serializes (`crates/checks/src/heavy.rs`): `SlotView`, `Owner`, `Disk`.
    fn status(dir: &str) -> String {
        json!({
            "dir": dir,
            "size": 2,
            "slots": [
                {"slot": 0, "owner": {"pid": 11, "command": "bun test", "cwd": "/w", "since": 1000, "weight": 1}, "held": true},
                {"slot": 1, "owner": null, "held": false}
            ],
            "queue": [21, 22],
            "disk": [
                {"path": "/w", "free": 50 * GB, "total": 500 * GB, "need": 20 * GB},
                {"path": "/tmp", "free": 5 * GB, "total": 100 * GB, "need": 10 * GB}
            ]
        })
        .to_string()
    }

    #[test]
    fn pool_of_counts_slots_waiters_and_low_volumes() {
        let pool = pool_of(&status("/h"), &[300, 900], "local", Os::Macos, 5_000).unwrap();
        assert_eq!(
            (pool.slots, pool.held, pool.queued, pool.oldest_wait_ms),
            (2, 1, 2, 900)
        );
        assert_eq!(
            (pool.device.as_str(), pool.as_of, pool.offline),
            ("local", 5_000, false)
        );
        assert_eq!(pool.volumes.len(), 2);
        assert_eq!(pool.volumes[0].free_gb, 50.0);
        assert_eq!(pool.volumes[0].total_gb, 500.0);
        assert!(!pool.volumes[0].low);
        assert!(pool.volumes[1].low);
        let idle = pool_of(&status("/h"), &[], "local", Os::Linux, 1).unwrap();
        assert_eq!(idle.oldest_wait_ms, 0);
    }

    #[test]
    fn pool_of_refuses_another_shape() {
        let error = pool_of("{\"size\": \"many\"}", &[], "local", Os::Macos, 1).unwrap_err();
        assert_eq!(error.code, "failed");
        assert_eq!(
            pool_of("nope", &[], "local", Os::Macos, 1)
                .unwrap_err()
                .code,
            "failed"
        );
    }

    #[test]
    fn queue_ages_count_only_live_waiters() {
        let dir = temp("queue");
        let queue = dir.join("queue");
        fs::create_dir_all(&queue).unwrap();
        let at = UNIX_EPOCH + Duration::from_millis(10_000);
        for name in [
            "00000000000000000001.21",
            "00000000000000000002.22",
            "00000000000000000003.99",
            "junk",
        ] {
            let file = File::create(queue.join(name)).unwrap();
            file.set_modified(at).unwrap();
        }
        let mut ages = queue_ages_blocking(&dir, &[21, 22], 16_000);
        ages.sort_unstable();
        assert_eq!(ages, vec![6_000, 6_000]);
        assert!(queue_ages_blocking(&dir.join("none"), &[21], 16_000).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn pool(device: &str) -> LocalPool {
        pool_of(&status("/h"), &[], device, Os::Windows, 7).unwrap()
    }

    #[test]
    fn a_lost_link_keeps_the_pool_flagged_and_unpairing_drops_it() {
        let paired = PairedPools::default();
        paired.set(pool("mini"));
        paired.set(pool("pc"));
        paired.offline("mini");
        paired.offline("unknown");
        let all = paired.all();
        assert_eq!(all.len(), 2);
        let mini = all.iter().find(|p| p.device == "mini").unwrap();
        assert!(mini.offline);
        assert_eq!(mini.slots, 2);
        assert!(!all.iter().find(|p| p.device == "pc").unwrap().offline);
        paired.forget("mini");
        assert_eq!(paired.all().len(), 1);
    }

    #[test]
    fn the_store_root_follows_the_checks_crate() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| (*v).to_owned())
            }
        };
        assert_eq!(
            store_root(&env(&[("OMPDESK_CHECKS_DIR", "/x"), ("HOME", "/h")])),
            Some(PathBuf::from("/x"))
        );
        assert_eq!(store_root(&env(&[])), None);
        if cfg!(not(windows)) {
            assert_eq!(
                store_root(&env(&[("HOME", "/h"), ("OMPDESK_HEAVY_DIR", "/ignored")])),
                Some(PathBuf::from("/h/.cache/ompdesk/checks"))
            );
            assert_eq!(
                store_root(&env(&[("HOME", "/h"), ("XDG_CACHE_HOME", "/c")])),
                Some(PathBuf::from("/c/ompdesk/checks"))
            );
            // A relative `XDG_CACHE_HOME` is not taken, as the heavy pool does not take it.
            assert_eq!(
                store_root(&env(&[("HOME", "/h"), ("XDG_CACHE_HOME", "cache")])),
                Some(PathBuf::from("/h/.cache/ompdesk/checks"))
            );
        }
    }

    // As `store::Run` serializes (`crates/checks/src/store.rs`), `Plan` included.
    fn run_json(id: &str, state: &str, ended: Option<u64>, failed: usize) -> String {
        json!({
            "id": id, "key": "k", "root": "/r", "cwd": "/r/app", "argv": ["bun", "test"],
            "runner": "vitest", "state": state, "pid": 1, "started": 1_000, "ended": ended,
            "exit_code": null, "head": "abc123", "dirty": false, "inputs": "digest-1",
            "changed_during": [],
            "plan": {"mode": "full", "reason": "", "from": null, "evidence": []},
            "reused": 0, "ran": 3, "failed": failed, "quarantined_failed": 0,
            "flaky": ["flaky one"], "saved_ms": 42, "light": false, "release": false,
            "summary": null
        })
        .to_string()
    }

    fn put(root: &Path, id: &str, text: &str) -> PathBuf {
        let run = root.join("runs").join(id);
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("run.json"), text).unwrap();
        run
    }

    // As `flaky::Book` with `flaky::Test` serializes (`crates/checks/src/flaky.rs`).
    fn flaky_json() -> String {
        json!({"tests": {"a > b": {
            "name": "a > b", "passed": 4, "failed": 2,
            "sets": [{"digest": "d1", "passed": 1, "failed": 1}],
            "quarantined": true, "flaked_on": ["d1"], "streak": 3,
            "streak_digest": "d2", "since": "r1", "cleared_in": null
        }}})
        .to_string()
    }

    #[test]
    fn journals_list_running_recent_and_skip_the_unreadable() {
        let root = temp("journals");
        // A running run whose `alive` lock is held by this very process's file below.
        let running = put(
            &root,
            "r-running",
            &run_json("r-running", "running", None, 0),
        );
        let alive = File::create(running.join("alive")).unwrap();
        alive.lock().unwrap();
        put(&root, "r-old", &run_json("r-old", "passed", Some(2_000), 0));
        let new = put(&root, "r-new", &run_json("r-new", "failed", Some(9_000), 2));
        // A results.jsonl as the reporters write it: a retried test's last line wins, a file record is no test.
        let lines = [
            json!({"runner": "vitest", "kind": "file", "file": "a.test.ts", "titles": [], "status": "failed", "ms": 1}),
            json!({"runner": "vitest", "kind": "test", "project": "", "file": "a.test.ts", "titles": ["x", "bad"], "status": "failed", "ms": 1}),
            json!({"runner": "vitest", "kind": "test", "project": "", "file": "a.test.ts", "titles": ["x", "fixed"], "status": "failed", "ms": 1}),
            json!({"runner": "vitest", "kind": "test", "project": "", "file": "a.test.ts", "titles": ["x", "fixed"], "status": "passed", "ms": 1}),
            json!({"end": "done"}),
        ];
        let text: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        fs::write(new.join("results.jsonl"), text.join("\n")).unwrap();
        put(&root, "r-half", "{\"id\": \"r-half\", \"key\": ");
        fs::create_dir_all(root.join("flaky")).unwrap();
        fs::write(root.join("flaky").join("check-key.json"), flaky_json()).unwrap();
        fs::write(root.join("flaky").join("broken.json"), "{").unwrap();

        let journals = Journals { root: root.clone() };
        let runs = journals.runs_blocking(5_000);
        let ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["r-new", "r-running"]);
        let new = &runs[0];
        assert_eq!(new.state, "failed");
        assert_eq!(new.device, "local");
        assert_eq!(new.cwd, "/r/app");
        assert_eq!(new.argv, vec!["bun", "test"]);
        assert_eq!((new.started, new.ended), (1_000, Some(9_000)));
        assert_eq!(new.head.as_deref(), Some("abc123"));
        assert_eq!(new.digest, "digest-1");
        assert_eq!(new.failed, vec!["x > bad"]);
        assert_eq!(new.flaky, vec!["flaky one"]);
        assert_eq!(new.saved_ms, 42);
        assert_eq!(new.session_tag, None);
        assert_eq!(runs[1].state, "running");
        assert_eq!(runs[1].ended, None);

        let flaky = journals.flaky_blocking();
        assert_eq!(
            flaky,
            vec![LocalFlaky {
                check: "check-key".into(),
                name: "a > b".into(),
                passed: 4,
                failed: 2,
                quarantined: true,
                streak: 3,
            }]
        );
        drop(alive);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_running_journal_without_a_live_runner_is_killed() {
        let root = temp("killed");
        put(&root, "r-dead", &run_json("r-dead", "running", None, 0));
        let runs = Journals { root: root.clone() }.runs_blocking(0);
        assert_eq!(runs[0].state, "killed");
        fs::remove_dir_all(&root).unwrap();
    }

    struct Fixed(Result<String, SourceError>);

    impl HeavyStatus for Fixed {
        fn read(&self) -> Fut<'_, Result<String, SourceError>> {
            Box::pin(async move { self.0.clone() })
        }
    }

    #[tokio::test]
    async fn pools_put_this_computer_first_and_fail_with_its_error() {
        let dir = temp("pools");
        let paired = PairedPools::default();
        paired.set(pool("mini"));
        let local = HeavyLocal::new(
            Arc::new(Fixed(Ok(status(&dir.display().to_string())))),
            paired.clone(),
            None,
            Os::Macos,
        );
        let pools = local.pools().await.unwrap();
        assert_eq!(pools.len(), 2);
        assert_eq!((pools[0].device.as_str(), pools[0].queued), ("local", 2));
        assert_eq!(pools[0].oldest_wait_ms, 0);
        assert_eq!(pools[1].device, "mini");
        assert!(local.runs(0).await.unwrap().is_empty());
        assert!(local.flaky().await.unwrap().is_empty());

        let down = HeavyLocal::new(
            Arc::new(Fixed(Err(SourceError::new("missing", "no binary")))),
            paired,
            None,
            Os::Macos,
        );
        assert_eq!(down.pools().await.unwrap_err().code, "missing");
        fs::remove_dir_all(&dir).unwrap();
    }
}
