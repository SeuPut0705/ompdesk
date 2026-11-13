//! The "Tests and cost" tab's data (`contract::Trends`), built from the repositories' ledgers and the computers' pools.
//!
//! - `tests`: every test in quarantine and every one that left it in the last week, per operating system. A test
//!   `ompdesk check` quarantined on a computer (`LocalFlaky`) is listed too, unless a runner's row already names it;
//!   its counts are of all its local runs, since a local book keeps no days.
//! - `slowdowns`: `slow`'s rule over each test's and each test file's durations.
//! - `minutes`: runner minutes and their price per system and month. `costUsd` is an estimate (`cost::BASIS`); the tab
//!   says so.
//! - `queueDepth`: the most jobs seen waiting in a pool, one point per day of the last week.
//! - The week's time lost to flaky tests and the week before, and what reruns of only the failed jobs and reused
//!   green results saved.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::cost::Use;
use super::{DAY_MS, day_of, month_of};
use crate::checks::contract::{
    DepthPoint, Os, RunnerMinutes, Slowdown, TestHistory, TestId, TestState, Trends,
};
use crate::checks::results::ledger::{Ledger, SHOW_CLEARED_MS, Track};
use crate::checks::sources::{LocalFlaky, LocalPool};

const WEEK: u32 = 7;

/// hash(repo, operating system, the test's full name): the same test on another system is another test.
pub fn test_id(repo: &str, os: Os, name: &str) -> TestId {
    let digest = Sha256::digest(format!("{repo}\n{}\n{name}", os.word()));
    crate::hex(&digest[..8])
}

/// What the computers' own checks know and no runner told.
pub struct Local<'a> {
    pub flaky: &'a [LocalFlaky],
    /// The system of the computer whose journals `flaky` is.
    pub os: Os,
    pub pools: &'a [LocalPool],
}

fn history(repo: &str, ledger: &Ledger, key: &str, track: &Track, now: u64) -> Option<TestHistory> {
    let test = ledger.flaky.tests.get(key)?;
    let cleared = track
        .cleared_at
        .filter(|at| !test.quarantined && at + SHOW_CLEARED_MS > now);
    if !test.quarantined && cleared.is_none() {
        return None;
    }
    let week = track.counts(now, WEEK);
    Some(TestHistory {
        test: test_id(repo, track.os, &track.name),
        name: track.name.clone(),
        os: track.os,
        p50_ms_30d: track.pace(now).median_ms.unwrap_or(0),
        runs_7d: week.runs,
        fails_7d: week.fails,
        state: if test.quarantined {
            TestState::Quarantined
        } else {
            TestState::Cleared
        },
        flaked_on: test.flaked_on.last().cloned(),
        quarantined_at: track.entered_at,
        cleared_at: cleared,
        quarantined_by: track.entered_by.clone(),
        clean_since: ledger.clean(key),
    })
}

fn slowdown(repo: &str, track: &Track, now: u64) -> Option<Slowdown> {
    let pace = track.pace(now);
    let slow = pace.slow?;
    Some(Slowdown {
        test: test_id(repo, track.os, &track.name),
        name: track.name.clone(),
        os: track.os,
        p50_ms_30d: pace.median_ms?,
        last_ms: pace.last_ms,
        since_sha: Some(slow.since_sha).filter(|sha| !sha.is_empty()),
    })
}

/// How far over its median a slowdown's newest run is, in thousandths.
fn over(slow: &Slowdown) -> u64 {
    slow.last_ms.last().copied().unwrap_or(0) * 1_000 / slow.p50_ms_30d.max(1)
}

/// `ledgers`: each watched repository (`owner/name`) with its ledger.
pub fn build(ledgers: &[(&str, &Ledger)], local: &Local, now: u64) -> Trends {
    let today = day_of(now);
    let mut trends = Trends::default();
    let mut used: BTreeMap<(String, usize), Use> = BTreeMap::new();
    let mut depth: BTreeMap<(u32, &str), u32> = BTreeMap::new();
    for (repo, ledger) in ledgers {
        for (key, track) in &ledger.tracks {
            trends.tests.extend(history(repo, ledger, key, track, now));
            trends.slowdowns.extend(slowdown(repo, track, now));
        }
        for (day, of) in &ledger.days {
            for (at, os) in Os::ALL.iter().enumerate() {
                let one = of.used.of(*os);
                if one.minutes > 0 {
                    used.entry((month_of(*day), at)).or_default().add(*one);
                }
            }
            let age = today.saturating_sub(*day);
            if age < WEEK {
                trends.lost_ms_7d += of.lost_ms;
                trends.saved_by_rerun_ms_7d += of.saved_ms;
                trends.saved_by_reuse_ms_7d += of.reused_ms;
                // One account's pool is seen from every repository: its day's peak is the highest any saw.
                for (pool, waiting) in &of.queued {
                    let peak = depth.entry((*day, pool)).or_default();
                    *peak = (*peak).max(*waiting);
                }
            } else if age < 2 * WEEK {
                trends.lost_ms_prev_7d += of.lost_ms;
            }
        }
    }
    for flaky in local.flaky.iter().filter(|f| f.quarantined) {
        let named = |t: &TestHistory| t.os == local.os && t.name == flaky.name;
        if trends.tests.iter().any(named) {
            continue;
        }
        trends.tests.push(TestHistory {
            test: test_id(&format!("local:{}", flaky.check), local.os, &flaky.name),
            name: flaky.name.clone(),
            os: local.os,
            p50_ms_30d: 0,
            runs_7d: flaky.passed + flaky.failed,
            fails_7d: flaky.failed,
            state: TestState::Quarantined,
            flaked_on: None,
            quarantined_at: None,
            cleared_at: None,
            quarantined_by: None,
            clean_since: flaky.streak,
        });
    }
    // Quarantined before cleared, the most failing first.
    trends.tests.sort_by(|a, b| {
        (
            a.state == TestState::Cleared,
            b.fails_7d,
            &a.name,
            a.os.word(),
        )
            .cmp(&(
                b.state == TestState::Cleared,
                a.fails_7d,
                &b.name,
                b.os.word(),
            ))
    });
    trends
        .slowdowns
        .sort_by(|a, b| over(b).cmp(&over(a)).then_with(|| a.name.cmp(&b.name)));
    trends.minutes = used
        .into_iter()
        .map(|((month, at), sum)| RunnerMinutes {
            os: Os::ALL[at],
            month,
            minutes: sum.minutes as f64,
            cost_usd: sum.usd(),
        })
        .collect();
    trends.queue_depth = depth
        .into_iter()
        .map(|((day, pool), queued)| DepthPoint {
            at: u64::from(day) * DAY_MS,
            pool: pool.to_string(),
            queued,
        })
        .collect();
    let stores: Vec<u64> = local
        .pools
        .iter()
        .filter_map(|p| p.check_store_bytes)
        .collect();
    trends.store_bytes = (!stores.is_empty()).then(|| stores.iter().sum());
    trends
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::contract::{Origin, Outcome};
    use crate::checks::results::ledger::tests::{T0, case, fail, feed, pass, quarantine};

    const HOUR: u64 = 3_600_000;
    const NONE: Local = Local {
        flaky: &[],
        os: Os::Macos,
        pools: &[],
    };

    #[test]
    fn a_quarantined_test_is_listed_with_its_week_and_a_cleared_one_for_a_week_more() {
        let mut ledger = Ledger::default();
        let key = quarantine(&mut ledger);
        let now = T0 + 2 * HOUR;
        let trends = build(&[("o/r", &ledger)], &NONE, now);
        assert_eq!(trends.tests.len(), 1);
        let row = &trends.tests[0];
        assert_eq!(
            (row.name.as_str(), row.os, row.state),
            ("a.test.ts › t", Os::Linux, TestState::Quarantined)
        );
        assert_eq!((row.runs_7d, row.fails_7d, row.clean_since), (2, 1, 0));
        assert_eq!(row.flaked_on.as_deref(), Some("d1"));
        assert_eq!(row.quarantined_at, Some(T0 + HOUR));
        assert!(matches!(row.quarantined_by, Some(Origin::Session { .. })));
        assert_eq!(row.p50_ms_30d, 20);
        assert_eq!(row.test, test_id("o/r", Os::Linux, "a.test.ts › t"));
        assert_ne!(row.test, test_id("o/r", Os::Windows, "a.test.ts › t"));
        // Five clean runs on different inputs clear it; it stays listed as cleared for a week.
        let passed = [pass("a.test.ts", "t")];
        for n in 1..=5u64 {
            let (run, digest) = (format!("c{n}"), format!("e{n}"));
            feed(
                &mut ledger,
                &run,
                &digest,
                T0 + n * DAY_MS,
                Os::Linux,
                &passed,
            );
        }
        assert!(!ledger.flaky.quarantined(&key));
        let cleared_at = T0 + 5 * DAY_MS;
        let trends = build(&[("o/r", &ledger)], &NONE, cleared_at + HOUR);
        let row = &trends.tests[0];
        assert_eq!(
            (row.state, row.clean_since, row.cleared_at),
            (TestState::Cleared, 5, Some(cleared_at))
        );
        assert!(
            build(&[("o/r", &ledger)], &NONE, cleared_at + 8 * DAY_MS)
                .tests
                .is_empty()
        );
    }

    #[test]
    fn a_test_and_its_file_over_their_median_three_runs_in_a_row_are_slowdowns() {
        let mut ledger = Ledger::default();
        let mut at = T0;
        let mut run = |ledger: &mut Ledger, ms: u64, n: u64| {
            at += HOUR;
            let cases = [case(
                "e2e/parity.e2e.ts",
                "sidebar-family",
                &[(Outcome::Pass, ms)],
            )];
            feed(
                ledger,
                &format!("r{n}"),
                &format!("d{n}"),
                at,
                Os::Macos,
                &cases,
            );
        };
        for n in 0..6 {
            run(&mut ledger, 38_000, n);
        }
        for n in 6..8 {
            run(&mut ledger, 60_000, n);
        }
        assert!(
            build(&[("o/r", &ledger)], &NONE, T0 + DAY_MS)
                .slowdowns
                .is_empty()
        );
        run(&mut ledger, 71_000, 8);
        let slow = build(&[("o/r", &ledger)], &NONE, T0 + DAY_MS).slowdowns;
        // The test and the file it is alone in.
        let names: Vec<&str> = slow.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            ["e2e/parity.e2e.ts", "e2e/parity.e2e.ts › sidebar-family"]
        );
        assert_eq!((slow[1].os, slow[1].p50_ms_30d), (Os::Macos, 38_000));
        assert_eq!(slow[1].last_ms[6..], [60_000, 60_000, 71_000]);
        assert_eq!(slow[1].since_sha.as_deref(), Some("abc1234"));
    }

    #[test]
    fn minutes_are_summed_per_system_and_month_across_repositories() {
        let (mut a, mut b) = (Ledger::default(), Ledger::default());
        let cases = [pass("a.test.ts", "t")];
        // Each fed job runs five minutes.
        feed(&mut a, "r1", "d1", T0, Os::Linux, &cases);
        feed(&mut a, "r2", "d2", T0 + HOUR, Os::Linux, &cases);
        feed(&mut b, "r3", "d3", T0 + 40 * DAY_MS, Os::Linux, &cases);
        let trends = build(&[("o/a", &a), ("o/b", &b)], &NONE, T0 + 41 * DAY_MS);
        let rows: Vec<(String, f64, f64)> = trends
            .minutes
            .iter()
            .map(|m| {
                (
                    format!("{} {}", m.month, m.os.word()),
                    m.minutes,
                    m.cost_usd,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("2024-10 linux".to_string(), 10.0, 0.06),
                ("2024-11 linux".to_string(), 5.0, 0.03)
            ]
        );
    }

    #[test]
    fn the_week_and_the_week_before_are_told_apart() {
        let mut ledger = Ledger::default();
        quarantine(&mut ledger);
        // A quarantined failure alone fails a five-minute job: time lost.
        let failed = [fail("a.test.ts", "t")];
        feed(&mut ledger, "old", "x1", T0 + DAY_MS, Os::Linux, &failed);
        feed(
            &mut ledger,
            "new",
            "x2",
            T0 + 9 * DAY_MS,
            Os::Linux,
            &failed,
        );
        ledger.note_reuse(T0 + 9 * DAY_MS, 7_000);
        ledger.note_queue(T0 + 9 * DAY_MS, "github-macos", 12);
        ledger.note_queue(T0 + DAY_MS, "github-macos", 71);
        let trends = build(&[("o/r", &ledger)], &NONE, T0 + 10 * DAY_MS);
        assert_eq!(
            (trends.lost_ms_7d, trends.lost_ms_prev_7d),
            (300_000, 300_000)
        );
        assert_eq!(trends.saved_by_reuse_ms_7d, 7_000);
        assert_eq!(
            trends.queue_depth,
            [DepthPoint {
                at: T0 + 9 * DAY_MS,
                pool: "github-macos".into(),
                queued: 12
            }]
        );
    }

    #[test]
    fn a_computers_own_quarantine_is_listed_once_and_the_stores_are_summed() {
        let mut ledger = Ledger::default();
        quarantine(&mut ledger);
        let flaky = |name: &str, quarantined| LocalFlaky {
            check: "k1".into(),
            name: name.into(),
            passed: 9,
            failed: 3,
            quarantined,
            streak: 2,
        };
        let pool = |device: &str, bytes| LocalPool {
            device: device.into(),
            os: Os::Linux,
            slots: 1,
            held: 0,
            queued: 0,
            oldest_wait_ms: 0,
            volumes: Vec::new(),
            check_store_bytes: bytes,
            as_of: 0,
            offline: false,
        };
        let local = Local {
            flaky: &[
                flaky("a.test.ts › t", true),
                flaky("b.test.ts › only local", true),
                flaky("c", false),
            ],
            os: Os::Linux,
            pools: &[
                pool("local", Some(4_000)),
                pool("mini", Some(2_800)),
                pool("desktop", None),
            ],
        };
        let trends = build(&[("o/r", &ledger)], &local, T0 + 2 * HOUR);
        let names: Vec<&str> = trends.tests.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["b.test.ts › only local", "a.test.ts › t"]);
        assert_eq!(
            (trends.tests[0].fails_7d, trends.tests[0].clean_since),
            (3, 2)
        );
        assert_eq!(trends.store_bytes, Some(6_800));
        assert_eq!(build(&[], &NONE, T0).store_bytes, None);
    }
}
