//! The merge queue against real git: a bare repository on this machine stands in for GitHub, a fake hub answers the
//! runs (red when the tested commit holds `bad.txt`), and `GitHands` builds, pushes and lands as it does for real.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    batches: Mutex<HashMap<String, StartReply>>,
    accepted: Mutex<HashSet<String>>,
    fail_finished: AtomicBool,
    finish_attempt: Mutex<Option<mpsc::UnboundedSender<()>>>,
    fail_forget: AtomicBool,
    forget_attempt: Mutex<Option<mpsc::UnboundedSender<(String, bool)>>>,
    fail_retire: AtomicBool,
    retire_attempt: Mutex<Option<mpsc::UnboundedSender<String>>>,
    push_before_first_run: Mutex<Option<String>>,
    /// While set, every start reaches admission and fails with these words (a dispatch that failed).
    refuse: Mutex<Option<String>>,
    /// While set, a batch's answer is withheld until the wait's scope is cancelled; counts the waits under way.
    hold_answers: AtomicUsize,
    final_unknown: AtomicUsize,
    waiting: AtomicUsize,
    told: mpsc::UnboundedSender<RunResult>,
}

impl QueueHost for Host {
    fn start_batch<'a>(
        &'a self,
        _repo: &'a str,
        git_ref: &'a str,
        sha: &'a str,
        effect_id: &'a str,
    ) -> Fut<'a, Result<StartReply, Fault>> {
        Box::pin(async move {
            if let Some(reply) = self.batches.lock().unwrap().get(effect_id).cloned() {
                return Ok(reply);
            }
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
                let reply = StartReply {
                    run_id: Some(run),
                    decision: StartDecision::Refused,
                    placement: None,
                    expected_start_min: None,
                    reason: why,
                };
                self.batches
                    .lock()
                    .unwrap()
                    .insert(effect_id.to_owned(), reply.clone());
                return Ok(reply);
            }
            let mut answer = answer::blank(
                &run,
                if self.final_unknown.load(Ordering::SeqCst) > 0 {
                    AnswerVerdict::Unknown
                } else if red {
                    AnswerVerdict::Red
                } else {
                    AnswerVerdict::Green
                },
                clock::now_ms(),
                if red { Next::Fix } else { Next::Land },
            );
            if answer.verdict == AnswerVerdict::Unknown {
                answer.say(Note {
                    error: Some("the final batch result could not be read".into()),
                    ..Note::new(NoteCode::Refused)
                });
            }
            if red {
                answer.counts.failed = 1;
                answer.failed.push(FailedTest {
                    test: "e2e/bad.e2e.ts".into(),
                    first_error: Some("expected good".into()),
                    known_flaky: false,
                    history: String::new(),
                    record: Some(TestRecord {
                        os: Os::Linux,
                        fails_7d: 0,
                        runs_7d: 0,
                        state: TestState::Active,
                        clean_runs: 0,
                        clear_after: 5,
                    }),
                });
            } else {
                answer.counts.passed = 3;
            }
            self.answers.lock().unwrap().insert(run.clone(), answer);
            let reply = StartReply {
                run_id: Some(run),
                decision: StartDecision::Started,
                placement: None,
                expected_start_min: None,
                reason: String::new(),
            };
            self.batches
                .lock()
                .unwrap()
                .insert(effect_id.to_owned(), reply.clone());
            Ok(reply)
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

    fn finished(&self, result: RunResult, scope: Scope) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async move {
            if let Some(sender) = self.finish_attempt.lock().unwrap().as_ref() {
                let _ = sender.send(());
            }
            if scope.cancelled() || self.fail_finished.load(Ordering::SeqCst) {
                return Err(Fault::new("unavailable", "result was not saved"));
            }
            if self.accepted.lock().unwrap().insert(result.run_id.clone()) {
                let _ = self.told.send(result);
            }
            Ok(())
        })
    }

    fn forget_batch<'a>(&'a self, effect_id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>> {
        Box::pin(async move {
            if let Some(sender) = self.forget_attempt.lock().unwrap().as_ref() {
                let _ = sender.send((effect_id.to_owned(), false));
            }
            if self.fail_forget.load(Ordering::SeqCst) {
                return Err(Fault::new(
                    "unavailable",
                    "the batch receipt was not forgotten",
                ));
            }
            if scope.cancelled() {
                return Err(Fault::new("cancelled", "the queue stopped"));
            }
            self.batches.lock().unwrap().remove(effect_id);
            if let Some(sender) = self.forget_attempt.lock().unwrap().as_ref() {
                let _ = sender.send((effect_id.to_owned(), true));
            }
            Ok(())
        })
    }

    fn forget_answer<'a>(&'a self, id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>> {
        Box::pin(async move {
            if let Some(sender) = self.retire_attempt.lock().unwrap().as_ref() {
                let _ = sender.send(id.to_owned());
            }
            if scope.cancelled() || self.fail_retire.load(Ordering::SeqCst) {
                return Err(Fault::new(
                    "unavailable",
                    "the answer receipt was not forgotten",
                ));
            }
            self.accepted.lock().unwrap().remove(id);
            Ok(())
        })
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
    save_attempt: Arc<Mutex<Option<mpsc::UnboundedSender<()>>>>,
    fail_saves: Arc<AtomicBool>,
    builds: Arc<AtomicUsize>,
    fail_drops: Arc<AtomicBool>,
    drop_attempt: Arc<Mutex<Option<mpsc::UnboundedSender<()>>>>,
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
        self.builds.fetch_add(1, Ordering::SeqCst);
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

    fn drop_branch<'a>(
        &'a self,
        repo: &'a str,
        candidate: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<(), Failure>> {
        Box::pin(async move {
            if let Some(sender) = self.drop_attempt.lock().unwrap().as_ref() {
                let _ = sender.send(());
            }
            if self.fail_drops.load(Ordering::SeqCst) {
                return Err(no_git());
            }
            self.inner.drop_branch(repo, candidate, scope).await?;
            let _ = self.dropped.send(candidate.to_owned());
            Ok(())
        })
    }

    fn name(&self) -> String {
        self.inner.name()
    }

    fn identity(&self) -> PathBuf {
        self.inner.identity()
    }

    fn save(
        &self,
        queue: &LandQueue,
        effects: &[Effect],
        answers: &HashMap<Sha, Answer>,
        retire_answers: &[String],
    ) -> Result<(), Fault> {
        let result = if !queue.is_empty() && self.fail_saves.load(Ordering::SeqCst) {
            Err(Fault::new("queue_save", "ENOSPC: injected save failure"))
        } else {
            self.inner.save(queue, effects, answers, retire_answers)
        };
        if !queue.is_empty() {
            if let Some(sender) = self.save_attempt.lock().unwrap().as_ref() {
                let _ = sender.send(());
            }
        }
        result
    }

    fn saved(&self) -> Vec<SavedLane> {
        self.inner.saved()
    }
}

struct Run {
    fixture: Fixture,
    host: Arc<Host>,
    queues: Arc<Queues>,
    told: mpsc::UnboundedReceiver<RunResult>,
    dropped: mpsc::UnboundedReceiver<String>,
    save_attempt: Arc<Mutex<Option<mpsc::UnboundedSender<()>>>>,
    fail_saves: Arc<AtomicBool>,
    builds: Arc<AtomicUsize>,
    fail_drops: Arc<AtomicBool>,
    drop_attempt: Arc<Mutex<Option<mpsc::UnboundedSender<()>>>>,
}

fn start(batch_size: usize, push_before_first_run: Option<&str>) -> Run {
    let fixture = Fixture::new();
    let (told_tx, told) = mpsc::unbounded_channel();
    let (dropped_tx, dropped) = mpsc::unbounded_channel();
    let save_attempt = Arc::new(Mutex::new(None));
    let fail_saves = Arc::new(AtomicBool::new(false));
    let builds = Arc::new(AtomicUsize::new(0));
    let fail_drops = Arc::new(AtomicBool::new(false));
    let drop_attempt = Arc::new(Mutex::new(None));
    let host = Arc::new(Host {
        remote: fixture.remote.clone(),
        work: fixture.work.clone(),
        starts: Mutex::default(),
        answers: Mutex::default(),
        batches: Mutex::default(),
        accepted: Mutex::default(),
        fail_finished: AtomicBool::new(false),
        finish_attempt: Mutex::default(),
        fail_forget: AtomicBool::new(false),
        forget_attempt: Mutex::default(),
        fail_retire: AtomicBool::new(false),
        retire_attempt: Mutex::default(),
        push_before_first_run: Mutex::new(push_before_first_run.map(str::to_owned)),
        refuse: Mutex::default(),
        hold_answers: AtomicUsize::new(0),
        final_unknown: AtomicUsize::new(0),
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
        save_attempt: save_attempt.clone(),
        fail_saves: fail_saves.clone(),
        builds: builds.clone(),
        fail_drops: fail_drops.clone(),
        drop_attempt: drop_attempt.clone(),
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
        save_attempt,
        fail_saves,
        builds,
        fail_drops,
        drop_attempt,
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
    run.queues.stop();

    let (told, _) = mpsc::unbounded_channel();
    let host = Arc::new(Host {
        remote: run.fixture.remote.clone(),
        work: run.fixture.work.clone(),
        starts: Mutex::default(),
        answers: Mutex::default(),
        batches: Mutex::default(),
        accepted: Mutex::default(),
        fail_finished: AtomicBool::new(false),
        finish_attempt: Mutex::default(),
        fail_forget: AtomicBool::new(false),
        forget_attempt: Mutex::default(),
        fail_retire: AtomicBool::new(false),
        retire_attempt: Mutex::default(),
        push_before_first_run: Mutex::default(),
        refuse: Mutex::default(),
        hold_answers: AtomicUsize::new(0),
        final_unknown: AtomicUsize::new(0),
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
    saved: Mutex<Option<SavedLane>>,
    building: AtomicUsize,
    started: mpsc::UnboundedSender<()>,
    hold_exit: AtomicBool,
    exiting: mpsc::UnboundedSender<()>,
    release: tokio::sync::Notify,
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
            let _ = self.exiting.send(());
            if self.hold_exit.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
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

    fn drop_branch<'a>(
        &'a self,
        _repo: &'a str,
        _candidate: &'a str,
        _scope: Scope,
    ) -> Fut<'a, Result<(), Failure>> {
        Box::pin(async { Ok(()) })
    }

    fn name(&self) -> String {
        "o/r".into()
    }

    fn identity(&self) -> PathBuf {
        PathBuf::from(format!("holding-{:p}", self))
    }

    fn save(
        &self,
        queue: &LandQueue,
        effects: &[Effect],
        answers: &HashMap<Sha, Answer>,
        retire_answers: &[String],
    ) -> Result<(), Fault> {
        *self.saved.lock().unwrap() = Some(SavedLane {
            queue: queue.clone(),
            effects: effects.to_vec(),
            answers: answers.clone(),
            retire_answers: retire_answers.to_vec(),
        });
        Ok(())
    }

    fn saved(&self) -> Vec<SavedLane> {
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
    let (exiting_tx, mut exiting) = mpsc::unbounded_channel();
    let hands = Arc::new(Holding {
        saved: Mutex::default(),
        building: AtomicUsize::new(0),
        started: started_tx,
        hold_exit: AtomicBool::new(true),
        exiting: exiting_tx,
        release: tokio::sync::Notify::new(),
    });
    let (told, _) = mpsc::unbounded_channel();
    let host = Arc::new(Host {
        remote: PathBuf::from("/nowhere/remote.git"),
        work: PathBuf::from("/nowhere/work"),
        starts: Mutex::default(),
        answers: Mutex::default(),
        batches: Mutex::default(),
        accepted: Mutex::default(),
        fail_finished: AtomicBool::new(false),
        finish_attempt: Mutex::default(),
        fail_forget: AtomicBool::new(false),
        forget_attempt: Mutex::default(),
        fail_retire: AtomicBool::new(false),
        retire_attempt: Mutex::default(),
        push_before_first_run: Mutex::default(),
        refuse: Mutex::default(),
        hold_answers: AtomicUsize::new(0),
        final_unknown: AtomicUsize::new(0),
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

    let mut entries = queues.entries();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), exiting.recv())
        .await
        .expect("the first build is canceled")
        .unwrap();
    let again = open_with(host, hands.clone(), tuning);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), started.recv())
            .await
            .is_err(),
        "the reopened lane waits for the canceled build to exit"
    );
    assert_eq!(hands.building.load(Ordering::SeqCst), 1);
    hands.hold_exit.store(false, Ordering::SeqCst);
    hands.release.notify_one();
    tokio::time::timeout(Duration::from_secs(60), async {
        while entries.changed().await.is_ok() {}
    })
    .await
    .expect("the old lane and its work end");
    build_started(&mut started).await;
    assert_eq!(hands.building.load(Ordering::SeqCst), 1);
    drop(again);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_final_unknown_ends_the_trial_without_redispatching_or_landing() {
    let mut run = start(1, None);
    run.host.final_unknown.store(1, Ordering::SeqCst);
    let before = run.fixture.main();
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    let id = run.enqueue("b1", &sha).await;
    let results = run.results(1).await;
    let answer = &results[&id].answer;
    assert_eq!(answer.verdict, AnswerVerdict::Red);
    assert_eq!(answer.run_id, id);
    assert!(
        answer
            .notes
            .iter()
            .any(|note| note.contains("the final batch result could not be read"))
    );
    assert_eq!(run.starts(), 1);
    assert_eq!(run.fixture.main(), before);
    run.no_candidates_left().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reopening_an_admitted_test_reuses_the_same_batch_run() {
    let run = start(1, None);
    run.host.hold_answers.store(1, Ordering::SeqCst);
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    let id = run.enqueue("b1", &sha).await;
    tokio::time::timeout(Duration::from_secs(60), async {
        while run.host.waiting.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the admitted batch is waiting");
    let Run {
        fixture,
        host,
        queues,
        mut told,
        ..
    } = run;
    let mut closed = queues.entries();
    queues.stop();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), async {
        while closed.changed().await.is_ok() {}
    })
    .await
    .expect("the old lane stops");
    host.hold_answers.store(0, Ordering::SeqCst);
    let remote = fixture.remote.to_string_lossy().into_owned();
    let dir = fixture.dir.join("queue");
    let hands = GitHands {
        git: Box::new(|scope| Some(Git::new(runner(), scope))),
        dir: Box::new(move || dir.clone()),
        url: Box::new(move |_| remote.clone()),
    };
    let again = open_with(host.clone(), Arc::new(hands), Tuning::default());
    let result = tokio::time::timeout(Duration::from_secs(60), told.recv())
        .await
        .expect("the original batch finishes")
        .unwrap();
    assert_eq!(result.run_id, id);
    assert_eq!(result.answer.verdict, AnswerVerdict::Green);
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    assert_eq!(fixture.main(), sha);
    drop(again);
}

#[tokio::test(flavor = "multi_thread")]
async fn reopening_replays_unaccepted_terminal_result_and_branch_cleanup() {
    let mut run = start(1, None);
    run.host.final_unknown.store(1, Ordering::SeqCst);
    run.host.fail_finished.store(true, Ordering::SeqCst);
    run.fail_drops.store(true, Ordering::SeqCst);
    let (finish_tx, mut finish_attempts) = mpsc::unbounded_channel();
    let (drop_tx, mut drop_attempts) = mpsc::unbounded_channel();
    *run.host.finish_attempt.lock().unwrap() = Some(finish_tx);
    *run.drop_attempt.lock().unwrap() = Some(drop_tx);
    let before = run.fixture.main();
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    let id = run.enqueue("b1", &sha).await;
    tokio::time::timeout(Duration::from_secs(60), finish_attempts.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(60), drop_attempts.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(run.told.try_recv().is_err());
    assert_eq!(run.starts(), 1);
    assert_eq!(run.fixture.main(), before);
    assert!(
        run.fixture
            .heads()
            .iter()
            .any(|head| head.starts_with(QUEUE_BRANCH_PREFIX))
    );

    let Run {
        fixture,
        host,
        queues,
        mut told,
        fail_drops,
        drop_attempt,
        ..
    } = run;
    let mut closed = queues.entries();
    queues.stop();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), async {
        while closed.changed().await.is_ok() {}
    })
    .await
    .expect("the old lane stops");
    host.fail_finished.store(false, Ordering::SeqCst);
    fail_drops.store(false, Ordering::SeqCst);
    let (dropped_tx, mut dropped) = mpsc::unbounded_channel();
    let remote = fixture.remote.to_string_lossy().into_owned();
    let dir = fixture.dir.join("queue");
    let hands = Watched {
        inner: GitHands {
            git: Box::new(|scope| Some(Git::new(runner(), scope))),
            dir: Box::new(move || dir.clone()),
            url: Box::new(move |_| remote.clone()),
        },
        dropped: dropped_tx,
        save_attempt: Arc::new(Mutex::new(None)),
        fail_saves: Arc::new(AtomicBool::new(false)),
        builds: Arc::new(AtomicUsize::new(0)),
        fail_drops,
        drop_attempt,
    };
    let again = open_with(host.clone(), Arc::new(hands), Tuning::default());
    let result = tokio::time::timeout(Duration::from_secs(60), told.recv())
        .await
        .expect("the result is redelivered")
        .unwrap();
    assert_eq!(result.run_id, id);
    assert_eq!(result.answer.verdict, AnswerVerdict::Red);
    assert!(
        result
            .answer
            .notes
            .iter()
            .any(|note| note.contains("the final batch result could not be read"))
    );
    tokio::time::timeout(Duration::from_secs(60), async {
        while fixture
            .heads()
            .iter()
            .any(|head| head.starts_with(QUEUE_BRANCH_PREFIX))
        {
            dropped.recv().await.expect("candidate cleanup completion");
        }
    })
    .await
    .expect("all candidate cleanups are retried");
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    assert_eq!(fixture.main(), before);
    drop(again);
}

#[tokio::test(flavor = "multi_thread")]
async fn reopening_retries_answer_retirement_without_sending_the_result_again() {
    let mut run = start(1, None);
    run.host.fail_retire.store(true, Ordering::SeqCst);
    let (attempt_tx, mut attempts) = mpsc::unbounded_channel();
    *run.host.retire_attempt.lock().unwrap() = Some(attempt_tx);
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    let id = run.enqueue("b1", &sha).await;
    let result = tokio::time::timeout(Duration::from_secs(60), run.told.recv())
        .await
        .expect("the result is accepted")
        .unwrap();
    assert_eq!(result.run_id, id);
    let attempted = tokio::time::timeout(Duration::from_secs(60), attempts.recv())
        .await
        .expect("retirement is attempted")
        .unwrap();
    assert_eq!(attempted, id);
    assert!(run.host.accepted.lock().unwrap().contains(&id));
    let file = run.fixture.dir.join("queue/lanes/o_r__main.json");
    let saved = read_lane(&file).expect("the terminal lane is saved");
    assert!(saved.retire_answers.contains(&id));
    assert!(
        !saved
            .effects
            .iter()
            .any(|effect| matches!(effect, Effect::Tell { entry, .. } if entry.id == id))
    );

    let Run {
        fixture,
        host,
        queues,
        mut told,
        ..
    } = run;
    let mut closed = queues.entries();
    queues.stop();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), async {
        while closed.changed().await.is_ok() {}
    })
    .await
    .expect("the old lane stops");
    host.fail_retire.store(false, Ordering::SeqCst);
    let remote = fixture.remote.to_string_lossy().into_owned();
    let dir = fixture.dir.join("queue");
    let hands = GitHands {
        git: Box::new(|scope| Some(Git::new(runner(), scope))),
        dir: Box::new(move || dir.clone()),
        url: Box::new(move |_| remote.clone()),
    };
    let again = open_with(host.clone(), Arc::new(hands), Tuning::default());
    let retried = tokio::time::timeout(Duration::from_secs(60), attempts.recv())
        .await
        .expect("retirement is retried")
        .unwrap();
    assert_eq!(retried, id);
    tokio::time::timeout(Duration::from_secs(60), async {
        while host.accepted.lock().unwrap().contains(&id) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the receipt is retired");
    assert!(told.try_recv().is_err(), "the result is not sent again");
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    drop(again);
}

#[tokio::test(flavor = "multi_thread")]
async fn reopening_retries_forgetting_the_batch_after_its_branch_was_deleted() {
    let run = start(1, None);
    run.host.fail_forget.store(true, Ordering::SeqCst);
    let (attempt_tx, mut attempts) = mpsc::unbounded_channel();
    *run.host.forget_attempt.lock().unwrap() = Some(attempt_tx);
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    run.enqueue("b1", &sha).await;
    let target = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let (id, done) = attempts.recv().await.expect("receipt deletion attempt");
            if !done && run.host.batches.lock().unwrap().contains_key(&id) {
                break id;
            }
        }
    })
    .await
    .expect("a saved batch receipt deletion is attempted");
    assert!(
        !run.fixture
            .heads()
            .iter()
            .any(|head| head.starts_with(QUEUE_BRANCH_PREFIX))
    );
    assert_eq!(run.host.batches.lock().unwrap().len(), 1);

    let Run {
        fixture,
        host,
        queues,
        ..
    } = run;
    let mut closed = queues.entries();
    queues.stop();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), async {
        while closed.changed().await.is_ok() {}
    })
    .await
    .expect("the old lane stops");
    host.fail_forget.store(false, Ordering::SeqCst);
    let remote = fixture.remote.to_string_lossy().into_owned();
    let dir = fixture.dir.join("queue");
    let hands = GitHands {
        git: Box::new(|scope| Some(Git::new(runner(), scope))),
        dir: Box::new(move || dir.clone()),
        url: Box::new(move |_| remote.clone()),
    };
    let again = open_with(host.clone(), Arc::new(hands), Tuning::default());
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let (id, done) = attempts.recv().await.expect("receipt deletion completion");
            if id == target && done {
                break;
            }
        }
    })
    .await
    .expect("the saved batch receipt is forgotten");
    assert!(host.batches.lock().unwrap().is_empty());
    assert_eq!(host.starts.lock().unwrap().len(), 1);
    drop(again);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_save_blocks_the_reply_and_candidate_until_the_same_entry_is_saved() {
    let run = start(1, None);
    run.host.hold_answers.store(1, Ordering::SeqCst);
    let before = run.fixture.main();
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    let (attempt_tx, mut attempts) = mpsc::unbounded_channel();
    *run.save_attempt.lock().unwrap() = Some(attempt_tx);
    run.fail_saves.store(true, Ordering::SeqCst);
    let request = LandRequest {
        repo: "o/r".into(),
        branch: "b1".into(),
        sha,
        base: "main".into(),
        pr: None,
        title: "change b1".into(),
        scope: StartScope::Changed,
    };
    let queues = run.queues.clone();
    let enqueue = tokio::spawn(async move { queues.enqueue(origin(), request).await });
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(30), attempts.recv())
            .await
            .expect("a save attempt")
            .expect("the save observer remains open");
    }
    assert!(
        !enqueue.is_finished(),
        "an unsaved entry is not acknowledged"
    );
    assert_eq!(run.starts(), 0);
    assert_eq!(run.builds.load(Ordering::SeqCst), 0);
    assert_eq!(run.fixture.main(), before);
    assert!(
        !run.fixture
            .heads()
            .iter()
            .any(|head| head.starts_with(QUEUE_BRANCH_PREFIX)),
        "an unsaved transition cannot push a candidate"
    );

    run.fail_saves.store(false, Ordering::SeqCst);
    let reply = tokio::time::timeout(Duration::from_secs(30), enqueue)
        .await
        .expect("the saved entry is acknowledged")
        .unwrap()
        .unwrap();
    assert_eq!(reply.decision, StartDecision::Held);
    let id = reply.run_id.unwrap();
    let Run {
        fixture,
        host,
        queues,
        ..
    } = run;
    let mut closed = queues.entries();
    queues.stop();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), async {
        while closed.changed().await.is_ok() {}
    })
    .await
    .expect("the old lane stops");
    let remote = fixture.remote.to_string_lossy().into_owned();
    let queue_dir = fixture.dir.join("queue");
    let hands = GitHands {
        git: Box::new(|scope| Some(Git::new(runner(), scope))),
        dir: Box::new(move || queue_dir.clone()),
        url: Box::new(move |_| remote.clone()),
    };
    let again = open_with(host, Arc::new(hands), Tuning::default());
    let mut entries = again.entries();
    let shown = tokio::time::timeout(
        Duration::from_secs(30),
        entries.wait_for(|entries| entries.iter().any(|entry| entry.id == id)),
    )
    .await
    .expect("the saved entry reappears")
    .unwrap()
    .clone();
    assert!(
        shown
            .iter()
            .any(|entry| entry.id == id && entry.branch == "b1")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_a_lane_cancels_its_wait_for_a_failed_save() {
    let run = start(1, None);
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    let (attempt_tx, mut attempts) = mpsc::unbounded_channel();
    *run.save_attempt.lock().unwrap() = Some(attempt_tx);
    run.fail_saves.store(true, Ordering::SeqCst);
    let request = LandRequest {
        repo: "o/r".into(),
        branch: "b1".into(),
        sha,
        base: "main".into(),
        pr: None,
        title: "change b1".into(),
        scope: StartScope::Changed,
    };
    let queues = run.queues.clone();
    let enqueue = tokio::spawn(async move { queues.enqueue(origin(), request).await });
    tokio::time::timeout(Duration::from_secs(30), attempts.recv())
        .await
        .expect("the lane attempts to save")
        .expect("the save observer remains open");
    run.queues.stop();
    let result = tokio::time::timeout(Duration::from_secs(2), enqueue)
        .await
        .expect("stop cancels the save backoff")
        .unwrap();
    assert!(result.is_err());
    assert_eq!(run.builds.load(Ordering::SeqCst), 0);
    assert_eq!(run.starts(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_acknowledged_enqueue_survives_reopen_after_a_save_failure() {
    let run = start(10, None);
    let before = run.fixture.main();
    let sha = run.fixture.branch("b1", "one.txt", "1\n");
    let queue_dir = run.fixture.dir.join("queue");
    std::fs::create_dir_all(&queue_dir).unwrap();
    let lanes = queue_dir.join("lanes");
    std::fs::write(&lanes, b"blocked").unwrap();
    let (attempt_tx, mut attempt_rx) = mpsc::unbounded_channel();
    *run.save_attempt.lock().unwrap() = Some(attempt_tx);
    let request = LandRequest {
        repo: "o/r".into(),
        branch: "b1".into(),
        sha,
        base: "main".into(),
        pr: None,
        title: "change b1".into(),
        scope: StartScope::Changed,
    };
    let queues = run.queues.clone();
    let enqueue = tokio::spawn(async move { queues.enqueue(origin(), request).await });
    tokio::time::timeout(Duration::from_secs(30), attempt_rx.recv())
        .await
        .expect("the queue tries to save")
        .expect("the save observer remains open");
    std::fs::remove_file(&lanes).unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(30), enqueue)
        .await
        .expect("enqueue is retried after storage recovers")
        .unwrap()
        .unwrap();
    assert_eq!(reply.decision, StartDecision::Held);
    let id = reply.run_id.unwrap();
    let Run {
        fixture,
        host,
        queues,
        ..
    } = run;
    let mut closed = queues.entries();
    queues.stop();
    drop(queues);
    tokio::time::timeout(Duration::from_secs(60), async {
        while closed.changed().await.is_ok() {}
    })
    .await
    .expect("the old queue stops");
    let remote = fixture.remote.to_string_lossy().into_owned();
    let hands = GitHands {
        git: Box::new(|scope| Some(Git::new(runner(), scope))),
        dir: Box::new(move || queue_dir.clone()),
        url: Box::new(move |_| remote.clone()),
    };
    let again = open_with(
        host,
        Arc::new(hands),
        Tuning {
            batch_size: 10,
            window_ms: 60 * 60_000,
        },
    );
    let request = LandRequest {
        repo: "o/r".into(),
        branch: "b2".into(),
        sha: "s2".into(),
        base: "main".into(),
        pr: None,
        title: "change b2".into(),
        scope: StartScope::Changed,
    };
    again.enqueue(origin(), request).await.unwrap();
    let entries = again.entries();
    let shown = entries.borrow();
    assert!(
        shown
            .iter()
            .any(|entry| entry.id == id && entry.branch == "b1"),
        "the acknowledged entry is present after reopening: {shown:?}"
    );
    assert_eq!(fixture.main(), before);
    assert!(
        !fixture
            .heads()
            .iter()
            .any(|head| head.starts_with(QUEUE_BRANCH_PREFIX)),
        "waiting entries do not push a candidate"
    );
}
