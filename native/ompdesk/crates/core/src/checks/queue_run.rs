//! Running the merge queue (`queue.rs` holds its rules). One task per base branch of a repository (a lane) owns that
//! base's `LandQueue` and is the only one to call it, one message at a time, so each of its methods is one step as in
//! the model. What the queue asks is done by tasks the lane starts, which answer the lane by message:
//!
//! - `Build`: read the base's tip first; a tip the queue did not know is told to it (`base_read`) instead of building on
//!   an old one. Then `Hands::build` merges the parts onto the tip and pushes the commit to the queue's own branch.
//! - `Test`: one run of that commit on that branch through the hub (`QueueHost::start_batch`, the same admission as
//!   every run), then its final `Answer` (`batch_answer`). A final `unknown` ends the trial without redispatching it.
//! - `Land`: `Hands::land` pushes the commit to the base, never forced, and says whether the base took it, moved on or
//!   refuses the queue's pushes.
//! - `Drop`: the candidate's work stops (its scope is cancelled) and its branch is deleted.
//! - `Tell`: the entry's result goes to the hub (`QueueHost::finished`), which ends its waits and wakes its session.
//!
//! Transient git, hub, and save failures back off from `RETRY_FIRST_MS` to `RETRY_MAX_MS`. Each step and its
//! outstanding effects are saved together before the effects or an enqueue reply are sent. Reopening replays the
//! outstanding effects; the host deduplicates batch starts and result delivery.
//!
//! A process-wide lane guard prevents a reopened lane from acting until the previous lane's canceled candidate work
//! has exited. Stopping the queues cancels that work and waits for it before releasing the guard.
//!
//! `GitHands` is the real `Hands`: git in a bare clone the queue owns per repository, with `git/land.rs`, the landing
//! git Autopilot uses too.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, watch};

use super::{Effect, LandQueue, Part, QUEUE_BRANCH_PREFIX, Told, Tuning, Unbuilt};
use crate::checks::answer;
use crate::checks::contract::{
    Answer, AnswerVerdict, Next, Note, NoteCode, Origin, QueueEntry, RepoId, RunResult, Sha,
    StartDecision, StartReply,
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
    fn drop_branch<'a>(
        &'a self,
        repo: &'a str,
        candidate: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<(), Failure>>;

    /// This computer's part of every name the queue makes, so two computers' queues never share a branch.
    fn name(&self) -> String;

    /// Identifies the storage directory shared by successive owners of the same lane.
    fn identity(&self) -> PathBuf;

    fn save(
        &self,
        queue: &LandQueue,
        effects: &[Effect],
        answers: &HashMap<Sha, Answer>,
        retire_answers: &[String],
    ) -> Result<(), Fault>;

    fn saved(&self) -> Vec<SavedLane>;
}

/// One lane and the effects not yet durably accepted by their destinations.
#[derive(Clone, Serialize, Deserialize)]
pub struct SavedLane {
    queue: LandQueue,
    effects: Vec<Effect>,
    answers: HashMap<Sha, Answer>,
    #[serde(default)]
    retire_answers: Vec<String>,
}

#[derive(Serialize)]
struct LaneSave<'a> {
    queue: &'a LandQueue,
    effects: &'a [Effect],
    answers: &'a HashMap<Sha, Answer>,
    retire_answers: &'a [String],
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
        candidate: String,
        commit: Sha,
        answer: Answer,
    },
    Landing {
        candidate: String,
        landing: Landing,
    },
    BaseRead {
        candidate: String,
        tip: Sha,
    },
    Dropped {
        candidate: String,
    },
    Told {
        id: String,
    },
    AnswerRetired {
        id: String,
    },
}

type Key = (RepoId, String);

type LaneOwnerKey = (PathBuf, RepoId, String);
static LANE_OWNERS: LazyLock<Mutex<HashMap<LaneOwnerKey, Weak<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lane_owner(key: LaneOwnerKey) -> Arc<tokio::sync::Mutex<()>> {
    let mut owners = locked(&LANE_OWNERS);
    if let Some(owner) = owners.get(&key).and_then(Weak::upgrade) {
        return owner;
    }
    owners.retain(|_, owner| owner.strong_count() > 0);
    let owner = Arc::new(tokio::sync::Mutex::new(()));
    owners.insert(key, Arc::downgrade(&owner));
    owner
}

struct Shared {
    host: Arc<dyn QueueHost>,
    hands: Arc<dyn Hands>,
    tuning: Tuning,
    /// Cancelled when `Queues` drops: every lane and the work it started ends.
    stop: Scope,
    lanes: Mutex<HashMap<Key, mpsc::UnboundedSender<Msg>>>,
    shown: Mutex<HashMap<Key, Vec<QueueEntry>>>,
    entries: watch::Sender<Arc<Vec<QueueEntry>>>,
    /// The saved lanes are started, once, before the first lane is looked up.
    loaded: tokio::sync::OnceCell<()>,
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

impl Drop for Queues {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The queues. Their saved lanes start at the first `enqueue`, or at once by a task of their own when a runtime runs,
/// so a caller may open them before what `hands` reads is ready.
pub(crate) fn open_with(
    host: Arc<dyn QueueHost>,
    hands: Arc<dyn Hands>,
    tuning: Tuning,
) -> Arc<Queues> {
    let shared = Arc::new(Shared {
        host,
        hands,
        tuning,
        stop: Scope::detached(),
        lanes: Mutex::default(),
        shown: Mutex::default(),
        entries: watch::Sender::new(Arc::default()),
        loaded: tokio::sync::OnceCell::new(),
    });
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let shared = Arc::downgrade(&shared);
        runtime.spawn(async move {
            if let Some(shared) = shared.upgrade() {
                shared.load().await;
            }
        });
    }
    Arc::new(Queues { shared })
}

impl Shared {
    async fn load(self: &Arc<Shared>) {
        self.loaded
            .get_or_init(|| async {
                for saved in self.hands.saved() {
                    let key = (saved.queue.repo.clone(), saved.queue.base.clone());
                    let lane = Lane::start(self, saved);
                    locked(&self.lanes).insert(key, lane);
                }
            })
            .await;
    }

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
        let lane = Lane::start(
            self,
            SavedLane {
                queue,
                effects: Vec::new(),
                answers: HashMap::new(),
                retire_answers: Vec::new(),
            },
        );
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
            let gone = || Fault::new("queue_gone", "the merge queue of that branch stopped");
            if self.shared.stop.cancelled() {
                return Err(gone());
            }
            self.shared.load().await;
            let lane = self.shared.lane(&request.repo, &request.base);
            let (reply, answer) = oneshot::channel();
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

    fn stop(&self) {
        self.shared.stop.cancel();
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
        let _ = write!(
            why,
            "{}: {}",
            failed.test,
            failed
                .first_error
                .as_deref()
                .unwrap_or("first error was not recorded")
        );
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

struct CandidateWork {
    scope: Scope,
    done: watch::Receiver<bool>,
}

struct WorkDone(watch::Sender<bool>);

impl Drop for WorkDone {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

async fn previous_done(mut previous: Option<watch::Receiver<bool>>, scope: &Scope) -> bool {
    if let Some(done) = previous.as_mut()
        && done.wait_for(|done| *done).await.is_err()
    {
        return false;
    }
    !scope.cancelled()
}

struct Lane {
    queue: LandQueue,
    effects: Vec<Effect>,
    retire_answers: Vec<String>,
    retire_ready: Vec<String>,
    shared: Arc<Shared>,
    tx: mpsc::UnboundedSender<Msg>,
    /// The scope of each candidate's work under way, cancelled when the queue drops it.
    work: HashMap<String, CandidateWork>,
    deliveries: HashMap<String, CandidateWork>,
    /// The answer of each run the queue was given, by commit, for the result of the entries it decided.
    answers: HashMap<Sha, Answer>,
    /// An `enqueue`'s answer, sent once the step that queued the entry is saved: a caller told "queued" never loses
    /// its entry to a crash.
    reply: Option<(oneshot::Sender<StartReply>, StartReply)>,
}

impl Lane {
    fn start(shared: &Arc<Shared>, saved: SavedLane) -> mpsc::UnboundedSender<Msg> {
        let (tx, rx) = mpsc::unbounded_channel();
        let lane = Lane {
            queue: saved.queue,
            effects: saved.effects,
            retire_answers: saved.retire_answers,
            retire_ready: Vec::new(),
            shared: Arc::clone(shared),
            tx: tx.clone(),
            work: HashMap::new(),
            deliveries: HashMap::new(),
            answers: saved.answers,
            reply: None,
        };
        tokio::spawn(lane.run(rx));
        tx
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        let stop = self.shared.stop.clone();
        let owner = lane_owner((
            self.shared.hands.identity(),
            self.queue.repo.clone(),
            self.queue.base.clone(),
        ));
        let _owner = tokio::select! {
            () = stop.on_cancel() => return,
            guard = owner.lock() => guard,
        };
        if let Some(saved) = self.shared.hands.saved().into_iter().find(|saved| {
            saved.queue.repo == self.queue.repo && saved.queue.base == self.queue.base
        }) {
            self.queue = saved.queue;
            self.effects = saved.effects;
            self.retire_answers = saved.retire_answers;
            self.answers = saved.answers;
        }
        self.retire_ready = self.retire_answers.clone();
        let resumed = self.effects.clone();
        if self.queue.is_empty() && resumed.is_empty() && self.retire_ready.is_empty() {
            self.shared.show(&self.queue);
        } else if !self.after(resumed, &stop).await {
            return;
        }
        loop {
            let wake = self.queue.next_wake();
            let msg = tokio::select! {
                biased;
                () = stop.on_cancel() => break,
                msg = rx.recv() => match msg {
                    Some(msg) => Some(msg),
                    None => break,
                },
                () = async {
                    match wake {
                        Some(at) => clock::sleep(Duration::from_millis(at.saturating_sub(clock::now_ms()))).await,
                        None => std::future::pending().await,
                    }
                } => None,
            };
            let effects = self.take(msg);
            self.record(&effects);
            if !self.after(effects, &stop).await {
                break;
            }
        }
        for work in self.work.values() {
            work.scope.cancel();
        }
        for work in self.deliveries.values() {
            work.scope.cancel();
        }
        for work in self.work.values_mut() {
            let _ = work.done.wait_for(|done| *done).await;
        }
        for work in self.deliveries.values_mut() {
            let _ = work.done.wait_for(|done| *done).await;
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
                self.reply = Some((reply, answer));
                effects
            }
            Msg::Built { candidate, result } => {
                let pending = self.effects.len();
                self.effects.retain(|effect| !matches!(effect, Effect::Build { candidate: id, .. } if id == &candidate));
                if self.effects.len() == pending {
                    return Vec::new();
                }
                self.queue.built(&candidate, result, now)
            }
            Msg::Verdict {
                candidate,
                commit,
                answer,
            } => {
                let pending = self.effects.len();
                self.effects.retain(|effect| !matches!(effect, Effect::Test { candidate: id, .. } if id == &candidate));
                if self.effects.len() == pending {
                    return Vec::new();
                }
                let green = answer.verdict == AnswerVerdict::Green;
                let why = red_why(&answer);
                self.answers.insert(commit.clone(), answer);
                self.queue.verdict(&commit, green, &why, now)
            }
            Msg::Landing { candidate, landing } => {
                let pending = self.effects.len();
                self.effects.retain(|effect| !matches!(effect, Effect::Land { candidate: id, .. } if id == &candidate));
                if self.effects.len() == pending {
                    return Vec::new();
                }
                match landing {
                    Landing::Landed { tip } => self.queue.landed(&candidate, tip, now),
                    Landing::Moved { tip } => self.queue.moved(&candidate, tip, now),
                    Landing::Refused { why } => self.queue.refused(&candidate, &why),
                }
            }
            Msg::BaseRead { candidate, tip } => {
                let pending = self.effects.len();
                self.effects.retain(|effect| !matches!(effect, Effect::Build { candidate: id, .. } if id == &candidate));
                if self.effects.len() == pending {
                    return Vec::new();
                }
                self.queue.base_read(tip, now)
            }
            Msg::Dropped { candidate } => {
                self.work.remove(&candidate);
                self.effects.retain(
                    |effect| !matches!(effect, Effect::Drop { candidate: id } if id == &candidate),
                );
                Vec::new()
            }
            Msg::Told { id } => {
                let pending = self.effects.len();
                self.effects.retain(
                    |effect| !matches!(effect, Effect::Tell { entry, .. } if entry.id == id),
                );
                if self.effects.len() != pending {
                    self.retire_answers.push(id.clone());
                    self.retire_ready.push(id);
                }
                if self.queue.is_empty()
                    && !self
                        .effects
                        .iter()
                        .any(|effect| matches!(effect, Effect::Tell { .. }))
                {
                    self.answers.clear();
                }
                Vec::new()
            }
            Msg::AnswerRetired { id } => {
                self.deliveries.remove(&id);
                self.retire_answers.retain(|pending| pending != &id);
                Vec::new()
            }
        }
    }

    fn record(&mut self, effects: &[Effect]) {
        for effect in effects {
            if let Effect::Drop { candidate } = effect {
                self.effects.retain(|pending| {
                    !matches!(pending,
                    Effect::Build { candidate: id, .. }
                    | Effect::Test { candidate: id, .. }
                    | Effect::Land { candidate: id, .. } if id == candidate)
                });
            }
            self.effects.push(effect.clone());
        }
    }

    async fn after(&mut self, effects: Vec<Effect>, stop: &Scope) -> bool {
        let mut retry = RETRY_FIRST_MS;
        loop {
            if stop.cancelled() {
                return false;
            }
            match self.shared.hands.save(
                &self.queue,
                &self.effects,
                &self.answers,
                &self.retire_answers,
            ) {
                Ok(()) => break,
                Err(_) if pause(stop, &mut retry).await => {}
                Err(_) => return false,
            }
        }
        if stop.cancelled() {
            return false;
        }
        self.shared.show(&self.queue);
        for effect in effects {
            self.effect(effect);
        }
        for id in std::mem::take(&mut self.retire_ready) {
            self.retire_answer(id);
        }
        if let Some((reply, answer)) = self.reply.take() {
            let _ = reply.send(answer);
        }
        true
    }

    fn scope_for(
        work: &mut HashMap<String, CandidateWork>,
        candidate: &str,
    ) -> (Scope, Option<watch::Receiver<bool>>, watch::Sender<bool>) {
        let scope = Scope::detached();
        let (done, receiver) = watch::channel(false);
        let old = work.insert(
            candidate.to_owned(),
            CandidateWork {
                scope: scope.clone(),
                done: receiver,
            },
        );
        let previous = old.map(|work| {
            work.scope.cancel();
            work.done
        });
        (scope, previous, done)
    }

    fn retire_answer(&mut self, id: String) {
        let (scope, previous, done) = Self::scope_for(&mut self.deliveries, &id);
        let (shared, tx) = (Arc::clone(&self.shared), self.tx.clone());
        tokio::spawn(async move {
            let _done = WorkDone(done);
            if !previous_done(previous, &scope).await {
                return;
            }
            let mut retry = RETRY_FIRST_MS;
            loop {
                match shared.host.forget_answer(&id, scope.clone()).await {
                    Ok(()) => {
                        if !scope.cancelled() {
                            let _ = tx.send(Msg::AnswerRetired { id });
                        }
                        return;
                    }
                    Err(_) if pause(&scope, &mut retry).await => {}
                    Err(_) => return,
                }
            }
        });
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
                let (scope, previous, done) = Self::scope_for(&mut self.work, &candidate);
                tokio::spawn(async move {
                    let _done = WorkDone(done);
                    if !previous_done(previous, &scope).await {
                        return;
                    }
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
                            let _ = tx.send(Msg::BaseRead {
                                candidate,
                                tip: now,
                            });
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
                let (scope, previous, done) = Self::scope_for(&mut self.work, &candidate);
                let git_ref = format!("{QUEUE_BRANCH_PREFIX}{candidate}");
                let effect_id = format!("{repo}:{candidate}");
                tokio::spawn(async move {
                    let _done = WorkDone(done);
                    if !previous_done(previous, &scope).await {
                        return;
                    }
                    // The stable effect id lets the host reconcile a retried start without dispatching it twice.
                    let mut retry = RETRY_FIRST_MS;
                    let started = loop {
                        let reply = tokio::select! {
                            () = scope.on_cancel() => return,
                            reply = shared.host.start_batch(&repo, &git_ref, &commit, &effect_id) => reply,
                        };
                        match reply {
                            Ok(StartReply {
                                run_id: None,
                                decision: StartDecision::Refused,
                                ..
                            }) if shared.host.paused() && pause(&scope, &mut retry).await => {}
                            Ok(reply) => break reply,
                            Err(_) if pause(&scope, &mut retry).await => {}
                            Err(_) => return,
                        }
                    };
                    let answer = match started {
                        StartReply {
                            run_id: Some(run),
                            decision:
                                StartDecision::Started | StartDecision::Held | StartDecision::Reused,
                            ..
                        } => loop {
                            match shared.host.batch_answer(run.clone(), scope.clone()).await {
                                Ok(answer) => break answer,
                                Err(_) if pause(&scope, &mut retry).await => {}
                                Err(_) => return,
                            }
                        },
                        refused => {
                            let mut answer = answer::blank(
                                &refused.run_id.unwrap_or_default(),
                                AnswerVerdict::Unknown,
                                clock::now_ms(),
                                Next::Fix,
                            );
                            answer.say(Note {
                                error: Some(refused.reason),
                                ..Note::new(NoteCode::Refused)
                            });
                            answer
                        }
                    };
                    if !scope.cancelled() {
                        let _ = tx.send(Msg::Verdict {
                            candidate,
                            commit,
                            answer,
                        });
                    }
                });
            }
            Effect::Land { candidate, commit } => {
                let (scope, previous, done) = Self::scope_for(&mut self.work, &candidate);
                tokio::spawn(async move {
                    let _done = WorkDone(done);
                    if !previous_done(previous, &scope).await {
                        return;
                    }
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
                let (scope, previous, done) = Self::scope_for(&mut self.work, &candidate);
                let effect_id = format!("{repo}:{candidate}");
                tokio::spawn(async move {
                    let _done = WorkDone(done);
                    if !previous_done(previous, &scope).await {
                        return;
                    }
                    let mut retry = RETRY_FIRST_MS;
                    loop {
                        let deleted = shared
                            .hands
                            .drop_branch(&repo, &candidate, scope.clone())
                            .await;
                        if deleted.is_ok()
                            && shared
                                .host
                                .forget_batch(&effect_id, scope.clone())
                                .await
                                .is_ok()
                        {
                            if !scope.cancelled() {
                                let _ = tx.send(Msg::Dropped { candidate });
                            }
                            return;
                        }
                        if !pause(&scope, &mut retry).await {
                            return;
                        }
                    }
                });
            }
            Effect::Tell { entry, told } => {
                let answer = match told {
                    Told::Landed { commit } => {
                        let mut answer = answer::blank(
                            &entry.id,
                            AnswerVerdict::Green,
                            clock::now_ms(),
                            Next::Land,
                        );
                        if let Some(run) = self.answers.get(&commit) {
                            answer.counts = run.counts.clone();
                        }
                        answer.say(Note {
                            base: Some(base.clone()),
                            commit: Some(commit),
                            ..Note::new(NoteCode::Landed)
                        });
                        answer
                    }
                    Told::Failed { why, commit } => {
                        let mut answer =
                            match commit.as_ref().and_then(|commit| self.answers.get(commit)) {
                                Some(run) => run.clone(),
                                None => answer::blank(
                                    &entry.id,
                                    AnswerVerdict::Red,
                                    clock::now_ms(),
                                    Next::Fix,
                                ),
                            };
                        answer.run_id = entry.id.clone();
                        answer.verdict = AnswerVerdict::Red;
                        answer.next = Next::Fix;
                        answer.as_of = clock::now_ms();
                        answer.say(Note {
                            base: Some(base.clone()),
                            error: Some(why),
                            ..Note::new(NoteCode::NotLanded)
                        });
                        answer
                    }
                };
                let result = RunResult {
                    run_id: entry.id,
                    origin: entry.origin,
                    answer,
                };
                let (scope, previous, done) = Self::scope_for(&mut self.deliveries, &result.run_id);
                tokio::spawn(async move {
                    let _done = WorkDone(done);
                    if !previous_done(previous, &scope).await {
                        return;
                    }
                    let mut retry = RETRY_FIRST_MS;
                    loop {
                        match shared.host.finished(result.clone(), scope.clone()).await {
                            Ok(()) => {
                                if !scope.cancelled() {
                                    let _ = tx.send(Msg::Told { id: result.run_id });
                                }
                                return;
                            }
                            Err(_) if pause(&scope, &mut retry).await => {}
                            Err(_) => return,
                        }
                    }
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
    /// The queue's folder, asked each time (the hub that gives it may not exist yet when this is made).
    pub dir: Box<dyn Fn() -> PathBuf + Send + Sync>,
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
        let repos = (self.dir)().join("repos");
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
        (self.dir)().join("lanes")
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

    fn drop_branch<'a>(
        &'a self,
        repo: &'a str,
        candidate: &'a str,
        scope: Scope,
    ) -> Fut<'a, Result<(), Failure>> {
        Box::pin(async move {
            let git = self.git(scope)?;
            let clone = self.clone_of(&git, repo).await?;
            let dest = format!("refs/heads/{QUEUE_BRANCH_PREFIX}{candidate}");
            let opts = Opts {
                timeout_ms: Some(land::PUSH_TIMEOUT_MS),
                ..Opts::default()
            };
            let remote = git
                .run(
                    &clone,
                    &["ls-remote", "--exit-code", "--heads", "origin", &dest],
                    opts,
                )
                .await?;
            if remote.code == 2 {
                return Ok(());
            }
            if remote.code != 0 {
                return Err(Failure::Remote(remote.stderr));
            }
            let deleted = git
                .run(&clone, &["push", "origin", "--delete", &dest], opts)
                .await?;
            if deleted.code == 0 {
                Ok(())
            } else {
                Err(Failure::Remote(deleted.stderr))
            }
        })
    }

    fn name(&self) -> String {
        let dir = (self.dir)();
        let file = dir.join("name");
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
        let _ = std::fs::create_dir_all(&dir);
        let _ = crate::disk::saves::write_kept(&file, name.as_bytes(), Some(0o600), 0o700);
        name
    }

    fn identity(&self) -> PathBuf {
        (self.dir)()
    }

    fn save(
        &self,
        queue: &LandQueue,
        effects: &[Effect],
        answers: &HashMap<Sha, Answer>,
        retire_answers: &[String],
    ) -> Result<(), Fault> {
        let file = self
            .lanes()
            .join(format!("{}__{}.json", slug(&queue.repo), slug(&queue.base)));
        let bytes = serde_json::to_vec(&LaneSave {
            queue,
            effects,
            answers,
            retire_answers,
        })
        .map_err(|error| Fault::new("queue_save", error.to_string()))?;
        match crate::disk::saves::write_kept(&file, &bytes, Some(0o600), 0o700)? {
            true => Ok(()),
            false => Err(Fault::new("queue_save", "the queue save was not committed")),
        }
    }

    fn saved(&self) -> Vec<SavedLane> {
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

fn read_lane(path: &Path) -> Option<SavedLane> {
    let bytes = std::fs::read(path).ok()?;
    if let Ok(saved) = serde_json::from_slice::<SavedLane>(&bytes) {
        return Some(saved);
    }
    let queue: LandQueue = serde_json::from_slice(&bytes).ok()?;
    let effects = queue.resume();
    Some(SavedLane {
        queue,
        effects,
        answers: HashMap::new(),
        retire_answers: Vec::new(),
    })
}

#[cfg(test)]
#[path = "queue_run_tests.rs"]
mod tests;
