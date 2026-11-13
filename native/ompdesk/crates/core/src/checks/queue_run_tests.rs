//! The merge queue against real git: a bare repository on this machine stands in for GitHub, a fake hub answers the
//! runs (red when the tested commit holds `bad.txt`), and `GitHands` builds, pushes and lands as it does for real.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

use super::*;
use crate::checks::contract::{FailedTest, Os, StartScope, TestRecord, TestState};
use crate::git::run::tests::runner;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A branch of `work` off the remote's main with one file written, pushed; its sha.
fn branch(work: &Path, name: &str, file: &str, content: &str) -> String {
    git(work, &["fetch", "-q", "origin"]);
    git(work, &["checkout", "-q", "-B", name, "origin/main"]);
    std::fs::write(work.join(file), content).unwrap();
    git(work, &["add", "-A"]);
    git(work, &["commit", "-q", "-m", name]);
    git(work, &["push", "-q", "origin", name]);
    git(work, &["rev-parse", "HEAD"])
}

/// A bare "remote" with one commit on main, and a working clone that makes branches.
struct Fixture {
    dir: PathBuf,
    remote: PathBuf,
    work: PathBuf,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = crate::fs::disk::make_temp_dir("ompdesk-queue-").unwrap();
        let remote = dir.join("remote.git");
        let work = dir.join("work");
        git(&dir, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(
            &dir,
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                work.to_str().unwrap(),
            ],
        );
        std::fs::write(work.join("README"), "start\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-q", "-m", "start"]);
        git(&work, &["push", "-q", "origin", "HEAD:main"]);
        Fixture { dir, remote, work }
    }

    /// A branch off the remote's main with one file written, pushed; its sha.
    fn branch(&self, name: &str, file: &str, content: &str) -> String {
        branch(&self.work, name, file, content)
    }

    fn main(&self) -> String {
        git(&self.remote, &["rev-parse", "main"])
    }

    fn files(&self, commit: &str) -> Vec<String> {
        git(&self.remote, &["ls-tree", "-r", "--name-only", commit])
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn heads(&self) -> Vec<String> {
        git(
            &self.remote,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )
        .lines()
        .map(str::to_owned)
        .collect()
    }

    fn holds(&self, older: &str, newer: &str) -> bool {
        Command::new("git")
            .args(["merge-base", "--is-ancestor", older, newer])
            .current_dir(&self.remote)
            .status()
            .unwrap()
            .success()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The hub as the queue sees it: a run is red when its commit holds `bad.txt`; the first run may push to main first.
struct Host {
    remote: PathBuf,
    work: PathBuf,
    starts: Mutex<Vec<(String, String)>>,
    answers: Mutex<HashMap<String, Answer>>,
    push_before_first_run: Mutex<Option<String>>,
    /// While set, every start reaches admission and fails with these words (a dispatch that failed).
    refuse: Mutex<Option<String>>,
    /// While set, a batch's answer is withheld until the wait's scope is cancelled; counts the waits under way.
    hold_answers: AtomicUsize,
    waiting: AtomicUsize,
    told: mpsc::UnboundedSender<RunResult>,
}

impl QueueHost for Host {
    fn start_batch<'a>(
        &'a self,
        _repo: &'a str,
        git_ref: &'a str,
        sha: &'a str,
    ) -> Fut<'a, Result<StartReply, Fault>> {
        Box::pin(async move {
            assert_eq!(
                git(
                    &self.remote,
                    &["rev-parse", &format!("refs/heads/{git_ref}")]
                ),
                sha,
                "the run's branch is the commit to test"
            );
            assert!(git_ref.starts_with(QUEUE_BRANCH_PREFIX));
            let push = self.push_before_first_run.lock().unwrap().take();
            if let Some(file) = push {
                // Someone else's commit pushed straight to main while the queue's run goes.
                branch(&self.work, "outside", &file, "outside\n");
                git(&self.work, &["push", "-q", "origin", "outside:main"]);
            }
            let files = git(&self.remote, &["ls-tree", "-r", "--name-only", sha]);
            let red = files.lines().any(|file| file == "bad.txt");
            let mut starts = self.starts.lock().unwrap();
            starts.push((git_ref.to_owned(), sha.to_owned()));
            let run = format!("run{}", starts.len());
            if let Some(why) = self.refuse.lock().unwrap().clone() {
                return Ok(StartReply {
                    run_id: Some(run),
                    decision: StartDecision::Refused,
                    placement: None,
                    expected_start_min: None,
                    reason: why,
                });
            }
            let mut answer = answer::blank(
                &run,
                if red {
                    AnswerVerdict::Red
                } else {
                    AnswerVerdict::Green
                },
                clock::now_ms(),
                if red { Next::Fix } else { Next::Land },
            );
            if red {
                answer.counts.failed = 1;
                answer.failed.push(FailedTest {
                    test: "e2e/bad.e2e.ts".into(),
                    first_error: "expected good".into(),
                    known_flaky: false,
                    history: String::new(),
                    record: TestRecord {
                        os: Os::Linux,
                        fails_7d: 0,
                        runs_7d: 0,
                        state: TestState::Active,
                        clean_runs: 0,
                        clear_after: 5,
                    },
                });
            } else {
                answer.counts.passed = 3;
            }
            self.answers.lock().unwrap().insert(run.clone(), answer);
            Ok(StartReply {
                run_id: Some(run),
                decision: StartDecision::Started,
                placement: None,
                expected_start_min: None,
                reason: String::new(),
            })
        })
    }

    fn batch_answer(&self, run: String, scope: Scope) -> Fut<'_, Result<Answer, Fault>> {
        Box::pin(async move {
            if self.hold_answers.load(Ordering::SeqCst) > 0 {
                self.waiting.fetch_add(1, Ordering::SeqCst);
                scope.on_cancel().await;
                self.waiting.fetch_sub(1, Ordering::SeqCst);
                return Err(Fault::new("cancelled", "the batch's wait was cancelled"));
            }
            Ok(self.answers.lock().unwrap()[&run].clone())
        })
    }

    fn paused(&self) -> bool {
        false
    }

    fn finished(&self, result: RunResult) {
        let _ = self.told.send(result);
    }

    // The tests hand `GitHands` their own git and folder (the remote is a bare repository, not GitHub).
    fn git(&self, scope: Scope) -> Option<Git> {
        Some(Git::new(runner(), scope))
    }

    fn queue_dir(&self) -> PathBuf {
        self.remote.with_file_name("queue")
    }
}

/// `GitHands` that also says when it deleted a candidate's branch.
struct Watched {
    inner: GitHands,
    dropped: mpsc::UnboundedSender<String>,
}

impl Hands for Watched {
    fn tip<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<Option<Sha>, Failure>> {
        self.inner.tip(repo, base, scope)
    }

    fn build<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        candidate: &'a str,
        tip: &'a str,
        parts: &'a [Part],
        scope: Scope,
    ) -> Fut<'a, Result<Result<Sha, Unbuilt>, Failure>> {
        self.inner.build(repo, base, candidate, tip, parts, scope)
    }

    fn land<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        commit: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<Landing, Failure>> {
        self.inner.land(repo, base, commit, scope)
    }

    fn drop_branch<'a>(&'a self, repo: &'a str, candidate: &'a str) -> Fut<'a, ()> {
        Box::pin(async move {
            self.inner.drop_branch(repo, candidate).await;
            let _ = self.dropped.send(candidate.to_owned());
        })
    }

    fn name(&self) -> String {
        self.inner.name()
    }

    fn save(&self, queue: &LandQueue) {
        self.inner.save(queue);
    }

    fn saved(&self) -> Vec<LandQueue> {
        self.inner.saved()
    }
}

struct Run {
    fixture: Fixture,
    host: Arc<Host>,
    queues: Arc<Queues>,
    told: mpsc::UnboundedReceiver<RunResult>,
    dropped: mpsc::UnboundedReceiver<String>,
}

fn start(batch_size: usize, push_before_first_run: Option<&str>) -> Run {
    let fixture = Fixture::new();
    let (told_tx, told) = mpsc::unbounded_channel();
    let (dropped_tx, dropped) = mpsc::unbounded_channel();
    let host = Arc::new(Host {
        remote: fixture.remote.clone(),
        work: fixture.work.clone(),
        starts: Mutex::default(),
        answers: Mutex::default(),
        push_before_first_run: Mutex::new(push_before_first_run.map(str::to_owned)),
        refuse: Mutex::default(),
        hold_answers: AtomicUsize::new(0),
        waiting: AtomicUsize::new(0),
        told: told_tx,
    });
    let remote = fixture.remote.to_string_lossy().into_owned();
    let hands = Watched {
        inner: GitHands {
            git: Box::new(|scope| {
                let mut runner = runner();
                for (key, value) in [
                    ("GIT_AUTHOR_NAME", "queue"),
                    ("GIT_AUTHOR_EMAIL", "queue@example.com"),
                    ("GIT_COMMITTER_NAME", "queue"),
                    ("GIT_COMMITTER_EMAIL", "queue@example.com"),
                ] {
                    runner.env.insert(key.into(), value.into());
                }
                Some(Git::new(runner, scope))
            }),
            dir: {
                let dir = fixture.dir.join("queue");
                Box::new(move || dir.clone())
            },
            url: Box::new(move |_| remote.clone()),
        },
        dropped: dropped_tx,
    };
    let tuning = Tuning {
        batch_size,
        window_ms: 60 * 60_000,
    };
    let queues = open_with(host.clone(), Arc::new(hands), tuning);
    Run {
        fixture,
        host,
        queues,
        told,
        dropped,
    }
}

fn origin() -> Origin {
    Origin::Session {
        session: "s1".into(),
        device: "d1".into(),
        goal: Some("g1".into()),
    }
}

impl Run {
    async fn enqueue(&self, branch: &str, sha: &str) -> String {
        let request = LandRequest {
            repo: "o/r".into(),
            branch: branch.into(),
            sha: sha.into(),
            base: "main".into(),
            pr: None,
            title: format!("change {branch}"),
            scope: StartScope::Changed,
        };
        let reply = self.queues.enqueue(origin(), request).await.unwrap();
        assert_eq!(reply.decision, StartDecision::Held, "{reply:?}");
        reply.run_id.unwrap()
    }

    /// The next `count` entry results, by entry id.
    async fn results(&mut self, count: usize) -> HashMap<String, RunResult> {
        let mut results = HashMap::new();
        while results.len() < count {
            let result = tokio::time::timeout(Duration::from_secs(60), self.told.recv())
                .await
                .expect("an entry's result within a minute")
                .unwrap();
            results.insert(result.run_id.clone(), result);
        }
        results
    }

    /// Waits until every candidate branch the queue pushed is deleted again.
    async fn no_candidates_left(&mut self) {
        while self
            .fixture
            .heads()
            .iter()
            .any(|head| head.starts_with(QUEUE_BRANCH_PREFIX))
        {
            tokio::time::timeout(Duration::from_secs(60), self.dropped.recv())
                .await
                .expect("a candidate's branch deleted")
                .unwrap();
        }
    }

    fn starts(&self) -> usize {
        self.host.starts.lock().unwrap().len()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_batch_of_two_lands_on_main_as_the_commit_its_one_run_passed() {
    let mut run = start(2, None);
    let before = run.fixture.main();
    let one = run.fixture.branch("b1", "one.txt", "1\n");
    let two = run.fixture.branch("b2", "two.txt", "2\n");
    let first = run.enqueue("b1", &one).await;
    let second = run.enqueue("b2", &two).await;
    let results = run.results(2).await;
    for id in [&first, &second] {
        assert_eq!(
            results[id].answer.verdict,
            AnswerVerdict::Green,
            "{:?}",
            results[id]
        );
        assert_eq!(results[id].origin, origin());
    }
    assert_eq!(run.starts(), 1, "one run for the batch");
    let tested = run.host.starts.lock().unwrap()[0].1.clone();
    let main = run.fixture.main();
    assert_eq!(main, tested, "main is exactly the commit the run passed");
    assert!(
        run.fixture.holds(&before, &main),
        "main was moved forward, not rewritten"
    );
    let files = run.fixture.files(&main);
    assert!(files.contains(&"one.txt".to_owned()) && files.contains(&"two.txt".to_owned()));
    run.no_candidates_left().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queue_stopped_while_its_batch_waits_on_the_hub_ends_that_wait_though_the_queues_are_still_held()
 {
    let run = start(1, None);
    run.host.hold_answers.store(1, Ordering::SeqCst);
    let one = run.fixture.branch("b1", "one.txt", "1\n");
    run.enqueue("b1", &one).await;
    tokio::time::timeout(Duration::from_secs(60), async {
        while run.host.waiting.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the batch waits on the hub within a minute");
    // The real hub's wait holds the hub's core, which owns these queues: only `stop` can end it, not their drop.
    run.queues.stop();
    tokio::time::timeout(Duration::from_secs(60), async {
        while run.host.waiting.load(Ordering::SeqCst) > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the batch's wait ends within a minute of the stop");
    let request = LandRequest {
        repo: "o/r".into(),
        branch: "b2".into(),
        sha: one.clone(),
        base: "main".into(),
        pr: None,
        title: "change b2".into(),
        scope: StartScope::Changed,
    };
    let refused = run.queues.enqueue(origin(), request).await.unwrap_err();
    assert_eq!(refused.code, "queue_gone");
}
#[tokio::test(flavor = "multi_thread")]
async fn a_batch_whose_run_could_not_start_fails_with_the_reason_and_is_never_sent_again() {
    let mut run = start(1, None);
    *run.host.refuse.lock().unwrap() = Some("its dispatch failed: HTTP 502".into());
    let one = run.fixture.branch("b1", "one.txt", "1\n");
    let id = run.enqueue("b1", &one).await;
    let results = run.results(1).await;
    let failed = &results[&id].answer;
    assert_ne!(failed.verdict, AnswerVerdict::Green, "{failed:?}");
    assert!(
        failed
            .notes
            .iter()
            .any(|note| note.contains("its dispatch failed: HTTP 502")),
        "{failed:?}"
    );
    // A dispatch that failed may have started its run: the same start is never sent again.
    assert_eq!(run.starts(), 1);
    run.no_candidates_left().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_red_batch_lands_the_good_branch_and_fails_the_bad_one_with_its_own_run() {
    let mut run = start(2, None);
    let good = run.fixture.branch("good", "one.txt", "1\n");
    let bad = run.fixture.branch("bad", "bad.txt", "x\n");
    let good_id = run.enqueue("good", &good).await;
    let bad_id = run.enqueue("bad", &bad).await;
    let results = run.results(2).await;
    assert_eq!(results[&good_id].answer.verdict, AnswerVerdict::Green);
    let failed = &results[&bad_id].answer;
    assert_eq!(failed.verdict, AnswerVerdict::Red);
    assert_eq!(failed.next, Next::Fix);
    assert_eq!(failed.run_id, bad_id);
    assert_eq!(
        failed.failed[0].test, "e2e/bad.e2e.ts",
        "the failure carries its run's tests"
    );
    assert!(
        failed
            .notes
            .iter()
            .any(|note| note.contains("not landed on main")),
        "{failed:?}"
    );
    // The batch, then the good branch alone; the bad one alone on the new main is already known red.
    assert_eq!(run.starts(), 2);
    let main = run.fixture.main();
    assert_eq!(main, good, "the good branch landed as a fast-forward");
    assert!(!run.fixture.files(&main).contains(&"bad.txt".to_owned()));
    run.no_candidates_left().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_branch_that_conflicts_is_failed_with_the_file_named_and_the_other_lands() {
    let mut run = start(2, None);
    let first = run.fixture.branch("a", "README", "a\n");
    let second = run.fixture.branch("b", "README", "b\n");
    let first_id = run.enqueue("a", &first).await;
    let second_id = run.enqueue("b", &second).await;
    let results = run.results(2).await;
    assert_eq!(results[&first_id].answer.verdict, AnswerVerdict::Green);
    let failed = &results[&second_id].answer;
    assert_eq!(failed.verdict, AnswerVerdict::Red);
    assert!(
        failed
            .notes
            .iter()
            .any(|note| note.contains("conflicts in README")),
        "{failed:?}"
    );
    assert_eq!(run.starts(), 1, "a build that does not merge starts no run");
    assert_eq!(run.fixture.main(), first);
    run.no_candidates_left().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_to_main_during_the_run_is_kept_and_the_branch_is_tested_again_on_it() {
    let mut run = start(1, Some("outside.txt"));
    let before = run.fixture.main();
    let one = run.fixture.branch("b1", "one.txt", "1\n");
    let id = run.enqueue("b1", &one).await;
    let results = run.results(1).await;
    assert_eq!(results[&id].answer.verdict, AnswerVerdict::Green);
    assert_eq!(run.starts(), 2, "tested again on the main that moved");
    let main = run.fixture.main();
    let files = run.fixture.files(&main);
    assert!(
        files.contains(&"outside.txt".to_owned()),
        "the other push is kept: {files:?}"
    );
    assert!(files.contains(&"one.txt".to_owned()));
    assert!(run.fixture.holds(&before, &main));
    let (_, second) = run.host.starts.lock().unwrap()[1].clone();
    assert_eq!(main, second, "what landed is the second run's commit");
    run.no_candidates_left().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queue_opened_again_shows_what_it_had_and_a_build_is_the_same_commit() {
    let run = start(2, None);
    let one = run.fixture.branch("b1", "one.txt", "1\n");
    run.enqueue("b1", &one).await;
    let shown = run.queues.entries().borrow().clone();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].branch, "b1");
    assert_eq!(shown[0].title, "change b1");
    assert_eq!(shown[0].state, crate::checks::contract::QueueState::Waiting);

    let (told, _) = mpsc::unbounded_channel();
    let host = Arc::new(Host {
        remote: run.fixture.remote.clone(),
        work: run.fixture.work.clone(),
        starts: Mutex::default(),
        answers: Mutex::default(),
        push_before_first_run: Mutex::default(),
        refuse: Mutex::default(),
        hold_answers: AtomicUsize::new(0),
        waiting: AtomicUsize::new(0),
        told,
    });
    let remote = run.fixture.remote.to_string_lossy().into_owned();
    let hands = GitHands {
        git: Box::new(|scope| Some(Git::new(runner(), scope))),
        dir: {
            let dir = run.fixture.dir.join("queue");
            Box::new(move || dir.clone())
        },
        url: Box::new(move |_| remote.clone()),
    };
    let again = open_with(host, Arc::new(hands), Tuning::default());
    let mut entries = again.entries();
    let shown = tokio::time::timeout(
        Duration::from_secs(60),
        entries.wait_for(|entries| !entries.is_empty()),
    )
    .await
    .expect("the saved lane shows its entry within a minute")
    .unwrap()
    .clone();
    assert_eq!(shown[0].id, run.queues.entries().borrow()[0].id);
}

/// Hands whose build holds until its scope is cancelled, counting the builds under way; the queue is kept in memory.
struct Holding {
    saved: Mutex<Option<LandQueue>>,
    building: AtomicUsize,
    started: mpsc::UnboundedSender<()>,
}

impl Hands for Holding {
    fn tip<'a>(
        &'a self,
        _repo: &'a str,
        _base: &'a str,
        _scope: Scope,
    ) -> Fut<'a, Result<Option<Sha>, Failure>> {
        Box::pin(async { Ok(Some("t0".to_owned())) })
    }

    fn build<'a>(
        &'a self,
        _repo: &'a str,
        _base: &'a str,
        _candidate: &'a str,
        _tip: &'a str,
        _parts: &'a [Part],
        scope: Scope,
    ) -> Fut<'a, Result<Result<Sha, Unbuilt>, Failure>> {
        Box::pin(async move {
            self.building.fetch_add(1, Ordering::SeqCst);
            let _ = self.started.send(());
            scope.on_cancel().await;
            self.building.fetch_sub(1, Ordering::SeqCst);
            Err(no_git())
        })
    }

    fn land<'a>(
        &'a self,
        _repo: &'a str,
        _base: &'a str,
        _commit: &'a str,
        _scope: Scope,
    ) -> Fut<'a, Result<Landing, Failure>> {
        Box::pin(async { Err(no_git()) })
    }

    fn drop_branch<'a>(&'a self, _repo: &'a str, _candidate: &'a str) -> Fut<'a, ()> {
        Box::pin(async {})
    }

    fn name(&self) -> String {
        "o/r".into()
    }

    fn save(&self, queue: &LandQueue) {
        *self.saved.lock().unwrap() = Some(queue.clone());
    }

    fn saved(&self) -> Vec<LandQueue> {
        self.saved.lock().unwrap().clone().into_iter().collect()
    }
}

async fn build_started(started: &mut mpsc::UnboundedReceiver<()>) {
    tokio::time::timeout(Duration::from_secs(60), started.recv())
        .await
        .expect("a build within a minute")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_queue_ends_its_lanes_and_their_work_and_one_opened_again_is_the_only_lane() {
    let (started_tx, mut started) = mpsc::unbounded_channel();
    let hands = Arc::new(Holding {
        saved: Mutex::default(),
        building: AtomicUsize::new(0),
        started: started_tx,
    });
    let (told, _) = mpsc::unbounded_channel();
    let host = Arc::new(Host {
        remote: PathBuf::from("/nowhere/remote.git"),
        work: PathBuf::from("/nowhere/work"),
        starts: Mutex::default(),
        answers: Mutex::default(),
        push_before_first_run: Mutex::default(),
        refuse: Mutex::default(),
        hold_answers: AtomicUsize::new(0),
        waiting: AtomicUsize::new(0),
        told,
    });
    let tuning = Tuning {
        batch_size: 1,
        window_ms: 60 * 60_000,
    };
    let queues = open_with(host.clone(), hands.clone(), tuning);
    let request = LandRequest {
        repo: "o/r".into(),
        branch: "b1".into(),
        sha: "s1".into(),
        base: "main".into(),
        pr: None,
        title: "change b1".into(),
        scope: StartScope::Changed,
    };
    queues.enqueue(origin(), request).await.unwrap();
    build_started(&mut started).await;

    // The hub closes with the build under way: the lane and its build end, and with them the last hold on the queues.
    let mut entries = queues.entries();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), async {
        while entries.changed().await.is_ok() {}
    })
    .await
    .expect("every lane and its work end within a minute of the queues dropping");
    assert_eq!(hands.building.load(Ordering::SeqCst), 0);

    // Opened again over what was saved, the one lane builds the same candidate again, alone.
    let again = open_with(host, hands.clone(), tuning);
    build_started(&mut started).await;
    assert_eq!(hands.building.load(Ordering::SeqCst), 1);
    drop(again);
}
