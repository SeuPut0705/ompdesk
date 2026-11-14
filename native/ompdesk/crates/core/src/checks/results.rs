//! Test results (check control P4): what a finished run attempt's tests came to, judged against the flaky quarantine.
//!
//! The hub hands a completed attempt in once (`take_in`) with each job's test report, and gets what the `Answer`
//! needs of it: green or red under the quarantine's rule, the failed tests with their first error, whether each is a
//! known flaky one and its record in words, whether a quarantined failure blocks a release gate, how often the run
//! may still be rerun and what to do next. Assembling the `Answer` and `wait` are the hub's.
//!
//! - `reports`: a job's report file (Vitest or Jest JSON, Playwright JSON, JUnit XML) as `Case`s.
//! - `zip`: the artifact a job uploaded it in.
//! - `ledger`: a repository's quarantine book, test durations and runner use, kept between runs; `store` saves it.
//! - `rerun`: the per-run cap and the next step.
//!
//! A job's report is the artifact `test-report-<job id>` its workflow uploads, the id being the job context's
//! `check_run_id`: a report finds its job, and a job that ran again has another id and another report.

pub mod ledger;
pub mod reports;
pub mod rerun;
pub mod store;
pub mod zip;

use self::ledger::{Attempt, Ended, Failed, JobDone, Ledger};
use self::reports::Case;
use self::rerun::Budget;
use super::contract::{Counts, FailedTest, Next, Note, NoteCode, Origin, Os, RunVerdict};
use super::sources::{GithubJob, GithubRun};
use super::trends::cost;

pub const ARTIFACT_PREFIX: &str = "test-report-";

/// The job an artifact reports on; None for any other artifact of the run.
pub fn job_of_artifact(name: &str) -> Option<u64> {
    name.strip_prefix(ARTIFACT_PREFIX)?.parse().ok()
}

/// The tests of a job's report artifact (the zip as GitHub serves it). `repo` is `owner/name`.
pub fn cases_of(archive: &[u8], repo: &str) -> Result<Vec<Case>, String> {
    let name = repo.rsplit('/').next().unwrap_or(repo);
    let report = |file: &str| file.ends_with(".json") || file.ends_with(".xml");
    let files = zip::files(archive, &report)?;
    if files.is_empty() {
        return Err("the artifact holds no test report".into());
    }
    let mut cases = Vec::new();
    for (file, bytes) in files {
        cases.extend(reports::parse(&bytes, name).map_err(|e| format!("{file}: {e}"))?);
    }
    Ok(cases)
}

/// One job of the attempt with what the hub read for it.
pub struct JobFacts<'a> {
    pub job: &'a GithubJob,
    /// Its report (`cases_of`); None when it uploaded none or it could not be read.
    pub cases: Option<&'a [Case]>,
}

pub struct Finished<'a> {
    pub run: &'a GithubRun,
    pub jobs: &'a [JobFacts<'a>],
    /// The run's input digest, as reuse keys it.
    pub digest: &'a str,
    /// Who started the run.
    pub by: Option<&'a Origin>,
    /// The run decides a release gate: a quarantined test that failed or flaked in it still fails it.
    pub release: bool,
}

/// What the `Answer` takes from the tests.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub verdict: RunVerdict,
    /// Tests of this attempt's reports; a job without a report counts as one.
    pub counts: Counts,
    /// The tests that fail the run first, then the quarantined ones that failed (`knownFlaky`).
    pub failed: Vec<FailedTest>,
    /// A quarantined test failed or flaked in a run that decides a release gate.
    pub blocks_release: bool,
    /// Jobs that failed outside their tests, or without a report: their log has the reason.
    pub unreported: Vec<String>,
    pub rerun: Budget,
    pub next: Next,
    pub said: Vec<Note>,
}

fn ended(conclusion: Option<&str>) -> Ended {
    match conclusion {
        Some("success") => Ended::Passed,
        Some("cancelled") => Ended::Cancelled,
        Some("skipped" | "neutral") => Ended::Skipped,
        _ => Ended::Failed,
    }
}

fn failed_test(test: &Failed) -> FailedTest {
    FailedTest {
        test: test.test.clone(),
        first_error: Some(test.first_error.clone()),
        known_flaky: test.known_flaky,
        history: test.record.english(),
        record: Some(test.record.clone()),
    }
}

/// Takes a completed attempt of a run in and answers what it came to. None while the run is not completed, and
/// for an attempt already taken in (the hub keeps the first answer: the ledger counts every attempt once).
pub fn take_in(ledger: &mut Ledger, done: &Finished) -> Option<Verdict> {
    if done.run.status != "completed" {
        return None;
    }
    let jobs: Vec<JobDone> = done
        .jobs
        .iter()
        .map(|facts| {
            let job = facts.job;
            let end = job
                .completed_at
                .or(job.started_at)
                .unwrap_or(done.run.updated_at);
            JobDone {
                name: &job.name,
                os: cost::os_of(&job.labels).unwrap_or(Os::Linux),
                labels: &job.labels,
                started: job.started_at.unwrap_or(end),
                ended: end,
                outcome: ended(job.conclusion.as_deref()),
                carried: job.attempt < done.run.attempt,
                cases: facts.cases,
            }
        })
        .collect();
    let run = done.run.id.to_string();
    let judged = ledger.ingest(&Attempt {
        run: &run,
        attempt: done.run.attempt,
        sha: &done.run.sha,
        digest: done.digest,
        by: done.by,
        jobs: &jobs,
    })?;
    let (next, budget) = rerun::next(&judged, done.run.attempt, done.release);
    let green = judged.green(done.release);
    let mut counts = Counts {
        passed: 0,
        failed: 0,
    };
    let (mut failed, mut flaky, mut unreported) = (Vec::new(), Vec::new(), Vec::new());
    let mut blocks_release = false;
    for job in &judged.jobs {
        blocks_release |= done.release && job.came_to.release_blocked(true);
        failed.extend(job.blocking.iter().map(failed_test));
        flaky.extend(job.quarantined.iter().map(failed_test));
        if job.reported {
            counts.passed += job.passed;
            counts.failed += (job.blocking.len() + job.quarantined.len()) as u32;
        } else {
            match job.outcome {
                Ended::Passed => counts.passed += 1,
                Ended::Failed => counts.failed += 1,
                Ended::Cancelled | Ended::Skipped => {}
            }
        }
        if job.outcome == Ended::Failed && job.blocking.is_empty() && job.quarantined.is_empty() {
            unreported.push(job.name.clone());
        }
    }
    let mut said = Vec::new();
    for name in &judged.entered {
        said.push(Note {
            test: Some(name.clone()),
            ..Note::new(NoteCode::QuarantineEntered)
        });
    }
    for name in &judged.cleared {
        said.push(Note {
            test: Some(name.clone()),
            ..Note::new(NoteCode::QuarantineLeft)
        });
    }
    if !flaky.is_empty() && !done.release {
        said.push(Note {
            count: Some(flaky.len() as u32),
            ..Note::new(NoteCode::QuarantinedPass)
        });
    }
    if blocks_release {
        said.push(Note::new(NoteCode::ReleaseBlocked));
    }
    for job in &unreported {
        said.push(Note {
            job: Some(job.clone()),
            ..Note::new(NoteCode::JobOutsideTests)
        });
    }
    if !green {
        said.push(Note {
            used: Some(budget.used),
            cap: Some(budget.cap),
            ..Note::new(NoteCode::RerunsUsed)
        });
    }
    failed.append(&mut flaky);
    Some(Verdict {
        verdict: if done.run.conclusion.as_deref() == Some("cancelled") {
            RunVerdict::Cancelled
        } else if green {
            RunVerdict::Green
        } else {
            RunVerdict::Red
        },
        counts,
        failed,
        blocks_release,
        unreported,
        rerun: budget,
        next,
        said,
    })
}

#[cfg(test)]
mod tests {
    use super::ledger::tests::{T0, fail, pass};
    use super::*;

    fn run(attempt: u32, conclusion: &str) -> GithubRun {
        GithubRun {
            id: 77,
            workflow: "ci.yml".into(),
            title: "ci".into(),
            branch: "omp/agent/x".into(),
            sha: "abc1234".into(),
            event: "workflow_dispatch".into(),
            status: "completed".into(),
            conclusion: Some(conclusion.into()),
            attempt,
            actor: "someone".into(),
            created_at: T0,
            updated_at: T0 + 600_000,
        }
    }

    fn job(id: u64, name: &str, label: &str, conclusion: &str) -> GithubJob {
        GithubJob {
            id,
            run: 77,
            name: name.into(),
            attempt: 1,
            status: "completed".into(),
            conclusion: Some(conclusion.into()),
            labels: vec![label.into()],
            created_at: T0,
            started_at: Some(T0 + 60_000),
            completed_at: Some(T0 + 240_000),
            steps: Vec::new(),
        }
    }

    #[test]
    fn an_attempt_comes_to_a_verdict_with_what_the_answer_needs() {
        let mut ledger = Ledger::default();
        let check = job(1, "check (node 1/2)", "ubuntu-latest", "failure");
        let build = job(2, "build", "ubuntu-latest", "failure");
        let win = job(3, "win-platform (1)", "windows-latest", "success");
        let cases = [
            fail("src/a.test.ts", "adds"),
            pass("src/a.test.ts", "subtracts"),
        ];
        let passed = [pass("src/a.test.ts", "adds")];
        let verdict = take_in(
            &mut ledger,
            &Finished {
                run: &run(1, "failure"),
                jobs: &[
                    JobFacts {
                        job: &check,
                        cases: Some(&cases),
                    },
                    JobFacts {
                        job: &build,
                        cases: None,
                    },
                    JobFacts {
                        job: &win,
                        cases: Some(&passed),
                    },
                ],
                digest: "d1",
                by: None,
                release: false,
            },
        )
        .unwrap();
        assert_eq!(verdict.verdict, RunVerdict::Red);
        assert_eq!(
            verdict.counts,
            Counts {
                passed: 2,
                failed: 2
            }
        );
        assert_eq!(verdict.failed.len(), 1);
        assert_eq!(verdict.failed[0].test, "src/a.test.ts › adds");
        assert!(!verdict.failed[0].known_flaky);
        let record = verdict.failed[0].record.as_ref().unwrap();
        assert_eq!(
            (record.os, record.fails_7d, record.runs_7d),
            (Os::Linux, 1, 1)
        );
        assert!(
            verdict.failed[0]
                .history
                .starts_with("on linux: failed 1 of 1 runs")
        );
        assert_eq!(verdict.unreported, vec!["build"]);
        assert_eq!(verdict.next, Next::RerunFailed);
        assert_eq!(verdict.rerun, Budget { used: 0, cap: 2 });
        assert!(
            verdict
                .said
                .iter()
                .any(|n| n.code == NoteCode::RerunsUsed && (n.used, n.cap) == (Some(0), Some(2)))
        );
        // The runner's minutes are in the day's use, each job's started minute counted.
        let day = &ledger.days[&crate::checks::trends::day_of(T0)];
        assert_eq!((day.used.linux.minutes, day.used.windows.minutes), (6, 3));
    }

    #[test]
    fn the_rerun_of_the_failed_job_quarantines_the_flake_and_the_run_is_green() {
        let mut ledger = Ledger::default();
        let check = job(1, "check", "ubuntu-latest", "failure");
        let other = job(2, "native", "ubuntu-latest", "success");
        let cases = [fail("src/a.test.ts", "adds")];
        let first = Finished {
            run: &run(1, "failure"),
            jobs: &[
                JobFacts {
                    job: &check,
                    cases: Some(&cases),
                },
                JobFacts {
                    job: &other,
                    cases: None,
                },
            ],
            digest: "d1",
            by: None,
            release: true,
        };
        assert_eq!(
            take_in(&mut ledger, &first).unwrap().next,
            Next::RerunFailed
        );
        assert_eq!(take_in(&mut ledger, &first), None);
        let mut again = job(9, "check", "ubuntu-latest", "success");
        again.attempt = 2;
        let cases = [pass("src/a.test.ts", "adds")];
        let verdict = take_in(
            &mut ledger,
            &Finished {
                run: &run(2, "success"),
                jobs: &[
                    JobFacts {
                        job: &again,
                        cases: Some(&cases),
                    },
                    JobFacts {
                        job: &other,
                        cases: None,
                    },
                ],
                ..first
            },
        )
        .unwrap();
        assert_eq!(
            (verdict.verdict, verdict.next),
            (RunVerdict::Green, Next::Land)
        );
        assert!(!verdict.blocks_release);
        assert_eq!(verdict.said[0].code, NoteCode::QuarantineEntered);
        assert_eq!(
            verdict.said[0].test.as_deref(),
            Some("src/a.test.ts › adds")
        );
        // The job not run again is counted as saved, not as used twice.
        let day = &ledger.days[&crate::checks::trends::day_of(T0)];
        assert_eq!((day.used.linux.minutes, day.saved_ms), (9, 180_000));
    }

    #[test]
    fn a_quarantined_failure_blocks_only_a_release_gate() {
        let mut ledger = Ledger::default();
        super::ledger::tests::quarantine(&mut ledger);
        let check = job(1, "check (node 1/2)", "ubuntu-latest", "failure");
        let cases = [fail("a.test.ts", "t")];
        let mut done = Finished {
            run: &run(1, "failure"),
            jobs: &[JobFacts {
                job: &check,
                cases: Some(&cases),
            }],
            digest: "d7",
            by: None,
            release: false,
        };
        let mut branch = Ledger::default();
        super::ledger::tests::quarantine(&mut branch);
        let verdict = take_in(&mut branch, &done).unwrap();
        assert_eq!(
            (verdict.verdict, verdict.blocks_release),
            (RunVerdict::Green, false)
        );
        assert!(verdict.failed[0].known_flaky);
        assert!(
            verdict
                .said
                .iter()
                .any(|n| n.code == NoteCode::QuarantinedPass && n.count == Some(1))
        );
        done.release = true;
        let verdict = take_in(&mut ledger, &done).unwrap();
        assert_eq!(
            (verdict.verdict, verdict.blocks_release),
            (RunVerdict::Red, true)
        );
        assert_eq!(verdict.next, Next::RerunFailed);
    }

    #[test]
    fn a_run_still_going_is_not_taken_in_and_a_cancelled_one_is_cancelled() {
        let mut ledger = Ledger::default();
        let check = job(1, "check", "ubuntu-latest", "cancelled");
        let mut going = run(1, "cancelled");
        going.status = "in_progress".into();
        let jobs = [JobFacts {
            job: &check,
            cases: None,
        }];
        let done = |run| Finished {
            run,
            jobs: &jobs,
            digest: "d1",
            by: None,
            release: false,
        };
        assert_eq!(take_in(&mut ledger, &done(&going)), None);
        let verdict = take_in(&mut ledger, &done(&run(1, "cancelled"))).unwrap();
        assert_eq!(
            (verdict.verdict, verdict.next),
            (RunVerdict::Cancelled, Next::Fix)
        );
    }

    #[test]
    fn a_report_artifact_is_named_by_its_job_and_read_from_its_zip() {
        assert_eq!(ARTIFACT_PREFIX, "test-report-");
        assert_eq!(
            job_of_artifact("test-report-132093447695"),
            Some(132093447695)
        );
        assert_eq!(job_of_artifact("out"), None);
        assert_eq!(job_of_artifact("test-report-x"), None);
        let vitest = br#"{"testResults":[{"name":"/home/runner/work/ompdesk/ompdesk/src/a.test.ts","status":"passed","assertionResults":[{"ancestorTitles":[],"title":"adds","fullName":"adds","status":"passed","duration":3.2,"failureMessages":[]}]}]}"#;
        let junit = br#"<testsuites><testsuite name="src/b.test.ts"><testcase classname="src/b.test.ts" name="b" time="0.5"/></testsuite></testsuites>"#;
        let archive = zip::tests::archive(&[
            ("vitest.json", vitest, false),
            ("junit.xml", junit, true),
            ("readme.txt", b"no report", true),
        ]);
        let cases = cases_of(&archive, "SeuPut0705/ompdesk").unwrap();
        let names: Vec<String> = cases.iter().map(Case::name).collect();
        assert_eq!(names, ["src/a.test.ts › adds", "src/b.test.ts › b"]);
        let empty = zip::tests::archive(&[("readme.txt", b"none", true)]);
        assert!(cases_of(&empty, "o/r").is_err());
        let broken = zip::tests::archive(&[("vitest.json", b"{", true)]);
        assert!(
            cases_of(&broken, "o/r")
                .unwrap_err()
                .starts_with("vitest.json: ")
        );
    }
}
