//! Flaky tests in quarantine, per check (`<store>/flaky/<check key>.json`).
//!
//! A test is flaky when it both passed and failed on the same input set (the same digest): nothing it depends on
//! changed, so the difference is the test's own. That is seen when a failed test passes on a rerun of the same
//! inputs, or within one run when a runner retried it (Playwright's `flaky` outcome). A test in quarantine still runs
//! and is always reported, with its passes, failures and the inputs it flaked on; its failure does not fail the check's
//! verdict, except under `--release`, where any quarantined test that failed in that run fails it.
//!
//! It leaves quarantine after `CLEAR_AFTER` passes in a row, each on a different input set than the one before (a
//! rerun of the same inputs proves nothing new). Five, because staying in quarantine is the costly error (the test's
//! real regressions stop failing the verdict) and leaving early is cheap (its next flake on one input set puts it
//! back): a test that fails one run in three still leaves wrongly with probability (2/3)^5 ≈ 13 %, and comes back at
//! its next flake.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const CLEAR_AFTER: u32 = 5;
/// Input sets kept per test, newest last.
const KEEP_SETS: usize = 8;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Outcomes {
    pub digest: String,
    pub passed: u32,
    pub failed: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Test {
    pub name: String,
    pub passed: u32,
    pub failed: u32,
    pub sets: Vec<Outcomes>,
    pub quarantined: bool,
    /// The input sets it both passed and failed on.
    pub flaked_on: Vec<String>,
    /// Passes in a row on changed inputs while quarantined.
    pub streak: u32,
    pub streak_digest: Option<String>,
    /// The run that put it in quarantine, and the run it left in.
    pub since: Option<String>,
    pub cleared_in: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Book {
    pub tests: BTreeMap<String, Test>,
}

pub fn path(store: &Path, key: &str) -> PathBuf {
    store.join("flaky").join(format!("{key}.json"))
}

impl Book {
    pub fn load(store: &Path, key: &str) -> Book {
        fs::read_to_string(path(store, key))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, store: &Path, key: &str) -> std::io::Result<()> {
        let p = path(store, key);
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = p.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        fs::rename(tmp, p)
    }

    pub fn quarantined(&self, key: &str) -> bool {
        self.tests.get(key).is_some_and(|t| t.quarantined)
    }

    /// Records one result this run produced (`status`: passed, failed, flaky; anything else is ignored) on input set
    /// `digest`. Returns true when this result put the test in quarantine.
    pub fn record(&mut self, key: &str, name: &str, status: &str, digest: &str, run: &str) -> bool {
        let (pass, fail) = match status {
            "passed" => (1, 0),
            "flaky" => (1, 1),
            "failed" | "timedOut" | "interrupted" | "missing" => (0, 1),
            _ => return false,
        };
        let t = self.tests.entry(key.to_string()).or_default();
        t.name = name.to_string();
        t.passed += pass;
        t.failed += fail;
        let at = match t.sets.iter().position(|s| s.digest == digest) {
            Some(at) => at,
            None => {
                t.sets.push(Outcomes {
                    digest: digest.to_string(),
                    ..Outcomes::default()
                });
                if t.sets.len() > KEEP_SETS {
                    t.sets.remove(0);
                }
                t.sets.len() - 1
            }
        };
        t.sets[at].passed += pass;
        t.sets[at].failed += fail;
        let flaked = t.sets[at].passed > 0 && t.sets[at].failed > 0;
        let mut entered = false;
        if flaked && !t.flaked_on.iter().any(|d| d == digest) {
            t.flaked_on.push(digest.to_string());
            if t.flaked_on.len() > KEEP_SETS {
                t.flaked_on.remove(0);
            }
        }
        if t.quarantined {
            if fail > 0 {
                t.streak = 0;
                t.streak_digest = None;
            } else if t.streak_digest.as_deref() != Some(digest) && !flaked_now(t, digest) {
                t.streak += 1;
                t.streak_digest = Some(digest.to_string());
                if t.streak >= CLEAR_AFTER {
                    t.quarantined = false;
                    t.cleared_in = Some(run.to_string());
                    t.streak = 0;
                    t.streak_digest = None;
                }
            }
        } else if flaked {
            t.quarantined = true;
            t.since = Some(run.to_string());
            t.cleared_in = None;
            t.streak = 0;
            t.streak_digest = None;
            entered = true;
        }
        entered
    }
}

/// The test flaked on this very input set: a pass there proves nothing about its fix.
fn flaked_now(t: &Test, digest: &str) -> bool {
    t.flaked_on.iter().any(|d| d == digest)
}

/// What a run's failures come to, counted against the quarantine: one rule for a local check and for a run on a
/// GitHub runner (the core's `checks::trends`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Failures {
    /// Failed tests that are not in quarantine.
    pub blocking: usize,
    /// Failed tests that are.
    pub quarantined: usize,
    /// Quarantined tests that passed only after a retry within this run.
    pub quarantined_flaky: usize,
}

impl Failures {
    /// A release check does not pass while a quarantined test failed or flaked in that run.
    pub fn release_blocked(&self, release: bool) -> bool {
        release && (self.quarantined > 0 || self.quarantined_flaky > 0)
    }

    /// Whether the run passes. `exit_ok`: its command (for a runner's job, its conclusion) reported success; a
    /// failure reported there fails the run unless every failed test is a quarantined one.
    pub fn passes(&self, exit_ok: bool, release: bool) -> bool {
        let exit_explained = exit_ok || (self.quarantined > 0 && self.blocking == 0);
        self.blocking == 0 && exit_explained && !self.release_blocked(release)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pass_and_a_failure_on_the_same_inputs_quarantine_a_test() {
        let mut book = Book::default();
        assert!(!book.record("t", "t", "failed", "d1", "r1"));
        assert!(!book.quarantined("t"));
        // Changed inputs: a pass then is no evidence of flakiness.
        assert!(!book.record("t", "t", "passed", "d2", "r2"));
        assert!(!book.quarantined("t"));
        assert!(!book.record("t", "t", "failed", "d3", "r3"));
        assert!(book.record("t", "t", "passed", "d3", "r4"));
        assert!(book.quarantined("t"));
        assert_eq!(book.tests["t"].flaked_on, vec!["d3"]);
        assert_eq!((book.tests["t"].passed, book.tests["t"].failed), (2, 2));
    }

    #[test]
    fn a_retried_pass_within_one_run_is_flaky() {
        let mut book = Book::default();
        assert!(book.record("t", "t", "flaky", "d1", "r1"));
        assert!(book.quarantined("t"));
    }

    #[test]
    fn it_leaves_after_passes_in_a_row_on_changed_inputs() {
        let mut book = Book::default();
        book.record("t", "t", "flaky", "d0", "r0");
        // Passes on the same inputs again and again count once.
        for _ in 0..10 {
            book.record("t", "t", "passed", "d1", "r1");
        }
        assert_eq!(book.tests["t"].streak, 1);
        for i in 2..CLEAR_AFTER {
            book.record("t", "t", "passed", &format!("d{i}"), "r");
        }
        assert!(book.quarantined("t"));
        // A failure resets the count.
        book.record("t", "t", "failed", "dx", "rx");
        assert_eq!(book.tests["t"].streak, 0);
        for i in 0..CLEAR_AFTER {
            book.record("t", "t", "passed", &format!("e{i}"), "last");
        }
        assert!(!book.quarantined("t"));
        assert_eq!(book.tests["t"].cleared_in.as_deref(), Some("last"));
    }

    #[test]
    fn only_quarantined_failures_are_forgiven_and_never_for_a_release() {
        let none = Failures::default();
        assert!(none.passes(true, true));
        // A failing exit code nothing explains.
        assert!(!none.passes(false, false));
        let quarantined = Failures {
            quarantined: 2,
            ..none
        };
        assert!(quarantined.passes(false, false));
        assert!(!quarantined.passes(false, true));
        assert!(!quarantined.passes(true, true));
        let mixed = Failures {
            blocking: 1,
            ..quarantined
        };
        assert!(!mixed.passes(false, false));
        assert!(!mixed.passes(true, false));
        // A quarantined test that needed a retry blocks only a release.
        let retried = Failures {
            quarantined_flaky: 1,
            ..none
        };
        assert!(retried.passes(true, false));
        assert!(!retried.passes(true, true));
    }
}
