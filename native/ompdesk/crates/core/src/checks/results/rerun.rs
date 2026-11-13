//! How often a red run may be run again, and what its failures say to do next (§5 policy 4, §9.6).
//!
//! A rerun is how a runner's failure is told from a flaky test: only the failed jobs run again on the same inputs,
//! and a test that then passes has passed and failed on one digest. So a first failure is worth one rerun, and a
//! test that failed twice on the same inputs without ever passing there is broken, not flaky: no rerun will help.
//! The cap is per run and shrinks with what a rerun costs (the failed jobs' time), so a two-hour suite is not run
//! three times on a hunch; it is told in every answer. On GitHub a rerun is of the failed jobs
//! (`rerun-failed-jobs`); one test alone can only be rerun by `ompdesk check`, which narrows its runner.

use serde::Serialize;

use super::ledger::{Ended, Judged};
use crate::checks::contract::Next;

/// The most reruns any run gets.
pub const MAX: u32 = 3;
const MINUTE: u64 = 60_000;

/// Reruns a run may have when its failed jobs took `failed_ms` together.
pub fn cap(failed_ms: u64) -> u32 {
    match failed_ms {
        ms if ms <= 5 * MINUTE => MAX,
        ms if ms <= 20 * MINUTE => 2,
        _ => 1,
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    /// Reruns this run already had.
    pub used: u32,
    pub cap: u32,
}

impl Budget {
    pub fn left(&self) -> bool {
        self.used < self.cap
    }
}

/// What to do after an attempt. `attempt` is the run's attempt number (1 for the first), `release` whether the
/// run decides a release gate.
pub fn next(judged: &Judged, attempt: u32, release: bool) -> (Next, Budget) {
    let failed_ms: u64 = judged
        .jobs
        .iter()
        .filter(|j| !j.passes(release))
        .map(|j| j.ms)
        .sum();
    let budget = Budget {
        used: attempt.saturating_sub(1),
        cap: cap(failed_ms),
    };
    if judged.green(release) {
        return (Next::Land, budget);
    }
    if judged.jobs.iter().any(|j| j.outcome == Ended::Cancelled) {
        // Somebody stopped it: running it again is theirs to ask for.
        return (Next::Fix, budget);
    }
    // Something a rerun could still change: a failure seen once on these inputs, a job that failed outside its
    // tests, or, for a release gate, a quarantined test that has to pass in the run that decides it.
    let open = judged.jobs.iter().filter(|j| !j.passes(release)).any(|j| {
        j.blocking.iter().any(|t| t.repeats < 2)
            || (j.blocking.is_empty() && (j.came_to.quarantined == 0 || release))
    });
    let next = if open && budget.left() {
        Next::RerunFailed
    } else {
        Next::Fix
    };
    (next, budget)
}

#[cfg(test)]
mod tests {
    use ompdesk_checks::flaky::Failures;

    use super::super::ledger::{Failed, JobJudged};
    use super::*;
    use crate::checks::contract::Os;

    fn failed(repeats: u32, known_flaky: bool) -> Failed {
        Failed {
            test: "a.test.ts › t".into(),
            os: Os::Linux,
            first_error: String::new(),
            known_flaky,
            history: String::new(),
            repeats,
        }
    }

    fn job(
        outcome: Ended,
        minutes: u64,
        blocking: Vec<Failed>,
        quarantined: Vec<Failed>,
    ) -> JobJudged {
        JobJudged {
            name: "check".into(),
            ms: minutes * MINUTE,
            outcome,
            reported: true,
            passed: 10,
            came_to: Failures {
                blocking: blocking.len(),
                quarantined: quarantined.len(),
                quarantined_flaky: 0,
            },
            blocking,
            quarantined,
        }
    }

    fn judged(jobs: Vec<JobJudged>) -> Judged {
        Judged {
            jobs,
            ..Judged::default()
        }
    }

    #[test]
    fn the_cap_shrinks_with_what_a_rerun_costs() {
        assert_eq!(cap(0), 3);
        assert_eq!(cap(5 * MINUTE), 3);
        assert_eq!(cap(5 * MINUTE + 1), 2);
        assert_eq!(cap(20 * MINUTE), 2);
        assert_eq!(cap(115 * MINUTE), 1);
    }

    #[test]
    fn a_first_failure_is_rerun_and_a_repeated_one_is_to_fix() {
        let once = judged(vec![job(Ended::Failed, 3, vec![failed(1, false)], vec![])]);
        assert_eq!(
            next(&once, 1, false),
            (Next::RerunFailed, Budget { used: 0, cap: 3 })
        );
        let twice = judged(vec![job(Ended::Failed, 3, vec![failed(2, false)], vec![])]);
        assert_eq!(next(&twice, 2, false).0, Next::Fix);
    }

    #[test]
    fn the_cap_ends_the_reruns() {
        let long = judged(vec![job(Ended::Failed, 60, vec![failed(1, false)], vec![])]);
        assert_eq!(
            next(&long, 1, false),
            (Next::RerunFailed, Budget { used: 0, cap: 1 })
        );
        assert_eq!(
            next(&long, 2, false),
            (Next::Fix, Budget { used: 1, cap: 1 })
        );
        // Passed jobs do not count toward the cost of a rerun: they are not run again.
        let mixed = judged(vec![
            job(Ended::Passed, 60, vec![], vec![]),
            job(Ended::Failed, 2, vec![failed(1, false)], vec![]),
        ]);
        assert_eq!(
            next(&mixed, 3, false),
            (Next::RerunFailed, Budget { used: 2, cap: 3 })
        );
        assert_eq!(next(&mixed, 4, false).0, Next::Fix);
    }

    #[test]
    fn green_lands_and_a_forgiven_flake_is_green_except_for_a_release() {
        let green = judged(vec![job(Ended::Passed, 3, vec![], vec![])]);
        assert_eq!(next(&green, 1, true).0, Next::Land);
        let flake = judged(vec![job(Ended::Failed, 3, vec![], vec![failed(1, true)])]);
        assert_eq!(next(&flake, 1, false).0, Next::Land);
        // The release gate needs a run in which it did not fail.
        assert_eq!(next(&flake, 1, true).0, Next::RerunFailed);
        assert_eq!(next(&flake, 4, true).0, Next::Fix);
    }

    #[test]
    fn a_job_that_failed_outside_its_tests_is_rerun_within_the_cap_and_a_cancelled_run_never() {
        let mut build = job(Ended::Failed, 3, vec![], vec![]);
        build.reported = false;
        assert_eq!(
            next(&judged(vec![build.clone()]), 1, false).0,
            Next::RerunFailed
        );
        let stopped = judged(vec![build, job(Ended::Cancelled, 1, vec![], vec![])]);
        assert_eq!(next(&stopped, 1, false).0, Next::Fix);
    }
}
