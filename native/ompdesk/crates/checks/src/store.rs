//! Where checks are kept: `<cache>/ompdesk/checks` (`OMPDESK_CHECKS_DIR` for tests), beside the heavy pool and, like
//! it, per user and computer, never per app profile.
//!
//! - `runs/<id>/run.json`: one run's journal (`Run`), rewritten whole at each step.
//! - `runs/<id>/log`: the command's stdout and stderr, and the check's own evidence lines.
//! - `runs/<id>/results.jsonl`: one line per finished test, written by the runner's reporter as it goes, so a run cut
//!   off half way still says what passed.
//! - `runs/<id>/reused.jsonl`: the earlier results this run reused, each with where it came from.
//! - `runs/<id>/inputs.tsv`: the input set this run's results hold for (`path\thash`), for the evidence of the next.
//! - `runs/<id>/alive`: locked by the runner for its whole life; free while the journal says running = the runner died.
//! - `inputs/<root>.tsv`: per checkout, the stat and hash of every input file last seen (`inputs::StatCache`).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DIR_ENV: &str = "OMPDESK_CHECKS_DIR";
/// Runs kept per check (repository and command); older ones go once a newer run of it starts.
const KEEP_RUNS: usize = 10;
/// Runs per check that keep their `inputs.tsv` (only the newest are ever compared with).
const KEEP_INPUTS: usize = 3;

pub fn store_dir(env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(dir) = env(DIR_ENV).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    // The heavy pool's parent: `<cache>/ompdesk`.
    let heavy = crate::heavy::pool_dir(&|name| {
        if name == crate::heavy::DIR_ENV {
            None
        } else {
            env(name)
        }
    });
    heavy
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
        .join("checks")
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Made by the foreground; its runner has not taken over yet.
    Starting,
    /// Waiting for a heavy slot.
    Waiting,
    Running,
    Passed,
    Failed,
    /// Stopped by `ompdesk check cancel`.
    Cancelled,
    /// The runner died before it finished (read from a free `alive` lock; never written by the runner).
    Killed,
    /// The command could not start, or the check itself failed.
    Error,
}

impl State {
    pub fn finished(self) -> bool {
        !matches!(self, State::Starting | State::Waiting | State::Running)
    }
}

/// How this run decided what to run, with the evidence it printed.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Plan {
    /// `full`, `narrowed` (only what has no reusable pass) or `reused` (nothing to run).
    pub mode: String,
    pub reason: String,
    /// The run whose results are reused.
    pub from: Option<String>,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Run {
    pub id: String,
    /// The check: repository root, folder and command (`key_of`).
    pub key: String,
    pub root: String,
    pub cwd: String,
    pub argv: Vec<String>,
    pub runner: String,
    pub state: State,
    /// The runner's process (its group on POSIX).
    pub pid: u32,
    pub started: u64,
    pub ended: Option<u64>,
    pub exit_code: Option<i32>,
    /// `git rev-parse HEAD` and whether the work tree had changes, for people; reuse reads `inputs`.
    pub head: Option<String>,
    pub dirty: bool,
    /// The digest of the input set as the run began (files, environment, tools, command): what its results hold for.
    pub inputs: Option<String>,
    /// Files outside the ignored outputs that changed while the command ran: its results cannot be reused.
    pub changed_during: Vec<String>,
    pub plan: Plan,
    pub reused: usize,
    pub ran: usize,
    /// Results that failed the verdict.
    pub failed: usize,
    /// Failures of quarantined tests, which do not fail it (but do under `--release`).
    #[serde(default)]
    pub quarantined_failed: usize,
    /// Tests this run found flaky (passed and failed on the same inputs), by name.
    #[serde(default)]
    pub flaky: Vec<String>,
    /// About how long reusing saved, from the reused run's own times.
    pub saved_ms: u64,
    pub light: bool,
    #[serde(default)]
    pub release: bool,
    pub summary: Option<String>,
}

pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn open(dir: PathBuf) -> io::Result<Store> {
        fs::create_dir_all(dir.join("runs"))?;
        fs::create_dir_all(dir.join("inputs"))?;
        Ok(Store { dir })
    }

    pub fn run_dir(&self, id: &str) -> PathBuf {
        self.dir.join("runs").join(id)
    }

    pub fn file(&self, id: &str, name: &str) -> PathBuf {
        self.run_dir(id).join(name)
    }

    pub fn read(&self, id: &str) -> Option<Run> {
        let text = fs::read_to_string(self.file(id, "run.json")).ok()?;
        let mut run: Run = serde_json::from_str(&text).ok()?;
        if !run.state.finished() && run.state != State::Starting && !self.runner_alive(id) {
            run.state = State::Killed;
        }
        Some(run)
    }

    /// Whether the run's runner still holds `alive`.
    pub fn runner_alive(&self, id: &str) -> bool {
        match File::open(self.file(id, "alive")) {
            Ok(file) => matches!(file.try_lock(), Err(fs::TryLockError::WouldBlock)),
            Err(_) => false,
        }
    }

    pub fn write(&self, run: &Run) -> io::Result<()> {
        let path = self.file(&run.id, "run.json");
        let tmp = self.file(&run.id, "run.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(run).unwrap_or_default())?;
        fs::rename(tmp, path)
    }

    pub fn create(&self, run: &Run) -> io::Result<()> {
        fs::create_dir_all(self.run_dir(&run.id))?;
        File::create(self.file(&run.id, "log"))?;
        self.write(run)
    }

    /// Every run of every check, newest first.
    pub fn all(&self) -> Vec<Run> {
        let Ok(entries) = fs::read_dir(self.dir.join("runs")) else {
            return Vec::new();
        };
        let mut runs: Vec<Run> = entries
            .flatten()
            .filter_map(|e| self.read(&e.file_name().to_string_lossy()))
            .collect();
        runs.sort_by(|a, b| b.started.cmp(&a.started).then(b.id.cmp(&a.id)));
        runs
    }

    pub fn of_key(&self, key: &str) -> Vec<Run> {
        self.all().into_iter().filter(|r| r.key == key).collect()
    }

    /// Drops a check's oldest runs (never one still running) and the input lists of all but the newest.
    pub fn prune(&self, key: &str) {
        let runs = self.of_key(key);
        for (at, run) in runs.iter().enumerate() {
            if !run.state.finished() {
                continue;
            }
            if at >= KEEP_RUNS {
                let _ = fs::remove_dir_all(self.run_dir(&run.id));
            } else if at >= KEEP_INPUTS {
                let _ = fs::remove_file(self.file(&run.id, "inputs.tsv"));
            }
        }
    }

    pub fn append(&self, id: &str, name: &str, line: &str) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file(id, name))?;
        file.write_all(line.as_bytes())?;
        if !line.ends_with('\n') {
            file.write_all(b"\n")?;
        }
        Ok(())
    }
}

/// A new run id: UTC date and time, then 4 hex digits.
pub fn new_id(now_ms: u64) -> String {
    use std::hash::{BuildHasher, RandomState};
    let rand = RandomState::new().hash_one(now_ms) as u16;
    let (y, mo, d, h, mi, s) = civil(now_ms / 1000);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{rand:04x}")
}

/// `YYYY-MM-DD HH:MM UTC` of milliseconds since the epoch.
pub fn utc(ms: u64) -> String {
    let (y, mo, d, h, mi, _) = civil(ms / 1000);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02} UTC")
}

/// Year, month, day, hour, minute, second of seconds since the epoch (Howard Hinnant's civil_from_days).
fn civil(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (
        y,
        m,
        d,
        (rem / 3600) as u32,
        (rem % 3600 / 60) as u32,
        (rem % 60) as u32,
    )
}

/// A duration as people read it: `42s`, `3m05s`, `2h20m`.
pub fn duration(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m{:02}s", s / 60, s % 60)
    } else {
        format!("{}h{:02}m", s / 3600, s % 3600 / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_read_as_utc() {
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
        // 2026-11-13 02:15:07 UTC
        assert_eq!(utc(1_794_536_107_000), "2026-11-13 02:15 UTC");
        assert!(new_id(1_794_536_107_000).starts_with("20261113-021507-"));
        assert_eq!(utc(951_782_400_000), "2000-02-29 00:00 UTC");
    }

    #[test]
    fn durations_read_short() {
        assert_eq!(duration(42_000), "42s");
        assert_eq!(duration(185_000), "3m05s");
        assert_eq!(duration(8_400_000), "2h20m");
    }
}
