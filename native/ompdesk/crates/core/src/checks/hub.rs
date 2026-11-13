//! `ChecksHub`: the one deep module of check control. Three calls (`start`, `wait`, `status`), one read-only stream for
//! screens (`watch`) and the owner's one control (`pause`). Everything else is behind it.
//!
//! `Hub` is the real one: the poller (`poller.rs`) reads the facts, `policy.rs` decides what a start dispatches,
//! `admission.rs` decides when, `ticket.rs` signs the dispatch and `answer.rs` writes the result. One loop per hub
//! (`Hub::run`) wakes on the poller's changes, frees the places of runs that ended, reaps lapsed leases and admits
//! what may start. The seams to the merge queue are here too: `LandQueue` and `QueueHost`.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, broadcast, watch};
use tokio::task::AbortHandle;

use super::admission::{self, Admission, Ask, Ended, Key, Limit, Stage};
use super::answer::{self, Judged};
use super::contract::{
    Answer, Decision, DecisionWhy, JobState, Lane, MainFact, Next, Origin, PolicyAction, Purpose,
    QueueEntry, RepoId, Rerun, RunId, RunResult, RunVerdict, Sha, Snapshot, StartDecision,
    StartReply, StartRequest, StartScope, StatusRequest, Until, WaitRequest, Where, WhyCode,
};
use super::policy::{self, Plan};
use super::poller::Poller;
use super::poller::provenance::{Claim, Expected};
use super::results::ledger::Ledger;
use super::results::store::Store;
use super::sources::{Dispatch, GithubSource, LocalSource};
use super::ticket::{self, AdmissionKey};
use crate::clock;
use crate::run::Runner;
use crate::server::{Fault, Scope};

/// How gh and git run, as main hands it over (`ghRunner` and `gitRunner`; None: not installed). It holds the
/// environment, tokens included: never logged, never part of an answer.
#[derive(Deserialize)]
pub struct Runners {
    pub gh: Option<Runner>,
    pub git: Option<Runner>,
    /// Where gh runs when a request names its repository itself.
    pub home: String,
}

pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How many results a slow subscriber may fall behind before it loses the oldest.
pub const RESULTS_KEPT: usize = 256;

pub trait ChecksHub: Send + Sync {
    /// Starts checks for `origin`. A refusal is an answer (`decision: refused` with its reason), not a fault.
    fn start(&self, origin: Origin, request: StartRequest) -> Fut<'_, Result<StartReply, Fault>>;

    /// Ends when the run's result arrived, when `timeoutSeconds` passed (`verdict: unknown`, `next: wait`) or when
    /// `scope` is cancelled (`cancelled`). It polls nothing of its own: the hub's one poller wakes it.
    fn wait(
        &self,
        origin: Origin,
        request: WaitRequest,
        scope: Scope,
    ) -> Fut<'_, Result<Answer, Fault>>;

    /// The cache as `origin` may see it under the request's scope. No GitHub request.
    fn status(&self, origin: Origin, request: StatusRequest) -> Fut<'_, Result<Snapshot, Fault>>;

    /// The whole cache, now and at each change.
    fn watch(&self) -> watch::Receiver<Arc<Snapshot>>;

    /// Every result as it arrives, whoever waits for it (main wakes the session that started the run).
    fn results(&self) -> broadcast::Receiver<RunResult>;

    /// The owner's switch: while paused every start is refused with "paused by the owner".
    fn pause(&self, paused: bool) -> Fut<'_, Result<(), Fault>>;

    /// What main knows and the hub cannot read itself.
    fn told(&self, fact: MainFact) -> Fut<'_, Result<(), Fault>>;

    /// How gh and git run from now on.
    fn runners(&self, runners: Runners) -> Fut<'_, Result<(), Fault>>;
}

fn not_built(part: &str) -> Fault {
    Fault::new(
        "not_built",
        format!("check control: {part} is not built yet"),
    )
}

/// What admission hands the merge queue for a `start {purpose: land}`: a branch to land on `base`, already resolved
/// (its repo, its head) and already past the owner's pause.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LandRequest {
    pub repo: RepoId,
    pub branch: String,
    pub sha: Sha,
    /// Where it lands (the repo's default branch unless policy says another).
    pub base: String,
    pub pr: Option<u64>,
    pub title: String,
    pub scope: StartScope,
}

/// The merge queue as admission and the snapshot see it (`queue.rs` implements it).
pub trait LandQueue: Send + Sync {
    /// Takes the branch into the queue. The reply's `runId` names the entry: a wait on it ends with the entry's
    /// result (`QueueHost::finished`). `held` while it waits or tests, `refused` with the reason when it cannot land.
    fn enqueue(&self, origin: Origin, request: LandRequest) -> Fut<'_, Result<StartReply, Fault>>;

    /// The queue as it stands, now and at each change (the snapshot's `queue`).
    fn entries(&self) -> watch::Receiver<Arc<Vec<QueueEntry>>>;
}

/// What the merge queue asks of the hub, so a batch's run goes through the same admission as every run.
// queue.rs is its first user; until it lands nothing implements this.
#[allow(dead_code)]
pub(crate) trait QueueHost: Send + Sync {
    /// Starts one run for a batch's temporary branch in lane `land`; admission decides when and where.
    fn start_batch<'a>(
        &'a self,
        repo: &'a str,
        git_ref: &'a str,
        sha: &'a str,
    ) -> Fut<'a, Result<StartReply, Fault>>;

    /// Ends with the batch run's answer (no timeout of its own; `scope` cancels it).
    fn batch_answer(&self, run: RunId, scope: Scope) -> Fut<'_, Result<Answer, Fault>>;

    /// An entry's result (`result.run_id` is the id `enqueue` answered): its waits end and its session is woken.
    fn finished(&self, result: RunResult);

    /// How git runs now (main's `gitRunner` from `checks.runners`), held to `scope`; None before main sent it or when
    /// git is not installed.
    fn git(&self, scope: Scope) -> Option<crate::git::run::Git>;

    /// The folder the queue keeps its clones and its saved state in; it survives a restart.
    fn queue_dir(&self) -> std::path::PathBuf;
}

/// The queue until `queue.rs` is built: nothing lands through it.
struct NoQueue(watch::Sender<Arc<Vec<QueueEntry>>>);

impl LandQueue for NoQueue {
    fn enqueue(
        &self,
        _origin: Origin,
        _request: LandRequest,
    ) -> Fut<'_, Result<StartReply, Fault>> {
        Box::pin(async { Err(not_built("the merge queue")) })
    }

    fn entries(&self) -> watch::Receiver<Arc<Vec<QueueEntry>>> {
        self.0.subscribe()
    }
}

/// How the hub counts places: one dispatched run. GitHub's macOS lane (`mac-dispatch`) runs one dispatched unit at a
/// time, so macOS has one place; Linux and Windows share the account's jobs, of which a branch run of a `ci.yml`
/// like this repo's takes about `RUN_JOBS`.
const RUN_JOBS: u32 = 10;
/// The account's job limit until the poller has read one.
const ACCOUNT_JOBS: u32 = 40;
/// How long a held entry waits without its owner asking; every `wait` renews it.
const LEASE_MS: u64 = 30 * 60 * 1000;
const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);
const SETTLE_EVERY: Duration = Duration::from_secs(30);
/// The answers the snapshot keeps for the board.
const ANSWERS_SHOWN: usize = 50;
/// The decisions the snapshot keeps for the board's "Decided automatically" log.
const DECISIONS_SHOWN: usize = 100;
const PAUSE_FILE: &str = "admission.json";

/// What the hub recorded of a run it started.
#[derive(Clone)]
struct Pending {
    origin: Origin,
    repo: RepoId,
    git_ref: String,
    sha: Sha,
    plan: Plan,
    /// The workflow takes a `ticket` input.
    ticketed: bool,
    digest: String,
    gate: Option<String>,
}

/// The hub's memory of its runs, behind one lock (never held across an await).
#[derive(Default)]
struct Book {
    pending: HashMap<RunId, Pending>,
    answers: HashMap<RunId, Answer>,
    /// Why a dispatch failed, by run.
    failures: HashMap<RunId, String>,
    ledgers: HashMap<RepoId, Ledger>,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    paused: bool,
}

/// Everything a hub holds; its loop holds it too.
pub struct Core {
    pub github: Arc<dyn GithubSource>,
    pub local: Arc<dyn LocalSource>,
    pub snapshot: watch::Sender<Arc<Snapshot>>,
    pub results: broadcast::Sender<RunResult>,
    /// Where `start {purpose: land}` goes once admission resolved it.
    pub queue: Arc<dyn LandQueue>,
    pub poller: Arc<Poller>,
    admission: Mutex<Admission>,
    book: Mutex<Book>,
    /// The test ledgers' folder; None keeps them in memory.
    store: Option<Store>,
    dir: Option<PathBuf>,
    key: Mutex<Option<AdmissionKey>>,
    /// Something changed that may let a held run start.
    kick: Arc<Notify>,
    /// An answer was written.
    done: Notify,
    ids: AtomicU64,
}

/// The real hub.
pub struct Hub {
    core: Arc<Core>,
    tasks: Mutex<Vec<AbortHandle>>,
}

impl std::ops::Deref for Hub {
    type Target = Core;
    fn deref(&self) -> &Core {
        &self.core
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        for task in locked(&self.tasks).drain(..) {
            task.abort();
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn source_fault(error: super::sources::SourceError) -> Fault {
    Fault::new("checks_source", error.message)
}

fn short(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}

impl Hub {
    /// Over the sources given (fakes in a test). Nothing runs on its own: a test calls `settle` and `pump`.
    pub fn new(github: Arc<dyn GithubSource>, local: Arc<dyn LocalSource>) -> Hub {
        let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(clock::now_ms())));
        let poller = Poller::new(Arc::clone(&github), Arc::clone(&local), snapshot.clone());
        Hub::build(github, local, poller, snapshot, None)
    }

    /// Over the person's gh and git and this computer's pool; its state (the owner's pause, the test ledgers) in
    /// `dir`. Its poller's rounds and its own loop start at once.
    pub fn real(dir: Option<PathBuf>) -> Hub {
        let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(clock::now_ms())));
        let poller = Poller::real(snapshot.clone());
        let rounds = poller.start();
        let hub = Hub::build(poller.github(), poller.local(), poller, snapshot, dir);
        locked(&hub.tasks).push(rounds);
        let run = hub.run();
        locked(&hub.tasks).push(run);
        hub
    }

    fn build(
        github: Arc<dyn GithubSource>,
        local: Arc<dyn LocalSource>,
        poller: Arc<Poller>,
        snapshot: watch::Sender<Arc<Snapshot>>,
        dir: Option<PathBuf>,
    ) -> Hub {
        let saved: Saved = dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join(PAUSE_FILE)).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let (limits, account, _) = places(&snapshot.borrow(), &HashMap::new());
        let mut admission = Admission::new(limits, account, LEASE_MS);
        admission.pause(saved.paused);
        snapshot.send_modify(|current| {
            let mut next = Snapshot::clone(current);
            next.paused = saved.paused;
            *current = Arc::new(next);
        });
        Hub {
            core: Arc::new(Core {
                github,
                local,
                snapshot,
                results: broadcast::Sender::new(RESULTS_KEPT),
                // The merge queue's part replaces this one line with its own queue (`queue::open(host)`).
                queue: Arc::new(NoQueue(watch::Sender::new(Arc::default()))),
                poller,
                admission: Mutex::new(admission),
                book: Mutex::default(),
                store: dir.as_ref().map(|dir| Store::new(dir.join("results"))),
                dir,
                key: Mutex::new(None),
                kick: Arc::new(Notify::new()),
                done: Notify::new(),
                ids: AtomicU64::new(0),
            }),
            tasks: Mutex::default(),
        }
    }

    /// The owner's admission key, from main (the keychain); None: dispatches carry no ticket.
    pub fn set_key(&self, key: Option<AdmissionKey>) {
        *locked(&self.key) = key;
    }

    /// The hub's loop: at each change the poller saw, at each start and every `SETTLE_EVERY`, it frees the places of
    /// runs that ended, answers them, reaps lapsed leases and admits what may start.
    pub fn run(&self) -> AbortHandle {
        let core = Arc::downgrade(&self.core);
        let kick = Arc::clone(&self.kick);
        let mut changes = self.poller.changes();
        tokio::spawn(async move {
            loop {
                {
                    let Some(core) = core.upgrade() else {
                        return;
                    };
                    for (id, run) in core.settle() {
                        core.judge(&id, &run).await;
                    }
                    core.pump().await;
                }
                tokio::select! {
                    changed = changes.changed() => if changed.is_err() { return },
                    () = kick.notified() => {}
                    () = clock::sleep(SETTLE_EVERY) => {}
                }
            }
        })
        .abort_handle()
    }
}

/// The places of GitHub's pools in runs, and the runs nobody started through this hub that hold them.
fn places(
    snapshot: &Snapshot,
    ours: &HashMap<RunId, Pending>,
) -> (BTreeMap<String, Limit>, u32, BTreeMap<String, u32>) {
    let jobs = snapshot
        .pools
        .iter()
        .find(|pool| pool.id == policy::HOSTED_POOL)
        .map_or(ACCOUNT_JOBS, |pool| pool.limit);
    let hosted = (jobs / RUN_JOBS).max(1);
    let limits = BTreeMap::from([
        (
            policy::MACOS_POOL.to_owned(),
            Limit {
                places: 1,
                hosted: true,
            },
        ),
        (
            policy::HOSTED_POOL.to_owned(),
            Limit {
                places: hosted,
                hosted: true,
            },
        ),
    ]);
    let mut outside = BTreeMap::new();
    for run in &snapshot.runs {
        if ours.contains_key(&run.id) || run.verdict.is_some() {
            continue;
        }
        let live = |pool: &str| {
            run.jobs.iter().any(|job| {
                job.pool == pool
                    && matches!(
                        job.state,
                        JobState::Held | JobState::Queued | JobState::Running
                    )
            })
        };
        let pool = if live(policy::MACOS_POOL) {
            policy::MACOS_POOL
        } else if live("github-linux") || live("github-windows") {
            policy::HOSTED_POOL
        } else {
            continue;
        };
        *outside.entry(pool.to_owned()).or_insert(0) += 1;
    }
    (limits, hosted + 1, outside)
}

impl Core {
    fn next_id(&self) -> RunId {
        let n = self.ids.fetch_add(1, Ordering::Relaxed);
        format!("chk-{:x}-{n}", clock::now_ms())
    }

    /// Frees the places of the hub's runs the poller saw end and reaps lapsed leases (whose owners are answered).
    /// Returns the runs that ended green or red, to answer.
    fn settle(&self) -> Vec<(RunId, super::contract::Run)> {
        let now = clock::now_ms();
        let snapshot = Arc::clone(&self.snapshot.borrow());
        let book = locked(&self.book);
        let (limits, account, outside) = places(&snapshot, &book.pending);
        let mut ended = Vec::new();
        let gone = {
            let mut admission = locked(&self.admission);
            admission.set_pools(limits, account, outside);
            for run in &snapshot.runs {
                let Some(verdict) = run.verdict else {
                    continue;
                };
                match admission.entry(&run.id).map(|entry| entry.stage) {
                    Some(Stage::Running) => {
                        admission.run_ended(&run.id, verdict == RunVerdict::Green);
                        ended.push((run.id.clone(), run.clone()));
                    }
                    Some(Stage::Cancelling) => admission.cancel_landed(&run.id),
                    _ => {}
                }
            }
            admission.reap(now)
        };
        drop(book);
        for id in gone {
            self.finish(
                &id,
                answer::unknown(
                    &id,
                    now,
                    Next::Wait,
                    "it waited in OMPdesk's queue past its lease, with no wait renewing it: start it again".into(),
                ),
            );
        }
        ended
    }

    /// Admits what may start, one dispatch at a time.
    async fn pump(&self) {
        while admission::pump(&self.admission, clock::now_ms(), |ask| self.dispatch(ask))
            .await
            .is_some()
        {}
    }

    /// Sends one admitted run's dispatch; its place is already in the ledger (A2). Its claim goes to the poller first,
    /// so the run GitHub then shows is known as this one.
    async fn dispatch(&self, ask: Ask) -> bool {
        let Some(pending) = locked(&self.book).pending.get(&ask.id).cloned() else {
            return false;
        };
        let now = clock::now_ms();
        self.poller.expect(Expected {
            repo: pending.repo.clone(),
            workflow: pending.plan.workflow.clone(),
            git_ref: pending.git_ref.clone(),
            after: now,
            claim: Claim {
                run_id: ask.id.clone(),
                origin: pending.origin.clone(),
                lane: ask.lane,
                gate: pending.gate.clone(),
                digest: pending.digest.clone(),
            },
        });
        let mut inputs = pending.plan.inputs.clone();
        if pending.ticketed
            && pending.plan.macos
            && let Some(key) = locked(&self.key).clone()
        {
            let expires = now.saturating_add(ticket::TICKET_TTL_MS);
            inputs.insert(
                "ticket".into(),
                ticket::mint(&key, &pending.repo, &pending.git_ref, &pending.sha, expires),
            );
        }
        let sent = self
            .github
            .dispatch(&Dispatch {
                repo: pending.repo.clone(),
                workflow: pending.plan.workflow.clone(),
                git_ref: pending.git_ref.clone(),
                inputs,
            })
            .await;
        match sent {
            Ok(()) => {
                self.poller.nudge(&pending.repo);
                true
            }
            Err(error) => {
                locked(&self.book).failures.insert(ask.id, error.message);
                false
            }
        }
    }

    /// One line of the "Decided automatically" log (the newest `DECISIONS_SHOWN`).
    fn decide(
        &self,
        policy: &str,
        run: &str,
        action: PolicyAction,
        reason: String,
        why: DecisionWhy,
    ) {
        let decision = Decision {
            policy: policy.into(),
            run: run.into(),
            action,
            reason,
            why,
            at: clock::now_ms(),
        };
        self.snapshot.send_modify(|current| {
            let mut next = Snapshot::clone(current);
            next.decisions.push(decision);
            let over = next.decisions.len().saturating_sub(DECISIONS_SHOWN);
            next.decisions.drain(..over);
            *current = Arc::new(next);
        });
    }

    /// Keeps a run's answer, tells every subscriber (main wakes the session that started it) and the board.
    fn finish(&self, id: &str, answer: Answer) {
        let origin = {
            let mut book = locked(&self.book);
            if book.answers.contains_key(id) {
                return;
            }
            book.answers.insert(id.to_owned(), answer.clone());
            book.pending
                .get(id)
                .map_or(Origin::Person, |pending| pending.origin.clone())
        };
        let result = RunResult {
            run_id: id.to_owned(),
            origin,
            answer,
        };
        let _ = self.results.send(result.clone());
        self.snapshot.send_modify(|current| {
            let mut next = Snapshot::clone(current);
            next.answers.retain(|kept| kept.run_id != result.run_id);
            next.answers.push(result);
            let over = next.answers.len().saturating_sub(ANSWERS_SHOWN);
            next.answers.drain(..over);
            *current = Arc::new(next);
        });
        self.done.notify_waiters();
    }

    fn answered(&self, id: &str) -> Option<Answer> {
        locked(&self.book).answers.get(id).cloned()
    }

    /// The answer of a run the poller saw end: read once, judged into its repository's ledger, kept.
    async fn judge(&self, id: &str, run: &super::contract::Run) -> Answer {
        if let Some(answer) = self.answered(id) {
            return answer;
        }
        let now = clock::now_ms();
        let Some((repo, github_run)) = self.poller.github_of(id) else {
            return answer::unknown(
                id,
                now,
                Next::Wait,
                format!("GitHub's run for {id} is not known yet"),
            );
        };
        if let Some((as_of, false)) = self.poller.confirmed(&repo, github_run) {
            let why = self.poller.trouble().map_or_else(
                || "not read again in time".to_owned(),
                |trouble| trouble.message,
            );
            return answer::unknown(
                id,
                now,
                Next::Wait,
                format!(
                    "GitHub's facts are stale (last read at {as_of}): {why}; never green from old data"
                ),
            );
        }
        let since = run
            .jobs
            .iter()
            .map(|job| job.queued_at)
            .min()
            .unwrap_or(now)
            .saturating_sub(60_000);
        let fetched = match answer::fetch(&*self.github, &repo, github_run, since).await {
            Ok(fetched) => fetched,
            Err(error) => {
                return answer::unknown(
                    id,
                    now,
                    Next::Wait,
                    format!("its results could not be read: {}", error.message),
                );
            }
        };
        let judged = {
            let mut book = locked(&self.book);
            let pending = book.pending.get(id).cloned();
            let mut ledger = book.ledgers.remove(&repo).unwrap_or_else(|| {
                self.store
                    .as_ref()
                    .map_or_else(Ledger::default, |store| store.load(&repo))
            });
            let answer = answer::judge(
                &mut ledger,
                &fetched,
                &Judged {
                    run_id: id,
                    digest: pending
                        .as_ref()
                        .map_or("", |pending| pending.digest.as_str()),
                    by: pending.as_ref().map(|pending| &pending.origin),
                    gate: pending.as_ref().and_then(|pending| pending.gate.as_ref()),
                    now,
                },
            );
            if let Some(store) = &self.store {
                // A ledger that cannot be saved stays in memory; the next save tries again.
                let _ = store.save(&repo, &ledger);
            }
            book.ledgers.insert(repo, ledger);
            answer
        };
        match judged {
            Some(answer) => {
                self.finish(id, answer);
                self.answered(id).unwrap_or_else(|| {
                    answer::unknown(id, now, Next::Wait, "no answer kept".into())
                })
            }
            None => self.answered(id).unwrap_or_else(|| {
                answer::unknown(
                    id,
                    now,
                    Next::Wait,
                    "this attempt was judged before OMPdesk restarted; its answer was not kept"
                        .into(),
                )
            }),
        }
    }

    /// Why a run of the hub's will not end by itself, if it will not: it never reached GitHub.
    fn over_before_github(&self, id: &str) -> Option<String> {
        let stage = locked(&self.admission).entry(id).map(|entry| entry.stage)?;
        match stage {
            Stage::Over(Ended::Failed) => Some(locked(&self.book).failures.get(id).map_or_else(
                || "its dispatch failed".to_owned(),
                |why| format!("its dispatch failed: {why}"),
            )),
            Stage::Over(Ended::Refused) => Some("it was refused".into()),
            Stage::Over(Ended::Expired) => Some("it waited past its lease: start it again".into()),
            Stage::Over(Ended::Cancelled) if locked(&self.admission).entry(id).is_some() => Some(
                "a newer start of the same branch and workflow replaced it before it ran".into(),
            ),
            _ => None,
        }
    }

    /// Ends with the run's answer, however long that takes; the caller bounds it.
    async fn answer_of(&self, id: &str) -> Answer {
        loop {
            if let Some(answer) = self.answered(id) {
                return answer;
            }
            if let Some(why) = self.over_before_github(id) {
                let answer = answer::unknown(id, clock::now_ms(), Next::Wait, why);
                self.finish(id, answer);
                continue;
            }
            let done = self.done.notified();
            tokio::select! {
                run = self.poller.ended(id) => return self.judge(id, &run).await,
                () = done => {}
            }
        }
    }

    async fn rerun(
        &self,
        origin: &Origin,
        repo: &str,
        git_ref: &str,
        sha: &str,
    ) -> Result<StartReply, Fault> {
        let last = {
            let book = locked(&self.book);
            book.pending
                .iter()
                .filter(|(id, pending)| {
                    &pending.origin == origin
                        && pending.repo == repo
                        && pending.git_ref == git_ref
                        && pending.sha == sha
                        && book
                            .answers
                            .get(*id)
                            .is_some_and(|answer| answer.next == Next::RerunFailed)
                })
                .map(|(id, _)| id.clone())
                .max()
        };
        let refused = |reason: String| StartReply {
            run_id: None,
            decision: StartDecision::Refused,
            placement: None,
            expected_start_min: None,
            reason,
        };
        let Some(id) = last else {
            return Ok(refused(format!(
                "no run of yours on {git_ref} at {} may be rerun (a red run whose answer says rerun-failed)",
                short(sha)
            )));
        };
        let Some((repo, run)) = self.poller.github_of(&id) else {
            return Ok(refused(format!("GitHub's run for {id} is not known")));
        };
        self.github
            .rerun_failed(&repo, run)
            .await
            .map_err(source_fault)?;
        locked(&self.book).answers.remove(&id);
        self.poller.nudge(&repo);
        Ok(StartReply {
            run_id: Some(id.clone()),
            decision: StartDecision::Started,
            placement: Some(Where::GithubHosted),
            expected_start_min: None,
            reason: format!("the failed jobs of {id} run again; wait on {id}"),
        })
    }

    async fn start(&self, origin: Origin, request: StartRequest) -> Result<StartReply, Fault> {
        let refuse = |reason: String| {
            Ok(StartReply {
                run_id: None,
                decision: StartDecision::Refused,
                placement: None,
                expected_start_min: None,
                reason,
            })
        };
        if locked(&self.admission).paused() {
            return refuse("paused by the owner".into());
        }
        let checkout = match (&request.repo, &request.git_ref, &request.cwd) {
            (Some(_), Some(_), _) | (_, _, None) => None,
            (_, _, Some(cwd)) => self.github.checkout(cwd).await.map_err(source_fault)?,
        };
        let Some(repo) = request
            .repo
            .clone()
            .or_else(|| checkout.as_ref().map(|checkout| checkout.repo.clone()))
        else {
            return refuse(
                "no repository: the folder is not a GitHub checkout, so name one (repo)".into(),
            );
        };
        let Some(git_ref) = request
            .git_ref
            .clone()
            .or_else(|| checkout.as_ref().map(|checkout| checkout.branch.clone()))
            .filter(|branch| !branch.is_empty())
        else {
            return refuse("no branch: the folder is on none, so name one (ref)".into());
        };
        let Some(sha) = self
            .github
            .head(&repo, &git_ref)
            .await
            .map_err(source_fault)?
        else {
            return refuse(format!("{git_ref} is not pushed to {repo}: push it first"));
        };
        if request.rerun == Some(Rerun::Failed) {
            return self.rerun(&origin, &repo, &git_ref, &sha).await;
        }
        if request.purpose == Purpose::Land && request.workflow.is_none() {
            return self
                .queue
                .enqueue(
                    origin,
                    LandRequest {
                        repo,
                        branch: git_ref.clone(),
                        sha,
                        base: "main".into(),
                        pr: None,
                        title: git_ref,
                        scope: request.scope,
                    },
                )
                .await;
        }
        let choice = match &request.workflow {
            Some(named) => policy::named(named),
            None => {
                let file = self
                    .github
                    .file(&repo, &sha, policy::REPO_FILE)
                    .await
                    .map_err(source_fault)?;
                match policy::choose(request.purpose, file.as_deref()) {
                    Ok(choice) => choice,
                    Err(why) => return refuse(why),
                }
            }
        };
        let path = format!(".github/workflows/{}", choice.workflow);
        let Some(text) = self
            .github
            .file(&repo, &sha, &path)
            .await
            .map_err(source_fault)?
        else {
            return refuse(format!(
                "{} is not in {repo} at {}",
                choice.workflow,
                short(&sha)
            ));
        };
        let declared = policy::dispatch_inputs(&text);
        let ticketed = declared
            .as_ref()
            .is_some_and(|names| names.contains("ticket"));
        let plan = match policy::fit(choice, declared) {
            Ok(plan) => plan,
            Err(why) => return refuse(why),
        };
        let mac_refs = if plan.macos {
            self.github
                .variable(&repo, "MAC_REFS")
                .await
                .map_err(source_fault)?
                .unwrap_or_default()
        } else {
            String::new()
        };
        if plan.macos && !policy::listed(&git_ref, &mac_refs) {
            return refuse(format!(
                "{git_ref} is not in MAC_REFS ({}): macOS runners are for main and release-bound branches; Main adds a branch with gh variable set MAC_REFS",
                if mac_refs.is_empty() {
                    "empty"
                } else {
                    &mac_refs
                }
            ));
        }
        let lane = policy::lane(
            request.purpose,
            request.workflow.is_some(),
            plan.macos,
            &git_ref,
            &mac_refs,
        );
        let digest = policy::digest(&sha, &text, &plan.inputs);
        let id = self.next_id();
        let pool = policy::pool(plan.macos);
        let workflow = plan.workflow.clone();
        locked(&self.book).pending.insert(
            id.clone(),
            Pending {
                origin: origin.clone(),
                repo: repo.clone(),
                git_ref: git_ref.clone(),
                sha,
                plan,
                ticketed,
                digest: digest.clone(),
                gate: (lane == Lane::Release).then(|| format!("release {workflow}")),
            },
        );
        let now = clock::now_ms();
        let started = locked(&self.admission).start(
            Ask {
                id: id.clone(),
                origin,
                lane,
                pool: pool.into(),
                key: Key {
                    repo: repo.clone(),
                    git_ref: git_ref.clone(),
                    workflow: workflow.clone(),
                },
                digest,
                governed: true,
            },
            now,
        );
        for old in &started.superseded {
            self.decide(
                "cancel-superseded",
                old,
                PolicyAction::CancelSuperseded,
                format!("{id} is a newer run of the same ref and workflow"),
                DecisionWhy {
                    run: Some(id.clone()),
                    ..DecisionWhy::new(WhyCode::NewerRun)
                },
            );
        }
        for old in &started.cancel {
            if let Some((repo, run)) = self.poller.github_of(old) {
                // A cancel that fails leaves the old run going; the poller still sees it end.
                let _ = self.github.cancel(&repo, run).await;
                self.poller.nudge(&repo);
            }
        }
        let replaced = if started.superseded.is_empty() {
            String::new()
        } else {
            format!("; it replaces {}", started.superseded.join(", "))
        };
        match (started.stage, started.reused_from) {
            (Stage::Over(Ended::Refused), _) => {
                locked(&self.book).pending.remove(&id);
                return refuse("paused by the owner".into());
            }
            (Stage::Over(Ended::Reused), Some(from)) => {
                let green = self.answered(&from);
                let answer = match &green {
                    Some(green) => answer::reused(&id, green, &from, 0, now),
                    None => answer::unknown(&id, now, Next::Wait, format!("{from} was green")),
                };
                self.decide(
                    "reuse-green",
                    &id,
                    PolicyAction::Reuse,
                    format!("{from} ran the same commit, workflow and inputs green"),
                    DecisionWhy {
                        run: Some(from.clone()),
                        ..DecisionWhy::new(WhyCode::GreenOnSameInputs)
                    },
                );
                self.finish(&id, answer);
                return Ok(StartReply {
                    run_id: Some(id),
                    decision: StartDecision::Reused,
                    placement: None,
                    expected_start_min: None,
                    reason: format!(
                        "{from} ran the same commit, workflow and inputs green: nothing runs"
                    ),
                });
            }
            _ => {}
        }
        self.pump().await;
        self.kick.notify_one();
        let stage = locked(&self.admission).entry(&id).map(|entry| entry.stage);
        let reply = |decision, reason: String| {
            Ok(StartReply {
                run_id: Some(id.clone()),
                decision,
                placement: Some(Where::GithubHosted),
                expected_start_min: None,
                reason,
            })
        };
        match stage {
            Some(Stage::Dispatching | Stage::Running) => reply(
                StartDecision::Started,
                format!(
                    "dispatched {workflow} on {git_ref} ({lane} lane){replaced}",
                    lane = lane.word()
                ),
            ),
            Some(Stage::Held) => {
                let (running, limit) = locked(&self.admission).load(pool);
                let full = running >= limit;
                self.decide(
                    if full {
                        "wait-when-full"
                    } else {
                        "release-first"
                    },
                    &id,
                    PolicyAction::Hold,
                    if full {
                        format!("{pool} is full ({running} of {limit})")
                    } else {
                        "a release run ahead holds the account's last place".to_owned()
                    },
                    DecisionWhy {
                        pool: Some(pool.into()),
                        running: Some(running),
                        limit: Some(limit),
                        ..DecisionWhy::new(if full {
                            WhyCode::PoolFull
                        } else {
                            WhyCode::ReleaseAhead
                        })
                    },
                );
                reply(
                    StartDecision::Held,
                    format!(
                        "{pool} has no free place: held in OMPdesk's queue ({lane} lane) and dispatched when one frees{replaced}",
                        lane = lane.word()
                    ),
                )
            }
            _ => Ok(StartReply {
                run_id: Some(id.clone()),
                decision: StartDecision::Refused,
                placement: None,
                expected_start_min: None,
                reason: self
                    .over_before_github(&id)
                    .unwrap_or_else(|| "it could not be dispatched".into()),
            }),
        }
    }

    async fn wait(&self, request: WaitRequest, scope: Scope) -> Result<Answer, Fault> {
        let id = request.run_id;
        let seconds = request
            .timeout_seconds
            .unwrap_or(super::contract::WAIT_DEFAULT_SECONDS)
            .clamp(1, super::contract::WAIT_MAX_SECONDS);
        let deadline = clock::sleep(Duration::from_secs(seconds));
        tokio::pin!(deadline);
        let timed_out = |note: String| answer::unknown(&id, clock::now_ms(), Next::Wait, note);
        if request.until == Until::Any {
            if let Some(answer) = self.answered(&id) {
                return Ok(answer);
            }
            let mut changes = self.poller.changes();
            tokio::select! {
                _ = changes.changed() => {}
                () = self.done.notified() => {}
                () = &mut deadline => {}
                () = scope.on_cancel() => return Err(Fault::new("cancelled", "the wait was cancelled")),
            }
            return Ok(self.answered(&id).unwrap_or_else(|| {
                timed_out("the run changed, or the time ran out: status shows it, wait again for the result".into())
            }));
        }
        let answer = self.answer_of(&id);
        tokio::pin!(answer);
        loop {
            tokio::select! {
                answer = &mut answer => return Ok(answer),
                () = &mut deadline => {
                    return Ok(timed_out(format!("no result within {seconds} s: wait again")));
                }
                () = scope.on_cancel() => return Err(Fault::new("cancelled", "the wait was cancelled")),
                () = clock::sleep(HEARTBEAT_EVERY) => {
                    // The owner is still asking: a held entry keeps its place in line.
                    locked(&self.admission).heartbeat(&id, clock::now_ms());
                }
            }
        }
    }

    fn pause(&self, paused: bool) -> Result<(), Fault> {
        locked(&self.admission).pause(paused);
        if let Some(dir) = &self.dir {
            let bytes = serde_json::to_vec(&Saved { paused }).unwrap_or_default();
            crate::disk::saves::write_kept(&dir.join(PAUSE_FILE), &bytes, Some(0o600), 0o700)?;
        }
        self.snapshot.send_modify(|current| {
            let mut next = Snapshot::clone(current);
            next.paused = paused;
            *current = Arc::new(next);
        });
        self.kick.notify_one();
        Ok(())
    }
}

impl ChecksHub for Hub {
    fn start(&self, origin: Origin, request: StartRequest) -> Fut<'_, Result<StartReply, Fault>> {
        Box::pin(self.core.start(origin, request))
    }

    fn wait(
        &self,
        _origin: Origin,
        request: WaitRequest,
        scope: Scope,
    ) -> Fut<'_, Result<Answer, Fault>> {
        Box::pin(self.core.wait(request, scope))
    }

    fn status(&self, origin: Origin, request: StatusRequest) -> Fut<'_, Result<Snapshot, Fault>> {
        Box::pin(super::poller::status(
            &*self.github,
            &self.snapshot,
            origin,
            request,
        ))
    }

    fn watch(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.snapshot.subscribe()
    }

    fn results(&self) -> broadcast::Receiver<RunResult> {
        self.results.subscribe()
    }

    fn pause(&self, paused: bool) -> Fut<'_, Result<(), Fault>> {
        let done = self.core.pause(paused);
        Box::pin(async move { done })
    }

    fn told(&self, fact: MainFact) -> Fut<'_, Result<(), Fault>> {
        self.poller.told(fact);
        Box::pin(async { Ok(()) })
    }

    fn runners(&self, runners: Runners) -> Fut<'_, Result<(), Fault>> {
        self.poller.runners(runners);
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;
