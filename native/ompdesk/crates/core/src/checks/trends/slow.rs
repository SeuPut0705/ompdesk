//! The slowdown alert: a test (or a test file) that ran over `OVER_PCT` of its 30-day median `IN_A_ROW` runs in a row.
//!
//! The median is of the passing runs in the window **before** those last runs, so a test that just became slow is
//! judged against what it was, and it needs `MIN_BASE` of them: a new test has no pace yet. Three in a row, because
//! one slow run is a busy runner. The alert ends by itself: when a run is back under the line, or when the slower
//! pace has filled half the window and is the median (it is then the test's pace, and no news). A median under
//! `MIN_MEDIAN_MS` raises none: there the runner's own jitter is larger than the rule's 30 %.

use super::{DAY_MS, WINDOW_DAYS, median};
use crate::checks::results::ledger::Sample;

pub const OVER_PCT: u64 = 130;
pub const IN_A_ROW: usize = 3;
const MIN_BASE: usize = 5;
const MIN_MEDIAN_MS: u64 = 200;
/// How many of the newest durations the trend line draws.
pub const TREND_POINTS: usize = 16;

#[derive(Clone, Debug, PartialEq)]
pub struct Slow {
    /// The first run of the slow streak: the commit to look at.
    pub since_sha: String,
    pub since_run: String,
    pub since_at: u64,
    /// How long the streak is.
    pub runs: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pace {
    /// None while the window holds no passing run.
    pub median_ms: Option<u64>,
    /// The newest durations, oldest first.
    pub last_ms: Vec<u64>,
    pub slow: Option<Slow>,
}

pub fn over(ms: u64, median_ms: u64) -> bool {
    ms.saturating_mul(100) > median_ms.saturating_mul(OVER_PCT)
}

/// `samples`: a test's passing runs, oldest first, one per run.
pub fn pace(samples: &[Sample], now: u64) -> Pace {
    let from = now.saturating_sub(WINDOW_DAYS * DAY_MS);
    let window: Vec<&Sample> = samples.iter().filter(|s| s.at >= from).collect();
    let last_ms = window[window.len().saturating_sub(TREND_POINTS)..]
        .iter()
        .map(|s| s.ms)
        .collect();
    let (base, recent) = window.split_at(window.len().saturating_sub(IN_A_ROW));
    let mut values: Vec<u64> = base.iter().map(|s| s.ms).collect();
    if values.is_empty() {
        values = window.iter().map(|s| s.ms).collect();
    }
    let median_ms = median(&mut values);
    let slow = match median_ms {
        Some(mid)
            if base.len() >= MIN_BASE
                && mid >= MIN_MEDIAN_MS
                && recent.len() == IN_A_ROW
                && recent.iter().all(|s| over(s.ms, mid)) =>
        {
            let before = base.iter().rev().take_while(|s| over(s.ms, mid)).count();
            let first = window[base.len() - before];
            Some(Slow {
                since_sha: first.sha.clone(),
                since_run: first.run.clone(),
                since_at: first.at,
                runs: before + IN_A_ROW,
            })
        }
        _ => None,
    };
    Pace {
        median_ms,
        last_ms,
        slow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 20_000 * DAY_MS;

    fn runs(ms: &[u64]) -> Vec<Sample> {
        let n = ms.len() as u64;
        ms.iter()
            .enumerate()
            .map(|(i, ms)| Sample {
                at: NOW - (n - i as u64) * 3_600_000,
                run: format!("r{i}"),
                sha: format!("sha{i}"),
                ms: *ms,
            })
            .collect()
    }

    #[test]
    fn three_runs_in_a_row_over_the_line_raise_it() {
        let p = pace(&runs(&[1000, 1010, 990, 1000, 1005, 1400, 1350, 1310]), NOW);
        assert_eq!(p.median_ms, Some(1000));
        let slow = p.slow.unwrap();
        assert_eq!((slow.since_sha.as_str(), slow.runs), ("sha5", 3));
        assert_eq!(p.last_ms.last(), Some(&1310));
    }

    #[test]
    fn two_in_a_row_or_exactly_the_line_do_not() {
        assert!(
            pace(
                &runs(&[1000, 1000, 1000, 1000, 1000, 1000, 1400, 1400]),
                NOW
            )
            .slow
            .is_none()
        );
        // 1.3 times the median is not over it.
        assert!(
            pace(
                &runs(&[1000, 1000, 1000, 1000, 1000, 1300, 1300, 1300]),
                NOW
            )
            .slow
            .is_none()
        );
        // A fast run between slow ones breaks the row.
        assert!(
            pace(
                &runs(&[1000, 1000, 1000, 1000, 1000, 1400, 900, 1400, 1400]),
                NOW
            )
            .slow
            .is_none()
        );
    }

    #[test]
    fn the_streak_names_the_run_it_began_with() {
        let p = pace(
            &runs(&[
                1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000, 2100, 2050, 2000, 1990,
            ]),
            NOW,
        );
        let slow = p.slow.unwrap();
        assert_eq!((slow.since_sha.as_str(), slow.runs), ("sha7", 5));
    }

    #[test]
    fn a_new_test_and_a_tiny_one_have_no_pace_to_fall_behind() {
        // Four runs before the three: too few to call a median.
        assert!(
            pace(&runs(&[1000, 1000, 1000, 1000, 2000, 2000, 2000]), NOW)
                .slow
                .is_none()
        );
        // 4 ms to 9 ms is the timer, not the test.
        assert!(pace(&runs(&[4, 4, 5, 4, 4, 9, 9, 9]), NOW).slow.is_none());
        assert_eq!(pace(&[], NOW), Pace::default());
        assert_eq!(pace(&runs(&[70, 90]), NOW).median_ms, Some(70));
    }

    #[test]
    fn a_slower_pace_that_stays_becomes_the_median_and_the_alert_ends() {
        let mut ms = vec![1000; 6];
        ms.extend([2000; 4]);
        assert!(pace(&runs(&ms), NOW).slow.is_some());
        ms.extend([2000; 6]);
        let p = pace(&runs(&ms), NOW);
        assert_eq!(p.median_ms, Some(2000));
        assert!(p.slow.is_none());
    }

    #[test]
    fn runs_older_than_the_window_do_not_count() {
        let mut samples = runs(&[1000, 1000, 1000, 1000, 1000, 1400, 1400, 1400]);
        for old in &mut samples[..5] {
            old.at = NOW - 31 * DAY_MS;
        }
        let p = pace(&samples, NOW);
        assert_eq!(p.median_ms, Some(1400));
        assert!(p.slow.is_none());
    }
}
