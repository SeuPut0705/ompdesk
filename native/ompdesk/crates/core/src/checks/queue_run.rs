//! Running the merge queue (`queue.rs` holds its rules). One task per base branch of a repository (a lane) owns that
//! base's `LandQueue` and is the only one to call it, one message at a time, so each of its methods is one step as in
//! the model. What the queue asks is done by tasks the lane starts, which answer the lane by message:
//!
//! - `Build`: read the base's tip first; a tip the queue did not know is told to it (`base_read`) instead of building on
//!   an old one. Then `Hands::build` merges the parts onto the tip and pushes the commit to the queue's own branch.
//! - `Test`: one run of that commit on that branch through the hub (`QueueHost::start_batch`, the same admission as
//!   every run), then its `Answer` (`batch_answer`). `unknown` is not a verdict: it is asked again.
//! - `Land`: `Hands::land` pushes the commit to the base, never forced, and says whether the base took it, moved on or
//!   refuses the queue's pushes.
//! - `Drop`: the candidate's work stops (its scope is cancelled) and its branch is deleted.
//! - `Tell`: the entry's result goes to the hub (`QueueHost::finished`), which ends its waits and wakes its session.
//!
//! A git or GitHub that fails for a while (no network, git not handed over yet, the owner paused admission) is tried
//! again after `RETRY_FIRST_MS`, doubling to `RETRY_MAX_MS`; nothing of it reaches the queue as a result. The queue is
//! saved after every step and its lanes start again from what was saved (`LandQueue::resume`).
//!
//! `GitHands` is the real `Hands`: git in a bare clone the queue owns per repository, with `git/land.rs`, the landing
//! git Autopilot uses too.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};

use super::{Effect, LandQueue, Part, QUEUE_BRANCH_PREFIX, Told, Tuning, Unbuilt};
use crate::checks::contract::{
    Answer, AnswerVerdict, Counts, Next, Origin, QueueEntry, RepoId, RunResult, Sha, StartDecision,
    StartReply,
};
use crate::checks::hub::{Fut, LandQueue as QueueSeam, LandRequest, QueueHost};
use crate::clock;
use crate::git::land::{self, Failure, Merge, PushFailure};
use crate::git::run::Git;
use crate::run::Opts;
use crate::server::{Fault, Scope};

/// The first wait before a step that failed for a while is tried again, and the longest.
pub const RETRY_FIRST_MS: u64 = 5_000;
pub const RETRY_MAX_MS: u64 = 5 * 60_000;
/// How long a run that answered `unknown` is left before it is asked again.
pub const UNKNOWN_AGAIN_MS: u64 = 30_000;

/// How a push of the queue to the base went.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Landing {
    /// The base holds the commit; `tip` is the base as read then.
    Landed { tip: Sha },
    /// The base moved on and does not hold it.
    Moved { tip: Sha },
    /// The remote takes no push of the queue's to the base (a rule, a permission), in its own words.
    Refused { why: String },
}

/// What the queue's work is done with: git against the repository's remote, and where the queue is kept. A `Failure`
/// is a failure for a while (it is tried again); what the remote decided is an answer.
pub trait Hands: Send + Sync {
    /// The base's tip on the remote; none when the remote has no such branch.
    fn tip<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<Option<Sha>, Failure>>;

    /// `parts` merged in order onto `tip` as one commit, pushed to the candidate's branch.
    fn build<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        candidate: &'a str,
        tip: &'a str,
        parts: &'a [Part],
        scope: Scope,
    ) -> Fut<'a, Result<Result<Sha, Unbuilt>, Failure>>;

    /// `commit` pushed to the base, never forced.
    fn land<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        commit: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<Landing, Failure>>;

    /// The candidate's branch deleted, if it was ever pushed.
    fn drop_branch<'a>(&'a self, repo: &'a str, candidate: &'a str) -> Fut<'a, ()>;

    /// This computer's part of every name the queue makes, so two computers' queues never share a branch.
    fn name(&self) -> String;

    fn save(&self, queue: &LandQueue);

    fn saved(&self) -> Vec<LandQueue>;
}

enum Msg {
    Enqueue {
        origin: Origin,
        request: LandRequest,
        reply: oneshot::Sender<StartReply>,
    },
    Built {
        candidate: String,
        result: Result<Sha, Unbuilt>,
    },
    Verdict {
        commit: Sha,
        answer: Answer,
    },
    Landing {
        candidate: String,
        landing: Landing,
    },
    BaseRead {
        tip: Sha,
    },
}

type Key = (RepoId, String);

struct Shared {
    host: Arc<dyn QueueHost>,
    hands: Arc<dyn Hands>,
    tuning: Tuning,
    lanes: Mutex<HashMap<Key, mpsc::UnboundedSender<Msg>>>,
    shown: Mutex<HashMap<Key, Vec<QueueEntry>>>,
    entries: watch::Sender<Arc<Vec<QueueEntry>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The merge queues of every repository and base, as the hub sees them.
pub struct Queues {
    shared: Arc<Shared>,
}

/// The queues, their saved lanes started again. Call inside the runtime.
pub(crate) fn open_with(
    host: Arc<dyn QueueHost>,
    hands: Arc<dyn Hands>,
    tuning: Tuning,
) -> Arc<Queues> {
    let shared = Arc::new(Shared {
        host,
        hands: Arc::clone(&hands),
        tuning,
        lanes: Mutex::default(),
        shown: Mutex::default(),
        entries: watch::Sender::new(Arc::default()),
    });
    for queue in hands.saved() {
        let key = (queue.repo.clone(), queue.base.clone());
        let lane = Lane::start(&shared, queue);
        locked(&shared.lanes).insert(key, lane);
    }
    Arc::new(Queues { shared })
}

impl Shared {
    fn lane(self: &Arc<Shared>, repo: &str, base: &str) -> mpsc::UnboundedSender<Msg> {
        let key = (repo.to_owned(), base.to_owned());
        let mut lanes = locked(&self.lanes);
        if let Some(lane) = lanes.get(&key).filter(|lane| !lane.is_closed()) {
            return lane.clone();
        }
        let name = format!("{}/{base}", self.hands.name());
        let queue = LandQueue::new(
            key.0.clone(),
            key.1.clone(),
            name,
            String::new(),
            self.tuning,
        );
        let lane = Lane::start(self, queue);
        lanes.insert(key, lane.clone());
        lane
    }

    fn show(&self, queue: &LandQueue) {
        let mut shown = locked(&self.shown);
        shown.insert((queue.repo.clone(), queue.base.clone()), queue.entries());
        let mut all: Vec<QueueEntry> = shown.values().flatten().cloned().collect();
        all.sort_by(|a, b| (&a.repo, &a.base).cmp(&(&b.repo, &b.base)));
        self.entries.send_replace(Arc::new(all));
    }
}

impl QueueSeam for Queues {
    fn enqueue(&self, origin: Origin, request: LandRequest) -> Fut<'_, Result<StartReply, Fault>> {
        Box::pin(async move {
            let lane = self.shared.lane(&request.repo, &request.base);
            let (reply, answer) = oneshot::channel();
            let gone = || Fault::new("queue_gone", "the merge queue of that branch stopped");
            lane.send(Msg::Enqueue {
                origin,
                request,
                reply,
            })
            .map_err(|_| gone())?;
            answer.await.map_err(|_| gone())
        })
    }

    fn entries(&self) -> watch::Receiver<Arc<Vec<QueueEntry>>> {
        self.shared.entries.subscribe()
    }
}

/// Waits before a step is tried again; false when the step's scope was cancelled meanwhile.
async fn pause(scope: &Scope, retry: &mut u64) -> bool {
    let wait = *retry;
    *retry = (*retry * 2).min(RETRY_MAX_MS);
    tokio::select! {
        () = clock::sleep(Duration::from_millis(wait)) => !scope.cancelled(),
        () = scope.on_cancel() => false,
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(9)]
}

/// What the check said, in a line, for the queue's record of a red combination.
fn red_why(answer: &Answer) -> String {
    let mut why = String::new();
    for failed in answer.failed.iter().take(3) {
        if !why.is_empty() {
            why.push_str("; ");
        }
        let _ = write!(why, "{}: {}", failed.test, failed.first_error);
    }
    if why.is_empty() {
        why = answer
            .notes
            .first()
            .cloned()
            .unwrap_or_else(|| "the check failed".to_owned());
    }
    why
}

fn blank_answer(run_id: String, verdict: AnswerVerdict, next: Next) -> Answer {
    Answer {
        run_id,
        verdict,
        as_of: clock::now_ms(),
        counts: Counts {
            passed: 0,
            failed: 0,
        },
        failed: Vec::new(),
        blocks_release: None,
        expected_wait_min: None,
        reused: None,
        next,
        notes: Vec::new(),
    }
}

struct Lane {
    queue: LandQueue,
    shared: Arc<Shared>,
    tx: mpsc::UnboundedSender<Msg>,
    /// The scope of each candidate's work under way, cancelled when the queue drops it.
    work: HashMap<String, Scope>,
    /// The answer of each run the queue was given, by commit, for the result of the entries it decided.
    answers: HashMap<Sha, Answer>,
}

impl Lane {
    fn start(shared: &Arc<Shared>, queue: LandQueue) -> mpsc::UnboundedSender<Msg> {
        let (tx, rx) = mpsc::unbounded_channel();
        let lane = Lane {
            queue,
            shared: Arc::clone(shared),
            tx: tx.clone(),
            work: HashMap::new(),
            answers: HashMap::new(),
        };
        tokio::spawn(lane.run(rx));
        tx
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        let resumed = self.queue.resume();
        self.after(resumed);
        loop {
            let msg = match self.queue.next_wake() {
                Some(at) => {
                    let wait = Duration::from_millis(at.saturating_sub(clock::now_ms()));
                    tokio::select! {
                        msg = rx.recv() => msg.map(Some),
                        () = clock::sleep(wait) => Some(None),
                    }
                }
                None => rx.recv().await.map(Some),
            };
            let Some(msg) = msg else {
                return;
            };
            let effects = self.take(msg);
            self.after(effects);
        }
    }

    /// One message, one step of the queue. `None`: time passed.
    fn take(&mut self, msg: Option<Msg>) -> Vec<Effect> {
        let now = clock::now_ms();
        let Some(msg) = msg else {
            return self.queue.tick(now);
        };
        match msg {
            Msg::Enqueue {
                origin,
                request,
                reply,
            } => {
                let goal = match &origin {
                    Origin::Session { goal, .. } => goal.clone(),
                    _ => None,
                };
                let ask = super::Ask {
                    branch: request.branch,
                    pr: request.pr,
                    title: request.title,
                    sha: request.sha,
                    goal,
                    origin,
                };
                let base = self.queue.base.clone();
                let (answer, effects) = match self.queue.enqueue(ask, now) {
                    Ok((id, effects)) => {
                        let position = self
                            .queue
                            .entries()
                            .iter()
                            .find(|entry| entry.id == id)
                            .map_or(0, |entry| entry.position);
                        let reply = StartReply {
                            run_id: Some(id),
                            decision: StartDecision::Held,
                            placement: None,
                            expected_start_min: None,
                            reason: format!("in the merge queue of {base}, number {position}"),
                        };
                        (reply, effects)
                    }
                    Err(refusal) => {
                        let reply = StartReply {
                            run_id: None,
                            decision: StartDecision::Refused,
                            placement: None,
                            expected_start_min: None,
                            reason: format!("not queued again: {refusal}"),
                        };
                        (reply, Vec::new())
                    }
                };
                let _ = reply.send(answer);
                effects
            }
            Msg::Built { candidate, result } => self.queue.built(&candidate, result, now),
            Msg::Verdict { commit, answer } => {
                let green = answer.verdict == AnswerVerdict::Green;
                let why = red_why(&answer);
                self.answers.insert(commit.clone(), answer);
                self.queue.verdict(&commit, green, &why, now)
            }
            Msg::Landing { candidate, landing } => match landing {
                Landing::Landed { tip } => self.queue.landed(&candidate, tip, now),
                Landing::Moved { tip } => self.queue.moved(&candidate, tip, now),
                Landing::Refused { why } => self.queue.refused(&candidate, &why),
            },
            Msg::BaseRead { tip } => self.queue.base_read(tip, now),
        }
    }

    fn after(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            self.effect(effect);
        }
        if self.queue.is_empty() {
            // Every entry a run's answer could still be told to has been told.
            self.answers.clear();
        }
        self.shared.show(&self.queue);
        self.shared.hands.save(&self.queue);
    }

    fn scope_for(&mut self, candidate: &str) -> Scope {
        let scope = Scope::detached();
        if let Some(old) = self.work.insert(candidate.to_owned(), scope.clone()) {
            old.cancel();
        }
        scope
    }

    fn effect(&mut self, effect: Effect) {
        let (repo, base) = (self.queue.repo.clone(), self.queue.base.clone());
        let (shared, tx) = (Arc::clone(&self.shared), self.tx.clone());
        match effect {
            Effect::Build {
                candidate,
                tip,
                parts,
            } => {
                let scope = self.scope_for(&candidate);
                tokio::spawn(async move {
                    let mut retry = RETRY_FIRST_MS;
                    let now = loop {
                        match shared.hands.tip(&repo, &base, scope.clone()).await {
                            Ok(now) => break now,
                            Err(_) if pause(&scope, &mut retry).await => {}
                            Err(_) => return,
                        }
                    };
                    let result = match now {
                        Some(now) if now != tip => {
                            let _ = tx.send(Msg::BaseRead { tip: now });
                            return;
                        }
                        Some(_) => loop {
                            let built = shared
                                .hands
                                .build(&repo, &base, &candidate, &tip, &parts, scope.clone())
                                .await;
                            match built {
                                Ok(result) => break result,
                                Err(_) if pause(&scope, &mut retry).await => {}
                                Err(_) => return,
                            }
                        },
                        None => Err(Unbuilt {
                            at: 1,
                            why: format!("the remote has no branch {base}"),
                        }),
                    };
                    if !scope.cancelled() {
                        let _ = tx.send(Msg::Built { candidate, result });
                    }
                });
            }
            Effect::Test { candidate, commit } => {
                let scope = self.scope_for(&candidate);
                let git_ref = format!("{QUEUE_BRANCH_PREFIX}{candidate}");
                tokio::spawn(async move {
                    let mut retry = RETRY_FIRST_MS;
                    let run = loop {
                        let started = shared.host.start_batch(&repo, &git_ref, &commit).await;
                        match started {
                            Ok(StartReply {
                                run_id: Some(run),
                                decision:
                                    StartDecision::Started | StartDecision::Held | StartDecision::Reused,
                                ..
                            }) => break run,
                            _ if pause(&scope, &mut retry).await => {}
                            _ => return,
                        }
                    };
                    let answer = loop {
                        match shared.host.batch_answer(run.clone(), scope.clone()).await {
                            Ok(answer) if answer.verdict != AnswerVerdict::Unknown => break answer,
                            Ok(_) => {
                                let mut wait = UNKNOWN_AGAIN_MS;
                                if !pause(&scope, &mut wait).await {
                                    return;
                                }
                            }
                            Err(_) if pause(&scope, &mut retry).await => {}
                            Err(_) => return,
                        }
                    };
                    if !scope.cancelled() {
                        let _ = tx.send(Msg::Verdict { commit, answer });
                    }
                });
            }
            Effect::Land { candidate, commit } => {
                let scope = self.scope_for(&candidate);
                tokio::spawn(async move {
                    let mut retry = RETRY_FIRST_MS;
                    loop {
                        match shared
                            .hands
                            .land(&repo, &base, &commit, scope.clone())
                            .await
                        {
                            Ok(landing) => {
                                let _ = tx.send(Msg::Landing { candidate, landing });
                                return;
                            }
                            Err(_) if pause(&scope, &mut retry).await => {}
                            Err(_) => return,
                        }
                    }
                });
            }
            Effect::Drop { candidate } => {
                if let Some(scope) = self.work.remove(&candidate) {
                    scope.cancel();
                }
                tokio::spawn(async move { shared.hands.drop_branch(&repo, &candidate).await });
            }
            Effect::Tell { entry, told } => {
                let answer = match told {
                    Told::Landed { commit } => {
                        let mut answer =
                            blank_answer(entry.id.clone(), AnswerVerdict::Green, Next::Land);
                        if let Some(run) = self.answers.get(&commit) {
                            answer.counts = run.counts.clone();
                        }
                        answer
                            .notes
                            .push(format!("landed on {base} in {}", short(&commit)));
                        answer
                    }
                    Told::Failed { why, commit } => {
                        let mut answer = match commit
                            .as_ref()
                            .and_then(|commit| self.answers.get(commit))
                        {
                            Some(run) => run.clone(),
                            None => blank_answer(entry.id.clone(), AnswerVerdict::Red, Next::Fix),
                        };
                        answer.run_id = entry.id.clone();
                        answer.verdict = AnswerVerdict::Red;
                        answer.next = Next::Fix;
                        answer.as_of = clock::now_ms();
                        answer.notes.push(format!("not landed on {base}: {why}"));
                        answer
                    }
                };
                shared.host.finished(RunResult {
                    run_id: entry.id,
                    origin: entry.origin,
                    answer,
                });
            }
        }
    }
}

// ---- the real hands: git in a bare clone the queue owns ------------------------------------------------------------

/// Git against the repository's remote, in `<dir>/repos/<owner>__<name>.git`, and the queue's saves in `<dir>/lanes/`.
pub struct GitHands {
    /// How git runs now; none until main handed it over.
    pub git: Box<dyn Fn(Scope) -> Option<Git> + Send + Sync>,
    pub dir: PathBuf,
    /// The remote's URL of a repository (`owner/name`).
    pub url: Box<dyn Fn(&str) -> String + Send + Sync>,
}

/// GitHub's URL of `owner/name`.
pub fn github_url(repo: &str) -> String {
    format!("https://github.com/{repo}.git")
}

fn slug(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn no_git() -> Failure {
    Failure::Git(Fault::new(
        "no_git",
        "git is not available to the merge queue yet",
    ))
}

impl GitHands {
    fn git(&self, scope: Scope) -> Result<Git, Failure> {
        (self.git)(scope).ok_or_else(no_git)
    }

    /// The repository's bare clone, made the first time.
    async fn clone_of(&self, git: &Git, repo: &str) -> Result<String, Failure> {
        let repos = self.dir.join("repos");
        let path = repos.join(format!("{}.git", slug(repo)));
        let text = path.to_string_lossy().into_owned();
        if path.join("HEAD").is_file() {
            return Ok(text);
        }
        std::fs::create_dir_all(&repos)
            .map_err(|error| Failure::Git(Fault::new("queue_dir", error.to_string())))?;
        let cwd = repos.to_string_lossy().into_owned();
        land::text(git, &cwd, &["init", "--bare", "-q", &text]).await?;
        land::text(git, &text, &["remote", "add", "origin", &(self.url)(repo)]).await?;
        Ok(text)
    }

    async fn fetch_branch(&self, git: &Git, clone: &str, branch: &str) -> Result<bool, Failure> {
        let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        let opts = Opts {
            timeout_ms: Some(land::PUSH_TIMEOUT_MS),
            ..Opts::default()
        };
        let fetched = git
            .run(clone, &["fetch", "--no-tags", "origin", &refspec], opts)
            .await?;
        if fetched.code == 0 {
            return Ok(true);
        }
        if fetched
            .stderr
            .to_lowercase()
            .contains("couldn't find remote ref")
        {
            return Ok(false);
        }
        Err(Failure::Remote(fetched.stderr))
    }

    async fn holds(&self, git: &Git, clone: &str, older: &str, newer: &str) -> Result<bool, Fault> {
        let answer =
            land::plain(git, clone, &["merge-base", "--is-ancestor", older, newer]).await?;
        Ok(answer.code == 0)
    }

    async fn push(
        &self,
        git: &Git,
        clone: &str,
        sha: &str,
        dest: &str,
    ) -> Result<crate::run::Output, Failure> {
        let url = land::push_url(git, clone, "origin").await?;
        Ok(land::push_sha(git, clone, "origin", &url, sha, dest).await?)
    }

    fn lanes(&self) -> PathBuf {
        self.dir.join("lanes")
    }
}

impl Hands for GitHands {
    fn tip<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<Option<Sha>, Failure>> {
        Box::pin(async move {
            let git = self.git(scope)?;
            let clone = self.clone_of(&git, repo).await?;
            land::fetch_tip(&git, &clone, "origin", base).await
        })
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
        Box::pin(async move {
            let git = self.git(scope)?;
            let clone = self.clone_of(&git, repo).await?;
            for (index, part) in parts.iter().enumerate() {
                let at = index + 1;
                if !self.fetch_branch(&git, &clone, &part.branch).await? {
                    let why = format!("the remote has no branch {}", part.branch);
                    return Ok(Err(Unbuilt { at, why }));
                }
                let object = format!("{}^{{commit}}", part.sha);
                if land::plain(&git, &clone, &["cat-file", "-e", &object])
                    .await?
                    .code
                    != 0
                {
                    let why = format!(
                        "{} is not on the remote's {}",
                        short(&part.sha),
                        part.branch
                    );
                    return Ok(Err(Unbuilt { at, why }));
                }
            }
            let mut built = tip.to_owned();
            for (index, part) in parts.iter().enumerate() {
                // A branch that already holds what is built so far is taken as it is: it lands as a fast-forward.
                if self.holds(&git, &clone, &built, &part.sha).await? {
                    built = part.sha.clone();
                    continue;
                }
                let tree = match land::merge_tree(&git, &clone, &built, &part.sha).await? {
                    Merge::Clean { tree } => tree,
                    Merge::Conflicts(files) => {
                        let why = format!("conflicts in {}", files.join(", "));
                        return Ok(Err(Unbuilt { at: index + 1, why }));
                    }
                    Merge::Unknown { stderr } => {
                        return Err(Failure::Git(Fault::new("git_exit", land::brief(&stderr))));
                    }
                };
                // The later of the two commits' dates: the same parts on the same tip build the same commit.
                let dates = land::text(
                    &git,
                    &clone,
                    &["show", "-s", "--format=%ct", &built, &part.sha],
                )
                .await?;
                let date = dates
                    .lines()
                    .filter_map(|line| line.trim().parse::<u64>().ok())
                    .max()
                    .unwrap_or_default();
                let message = format!("Merge {} into {base} (OMPdesk merge queue)", part.branch);
                built = land::commit_tree(
                    &git,
                    &clone,
                    &tree,
                    &[&built, &part.sha],
                    &message,
                    Some(&format!("{date} +0000")),
                )
                .await?;
            }
            let dest = format!("{QUEUE_BRANCH_PREFIX}{candidate}");
            let pushed = self.push(&git, &clone, &built, &dest).await?;
            if pushed.code != 0 {
                return Err(Failure::Remote(pushed.stderr));
            }
            Ok(Ok(built))
        })
    }

    fn land<'a>(
        &'a self,
        repo: &'a str,
        base: &'a str,
        commit: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<Landing, Failure>> {
        Box::pin(async move {
            let git = self.git(scope)?;
            let clone = self.clone_of(&git, repo).await?;
            let pushed = self.push(&git, &clone, commit, base).await?;
            if pushed.code == 0 {
                return Ok(Landing::Landed {
                    tip: commit.to_owned(),
                });
            }
            if land::moved_on(&pushed.stderr) {
                let Some(tip) = land::fetch_tip(&git, &clone, "origin", base).await? else {
                    return Err(Failure::Remote(pushed.stderr));
                };
                // A push that went through before a restart reads as moved on once others pushed after it.
                return Ok(if self.holds(&git, &clone, commit, &tip).await? {
                    Landing::Landed { tip }
                } else {
                    Landing::Moved { tip }
                });
            }
            if land::classify_push_failure(&pushed.stderr) == PushFailure::Network {
                return Err(Failure::Remote(pushed.stderr));
            }
            let said = pushed
                .stderr
                .lines()
                .filter_map(|line| line.strip_prefix("remote:"))
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let why = land::brief(if said.is_empty() {
                &pushed.stderr
            } else {
                &said
            });
            Ok(Landing::Refused { why })
        })
    }

    fn drop_branch<'a>(&'a self, repo: &'a str, candidate: &'a str) -> Fut<'a, ()> {
        Box::pin(async move {
            let Ok(git) = self.git(Scope::detached()) else {
                return;
            };
            let Ok(clone) = self.clone_of(&git, repo).await else {
                return;
            };
            let dest = format!("refs/heads/{QUEUE_BRANCH_PREFIX}{candidate}");
            let opts = Opts {
                timeout_ms: Some(land::PUSH_TIMEOUT_MS),
                ..Opts::default()
            };
            // Never pushed (dropped while it was built): git says so, and that is the end of it.
            let _ = git
                .run(&clone, &["push", "origin", "--delete", &dest], opts)
                .await;
        })
    }

    fn name(&self) -> String {
        let file = self.dir.join("name");
        if let Ok(name) = std::fs::read_to_string(&file)
            && !name.trim().is_empty()
        {
            return name.trim().to_owned();
        }
        let mut raw = [0u8; 4];
        let name = match crate::sys::random(&mut raw) {
            Ok(()) => raw.iter().fold(String::new(), |mut hex, byte| {
                let _ = write!(hex, "{byte:02x}");
                hex
            }),
            Err(_) => format!("{:x}", clock::now_ms()),
        };
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = crate::disk::saves::write_kept(&file, name.as_bytes(), Some(0o600), 0o700);
        name
    }

    fn save(&self, queue: &LandQueue) {
        let file = self
            .lanes()
            .join(format!("{}__{}.json", slug(&queue.repo), slug(&queue.base)));
        if let Ok(bytes) = serde_json::to_vec(queue) {
            let _ = crate::disk::saves::write_kept(&file, &bytes, Some(0o600), 0o700);
        }
    }

    fn saved(&self) -> Vec<LandQueue> {
        let Ok(entries) = std::fs::read_dir(self.lanes()) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .filter_map(|path| read_lane(&path))
            .collect()
    }
}

fn read_lane(path: &Path) -> Option<LandQueue> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(test)]
#[path = "queue_run_tests.rs"]
mod tests;
