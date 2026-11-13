use std::collections::BTreeMap;

use super::budget::Budget;
use super::github::GhSource;
use super::github::tests::{REPO, Replay, T0, source};
use super::provenance::tests::{claim, dispatched, session};
use super::wire::fixtures::LIVE_RUN;
use super::*;
use crate::checks::contract::Where;
use crate::checks::sources::{FakeGithub, FakeLocal, LocalVolume};

fn run(id: u64, status: &str, updated_at: Timestamp) -> GithubRun {
    GithubRun {
        status: status.to_owned(),
        conclusion: (status == "completed").then(|| "success".to_owned()),
        updated_at,
        ..dispatched(id, "ci.yml", "omp/agent/checks-poller", T0 - 60_000)
    }
}

fn job(id: u64, run: u64, status: &str, label: &str) -> GithubJob {
    GithubJob {
        id,
        run,
        attempt: 1,
        name: format!("job {id}"),
        status: status.to_owned(),
        conclusion: (status == "completed").then(|| "success".to_owned()),
        labels: vec![label.to_owned()],
        created_at: T0 - 60_000,
        started_at: (status != "queued").then_some(T0 - 50_000),
        completed_at: (status == "completed").then_some(T0 - 10_000),
        steps: Vec::new(),
    }
}

fn local_pool() -> LocalPool {
    LocalPool {
        device: "local".to_owned(),
        os: Os::Macos,
        slots: 2,
        held: 1,
        queued: 0,
        oldest_wait_ms: 0,
        volumes: vec![LocalVolume {
            path: "/".to_owned(),
            free_gb: 192.0,
            total_gb: 927.0,
            low: false,
        }],
        as_of: T0,
        offline: false,
        check_store_bytes: None,
        foreign: Vec::new(),
    }
}

fn fresh(runs: Vec<GithubRun>) -> Got {
    Got::Runs(Ok(Read::Fresh {
        value: runs,
        mark: Some("m1".to_owned()),
    }))
}

fn error(code: &str) -> SourceError {
    SourceError::new(code, format!("it is {code}"))
}

fn runs_ask(engine: &mut Engine, now: Timestamp) -> Ask {
    engine
        .plan(now)
        .into_iter()
        .find(|ask| matches!(ask, Ask::Runs { .. }))
        .expect("the runs are due")
}

/// Answers every local read, so only GitHub's are left to look at.
fn local_answered(engine: &mut Engine, now: Timestamp) {
    engine.apply(now, &Ask::Pools, Got::Pools(Ok(vec![local_pool()])));
    engine.apply(
        now,
        &Ask::LocalRuns { since: 0 },
        Got::LocalRuns(Ok(Vec::new())),
    );
}

fn github_asks(engine: &mut Engine, now: Timestamp) -> Vec<Ask> {
    engine
        .plan(now)
        .into_iter()
        .filter(|ask| !matches!(ask, Ask::Pools | Ask::LocalRuns { .. }))
        .collect()
}

fn watching() -> Engine {
    let mut engine = Engine::new(Os::Macos);
    engine.watch(REPO);
    engine
}

fn jobs_ask(run: u64) -> Ask {
    Ask::Jobs {
        repo: REPO.to_owned(),
        run,
    }
}

fn hosted(engine: &mut Engine, now: Timestamp, os: Os) -> Pool {
    engine
        .pools(now)
        .into_iter()
        .find(|pool| pool.os == os && pool.place == Where::GithubHosted)
        .unwrap()
}

#[test]
fn the_first_round_reads_the_computers_and_each_repositorys_runs_and_limits() {
    let mut engine = watching();
    assert_eq!(
        engine.plan(T0),
        [
            Ask::Pools,
            Ask::LocalRuns {
                since: T0 - HISTORY
            },
            Ask::Runs {
                repo: REPO.to_owned(),
                since: T0 - HISTORY,
                mark: None
            },
            Ask::Limits {
                repo: REPO.to_owned()
            },
        ]
    );
    // Nothing watched: no request to GitHub at all, and no pool of its runners is claimed to be known.
    let mut idle = Engine::new(Os::Macos);
    assert_eq!(idle.plan(T0).len(), 2);
    local_answered(&mut idle, T0);
    assert_eq!(
        idle.pools(T0)
            .iter()
            .map(|pool| pool.id.as_str())
            .collect::<Vec<_>>(),
        ["device-local"]
    );
}

#[test]
fn the_jobs_of_what_runs_are_read_and_a_finished_run_is_history() {
    let mut engine = watching();
    local_answered(&mut engine, T0);
    let ask = runs_ask(&mut engine, T0);
    let answer = fresh(vec![
        run(1, "in_progress", T0 - 1_000),
        run(2, "queued", T0 - 1_000),
        run(3, "completed", T0 - 1_000),
    ]);
    assert!(engine.apply(T0, &ask, answer));
    engine.apply(
        T0,
        &Ask::Limits {
            repo: REPO.to_owned(),
        },
        Got::Limits(Ok(None)),
    );
    assert_eq!(github_asks(&mut engine, T0), [jobs_ask(1), jobs_ask(2)]);
    assert!(engine.apply(
        T0,
        &jobs_ask(1),
        Got::Jobs(Ok(vec![job(11, 1, "in_progress", "macos-15")]))
    ));
    engine.apply(T0, &jobs_ask(2), Got::Jobs(Ok(Vec::new())));
    // A run in progress has its jobs read every 20 s, a waiting one every 60 s, the runs every 15 s.
    assert_eq!(engine.next(), T0 + LOCAL_EVERY);
    local_answered(&mut engine, T0 + 14_999);
    assert_eq!(github_asks(&mut engine, T0 + 14_999), []);
    let again = github_asks(&mut engine, T0 + 15_000);
    assert_eq!(
        again,
        [Ask::Runs {
            repo: REPO.to_owned(),
            since: T0 - SKEW,
            mark: Some("m1".to_owned())
        }]
    );
    assert_eq!(github_asks(&mut engine, T0 + 20_000)[1..], [jobs_ask(1)]);
    assert_eq!(
        github_asks(&mut engine, T0 + 60_000)[1..],
        [jobs_ask(1), jobs_ask(2)]
    );
}

#[test]
fn an_unchanged_answer_confirms_what_is_known() {
    let mut engine = watching();
    let ask = runs_ask(&mut engine, T0);
    engine.apply(T0, &ask, fresh(vec![run(1, "in_progress", T0)]));
    engine.apply(
        T0,
        &jobs_ask(1),
        Got::Jobs(Ok(vec![job(11, 1, "in_progress", "macos-15")])),
    );
    let before = engine.runs(T0);
    let later = T0 + 10 * RUNS_ACTIVE_EVERY;
    assert_eq!(engine.confirmed(REPO, 1, later), Some((T0, false)));
    assert_eq!(
        hosted(&mut engine, later, Os::Macos).state,
        PoolState::Stale
    );
    assert!(!engine.apply(later, &ask, Got::Runs(Ok(Read::Unchanged))));
    assert!(!engine.apply(
        later,
        &jobs_ask(1),
        Got::Jobs(Ok(vec![job(11, 1, "in_progress", "macos-15")]))
    ));
    assert_eq!(engine.confirmed(REPO, 1, later), Some((later, true)));
    let pool = hosted(&mut engine, later, Os::Macos);
    assert_eq!(
        (pool.state, pool.as_of, pool.running),
        (PoolState::Live, later, 1)
    );
    assert_eq!(engine.runs(later), before);
}

#[test]
fn a_run_that_ended_has_its_jobs_read_once_more_and_then_is_left_alone() {
    let mut engine = watching();
    let ask = runs_ask(&mut engine, T0);
    engine.apply(
        T0,
        &ask,
        fresh(vec![run(1, "in_progress", T0), run(2, "in_progress", T0)]),
    );
    engine.apply(
        T0,
        &jobs_ask(1),
        Got::Jobs(Ok(vec![job(11, 1, "in_progress", "macos-15")])),
    );
    engine.apply(
        T0,
        &jobs_ask(2),
        Got::Jobs(Ok(vec![job(21, 2, "in_progress", "macos-15")])),
    );
    assert_eq!(hosted(&mut engine, T0, Os::Macos).running, 2);
    // The next answer: one ended, the other is no longer told at all (GitHub no longer has it).
    let now = T0 + 5_000;
    assert!(engine.apply(now, &ask, fresh(vec![run(1, "completed", now)])));
    let runs = engine.runs(now);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].verdict, Some(RunVerdict::Green));
    // Its jobs as last read still show one running, but the run ended: nothing of it takes a slot.
    assert_eq!(hosted(&mut engine, now, Os::Macos).running, 0);
    assert_eq!(
        github_asks(&mut engine, now),
        [
            Ask::Limits {
                repo: REPO.to_owned()
            },
            jobs_ask(1)
        ]
    );
    assert!(engine.apply(
        now,
        &jobs_ask(1),
        Got::Jobs(Ok(vec![job(11, 1, "completed", "macos-15")]))
    ));
    assert_eq!(engine.runs(now)[0].jobs[0].state, JobState::Passed);
    // Settled: never asked about again, and current however old.
    let later = now + 3_600_000;
    assert!(!github_asks(&mut engine, later).contains(&jobs_ask(1)));
    engine.apply(later, &ask, Got::Runs(Ok(Read::Unchanged)));
    assert_eq!(engine.confirmed(REPO, 1, later), Some((later, true)));
}

#[test]
fn an_answer_older_than_what_is_known_changes_nothing() {
    let mut engine = watching();
    let ask = runs_ask(&mut engine, T0);
    engine.apply(T0, &ask, fresh(vec![run(1, "completed", T0)]));
    assert!(!engine.apply(T0 + 1, &ask, fresh(vec![run(1, "in_progress", T0 - 5_000)])));
    assert_eq!(engine.runs(T0 + 1)[0].verdict, Some(RunVerdict::Green));
    // Run again as a second attempt, it is unfinished again and its jobs are read.
    let rerun = GithubRun {
        attempt: 2,
        ..run(1, "queued", T0 - 5_000)
    };
    assert!(engine.apply(T0 + 2, &ask, fresh(vec![rerun])));
    assert_eq!(engine.runs(T0 + 2)[0].verdict, None);
    assert!(github_asks(&mut engine, T0 + 2).contains(&jobs_ask(1)));
}

#[test]
fn a_source_that_cannot_answer_is_told_tried_ever_more_slowly_and_its_facts_turn_stale() {
    let mut engine = watching();
    let ask = runs_ask(&mut engine, T0);
    engine.apply(T0, &ask, fresh(vec![run(1, "in_progress", T0)]));
    engine.apply(
        T0,
        &jobs_ask(1),
        Got::Jobs(Ok(vec![job(11, 1, "in_progress", "macos-15")])),
    );
    engine.apply(
        T0,
        &Ask::Limits {
            repo: REPO.to_owned(),
        },
        Got::Limits(Ok(None)),
    );
    let mut now = T0 + RUNS_ACTIVE_EVERY;
    let mut waits = Vec::new();
    for _ in 0..7 {
        local_answered(&mut engine, now);
        let asks = github_asks(&mut engine, now);
        let runs = asks
            .iter()
            .find(|ask| matches!(ask, Ask::Runs { .. }))
            .unwrap_or_else(|| panic!("{asks:?}"));
        engine.apply(now, runs, Got::Runs(Err(error("offline"))));
        // Held: nothing of GitHub's is read, the computers still are.
        assert_eq!(github_asks(&mut engine, now), []);
        let next = (now..).step_by(1_000).find(|at| {
            local_answered(&mut engine, *at);
            !github_asks(&mut engine, *at).is_empty()
        });
        waits.push(next.unwrap() - now);
        now = next.unwrap();
    }
    assert_eq!(
        waits,
        [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]
    );
    assert_eq!(
        engine.trouble().map(|trouble| trouble.code.as_str()),
        Some("offline")
    );
    // What was known is still told, as stale, with the time it was last confirmed.
    let pool = hosted(&mut engine, now, Os::Macos);
    assert_eq!(
        (pool.state, pool.as_of, pool.running),
        (PoolState::Stale, T0, 1)
    );
    assert_eq!(engine.confirmed(REPO, 1, now), Some((T0, false)));
    assert_eq!(engine.runs(now).len(), 1);

    // The network is back: read at once, and the trouble is gone with the first answer.
    engine.apply(now, &ask, Got::Runs(Err(error("offline"))));
    engine.retry_now();
    assert!(
        github_asks(&mut engine, now)
            .iter()
            .any(|ask| matches!(ask, Ask::Runs { .. }))
    );
    engine.apply(now, &ask, Got::Runs(Ok(Read::Unchanged)));
    assert_eq!(engine.trouble(), None);
    assert!(github_asks(&mut engine, now).contains(&jobs_ask(1)));
}

#[test]
fn a_rate_limit_holds_every_read_until_the_time_github_named() {
    let mut engine = watching();
    let ask = runs_ask(&mut engine, T0);
    engine.apply(T0, &ask, fresh(vec![run(1, "in_progress", T0)]));
    let limited = SourceError {
        retry_at: Some(T0 + 1_200_000),
        ..error("rate_limited")
    };
    engine.apply(T0, &jobs_ask(1), Got::Jobs(Err(limited)));
    assert_eq!(github_asks(&mut engine, T0 + 1_199_999), []);
    // A wait GitHub asked for is not one `retry_now` ends.
    engine.retry_now();
    assert_eq!(github_asks(&mut engine, T0 + 1_199_999), []);
    assert_eq!(engine.trouble().unwrap().code, "rate_limited");
    assert_eq!(
        hosted(&mut engine, T0 + 60_000, Os::Macos).state,
        PoolState::Stale
    );
    assert!(!github_asks(&mut engine, T0 + 1_200_000).is_empty());
}

#[test]
fn one_reads_own_failure_holds_nothing_else_back() {
    let mut engine = watching();
    engine.watch("o/gone");
    let ask = runs_ask(&mut engine, T0);
    engine.apply(
        T0,
        &ask,
        fresh(vec![run(1, "in_progress", T0), run(2, "in_progress", T0)]),
    );
    engine.apply(T0, &jobs_ask(1), Got::Jobs(Err(error("failed"))));
    assert_eq!(engine.trouble(), None);
    assert!(github_asks(&mut engine, T0).contains(&jobs_ask(2)));
    // A repository that cannot be listed is told so and leaves GitHub's pools stale: its jobs are not counted.
    let gone = Ask::Runs {
        repo: "o/gone".to_owned(),
        since: T0 - HISTORY,
        mark: None,
    };
    assert!(engine.apply(
        T0,
        &gone,
        Got::Runs(Err(SourceError::new("failed", "Not Found (HTTP 404)")))
    ));
    assert_eq!(engine.trouble(), None);
    engine.apply(T0, &jobs_ask(1), Got::Jobs(Ok(Vec::new())));
    engine.apply(T0, &jobs_ask(2), Got::Jobs(Ok(Vec::new())));
    assert_eq!(hosted(&mut engine, T0, Os::Linux).state, PoolState::Stale);
    engine.unwatch("o/gone");
    assert_eq!(hosted(&mut engine, T0, Os::Linux).state, PoolState::Live);
}

#[test]
fn when_the_quota_is_short_every_run_still_gets_its_turn() {
    let mut engine = watching();
    let ask = runs_ask(&mut engine, T0);
    // 100 runs in progress, each with jobs to read every 20 s: 18 000 reads an hour wanted, 2 000 allowed.
    let runs: Vec<GithubRun> = (1..=100).map(|id| run(id, "in_progress", T0)).collect();
    engine.apply(T0, &ask, fresh(runs));
    let mut budget = Budget::default();
    let mut read: BTreeMap<u64, u32> = BTreeMap::new();
    let mut now = T0;
    while now < T0 + 3_600_000 {
        for ask in engine.plan(now) {
            let got = match &ask {
                Ask::Jobs { run, .. } => {
                    if budget.take(now) {
                        *read.entry(*run).or_default() += 1;
                        Got::Jobs(Ok(vec![job(
                            run * 10,
                            *run,
                            "in_progress",
                            "ubuntu-latest",
                        )]))
                    } else {
                        Got::Jobs(Err(SourceError {
                            retry_at: Some(budget.next(now)),
                            ..error("rate_limited")
                        }))
                    }
                }
                // What costs nothing unchanged is not what the quota is short of.
                Ask::Runs { .. } => Got::Runs(Ok(Read::Unchanged)),
                Ask::Limits { .. } => Got::Limits(Ok(None)),
                Ask::Pools => Got::Pools(Ok(Vec::new())),
                Ask::LocalRuns { .. } => Got::LocalRuns(Ok(Vec::new())),
                Ask::Checkout { .. } => unreachable!(),
            };
            engine.apply(now, &ask, got);
        }
        now = engine.next().max(now + 250);
    }
    let all: u32 = read.values().sum();
    assert!((1_990..=2_061).contains(&all), "{all}");
    assert_eq!(read.len(), 100);
    let (least, most) = (read.values().min().unwrap(), read.values().max().unwrap());
    assert!(most - least <= 1, "{least}..{most}");
}

#[test]
fn who_started_a_run_is_the_hubs_record_and_nothing_the_run_says() {
    let mut engine = watching();
    engine.claims().expect(Expected {
        repo: REPO.to_owned(),
        workflow: "ci.yml".to_owned(),
        git_ref: "omp/agent/checks-poller".to_owned(),
        after: T0 - 61_000,
        claim: claim("run-1", session("a")),
    });
    let ask = runs_ask(&mut engine, T0);
    let pushed = GithubRun {
        event: "push".to_owned(),
        title: "run-1 by session a".to_owned(),
        ..run(2, "in_progress", T0)
    };
    engine.apply(T0, &ask, fresh(vec![run(1, "in_progress", T0), pushed]));
    let runs = engine.runs(T0);
    let of = |id: &str| runs.iter().find(|run| run.id == id).unwrap();
    let started = of("run-1");
    assert_eq!(
        (
            &started.origin,
            started.lane,
            started.gate.as_deref(),
            started.digest.as_str()
        ),
        (&session("a"), Lane::Release, Some("gate-mac"), "d1")
    );
    assert_eq!(started.trigger, Trigger::Dispatch);
    let persons = of("gh-2");
    assert_eq!(
        (
            &persons.origin,
            persons.lane,
            persons.trigger,
            persons.digest.as_str()
        ),
        (&Origin::Person, Lane::Branch, Trigger::Push, "")
    );
    assert_eq!(
        (persons.repo.as_str(), persons.git_ref.as_str()),
        (REPO, "omp/agent/checks-poller")
    );
    // A dispatch made after the run was first seen never takes it.
    engine.claims().expect(Expected {
        repo: REPO.to_owned(),
        workflow: "ci.yml".to_owned(),
        git_ref: "omp/agent/checks-poller".to_owned(),
        after: T0 - 61_000,
        claim: claim("run-9", session("b")),
    });
    assert!(engine.runs(T0 + 1).iter().all(|run| run.id != "run-9"));
}

#[test]
fn two_dispatches_of_one_workflow_that_show_in_one_read_bind_in_the_order_sent() {
    let mut engine = watching();
    for (id, who, after) in [("run-1", "a", T0 - 61_000), ("run-2", "b", T0 - 60_500)] {
        engine.claims().expect(Expected {
            repo: REPO.to_owned(),
            workflow: "ci.yml".to_owned(),
            git_ref: "omp/agent/checks-poller".to_owned(),
            after,
            claim: claim(id, session(who)),
        });
    }
    let ask = runs_ask(&mut engine, T0);
    let older = run(11, "in_progress", T0);
    let newer = GithubRun {
        created_at: older.created_at + 400,
        ..run(12, "in_progress", T0)
    };
    // GitHub lists runs newest first.
    engine.apply(T0, &ask, fresh(vec![newer, older]));
    let runs = engine.runs(T0);
    let origin = |id: &str| runs.iter().find(|run| run.id == id).unwrap().origin.clone();
    assert_eq!(origin("run-1"), session("a"));
    assert_eq!(origin("run-2"), session("b"));
    assert_eq!(
        engine.claims().github_of("run-1"),
        Some((REPO.to_owned(), 11))
    );
}

#[test]
fn a_job_is_told_by_how_it_stands_and_only_when_it_takes_a_runner() {
    let mut engine = watching();
    let ask = runs_ask(&mut engine, T0);
    engine.apply(T0, &ask, fresh(vec![run(1, "in_progress", T0)]));
    let ended = |id: u64, conclusion: &str, label: &str| GithubJob {
        conclusion: Some(conclusion.to_owned()),
        ..job(id, 1, "completed", label)
    };
    let jobs = vec![
        job(11, 1, "queued", "macos-15"),
        job(12, 1, "in_progress", "windows-latest"),
        ended(13, "success", "ubuntu-latest"),
        ended(14, "failure", "ubuntu-latest"),
        ended(15, "cancelled", "ubuntu-latest"),
        ended(16, "timed_out", "ubuntu-latest"),
        ended(17, "a_word_from_the_future", "ubuntu-latest"),
        ended(18, "skipped", "ubuntu-latest"),
        GithubJob {
            labels: Vec::new(),
            ..job(19, 1, "queued", "")
        },
    ];
    engine.apply(T0, &jobs_ask(1), Got::Jobs(Ok(jobs)));
    let told = engine.runs(T0).remove(0);
    assert_eq!(
        told.jobs
            .iter()
            .map(|job| (job.id.as_str(), job.state, job.pool.as_str()))
            .collect::<Vec<_>>(),
        [
            ("11", JobState::Queued, "github-macos"),
            ("12", JobState::Running, "github-windows"),
            ("13", JobState::Passed, "github-linux"),
            ("14", JobState::Failed, "github-linux"),
            ("15", JobState::Cancelled, "github-linux"),
            ("16", JobState::Failed, "github-linux"),
            ("17", JobState::Failed, "github-linux"),
        ]
    );
    let waiting = &told.jobs[0];
    assert_eq!(
        (waiting.queued_at, waiting.started_at, waiting.ended_at),
        (T0 - 60_000, None, None)
    );
    let macos = hosted(&mut engine, T0, Os::Macos);
    assert_eq!((macos.queued, macos.oldest_wait_ms), (1, 60_000));
    // How a run ended, in the contract's three words; a word never seen is not green.
    for (conclusion, verdict) in [
        ("success", RunVerdict::Green),
        ("failure", RunVerdict::Red),
        ("cancelled", RunVerdict::Cancelled),
        ("timed_out", RunVerdict::Red),
        ("startup_failure", RunVerdict::Red),
        ("a_word_from_the_future", RunVerdict::Red),
    ] {
        assert_eq!(verdict_of(Some(conclusion)), verdict, "{conclusion}");
    }
    assert_eq!(verdict_of(None), RunVerdict::Red);
}

#[test]
fn a_local_check_is_a_run_of_one_job_on_its_computers_pool() {
    let mut engine = Engine::new(Os::Macos);
    let check = |id: &str, state: &str, ended: Option<Timestamp>| LocalRun {
        id: id.to_owned(),
        device: "local".to_owned(),
        cwd: "/w/ompdesk".to_owned(),
        argv: vec!["bunx".to_owned(), "vitest".to_owned()],
        state: state.to_owned(),
        started: T0 - 30_000,
        ended,
        head: Some("759386ee3".to_owned()),
        digest: "d7".to_owned(),
        failed: Vec::new(),
        flaky: Vec::new(),
        saved_ms: 0,
        session_tag: None,
    };
    let runs = vec![
        check("j1", "running", None),
        check("j2", "failed", Some(T0)),
        check("j3", "waiting", None),
        check("j4", "killed", None),
    ];
    assert!(engine.apply(T0, &Ask::LocalRuns { since: 0 }, Got::LocalRuns(Ok(runs))));
    engine
        .claims()
        .claim_local("j2", claim("run-5", session("a")));
    // The folder's repository is asked for once, however many checks ran in it.
    let folder = Ask::Checkout {
        cwd: "/w/ompdesk".to_owned(),
    };
    assert_eq!(engine.plan(T0), [Ask::Pools, folder.clone()]);
    let checkout = Checkout {
        repo: REPO.to_owned(),
        branch: "main".to_owned(),
        sha: "759386ee3".to_owned(),
    };
    engine.apply(T0, &folder, Got::Checkout(Ok(Some(checkout))));
    assert_eq!(engine.plan(T0), [Ask::Pools]);
    let told = engine.runs(T0);
    assert_eq!(
        told.iter()
            .map(|run| (run.id.as_str(), run.jobs[0].state, run.verdict, &run.origin))
            .collect::<Vec<_>>(),
        [
            ("local-j1", JobState::Running, None, &Origin::Person),
            (
                "run-5",
                JobState::Failed,
                Some(RunVerdict::Red),
                &session("a")
            ),
            ("local-j3", JobState::Queued, None, &Origin::Person),
            (
                "local-j4",
                JobState::Failed,
                Some(RunVerdict::Red),
                &Origin::Person
            ),
        ]
    );
    let first = &told[0];
    assert_eq!(
        (
            first.repo.as_str(),
            first.git_ref.as_str(),
            first.sha.as_str(),
            first.lane,
            first.trigger
        ),
        (REPO, "main", "759386ee3", Lane::Local, Trigger::Local)
    );
    assert_eq!(
        (
            first.jobs[0].pool.as_str(),
            first.jobs[0].os,
            first.digest.as_str()
        ),
        ("device-local", Os::Macos, "d7")
    );
}

#[test]
fn the_computers_are_read_whatever_github_does_and_say_stale_when_they_cannot_be() {
    let mut engine = watching();
    let paired = LocalPool {
        device: "0123456789abcdefghijklmnop".to_owned(),
        os: Os::Windows,
        as_of: T0 - 30_000,
        ..local_pool()
    };
    engine.apply(T0, &Ask::Pools, Got::Pools(Ok(vec![local_pool(), paired])));
    let device = |engine: &mut Engine, now, id: &str| {
        let pools = engine.pools(now);
        let pool = pools.iter().find(|pool| pool.id == id).unwrap();
        (pool.state, pool.limit)
    };
    assert_eq!(
        device(&mut engine, T0, "device-local"),
        (PoolState::Live, 2)
    );
    assert_eq!(
        device(&mut engine, T0, "device-0123456789abcdefghijklmnop"),
        (PoolState::Live, 2)
    );
    // The paired computer read its pool a minute ago and nothing newer came: stale, though this one's read is new.
    engine.apply(
        T0 + 30_001,
        &Ask::Pools,
        Got::Pools(Ok(engine.pools.clone())),
    );
    assert_eq!(
        device(
            &mut engine,
            T0 + 30_001,
            "device-0123456789abcdefghijklmnop"
        )
        .0,
        PoolState::Stale
    );
    // This computer's own read fails: what was known stays, stale after three periods.
    let now = T0 + 30_001;
    engine.apply(
        now + LOCAL_EVERY,
        &Ask::Pools,
        Got::Pools(Err(error("failed"))),
    );
    assert_eq!(
        device(&mut engine, now + 3 * LOCAL_EVERY, "device-local"),
        (PoolState::Live, 2)
    );
    assert_eq!(
        device(&mut engine, now + 3 * LOCAL_EVERY + 1, "device-local"),
        (PoolState::Stale, 2)
    );
}

#[test]
fn a_limits_variable_of_any_watched_repository_widens_the_accounts_pools() {
    let mut engine = watching();
    let limits = Ask::Limits {
        repo: REPO.to_owned(),
    };
    assert_eq!(hosted(&mut engine, T0, Os::Macos).limit, 5);
    assert!(engine.apply(
        T0,
        &limits,
        Got::Limits(Ok(Some("{\"jobs\":500,\"macos\":50}".to_owned())))
    ));
    assert_eq!(
        (
            hosted(&mut engine, T0, Os::Macos).limit,
            hosted(&mut engine, T0, Os::Linux).limit
        ),
        (50, 500)
    );
    // Asked again ten minutes on; a value of another shape is no limit.
    assert!(!github_asks(&mut engine, T0 + LIMITS_EVERY - 1).contains(&limits));
    assert!(github_asks(&mut engine, T0 + LIMITS_EVERY).contains(&limits));
    engine.apply(
        T0 + LIMITS_EVERY,
        &limits,
        Got::Limits(Ok(Some("fifty".to_owned()))),
    );
    assert_eq!(hosted(&mut engine, T0 + LIMITS_EVERY, Os::Macos).limit, 5);
}

/// One second on the manual clock, after the rounds' task had its turn: an `advance` with no timer due yet lets no
/// task run, so the task's first round would never register its sleep.
async fn second() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    clock::advance(1_000).await;
}

/// The poller over GitHub as recorded: the real source, the real reader of gh's output, the hub's snapshot.
#[tokio::test]
async fn the_recorded_repository_is_told_in_the_hubs_snapshot() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(T0);
    let replay = Replay::recorded();
    let (github, _) = source(&replay);
    let github: Arc<GhSource> = Arc::new(github);
    let local = Arc::new(FakeLocal::default());
    local.with(|facts| facts.pools = vec![local_pool()]);
    let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(T0)));
    let mut seen = snapshot.subscribe();
    let poller = Poller::new(github.clone(), local, snapshot.clone());
    poller.watch(REPO);
    // The lists, then the jobs of what runs.
    poller.round().await;
    poller.round().await;
    assert!(seen.has_changed().unwrap());
    let told = Arc::clone(&seen.borrow_and_update());
    assert_eq!(told.as_of, T0);
    assert_eq!(
        told.pools
            .iter()
            .map(|pool| pool.id.as_str())
            .collect::<Vec<_>>(),
        [
            "github-macos",
            "github-windows",
            "github-linux",
            "device-local"
        ]
    );
    // The 15 unfinished, and of the 16 finished ones those updated in the half hour the first read asks back for.
    assert_eq!(told.runs.len(), 21);
    let live = told
        .runs
        .iter()
        .find(|run| run.id == format!("gh-{LIVE_RUN}"))
        .unwrap();
    assert_eq!(
        (
            live.repo.as_str(),
            live.git_ref.as_str(),
            &live.origin,
            live.verdict
        ),
        (REPO, "omp/agent/rust-batch-shell", &Origin::Person, None)
    );
    assert_eq!(
        live.jobs.iter().map(|job| job.state).collect::<Vec<_>>(),
        [
            JobState::Running,
            JobState::Passed,
            JobState::Passed,
            JobState::Passed,
            JobState::Passed,
            JobState::Running
        ]
    );
    // One macOS and one Windows runner taken, as that run's recorded jobs say. The other runs' jobs were not
    // recorded (the stand-in answers them `404`), so GitHub's pools are not yet all confirmed: stale, not a guess.
    let pool = |id: &str| told.pools.iter().find(|pool| pool.id == id).unwrap();
    assert_eq!(
        (
            pool("github-macos").running,
            pool("github-windows").running,
            pool("github-macos").limit
        ),
        (1, 1, 5)
    );
    assert_eq!(pool("github-macos").state, PoolState::Stale);
    assert_eq!(pool("device-local").state, PoolState::Live);
    assert_eq!(poller.confirmed(REPO, LIVE_RUN), Some((T0, true)));
    assert_eq!(poller.trouble(), None);

    // `status` is that snapshot, cut to what was asked for, and asks GitHub nothing.
    let asked = replay.count();
    let status = |scope, repo: Option<&str>| {
        let request = StatusRequest {
            scope,
            repo: repo.map(str::to_owned),
            cwd: None,
        };
        super::status(&*github, &snapshot, session("a"), request)
    };
    assert_eq!(status(StatusScope::All, None).await.unwrap(), *told);
    assert_eq!(
        status(StatusScope::Repo, Some(REPO))
            .await
            .unwrap()
            .runs
            .len(),
        21
    );
    let other = status(StatusScope::Repo, Some("o/other")).await.unwrap();
    assert_eq!((other.runs.len(), other.pools.len()), (0, 4));
    assert_eq!(status(StatusScope::Mine, None).await.unwrap().runs.len(), 0);
    assert_eq!(
        status(StatusScope::Repo, None).await.unwrap_err().code,
        "no_repo"
    );
    assert_eq!(replay.count(), asked);
    clock::set_real();
}

/// The rounds on the hub's clock, over the contract's fakes: what an hour costs, and what a reader is told.
#[tokio::test]
async fn an_hour_of_rounds_reads_on_schedule_and_tells_only_changes() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(T0);
    let github = Arc::new(FakeGithub::default());
    github.with(|facts| {
        facts.runs = vec![
            (REPO.to_owned(), run(1, "in_progress", T0)),
            (REPO.to_owned(), run(2, "completed", T0)),
        ];
        facts.jobs = vec![job(11, 1, "in_progress", "macos-15")];
        facts.checkouts.insert(
            "/w/ompdesk".to_owned(),
            Checkout {
                repo: REPO.to_owned(),
                branch: "main".to_owned(),
                sha: "759386ee3".to_owned(),
            },
        );
    });
    let local = Arc::new(FakeLocal::default());
    local.with(|facts| facts.pools = vec![local_pool()]);
    let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(T0)));
    let mut seen = snapshot.subscribe();
    let poller = Poller::new(github.clone(), local.clone(), snapshot.clone());
    poller.expect(Expected {
        repo: REPO.to_owned(),
        workflow: "ci.yml".to_owned(),
        git_ref: "omp/agent/checks-poller".to_owned(),
        after: T0 - 61_000,
        claim: claim("run-1", session("a")),
    });
    let rounds = poller.start();
    let mut told = 0;
    for _ in 0..3_600 {
        second().await;
        if seen.has_changed().unwrap() {
            seen.borrow_and_update();
            told += 1;
        }
    }
    // An hour with one run in progress: its runs every 15 s, its jobs every 20 s, the limits every 10 min.
    let reads = github.reads();
    assert!((420..=440).contains(&reads), "{reads}");
    // Nothing changed after the first rounds: told then, and once a minute to keep `asOf` near.
    assert!((60..=64).contains(&told), "{told}");
    let now = Arc::clone(&snapshot.borrow());
    assert!(clock::now_ms() - now.as_of <= RETELL_EVERY);
    // Newest first, and of two made at once the later id first.
    assert_eq!(
        now.runs
            .iter()
            .map(|run| run.id.as_str())
            .collect::<Vec<_>>(),
        ["gh-2", "run-1"]
    );
    assert!(now.pools.iter().all(|pool| pool.state == PoolState::Live));
    // The session sees its own run and nobody else's.
    let mine = super::status(
        &*github,
        &snapshot,
        Origin::Session {
            session: "a".to_owned(),
            device: "local".to_owned(),
            goal: Some("goal-7".to_owned()),
        },
        StatusRequest {
            scope: StatusScope::Mine,
            repo: None,
            cwd: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        mine.runs
            .iter()
            .map(|run| run.id.as_str())
            .collect::<Vec<_>>(),
        ["run-1"]
    );
    // The folder's repository, read with git.
    let here = super::status(
        &*github,
        &snapshot,
        Origin::Person,
        StatusRequest {
            scope: StatusScope::Repo,
            repo: None,
            cwd: Some("/w/ompdesk".to_owned()),
        },
    )
    .await
    .unwrap();
    assert_eq!(here.runs.len(), 2);

    // GitHub stops answering: an hour later what is told is stale, and it was asked ever more slowly.
    github.with(|facts| facts.down = Some(error("offline")));
    let before = github.reads();
    for _ in 0..3_600 {
        second().await;
    }
    // About 16 rounds in the hour (a wait of 15 s doubling to 5 min), each sending what was due (the runs, the
    // running run's jobs, the limits): a tenth of a healthy hour's reads.
    let offline = github.reads() - before;
    assert!((16..=60).contains(&offline), "{offline}");
    let stale = Arc::clone(&snapshot.borrow());
    assert!(
        stale
            .pools
            .iter()
            .all(|pool| (pool.place == Where::GithubHosted) == (pool.state == PoolState::Stale))
    );
    assert_eq!(stale.runs.len(), 2);
    assert_eq!(poller.trouble().unwrap().code, "offline");
    assert_eq!(
        poller.confirmed(REPO, 1).map(|(_, fresh)| fresh),
        Some(false)
    );
    rounds.abort();
    clock::set_real();
}

#[test]
fn the_repositories_followed_are_mains_and_those_a_start_still_waits_on() {
    let mut engine = Engine::new(Os::Macos);
    engine.follow(&["o/a".to_owned(), REPO.to_owned()]);
    engine.claims().expect(Expected {
        repo: REPO.to_owned(),
        workflow: "ci.yml".to_owned(),
        git_ref: "omp/agent/checks-poller".to_owned(),
        after: T0 - 61_000,
        claim: claim("run-1", session("a")),
    });
    let followed = |engine: &Engine| engine.repos.keys().cloned().collect::<Vec<_>>();
    // The sessions of `REPO` closed, but its dispatch still waits for a run.
    engine.follow(&["o/a".to_owned()]);
    assert_eq!(followed(&engine), ["SeuPut0705/ompdesk", "o/a"]);
    let ask = Ask::Runs {
        repo: REPO.to_owned(),
        since: 0,
        mark: None,
    };
    engine.apply(T0, &ask, fresh(vec![run(1, "in_progress", T0)]));
    // Its run showed and runs: still followed.
    engine.follow(&["o/a".to_owned()]);
    assert_eq!(followed(&engine), ["SeuPut0705/ompdesk", "o/a"]);
    engine.apply(
        T0 + RUNS_ACTIVE_EVERY,
        &ask,
        fresh(vec![run(1, "completed", T0 + 1)]),
    );
    engine.follow(&["o/a".to_owned()]);
    assert_eq!(followed(&engine), ["o/a"]);
}

/// What admission waits on: the run's end, told once its jobs were read after it, with no request of its own.
#[tokio::test]
async fn a_wait_for_a_runs_end_ends_on_the_round_that_read_its_final_jobs() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(T0);
    let github = Arc::new(FakeGithub::default());
    github.with(|facts| {
        facts.runs = vec![(REPO.to_owned(), run(1, "in_progress", T0))];
        facts.jobs = vec![job(11, 1, "in_progress", "macos-15")];
    });
    let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(T0)));
    let poller = Poller::new(github.clone(), Arc::new(FakeLocal::default()), snapshot);
    poller.expect(Expected {
        repo: REPO.to_owned(),
        workflow: "ci.yml".to_owned(),
        git_ref: "omp/agent/checks-poller".to_owned(),
        after: T0 - 61_000,
        claim: claim("run-1", session("a")),
    });
    let changes = poller.changes();
    let rounds = poller.start();
    let ended = poller.ended("run-1");
    tokio::pin!(ended);
    for _ in 0..30 {
        second().await;
    }
    assert!(changes.has_changed().unwrap());
    assert_eq!(poller.github_of("run-1"), Some((REPO.to_owned(), 1)));
    assert_eq!(poller.github_of("gh-1"), Some((REPO.to_owned(), 1)));
    assert_eq!(poller.github_of("gh-2"), None);
    tokio::select! {
        biased;
        _ = &mut ended => panic!("ended while it runs"),
        () = tokio::task::yield_now() => {}
    }
    github.with(|facts| {
        facts.runs[0].1 = run(1, "completed", T0 + 40_000);
        facts.jobs[0] = job(11, 1, "completed", "macos-15");
    });
    for _ in 0..30 {
        second().await;
    }
    let done = ended.await;
    assert_eq!(
        (
            done.id.as_str(),
            done.verdict,
            done.jobs[0].state,
            done.jobs[0].name.as_str()
        ),
        ("run-1", Some(RunVerdict::Green), JobState::Passed, "job 11")
    );
    rounds.abort();
    clock::set_real();
}
