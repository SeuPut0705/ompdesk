//! The real hub over fake GitHub: what a start dispatches, the queue, the owner's pause, and the answer of a run.

use std::collections::BTreeMap;
use std::sync::Arc;

use super::*;
use crate::checks::contract::{AnswerVerdict, samples};
use crate::checks::sources::{Checkout, FakeGithub, FakeLocal, GithubJob, GithubRun, GithubWrite};

const REPO: &str = "o/app";
const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
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
    hub.set_key(ticket::AdmissionKey::from_hex(ticket::VECTOR.key_hex));
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
    let key = ticket::AdmissionKey::from_hex(ticket::VECTOR.key_hex).unwrap();
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
    drop(hub);
    assert!(host.start_batch(REPO, "feat", SHA).await.is_err());
}
