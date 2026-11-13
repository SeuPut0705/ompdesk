//! One repository's tests and runner use as its runs showed them, kept between runs (`Ledger`).
//!
//! **Quarantine** is the rule of `ompdesk check` (`ompdesk_checks::flaky::Book`, the one implementation): a test that
//! passed and failed on one input digest is flaky, and leaves after `CLEAR_AFTER` clean runs on different inputs. A
//! run on a runner feeds the same book: a job's rerun on the same commit and inputs is the same digest, and a
//! runner's own retry is a `flaky` result. A test is kept per operating system, because the same test is a
//! different program on each (a test that flakes on Windows is not suspect on Linux, and its durations differ).
//!
//! **Only failures are remembered.** A repository has thousands of tests and a book that recorded every pass would
//! be megabytes rewritten on every run, so a pass is recorded only for a test the book already knows. What that
//! would lose is a test's first failure on inputs it passed on before; `seen` keeps it: the jobs of a run that
//! reported and the tests that failed there. A report lists every test of its job, so a test of that job that is
//! not among the failed passed. It is kept per run, not per digest: a rerun runs the same jobs again, while another
//! run of the same inputs may deal its tests to other jobs, and a test missing from a job's failures would then
//! read as passed where it never ran.
//!
//! **Durations** (`Track::samples`) are passing runs only, at most `MAX_SAMPLES` over the window: past that every
//! second of the older ones goes, so the window stays covered and the median leans to the recent. A file always has
//! a track (the sum of its tests); a test has its own once it took `TRACK_TEST_MS` or failed.

use std::collections::BTreeMap;

use ompdesk_checks::flaky::{Book, CLEAR_AFTER, Failures};
use serde::{Deserialize, Serialize};

use super::reports::{Case, Outcome};
use crate::checks::contract::{Origin, Os, TestRecord, TestState};
use crate::checks::trends::cost::{self, Use};
use crate::checks::trends::slow::{self, Pace};
use crate::checks::trends::{DAY_MS, PerOs, WINDOW_DAYS, day_of};

const MAX_SAMPLES: usize = 96;
/// The newest samples are never thinned: the slowdown rule and the trend line read them one by one.
const KEEP_RECENT: usize = slow::TREND_POINTS;
const TRACK_TEST_MS: u64 = 1_000;
const KEEP_SEEN: usize = 64;
/// Run attempts remembered as taken in, newest last.
const KEEP_DONE: usize = 2_048;
/// How long a test that left quarantine stays listed.
pub const SHOW_CLEARED_MS: u64 = 7 * DAY_MS;
/// How long a day's runner use is kept: this month and the five before it.
const COST_DAYS: u64 = 186;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Sample {
    pub at: u64,
    pub run: String,
    pub sha: String,
    pub ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct DayCount {
    pub runs: u32,
    pub fails: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Track {
    pub os: Os,
    pub name: String,
    pub samples: Vec<Sample>,
    /// Results per UTC day, for "failed 11 of 140 in 7 days".
    pub days: BTreeMap<u32, DayCount>,
    pub entered_at: Option<u64>,
    /// Who started the run that put it in quarantine.
    pub entered_by: Option<Origin>,
    pub cleared_at: Option<u64>,
    pub last_error: String,
}

impl Default for Track {
    fn default() -> Track {
        Track {
            os: Os::Linux,
            name: String::new(),
            samples: Vec::new(),
            days: BTreeMap::new(),
            entered_at: None,
            entered_by: None,
            cleared_at: None,
            last_error: String::new(),
        }
    }
}

impl Track {
    /// Results and failures in the `days` up to `now`.
    pub fn counts(&self, now: u64, days: u32) -> DayCount {
        let from = day_of(now).saturating_sub(days.saturating_sub(1));
        self.days
            .range(from..)
            .fold(DayCount::default(), |sum, (_, d)| DayCount {
                runs: sum.runs + d.runs,
                fails: sum.fails + d.fails,
            })
    }

    pub fn pace(&self, now: u64) -> Pace {
        slow::pace(&self.samples, now)
    }
}

/// A job of a run that reported (`<run>/<job name>`): the tests that failed there.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Seen {
    pub inputs: String,
    pub failed: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Day {
    /// Job time that went into flaky tests: a job that failed on nothing but quarantined tests, and the failed
    /// attempts a runner retried.
    pub lost_ms: u64,
    /// Job time a rerun of only the failed jobs did not spend again.
    pub saved_ms: u64,
    /// Job time a reused green result did not spend at all.
    pub reused_ms: u64,
    pub used: PerOs<Use>,
    /// The most jobs seen waiting at once, by pool.
    pub queued: BTreeMap<String, u32>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(default)]
pub struct Ledger {
    pub flaky: Book,
    pub tracks: BTreeMap<String, Track>,
    pub seen: Vec<Seen>,
    pub days: BTreeMap<u32, Day>,
    pub done: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    Passed,
    Failed,
    Cancelled,
    Skipped,
}

/// One job of a run attempt, as GitHub (or a local runner) reported it.
#[derive(Clone, Copy)]
pub struct JobDone<'a> {
    /// The same across a run's attempts.
    pub name: &'a str,
    pub os: Os,
    pub labels: &'a [String],
    pub started: u64,
    pub ended: u64,
    pub outcome: Ended,
    /// Not run in this attempt: its result is an earlier attempt's (a rerun of only the failed jobs).
    pub carried: bool,
    /// Its test report; `None` when it uploaded none (a job without tests, or one that died before writing it).
    pub cases: Option<&'a [Case]>,
}

pub struct Attempt<'a> {
    pub run: &'a str,
    pub attempt: u32,
    pub sha: &'a str,
    /// The run's input digest (commit, workflow file, inputs, tools), as reuse keys it.
    pub digest: &'a str,
    pub by: Option<&'a Origin>,
    pub jobs: &'a [JobDone<'a>],
}

/// A failed test with what an agent needs to judge it without reading a log.
#[derive(Clone, Debug, PartialEq)]
pub struct Failed {
    pub test: String,
    pub first_error: String,
    pub known_flaky: bool,
    pub record: TestRecord,
    /// How often it has failed on these inputs, this time included, without ever passing on them.
    pub repeats: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct JobJudged {
    pub name: String,
    pub ms: u64,
    pub outcome: Ended,
    pub reported: bool,
    /// Tests that passed, a retried pass included.
    pub passed: u32,
    pub came_to: Failures,
    pub blocking: Vec<Failed>,
    pub quarantined: Vec<Failed>,
}

impl JobJudged {
    /// `release`: the run is a release gate's, where a quarantined test that failed or flaked still fails it.
    pub fn passes(&self, release: bool) -> bool {
        match self.outcome {
            Ended::Skipped => true,
            Ended::Cancelled => false,
            Ended::Passed | Ended::Failed => {
                self.came_to.passes(self.outcome == Ended::Passed, release)
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Judged {
    pub jobs: Vec<JobJudged>,
    /// Tests this attempt put in quarantine, and tests it let out.
    pub entered: Vec<String>,
    pub cleared: Vec<String>,
}

impl Judged {
    pub fn green(&self, release: bool) -> bool {
        self.jobs.iter().all(|j| j.passes(release))
    }
}

pub fn key(os: Os, name: &str) -> String {
    format!("{}|{name}", os.word())
}

fn file_name(case: &Case) -> String {
    if case.project.is_empty() {
        case.file.clone()
    } else {
        format!("[{}] {}", case.project, case.file)
    }
}

fn push_sample(samples: &mut Vec<Sample>, sample: Sample) {
    // A run's rerun is the same run: its last word counts once.
    if let Some(last) = samples.last_mut()
        && last.run == sample.run
    {
        *last = sample;
        return;
    }
    samples.push(sample);
    if samples.len() > MAX_SAMPLES {
        let old = samples.len() - KEEP_RECENT;
        let mut at = 0;
        samples.retain(|_| {
            let keep = at >= old || at % 2 == 0;
            at += 1;
            keep
        });
    }
}

impl Ledger {
    /// Takes one finished attempt of a run in: its tests into the quarantine book and the tracks, its jobs into
    /// the day's runner use. Taking the same attempt in again changes nothing and answers `None`.
    pub fn ingest(&mut self, attempt: &Attempt) -> Option<Judged> {
        let id = format!("{}#{}", attempt.run, attempt.attempt);
        if self.done.contains(&id) {
            return None;
        }
        let mut judged = Judged::default();
        let mut newest = 0;
        for job in attempt.jobs {
            newest = newest.max(job.ended);
            let ms = job.ended.saturating_sub(job.started);
            if job.carried {
                if job.outcome == Ended::Passed {
                    self.days.entry(day_of(job.ended)).or_default().saved_ms += ms;
                }
                continue;
            }
            if job.outcome != Ended::Skipped
                && let Some(used) = cost::price(job.os, job.labels, job.started, job.ended)
            {
                let day = self.days.entry(day_of(job.ended)).or_default();
                day.used.of_mut(job.os).add(used);
            }
            let job = self.job(attempt, job, &mut judged.entered, &mut judged.cleared);
            judged.jobs.push(job);
        }
        self.done.push(id);
        if self.done.len() > KEEP_DONE {
            self.done.drain(..self.done.len() - KEEP_DONE);
        }
        self.trim(newest);
        Some(judged)
    }

    fn job(
        &mut self,
        attempt: &Attempt,
        job: &JobDone,
        entered: &mut Vec<String>,
        cleared: &mut Vec<String>,
    ) -> JobJudged {
        let ms = job.ended.saturating_sub(job.started);
        let mut out = JobJudged {
            name: job.name.to_string(),
            ms,
            outcome: job.outcome,
            reported: job.cases.is_some(),
            passed: 0,
            came_to: Failures::default(),
            blocking: Vec::new(),
            quarantined: Vec::new(),
        };
        let Some(cases) = job.cases else {
            return out;
        };
        let (at, day) = (job.ended, day_of(job.ended));
        let inputs = format!("{}/{}", attempt.run, job.name);
        let earlier = self.seen.iter().position(|s| s.inputs == inputs);
        let run = format!("{}#{}", attempt.run, attempt.attempt);
        // A file's total, while every test of it passed (a failure's time says nothing of the file's pace).
        let mut files: BTreeMap<String, Option<u64>> = BTreeMap::new();
        let mut failed_here: Vec<String> = Vec::new();
        let mut retried_ms = 0;
        for case in cases {
            let outcome = case.outcome();
            if outcome == Outcome::Skip {
                continue;
            }
            let (name, failed, flaky) = (case.name(), outcome == Outcome::Fail, case.flaky());
            out.passed += u32::from(!failed);
            if !case.titles.is_empty() {
                let total = files.entry(file_name(case)).or_insert(Some(0));
                *total = match (*total, failed) {
                    (Some(sum), false) => Some(sum + case.ms()),
                    _ => None,
                };
            }
            let id = key(job.os, &name);
            let was = self.flaky.quarantined(&id);
            let known = self.flaky.tests.contains_key(&id);
            let mut put = false;
            if flaky {
                put = self.flaky.record(&id, &name, "flaky", attempt.digest, &run);
                retried_ms += case
                    .attempts
                    .iter()
                    .filter(|a| a.outcome == Outcome::Fail)
                    .map(|a| a.ms)
                    .sum::<u64>();
            } else if failed {
                // It passed on these inputs before: this job reported on them and did not name it.
                let passed_before = earlier.is_some_and(|i| !self.seen[i].failed.contains(&name));
                let recorded = self.flaky.tests.get(&id).is_some_and(|t| {
                    t.sets
                        .iter()
                        .any(|s| s.digest == attempt.digest && s.passed > 0)
                });
                if passed_before && !recorded {
                    self.flaky
                        .record(&id, &name, "passed", attempt.digest, &run);
                }
                put = self
                    .flaky
                    .record(&id, &name, "failed", attempt.digest, &run);
            } else if known {
                // A pass after a failure on these inputs is what puts it in quarantine.
                put = self
                    .flaky
                    .record(&id, &name, "passed", attempt.digest, &run);
            }
            let now_quarantined = self.flaky.quarantined(&id);
            let tracked = self.tracks.contains_key(&id);
            if !(tracked || failed || flaky || known || case.ms() >= TRACK_TEST_MS) {
                continue;
            }
            let track = self.tracks.entry(id.clone()).or_default();
            track.os = job.os;
            track.name.clone_from(&name);
            let count = track.days.entry(day).or_default();
            count.runs += 1;
            count.fails += u32::from(failed || flaky);
            if failed || flaky {
                track.last_error.clone_from(&case.first_error);
            }
            if put {
                track.entered_at = Some(at);
                track.entered_by = attempt.by.cloned();
                track.cleared_at = None;
                entered.push(name.clone());
            } else if was && !now_quarantined {
                track.cleared_at = Some(at);
                cleared.push(name.clone());
            }
            if !failed {
                push_sample(
                    &mut track.samples,
                    Sample {
                        at,
                        run: attempt.run.to_string(),
                        sha: attempt.sha.to_string(),
                        ms: case.ms(),
                    },
                );
            }
            if failed {
                failed_here.push(name.clone());
                let test = Failed {
                    record: self.record(&id, job.os, at),
                    repeats: self.repeats(&id, attempt.digest),
                    test: name,
                    first_error: case.first_error.clone(),
                    known_flaky: now_quarantined,
                };
                if now_quarantined {
                    out.quarantined.push(test);
                } else {
                    out.blocking.push(test);
                }
            } else if flaky && now_quarantined {
                out.came_to.quarantined_flaky += 1;
            }
        }
        out.came_to.blocking = out.blocking.len();
        out.came_to.quarantined = out.quarantined.len();
        for (name, total) in files {
            let Some(ms) = total else { continue };
            let track = self.tracks.entry(key(job.os, &name)).or_default();
            track.os = job.os;
            track.name = name;
            track.days.entry(day).or_default().runs += 1;
            push_sample(
                &mut track.samples,
                Sample {
                    at,
                    run: attempt.run.to_string(),
                    sha: attempt.sha.to_string(),
                    ms,
                },
            );
        }
        let flakes_alone = job.outcome == Ended::Failed
            && out.came_to.blocking == 0
            && out.came_to.quarantined > 0;
        self.days.entry(day).or_default().lost_ms += if flakes_alone { ms } else { retried_ms };
        match earlier {
            Some(i) => {
                for name in failed_here {
                    if !self.seen[i].failed.contains(&name) {
                        self.seen[i].failed.push(name);
                    }
                }
            }
            None => {
                self.seen.push(Seen {
                    inputs,
                    failed: failed_here,
                });
                if self.seen.len() > KEEP_SEEN {
                    self.seen.remove(0);
                }
            }
        }
        out
    }

    /// The most jobs a poll saw waiting in `pool`: the day's peak. True when this raised it (the ledger changed).
    pub fn note_queue(&mut self, at: u64, pool: &str, waiting: u32) -> bool {
        let peak = self
            .days
            .get(&day_of(at))
            .and_then(|day| day.queued.get(pool))
            .copied()
            .unwrap_or(0);
        if waiting <= peak {
            return false;
        }
        let day = self.days.entry(day_of(at)).or_default();
        day.queued.insert(pool.to_string(), waiting);
        true
    }

    /// A start answered with a green result of the same inputs instead of a run.
    pub fn note_reuse(&mut self, at: u64, saved_ms: u64) {
        self.days.entry(day_of(at)).or_default().reused_ms += saved_ms;
    }

    /// A quarantined test's clean runs so far, of `CLEAR_AFTER`.
    pub fn clean(&self, key: &str) -> u32 {
        self.flaky
            .tests
            .get(key)
            .map_or(0, |t| if t.quarantined { t.streak } else { CLEAR_AFTER })
    }

    fn repeats(&self, key: &str, digest: &str) -> u32 {
        self.flaky
            .tests
            .get(key)
            .and_then(|t| t.sets.iter().find(|s| s.digest == digest))
            .map_or(0, |s| if s.passed == 0 { s.failed } else { 0 })
    }

    /// A failed test's record, for the answer: its week and where the quarantine stands.
    pub fn record(&self, key: &str, os: Os, now: u64) -> TestRecord {
        let week = self
            .tracks
            .get(key)
            .map(|t| t.counts(now, 7))
            .unwrap_or_default();
        let (state, clean_runs) = match self.flaky.tests.get(key) {
            Some(t) if t.quarantined => (TestState::Quarantined, t.streak),
            Some(t) if !t.flaked_on.is_empty() => (TestState::Cleared, 0),
            _ => (TestState::Active, 0),
        };
        TestRecord {
            os,
            fails_7d: week.fails,
            runs_7d: week.runs,
            state,
            clean_runs,
            clear_after: CLEAR_AFTER,
        }
    }

    /// Drops what the windows no longer hold. A test's book entry goes once it is out of quarantine, none of its
    /// remembered input sets holds a failure and it is no longer listed as cleared.
    fn trim(&mut self, now: u64) {
        let first_cost_day = day_of(now.saturating_sub(COST_DAYS * DAY_MS));
        self.days.retain(|day, _| *day >= first_cost_day);
        let from = now.saturating_sub(WINDOW_DAYS * DAY_MS);
        let first_day = day_of(from);
        for track in self.tracks.values_mut() {
            track.samples.retain(|s| s.at >= from);
            track.days.retain(|day, _| *day >= first_day);
        }
        let shown = |t: &Track| t.cleared_at.is_some_and(|at| at + SHOW_CLEARED_MS > now);
        let tracks = &self.tracks;
        self.flaky.tests.retain(|key, t| {
            t.quarantined
                || t.sets.iter().any(|s| s.failed > 0)
                || tracks.get(key).is_some_and(shown)
        });
        let flaky = &self.flaky;
        self.tracks.retain(|key, t| {
            !t.samples.is_empty() || !t.days.is_empty() || flaky.tests.contains_key(key)
        });
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::reports::Attempt as Try;
    use super::*;

    const HOUR: u64 = 3_600_000;
    pub(crate) const T0: u64 = 20_000 * DAY_MS;

    pub(crate) fn case(file: &str, title: &str, tries: &[(Outcome, u64)]) -> Case {
        Case {
            runner: "vitest".into(),
            project: String::new(),
            file: file.into(),
            titles: vec![title.into()],
            attempts: tries
                .iter()
                .map(|(outcome, ms)| Try {
                    outcome: *outcome,
                    ms: *ms,
                })
                .collect(),
            first_error: if tries.iter().any(|(o, _)| *o == Outcome::Fail) {
                "AssertionError: expected 1 to be 2".into()
            } else {
                String::new()
            },
        }
    }

    pub(crate) fn pass(file: &str, title: &str) -> Case {
        case(file, title, &[(Outcome::Pass, 20)])
    }

    /// One run's one job, for the tests of the modules that read a ledger.
    pub(crate) fn feed(
        ledger: &mut Ledger,
        run: &str,
        digest: &str,
        at: u64,
        os: Os,
        cases: &[Case],
    ) {
        take(
            ledger,
            Run {
                os,
                ..linux(run, 1, digest, at, cases)
            },
        );
    }

    pub(crate) fn fail(file: &str, title: &str) -> Case {
        case(file, title, &[(Outcome::Fail, 20)])
    }

    #[derive(Clone, Copy)]
    struct Run<'a> {
        run: &'a str,
        attempt: u32,
        digest: &'a str,
        at: u64,
        os: Os,
        cases: &'a [Case],
    }

    fn take(ledger: &mut Ledger, r: Run) -> Option<Judged> {
        let labels = vec!["ubuntu-latest".to_string()];
        let by = Origin::Session {
            session: "s1".into(),
            device: "local".into(),
            goal: None,
        };
        let ok = r.cases.iter().all(|c| c.outcome() != Outcome::Fail);
        ledger.ingest(&Attempt {
            run: r.run,
            attempt: r.attempt,
            sha: "abc1234",
            digest: r.digest,
            by: Some(&by),
            jobs: &[JobDone {
                name: "check (node 1/2)",
                os: r.os,
                labels: &labels,
                started: r.at - 5 * 60_000,
                ended: r.at,
                outcome: if ok { Ended::Passed } else { Ended::Failed },
                carried: false,
                cases: Some(r.cases),
            }],
        })
    }

    fn linux<'a>(
        run: &'a str,
        attempt: u32,
        digest: &'a str,
        at: u64,
        cases: &'a [Case],
    ) -> Run<'a> {
        Run {
            run,
            attempt,
            digest,
            at,
            os: Os::Linux,
            cases,
        }
    }

    #[test]
    fn a_failure_that_passes_on_the_rerun_of_the_same_inputs_is_quarantined() {
        let mut ledger = Ledger::default();
        let cases = [fail("a.test.ts", "t"), pass("a.test.ts", "u")];
        let first = take(&mut ledger, linux("r1", 1, "d1", T0, &cases)).unwrap();
        assert_eq!(first.jobs[0].blocking.len(), 1);
        assert!(!first.jobs[0].blocking[0].known_flaky);
        assert_eq!(first.jobs[0].blocking[0].repeats, 1);
        assert_eq!(first.jobs[0].passed, 1);
        assert!(!first.green(false));
        let cases = [pass("a.test.ts", "t"), pass("a.test.ts", "u")];
        let again = take(&mut ledger, linux("r1", 2, "d1", T0 + HOUR, &cases)).unwrap();
        assert_eq!(again.entered, vec!["a.test.ts › t"]);
        assert!(again.green(true));
        let k = key(Os::Linux, "a.test.ts › t");
        assert!(ledger.flaky.quarantined(&k));
        assert!(matches!(
            ledger.tracks[&k].entered_by,
            Some(Origin::Session { .. })
        ));
        // The test that only ever passed is not kept.
        assert!(
            !ledger
                .flaky
                .tests
                .contains_key(&key(Os::Linux, "a.test.ts › u"))
        );
    }

    #[test]
    fn a_failure_that_fails_again_on_the_same_inputs_is_not_flaky_and_counts_its_repeats() {
        let mut ledger = Ledger::default();
        let cases = [fail("a.test.ts", "t")];
        take(&mut ledger, linux("r1", 1, "d1", T0, &cases));
        let again = take(&mut ledger, linux("r1", 2, "d1", T0 + HOUR, &cases)).unwrap();
        assert!(again.entered.is_empty());
        assert_eq!(again.jobs[0].blocking[0].repeats, 2);
    }

    #[test]
    fn a_first_failure_on_inputs_the_job_passed_on_before_is_flaky_too() {
        let mut ledger = Ledger::default();
        let cases = [pass("a.test.ts", "t"), fail("a.test.ts", "other")];
        take(&mut ledger, linux("r1", 1, "d1", T0, &cases));
        // The rerun of the failed job: `t`, never seen failing, fails now.
        let rerun = [fail("a.test.ts", "t"), pass("a.test.ts", "other")];
        let judged = take(&mut ledger, linux("r1", 2, "d1", T0 + HOUR, &rerun)).unwrap();
        assert_eq!(judged.entered.len(), 2);
        assert!(judged.jobs[0].quarantined[0].known_flaky);
        // Another run of the same inputs may hold other tests under that job's name: its silence proves no pass.
        let mut other = Ledger::default();
        take(&mut other, linux("r1", 1, "d1", T0, &cases));
        let judged = take(&mut other, linux("r2", 1, "d1", T0 + HOUR, &rerun)).unwrap();
        assert_eq!(judged.entered, vec!["a.test.ts › other"]);
        assert!(!other.flaky.quarantined(&key(Os::Linux, "a.test.ts › t")));
        // A failure on inputs nothing reported on before proves nothing.
        let mut fresh = Ledger::default();
        let cases = [fail("a.test.ts", "t")];
        let judged = take(&mut fresh, linux("r9", 1, "d9", T0, &cases)).unwrap();
        assert!(judged.entered.is_empty());
    }

    #[test]
    fn a_different_outcome_on_another_system_or_other_inputs_is_not_flaky() {
        let mut ledger = Ledger::default();
        let failed = [fail("a.test.ts", "t")];
        take(&mut ledger, linux("r1", 1, "d1", T0, &failed));
        let passed = [pass("a.test.ts", "t")];
        let windows = Run {
            os: Os::Windows,
            ..linux("r2", 1, "d1", T0 + HOUR, &passed)
        };
        take(&mut ledger, windows);
        take(&mut ledger, linux("r3", 1, "d2", T0 + 2 * HOUR, &passed));
        assert!(ledger.flaky.tests.values().all(|t| !t.quarantined));
    }

    #[test]
    fn a_retried_pass_is_flaky_and_its_failed_attempts_are_time_lost() {
        let mut ledger = Ledger::default();
        let retried = [case(
            "e2e/a.e2e.ts",
            "t",
            &[(Outcome::Fail, 30_000), (Outcome::Pass, 4_000)],
        )];
        let judged = take(&mut ledger, linux("r1", 1, "d1", T0, &retried)).unwrap();
        assert_eq!(judged.entered.len(), 1);
        assert_eq!(judged.jobs[0].came_to.quarantined_flaky, 1);
        // The job passed: a branch run is green, a release gate is not.
        assert!(judged.green(false));
        assert!(!judged.green(true));
        assert_eq!(ledger.days[&day_of(T0)].lost_ms, 30_000);
        // Its passing attempt is its duration.
        let track = &ledger.tracks[&key(Os::Linux, "e2e/a.e2e.ts › t")];
        assert_eq!(track.samples[0].ms, 4_000);
    }

    pub(crate) fn quarantine(ledger: &mut Ledger) -> String {
        let failed = [fail("a.test.ts", "t")];
        take(ledger, linux("r1", 1, "d1", T0, &failed));
        let passed = [pass("a.test.ts", "t")];
        take(ledger, linux("r1", 2, "d1", T0 + HOUR, &passed));
        key(Os::Linux, "a.test.ts › t")
    }

    #[test]
    fn a_quarantined_failure_is_forgiven_on_a_branch_and_fails_a_release_gate() {
        let mut ledger = Ledger::default();
        quarantine(&mut ledger);
        let failed = [fail("a.test.ts", "t")];
        let judged = take(&mut ledger, linux("r2", 1, "d2", T0 + DAY_MS, &failed)).unwrap();
        assert_eq!(judged.jobs[0].outcome, Ended::Failed);
        assert_eq!(judged.jobs[0].quarantined.len(), 1);
        assert!(judged.jobs[0].blocking.is_empty());
        assert!(judged.green(false));
        assert!(!judged.green(true));
        // The whole job went into the flake.
        assert_eq!(ledger.days[&day_of(T0 + DAY_MS)].lost_ms, 5 * 60_000);
        // Beside a real failure it forgives nothing.
        let mixed = [fail("a.test.ts", "t"), fail("a.test.ts", "broken")];
        let judged = take(&mut ledger, linux("r3", 1, "d3", T0 + 2 * DAY_MS, &mixed)).unwrap();
        assert!(!judged.green(false));
    }

    #[test]
    fn a_failed_job_without_a_report_is_red() {
        let mut ledger = Ledger::default();
        let labels = vec!["ubuntu-latest".to_string()];
        let judged = ledger
            .ingest(&Attempt {
                run: "r1",
                attempt: 1,
                sha: "abc",
                digest: "d1",
                by: None,
                jobs: &[JobDone {
                    name: "build",
                    os: Os::Linux,
                    labels: &labels,
                    started: T0,
                    ended: T0 + 1_000,
                    outcome: Ended::Failed,
                    carried: false,
                    cases: None,
                }],
            })
            .unwrap();
        assert!(!judged.jobs[0].reported);
        assert!(!judged.green(false));
    }

    #[test]
    fn it_leaves_quarantine_after_five_clean_runs_on_different_inputs() {
        let mut ledger = Ledger::default();
        let k = quarantine(&mut ledger);
        let passed = [pass("a.test.ts", "t")];
        // The same inputs again and again are one clean run.
        for n in 0..4 {
            let run = format!("same{n}");
            take(
                &mut ledger,
                linux(&run, 1, "d2", T0 + DAY_MS + n * HOUR, &passed),
            );
        }
        assert_eq!(ledger.clean(&k), 1);
        let mut cleared = Vec::new();
        for n in 3..3 + u64::from(CLEAR_AFTER) - 1 {
            let (run, digest) = (format!("r{n}"), format!("d{n}"));
            let judged = take(
                &mut ledger,
                linux(&run, 1, &digest, T0 + n * DAY_MS, &passed),
            );
            cleared.extend(judged.unwrap().cleared);
        }
        assert_eq!(cleared, vec!["a.test.ts › t"]);
        assert!(!ledger.flaky.quarantined(&k));
        assert_eq!(ledger.clean(&k), CLEAR_AFTER);
        assert!(ledger.tracks[&k].cleared_at.is_some());
        let record = ledger.record(&k, Os::Linux, T0 + 7 * DAY_MS);
        assert_eq!(record.state, TestState::Cleared);
        assert!(record.english().contains("was flaky"));
    }

    #[test]
    fn the_same_attempt_taken_in_twice_counts_once() {
        let mut ledger = Ledger::default();
        let cases = [fail("a.test.ts", "t")];
        assert!(take(&mut ledger, linux("r1", 1, "d1", T0, &cases)).is_some());
        assert!(take(&mut ledger, linux("r1", 1, "d1", T0, &cases)).is_none());
        let k = key(Os::Linux, "a.test.ts › t");
        assert_eq!(ledger.flaky.tests[&k].failed, 1);
        assert_eq!(
            ledger.tracks[&k].counts(T0, 7),
            DayCount { runs: 1, fails: 1 }
        );
        assert_eq!(ledger.days[&day_of(T0)].used.linux.minutes, 5);
    }

    #[test]
    fn a_job_not_run_again_is_time_saved_and_costs_nothing_twice() {
        let mut ledger = Ledger::default();
        let labels = vec!["macos-latest".to_string()];
        let job = |name: &'static str, outcome, carried| JobDone {
            name,
            os: Os::Macos,
            labels: &labels,
            started: T0,
            ended: T0 + 10 * 60_000,
            outcome,
            carried,
            cases: None,
        };
        let mut take = |attempt, jobs: &[JobDone]| {
            ledger.ingest(&Attempt {
                run: "r1",
                attempt,
                sha: "abc",
                digest: "d1",
                by: None,
                jobs,
            })
        };
        take(
            1,
            &[
                job("smoke", Ended::Passed, false),
                job("native", Ended::Failed, false),
            ],
        );
        take(
            2,
            &[
                job("smoke", Ended::Passed, true),
                job("native", Ended::Passed, false),
            ],
        );
        let day = &ledger.days[&day_of(T0)];
        assert_eq!(
            day.used.macos,
            Use {
                minutes: 30,
                micros: 30 * 62_000
            }
        );
        assert_eq!(day.saved_ms, 10 * 60_000);
    }

    #[test]
    fn a_file_has_a_track_and_a_quick_test_has_none_until_it_fails() {
        let mut ledger = Ledger::default();
        let cases = [
            pass("a.test.ts", "quick"),
            case("a.test.ts", "long", &[(Outcome::Pass, 1_500)]),
            case("a.test.ts", "skipped", &[(Outcome::Skip, 0)]),
        ];
        take(&mut ledger, linux("r1", 1, "d1", T0, &cases));
        assert_eq!(
            ledger.tracks[&key(Os::Linux, "a.test.ts")].samples[0].ms,
            1_520
        );
        assert!(
            ledger
                .tracks
                .contains_key(&key(Os::Linux, "a.test.ts › long"))
        );
        assert!(
            !ledger
                .tracks
                .contains_key(&key(Os::Linux, "a.test.ts › quick"))
        );
        assert!(
            !ledger
                .tracks
                .contains_key(&key(Os::Linux, "a.test.ts › skipped"))
        );
        // A file with a failing test adds no duration that run.
        let failed = [fail("a.test.ts", "quick")];
        take(&mut ledger, linux("r2", 1, "d2", T0 + HOUR, &failed));
        assert_eq!(ledger.tracks[&key(Os::Linux, "a.test.ts")].samples.len(), 1);
        assert!(
            ledger
                .tracks
                .contains_key(&key(Os::Linux, "a.test.ts › quick"))
        );
    }

    #[test]
    fn samples_stay_bounded_and_keep_the_newest_and_the_window() {
        let mut samples = Vec::new();
        for n in 0..1_000u64 {
            push_sample(
                &mut samples,
                Sample {
                    at: n,
                    run: format!("r{n}"),
                    sha: String::new(),
                    ms: n,
                },
            );
        }
        assert!(samples.len() <= MAX_SAMPLES);
        let newest: Vec<u64> = samples[samples.len() - KEEP_RECENT..]
            .iter()
            .map(|s| s.at)
            .collect();
        assert_eq!(
            newest,
            (1_000 - KEEP_RECENT as u64..1_000).collect::<Vec<_>>()
        );
        assert!(samples.windows(2).all(|w| w[0].at < w[1].at));
        // A rerun replaces its run's sample.
        push_sample(
            &mut samples,
            Sample {
                at: 2_000,
                run: "r999".into(),
                sha: String::new(),
                ms: 7,
            },
        );
        assert_eq!(samples.last().map(|s| s.ms), Some(7));
    }

    #[test]
    fn what_the_windows_no_longer_hold_goes() {
        let mut ledger = Ledger::default();
        let failed = [fail("a.test.ts", "t")];
        take(&mut ledger, linux("r1", 1, "d1", T0, &failed));
        ledger.note_queue(T0, "github-macos", 71);
        ledger.note_queue(T0 + 1, "github-macos", 12);
        ledger.note_reuse(T0, 90_000);
        assert_eq!(ledger.days[&day_of(T0)].queued["github-macos"], 71);
        assert_eq!(ledger.days[&day_of(T0)].reused_ms, 90_000);
        // Eight later input sets push the failing one out of the book's memory.
        let passed = [pass("a.test.ts", "t")];
        for n in 0..9u64 {
            let (run, digest) = (format!("p{n}"), format!("e{n}"));
            take(
                &mut ledger,
                linux(&run, 1, &digest, T0 + (40 + n) * DAY_MS, &passed),
            );
        }
        assert!(ledger.flaky.tests.is_empty());
        let track = &ledger.tracks[&key(Os::Linux, "a.test.ts › t")];
        assert!(!track.days.contains_key(&day_of(T0)));
        // The day's runner use outlives the tests' window, and goes after half a year.
        assert!(ledger.days.contains_key(&day_of(T0)));
        take(
            &mut ledger,
            linux("late", 1, "z", T0 + 200 * DAY_MS, &passed),
        );
        assert!(!ledger.days.contains_key(&day_of(T0)));
    }

    #[test]
    fn the_ledger_reads_back_what_it_wrote() {
        let mut ledger = Ledger::default();
        let k = quarantine(&mut ledger);
        ledger.note_queue(T0, "github-macos", 3);
        let text = serde_json::to_string(&ledger).unwrap();
        let back: Ledger = serde_json::from_str(&text).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), text);
        assert!(back.flaky.quarantined(&k));
        // A file an older build wrote, with fields missing, still reads.
        let old: Ledger = serde_json::from_str(r#"{"tracks":{"linux|a":{"name":"a"}}}"#).unwrap();
        assert_eq!(old.tracks["linux|a"].os, Os::Linux);
    }
}
