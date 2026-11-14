//! The real hub over fake GitHub: what a start dispatches, the queue, the owner's pause, and the answer of a run.

use std::collections::BTreeMap;
use std::sync::Arc;

use super::*;
use crate::checks::contract::{AnswerVerdict, samples};
use crate::checks::sources::{
    Checkout, FakeGithub, FakeLocal, GithubJob, GithubRun, GithubWrite, SourceError,
};

const REPO: &str = "o/app";
const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
const SHA2: &str = "89abcdef0123456789abcdef0123456789abcdef";
const CI: &str = "on:\n  push:\n  workflow_dispatch:\n    inputs:\n      batch:\n        type: boolean\n      ticket:\n        type: string\n";
const CI_MAC: &str = "on:\n  workflow_dispatch:\n    inputs:\n      batch:\n        type: boolean\n      mac:\n        type: boolean\n";

fn github(workflow: &str) -> Arc<FakeGithub> {
    let github = Arc::new(FakeGithub::default());
    github.with(|facts| {
        for branch in ["feat", "feat2"] {
            facts.checkouts.insert(
                format!("/w/{branch}"),
                Checkout {
                    repo: REPO.into(),
                    branch: branch.into(),
                    sha: SHA.into(),
                },
            );
            facts.heads.insert(format!("{REPO}\n{branch}"), SHA.into());
        }
        facts.files.insert(
            format!("{REPO}\n{SHA}\n.github/workflows/ci.yml"),
            workflow.into(),
        );
    });
    github
}

fn hub(github: &Arc<FakeGithub>) -> Hub {
    Hub::new(github.clone(), Arc::new(FakeLocal::default()))
}

fn start(purpose: Purpose, branch: &str) -> StartRequest {
    StartRequest {
        purpose,
        scope: StartScope::Changed,
        rerun: None,
        repo: None,
        git_ref: None,
        cwd: Some(format!("/w/{branch}")),
        workflow: None,
    }
}

fn dispatches(github: &FakeGithub) -> Vec<Dispatch> {
    github
        .writes()
        .into_iter()
        .filter_map(|write| match write {
            GithubWrite::Dispatch(dispatch) => Some(dispatch),
            _ => None,
        })
        .collect()
}

/// A run of ci.yml on `branch` at `sha` as GitHub lists it, made `ago` ms after the clock's start.
fn gh_run(id: u64, branch: &str, sha: &str, at: u64, conclusion: Option<&str>) -> GithubRun {
    GithubRun {
        id,
        workflow: "ci.yml".into(),
        title: "ci".into(),
        branch: branch.into(),
        sha: sha.into(),
        event: "workflow_dispatch".into(),
        status: if conclusion.is_some() {
            "completed"
        } else {
            "in_progress"
        }
        .into(),
        conclusion: conclusion.map(Into::into),
        attempt: 1,
        actor: "someone".into(),
        created_at: at,
        updated_at: at + 1_000,
    }
}

fn gh_job(id: u64, run: u64, at: u64, conclusion: Option<&str>) -> GithubJob {
    GithubJob {
        id,
        run,
        name: "check".into(),
        attempt: 1,
        status: if conclusion.is_some() {
            "completed"
        } else {
            "in_progress"
        }
        .into(),
        conclusion: conclusion.map(Into::into),
        labels: vec!["ubuntu-latest".into()],
        created_at: at,
        started_at: Some(at + 500),
        completed_at: conclusion.map(|_| at + 1_000),
        steps: Vec::new(),
    }
}

async fn rounds(hub: &Hub, count: usize) {
    for _ in 0..count {
        clock::advance(30_000).await;
        hub.poller.round().await;
    }
}

#[tokio::test]
async fn a_held_run_whose_branch_moved_meanwhile_is_not_dispatched_for_the_new_commit() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(1_794_000_000_000);
    let github = github(CI_MAC);
    github.with(|facts| {
        facts
            .variables
            .insert(format!("{REPO}\nMAC_REFS"), "feat feat2".into());
    });
    let hub = hub(&github);
    let first = hub
        .start(samples::session(), start(Purpose::Release, "feat"))
        .await
        .unwrap();
    assert_eq!(first.decision, StartDecision::Started, "{}", first.reason);
    let held = hub
        .start(samples::session(), start(Purpose::Release, "feat2"))
        .await
        .unwrap();
    assert_eq!(held.decision, StartDecision::Held, "{}", held.reason);
    let held = held.run_id.unwrap();
    // feat2 moves on while its run waits in OMPdesk's queue.
    github.with(|facts| {
        facts.heads.insert(format!("{REPO}\nfeat2"), SHA2.into());
    });
    // The first run ends: macOS frees and the held run takes the place.
    let at = clock::now_ms() + 1_000;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA, at, Some("success")))];
        facts.jobs = vec![gh_job(701, 77, at, Some("success"))];
    });
    rounds(&hub, 3).await;
    hub.settle();
    hub.pump().await;
    // Dispatching it now would run SHA2 under the digest and ticket of SHA.
    assert_eq!(dispatches(&github).len(), 1);
    let answer = hub.answer_of(&held).await;
    assert!(
        answer.notes.iter().any(|note| note.contains("moved")),
        "{:?}",
        answer.notes
    );
    clock::set_real();
}

#[tokio::test]
async fn a_run_github_started_on_another_commit_than_asked_is_never_reused_as_green_for_the_asked_one()
 {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(1_794_000_000_000);
    let github = github(CI);
    let hub = hub(&github);
    let first = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    assert_eq!(first.decision, StartDecision::Started, "{}", first.reason);
    // A push landed between the hub's read of feat and GitHub resolving the dispatch's ref: GitHub ran SHA2.
    let at = clock::now_ms() + 1_000;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA2, at, Some("success")))];
        facts.jobs = vec![gh_job(701, 77, at, Some("success"))];
    });
    rounds(&hub, 3).await;
    hub.settle();
    // feat is still SHA at the hub's next read: nothing tested SHA, so a start of it runs.
    let again = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    assert_ne!(again.decision, StartDecision::Reused, "{}", again.reason);
    clock::set_real();
}

#[tokio::test]
async fn a_rerun_of_failed_jobs_waits_for_admission_and_is_answered_as_its_own_run() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(1_794_000_000_000);
    let github = github(CI);
    let hub = hub(&github);
    let first = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap()
        .run_id
        .unwrap();
    let at = clock::now_ms() + 1_000;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA, at, None))];
        facts.jobs = vec![gh_job(701, 77, at, None)];
    });
    rounds(&hub, 2).await;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA, at, Some("failure")))];
        facts.jobs = vec![gh_job(701, 77, at, Some("failure"))];
    });
    rounds(&hub, 3).await;
    hub.pass().await;
    let red = hub.answered(&first).expect("the red run is answered");
    assert_eq!(red.next, Next::RerunFailed, "{:?}", red.notes);
    let reruns = |github: &FakeGithub| {
        github
            .writes()
            .into_iter()
            .filter(|write| matches!(write, GithubWrite::RerunFailed { .. }))
            .count()
    };
    let rerun = || StartRequest {
        rerun: Some(Rerun::Failed),
        ..start(Purpose::Branch, "feat")
    };
    // The owner paused admission: a rerun starts nothing either.
    hub.pause(true).await.unwrap();
    let refused = hub.start(samples::session(), rerun()).await.unwrap();
    assert_eq!(
        refused.decision,
        StartDecision::Refused,
        "{}",
        refused.reason
    );
    assert_eq!(reruns(&github), 0);
    hub.pause(false).await.unwrap();
    let again = hub.start(samples::session(), rerun()).await.unwrap();
    assert_eq!(again.decision, StartDecision::Started, "{}", again.reason);
    assert_eq!(reruns(&github), 1);
    let again = again.run_id.unwrap();
    assert_ne!(again, first, "the rerun is answered by its own id");
    // GitHub runs the failed jobs again (attempt 2) and they pass: the rerun's own answer is green.
    let again_at = clock::now_ms() + 1_000;
    let attempt = |conclusion: Option<&str>| {
        let mut run = gh_run(77, "feat", SHA, again_at, conclusion);
        run.attempt = 2;
        let mut job = gh_job(702, 77, again_at, conclusion);
        job.attempt = 2;
        (run, job)
    };
    github.with(|facts| {
        let (run, job) = attempt(None);
        facts.runs = vec![(REPO.into(), run)];
        facts.jobs = vec![job];
    });
    rounds(&hub, 2).await;
    github.with(|facts| {
        let (run, job) = attempt(Some("success"));
        facts.runs = vec![(REPO.into(), run)];
        facts.jobs = vec![job];
    });
    rounds(&hub, 3).await;
    hub.pass().await;
    let green = hub.answered(&again).expect("the rerun is answered");
    assert_eq!(green.verdict, AnswerVerdict::Green, "{:?}", green.notes);
    assert_eq!(hub.answered(&first).unwrap().verdict, AnswerVerdict::Red);
    clock::set_real();
}

#[tokio::test]
async fn a_run_whose_results_could_not_be_read_when_it_ended_is_answered_once_they_can() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(1_794_000_000_000);
    let github = github(CI);
    let hub = hub(&github);
    let mut results = hub.results();
    let id = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap()
        .run_id
        .unwrap();
    let at = clock::now_ms() + 1_000;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA, at, None))];
        facts.jobs = vec![gh_job(701, 77, at, None)];
    });
    rounds(&hub, 2).await;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA, at, Some("success")))];
        facts.jobs = vec![gh_job(701, 77, at, Some("success"))];
    });
    rounds(&hub, 3).await;
    // The run ended, and GitHub cannot be read the moment the hub comes to judge it.
    github.with(|facts| facts.down = Some(SourceError::new("offline", "no network")));
    hub.pass().await;
    assert!(results.try_recv().is_err());
    github.with(|facts| facts.down = None);
    hub.pass().await;
    let heard = results
        .try_recv()
        .expect("the session is woken with its answer");
    assert_eq!(
        (heard.run_id, heard.answer.verdict),
        (id, AnswerVerdict::Green)
    );
    clock::set_real();
}

#[tokio::test]
async fn a_start_dispatches_only_the_inputs_the_workflow_declares_and_a_newer_one_replaces_it() {
    let github = github(CI);
    let hub = hub(&github);
    let first = hub
        .start(samples::session(), start(Purpose::Release, "feat"))
        .await
        .unwrap();
    assert_eq!(first.decision, StartDecision::Started, "{}", first.reason);
    // The default's `mac` is not an input of this ci.yml, so the workflow decides its own systems; no key, no ticket.
    assert_eq!(
        dispatches(&github),
        vec![Dispatch {
            repo: REPO.into(),
            workflow: "ci.yml".into(),
            git_ref: "feat".into(),
            inputs: BTreeMap::from([("batch".into(), "true".into())]),
        }]
    );
    // A release run is never superseded; a branch run is, by the next start of its branch.
    let release = hub
        .start(samples::session(), start(Purpose::Release, "feat"))
        .await
        .unwrap();
    assert!(!release.reason.contains("replaces"), "{}", release.reason);
    let older = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    let newer = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    assert_eq!(newer.decision, StartDecision::Started);
    let older = older.run_id.unwrap();
    assert!(
        newer.reason.ends_with(&format!("; it replaces {older}")),
        "{}",
        newer.reason
    );
    // The board's log says so, with a code it translates.
    let decisions = hub.watch().borrow().decisions.clone();
    let last = decisions.last().unwrap();
    assert_eq!(
        (last.run.as_str(), last.why.code, last.why.run.clone()),
        (older.as_str(), WhyCode::NewerRun, newer.run_id)
    );
}

#[tokio::test]
async fn macos_is_for_listed_branches_one_unit_at_a_time_and_the_dispatch_carries_a_ticket() {
    // The ticket's expiry is minted and checked on the hub's clock, which another test may set: hold it real.
    let _serial = clock::TEST_CLOCK.lock().await;
    let github = github(&format!("{CI_MAC}      ticket:\n        type: string\n"));
    let hub = hub(&github);
    let refused = hub
        .start(samples::session(), start(Purpose::Release, "feat"))
        .await
        .unwrap();
    assert_eq!(refused.decision, StartDecision::Refused);
    assert!(
        refused.reason.contains("not in MAC_REFS"),
        "{}",
        refused.reason
    );
    assert!(dispatches(&github).is_empty());

    github.with(|facts| {
        facts
            .variables
            .insert(format!("{REPO}\nMAC_REFS"), "feat feat2".into());
    });
    hub.set_key(Some(ticket::VECTOR.key()));
    let started = hub
        .start(samples::session(), start(Purpose::Release, "feat"))
        .await
        .unwrap();
    assert_eq!(
        started.decision,
        StartDecision::Started,
        "{}",
        started.reason
    );
    let sent = dispatches(&github);
    assert_eq!(sent[0].inputs["mac"], "true");
    let key = ticket::VECTOR.key();
    assert_eq!(
        ticket::verify(
            &key,
            &sent[0].inputs["ticket"],
            REPO,
            "feat",
            SHA,
            clock::now_ms()
        ),
        Ok(())
    );
    // The macOS lane holds one dispatched unit: the next waits in OMPdesk, not at GitHub.
    let held = hub
        .start(samples::session(), start(Purpose::Release, "feat2"))
        .await
        .unwrap();
    assert_eq!(held.decision, StartDecision::Held, "{}", held.reason);
    assert_eq!(dispatches(&github).len(), 1);
    let decisions = hub.watch().borrow().decisions.clone();
    let why = &decisions.last().unwrap().why;
    assert_eq!(
        (why.code, why.pool.as_deref(), why.running, why.limit),
        (WhyCode::PoolFull, Some("github-macos"), Some(1), Some(1))
    );
}

#[tokio::test]
async fn the_adoption_card_counts_starts_refusals_polls_and_a_land_after_a_red_answer() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(1_794_000_000_000);
    let github = github(CI);
    let hub = hub(&github);
    let first = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap()
        .run_id
        .unwrap();
    let refused = hub
        .start(samples::session(), start(Purpose::Branch, "nowhere"))
        .await
        .unwrap();
    assert_eq!(refused.decision, StartDecision::Refused);
    hub.told(MainFact::Polls { polls: 7 }).await.unwrap();
    let at = clock::now_ms() + 1_000;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA, at, None))];
        facts.jobs = vec![gh_job(701, 77, at, None)];
    });
    rounds(&hub, 2).await;
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), gh_run(77, "feat", SHA, at, Some("failure")))];
        facts.jobs = vec![gh_job(701, 77, at, Some("failure"))];
    });
    rounds(&hub, 3).await;
    hub.pass().await;
    assert_ne!(hub.answered(&first).unwrap().verdict, AnswerVerdict::Green);
    // The session was told the commit is not green, and lands it anyway: a start through the tool, and a wrong green.
    let _ = hub
        .start(samples::session(), start(Purpose::Land, "feat"))
        .await;
    let adoption = hub.watch().borrow().adoption.clone();
    assert_eq!(
        (
            adoption.started,
            adoption.refused,
            adoption.polls,
            adoption.wrong_greens
        ),
        (2, 1, 7, 1),
        "{adoption:?}"
    );
    clock::set_real();
}

#[tokio::test]
async fn the_decisions_answers_and_adoption_survive_a_restart_of_the_hub() {
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-checks-journal-{}-{}",
        std::process::id(),
        clock::now_ms()
    ));
    let github = github(CI);
    let local: Arc<dyn LocalSource> = Arc::new(FakeLocal::default());
    let open = || {
        let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(clock::now_ms())));
        let poller = Poller::new(github.clone(), local.clone(), snapshot.clone());
        Hub::build(
            github.clone(),
            local.clone(),
            poller,
            snapshot,
            Some(dir.clone()),
        )
    };
    let hub = open();
    // Two starts of one branch: the second supersedes the first (a decision), and the first is answered.
    for _ in 0..2 {
        hub.start(samples::session(), start(Purpose::Branch, "feat"))
            .await
            .unwrap();
    }
    hub.told(MainFact::Polls { polls: 3 }).await.unwrap();
    let before = Arc::clone(&hub.watch().borrow());
    assert!(!before.decisions.is_empty());
    drop(hub);
    let hub = open();
    let after = Arc::clone(&hub.watch().borrow());
    assert_eq!(after.decisions, before.decisions);
    assert_eq!(after.answers, before.answers);
    assert_eq!(after.adoption, before.adoption);
    assert_eq!(after.adoption.started, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_owners_pause_refuses_every_start_and_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-checks-hub-{}-{}",
        std::process::id(),
        clock::now_ms()
    ));
    let github = github(CI);
    let local: Arc<dyn LocalSource> = Arc::new(FakeLocal::default());
    let snapshot = || watch::Sender::new(Arc::new(Snapshot::empty(clock::now_ms())));
    let open = |snapshot: watch::Sender<Arc<Snapshot>>| {
        let poller = Poller::new(github.clone(), local.clone(), snapshot.clone());
        Hub::build(
            github.clone(),
            local.clone(),
            poller,
            snapshot,
            Some(dir.clone()),
        )
    };
    let hub = open(snapshot());
    hub.pause(true).await.unwrap();
    assert!(hub.watch().borrow().paused);
    drop(hub);
    let hub = open(snapshot());
    let reply = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    assert_eq!(
        (reply.decision, reply.reason.as_str()),
        (StartDecision::Refused, "paused by the owner")
    );
    hub.pause(false).await.unwrap();
    let reply = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    assert_eq!(reply.decision, StartDecision::Started);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_workflow_that_cannot_be_dispatched_is_refused_with_its_name() {
    let github = github("on:\n  push:\n    branches: [main]\n");
    let reply = hub(&github)
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    assert_eq!(reply.decision, StartDecision::Refused);
    assert_eq!(
        reply.reason,
        "ci.yml cannot be dispatched (it has no on.workflow_dispatch)"
    );
}

#[tokio::test]
async fn a_wait_ends_with_the_judgment_and_every_subscriber_hears_it_once() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(1_794_000_000_000);
    let github = github(CI);
    let hub = hub(&github);
    let mut results = hub.results();
    let reply = hub
        .start(samples::session(), start(Purpose::Branch, "feat"))
        .await
        .unwrap();
    let id = reply.run_id.unwrap();
    let now = clock::now_ms();
    let run = |status: &str, conclusion: Option<&str>| GithubRun {
        id: 77,
        workflow: "ci.yml".into(),
        title: "ci [batch ]".into(),
        branch: "feat".into(),
        sha: SHA.into(),
        event: "workflow_dispatch".into(),
        status: status.into(),
        conclusion: conclusion.map(Into::into),
        attempt: 1,
        actor: "someone".into(),
        created_at: now + 1_000,
        updated_at: now + 2_000,
    };
    let job = |status: &str, conclusion: Option<&str>| GithubJob {
        id: 701,
        run: 77,
        name: "check".into(),
        attempt: 1,
        status: status.into(),
        conclusion: conclusion.map(Into::into),
        labels: vec!["ubuntu-latest".into()],
        created_at: now + 1_000,
        started_at: Some(now + 1_500),
        completed_at: conclusion.map(|_| now + 2_000),
        steps: Vec::new(),
    };
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), run("in_progress", None))];
        facts.jobs = vec![job("in_progress", None)];
    });
    for _ in 0..2 {
        clock::advance(30_000).await;
        hub.poller.round().await;
    }
    let waited = hub.wait(
        samples::session(),
        WaitRequest {
            run_id: id.clone(),
            until: Until::Result,
            timeout_seconds: Some(3_600),
        },
        Scope::detached(),
    );
    tokio::pin!(waited);
    tokio::select! {
        biased;
        _ = &mut waited => panic!("answered while the run runs"),
        () = tokio::task::yield_now() => {}
    }
    github.with(|facts| {
        facts.runs = vec![(REPO.into(), run("completed", Some("failure")))];
        facts.jobs = vec![job("completed", Some("failure"))];
    });
    for _ in 0..4 {
        clock::advance(30_000).await;
        hub.poller.round().await;
    }
    let answer = waited.await.unwrap();
    assert_eq!(answer.run_id, id);
    assert_eq!(answer.verdict, AnswerVerdict::Red, "{:?}", answer.notes);
    assert!(
        answer
            .notes
            .iter()
            .any(|note| note.contains("\"check\" failed outside its tests")),
        "{:?}",
        answer.notes
    );
    let heard = results.recv().await.unwrap();
    assert_eq!(
        (heard.run_id, heard.origin),
        (id.clone(), samples::session())
    );
    assert!(results.try_recv().is_err());
    // A second wait reads the kept answer.
    let again = hub
        .wait(
            samples::session(),
            WaitRequest {
                run_id: id,
                until: Until::Result,
                timeout_seconds: Some(1),
            },
            Scope::detached(),
        )
        .await
        .unwrap();
    assert_eq!(again, answer);
    clock::set_real();
}

#[tokio::test]
async fn a_batch_held_longer_than_a_lease_keeps_its_place_while_the_queue_waits_for_it() {
    let _serial = clock::TEST_CLOCK.lock().await;
    clock::set_manual(1_794_000_000_000);
    let github = github(CI);
    let hub = hub(&github);
    // The account is full: the batch waits in OMPdesk's queue.
    locked(&hub.admission).set_pools(
        BTreeMap::from([(
            policy::HOSTED_POOL.to_owned(),
            admission::Limit {
                places: 0,
                hosted: true,
            },
        )]),
        40,
        BTreeMap::new(),
    );
    let host = hub.queue_host();
    let batch = host.start_batch(REPO, "feat", SHA).await.unwrap();
    assert_eq!(batch.decision, StartDecision::Held, "{}", batch.reason);
    let run = batch.run_id.unwrap();
    let waited = host.batch_answer(run.clone(), Scope::detached());
    tokio::pin!(waited);
    // Forty minutes, more than a lease, with the queue waiting on the batch all along.
    for _ in 0..40 {
        tokio::select! {
            biased;
            answer = &mut waited => panic!("answered while held: {answer:?}"),
            () = tokio::task::yield_now() => {}
        }
        clock::advance(60_000).await;
    }
    let gone = locked(&hub.admission).reap(clock::now_ms());
    assert!(gone.is_empty(), "reaped {gone:?}");
    assert_eq!(
        locked(&hub.admission).entry(&run).unwrap().stage,
        admission::Stage::Held
    );
    clock::set_real();
}

#[tokio::test]
async fn the_merge_queue_starts_its_batch_in_the_land_lane_and_its_entries_end_through_the_hub() {
    let github = github(CI);
    let hub = hub(&github);
    let host = hub.queue_host();
    let batch = host.start_batch(REPO, "feat", SHA).await.unwrap();
    assert_eq!(batch.decision, StartDecision::Started, "{}", batch.reason);
    assert!(batch.reason.contains("(land lane)"), "{}", batch.reason);
    assert_eq!(dispatches(&github)[0].git_ref, "feat");
    // Until main hands over how git runs, the queue has none.
    assert!(host.git(Scope::detached()).is_none());
    // A hub without a state folder has a queue folder of its own, which goes with it.
    let other = Hub::new(github.clone(), Arc::new(FakeLocal::default()))
        .queue_host()
        .queue_dir();
    assert_ne!(host.queue_dir(), other);
    std::fs::create_dir_all(host.queue_dir()).unwrap();
    let mine = host.queue_dir();
    // An entry's result ends the waits on it, told as the session that enqueued it.
    let mut results = hub.results();
    let entry = answer::unknown(
        "q-1",
        clock::now_ms(),
        Next::Fix,
        "not landed on main: red".into(),
    );
    host.finished(RunResult {
        run_id: "q-1".into(),
        origin: samples::session(),
        answer: entry.clone(),
    });
    let heard = results.recv().await.unwrap();
    assert_eq!(
        (heard.run_id.as_str(), heard.origin),
        ("q-1", samples::session())
    );
    let waited = hub
        .wait(
            samples::session(),
            WaitRequest {
                run_id: "q-1".into(),
                until: Until::Result,
                timeout_seconds: Some(1),
            },
            Scope::detached(),
        )
        .await
        .unwrap();
    assert_eq!(waited, entry);
    let queue = Arc::downgrade(&hub.core.queue);
    drop(hub);
    assert!(host.start_batch(REPO, "feat", SHA).await.is_err());
    assert!(!mine.exists());
    // The hub was the queues' owner: they drop with it, which stops their lanes (queue_run.rs).
    assert!(queue.upgrade().is_none());
}

#[tokio::test]
async fn a_hub_dropped_while_a_batch_wait_holds_its_core_stops_its_queue() {
    let github = github(CI);
    let hub = hub(&github);
    // What a batch's wait on the hub holds (`Host::batch_answer` upgrades to the core for as long as it waits).
    let held = Arc::clone(&hub.core);
    drop(hub);
    let refused = held
        .queue
        .enqueue(
            samples::session(),
            LandRequest {
                repo: REPO.into(),
                branch: "feat".into(),
                sha: SHA.into(),
                base: "main".into(),
                pr: None,
                title: "feat".into(),
                scope: StartScope::Changed,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, "queue_gone");
}

#[tokio::test]
async fn the_hub_answers_its_own_computers_pool_for_a_paired_link_to_forward() {
    let local = Arc::new(FakeLocal::default());
    let pool = |device: &str| crate::checks::sources::LocalPool {
        device: device.into(),
        os: crate::checks::contract::Os::Macos,
        slots: 2,
        held: 1,
        queued: 0,
        oldest_wait_ms: 0,
        volumes: Vec::new(),
        as_of: 1,
        offline: false,
        check_store_bytes: None,
        foreign: Vec::new(),
    };
    // A paired computer's pool is in the list too; only this computer's own is answered.
    local.with(|facts| facts.pools = vec![pool("mac-mini"), pool("local")]);
    let hub = Hub::new(Arc::new(FakeGithub::default()), local.clone());
    assert_eq!(hub.local_pool().await.unwrap(), pool("local"));
    local.with(|facts| facts.pools = vec![pool("mac-mini")]);
    assert_eq!(hub.local_pool().await.unwrap_err().code, "checks_source");
}
