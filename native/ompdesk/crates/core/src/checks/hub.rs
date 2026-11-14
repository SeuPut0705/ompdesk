//! `ChecksHub`: the one deep module of check control. Three calls (`start`, `wait`, `status`), one read-only stream for
//! screens (`watch`) and the owner's one control (`pause`). Everything else is behind it.
//!
//! `Hub` is the real one: the poller (`poller.rs`) reads the facts, `policy.rs` decides what a start dispatches,
//! `admission.rs` decides when, `ticket.rs` signs the dispatch and `answer.rs` writes the result. One loop per hub
//! (`Hub::run`) wakes on the poller's changes, frees the places of runs that ended, reaps lapsed leases and admits
//! what may start. The seams to the merge queue are here too: `LandQueue` and `QueueHost`.

use std::collections::{BTreeMap, HashMap, HashSet};
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
    Answer, AnswerVerdict, Decision, DecisionWhy, DeviceId, JobState, Lane, LocalRunAsk, MainFact,
    Next, Note, NoteCode, Origin, PolicyAction, Purpose, QueueEntry, RemoteRun, RepoId, Rerun,
    RunId, RunResult, Sha, Snapshot, StartDecision, StartReply, StartRequest, StartScope,
    StatusRequest, Until, WaitRequest, Where, WhyCode, WorkflowAsk,
};
use super::local_run::LocalRunner;
use super::policy::{self, Plan};
use super::poller::Poller;
use super::poller::provenance::{Claim, GithubBinding};
use super::results::ledger::Ledger;
use super::results::store::Store;
use super::sources::{Dispatch, GithubSource, LocalPool, LocalSource, WriteError};
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
    /// The same opaque identity for live events and persisted replay.
    fn delivery_id(&self, result: &RunResult) -> String;

    fn notifications(&self) -> Vec<(String, RunResult)>;
    fn acknowledge<'a>(&'a self, delivery_id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>>;

    /// The owner's switch: while paused every start is refused with "paused by the owner".
    fn pause(&self, paused: bool) -> Fut<'_, Result<(), Fault>>;

    /// What main knows and the hub cannot read itself.
    fn told(&self, fact: MainFact) -> Fut<'_, Result<(), Fault>>;

    /// How gh and git run from now on.
    fn runners(&self, runners: Runners) -> Fut<'_, Result<(), Fault>>;

    /// This computer's own pool as its poller reads it (device `local`): what a paired computer forwards to another
    /// hub as `MainFact::DevicePool`, so the mapping of `ompdesk heavy status` stays in one place.
    fn local_pool(&self) -> Fut<'_, Result<LocalPool, Fault>>;

    /// Runs a check on this computer through `ompdesk check` for another hub that placed it here; ends with its
    /// answer, or a fault when it could not start (that hub then runs it on GitHub).
    fn run_local(&self, ask: LocalRunAsk, scope: Scope) -> Fut<'_, Result<Answer, Fault>>;

    /// Every check this hub placed on a paired computer, for main to send over the link.
    fn remote_runs(&self) -> broadcast::Receiver<RemoteRun>;

    /// What the paired computer answered for a `RemoteRun`, or why it gave no answer.
    fn remote_answer(
        &self,
        id: RunId,
        answer: Result<Answer, String>,
    ) -> Fut<'_, Result<(), Fault>>;
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

    /// The hub closes: every lane ends at its next turn and cancels the steps it started (a batch's wait on the hub
    /// included), and nothing is taken any more. Called by `Hub::drop`, because a step under way holds the hub's core,
    /// which owns the queue, so the queue's own drop would wait on that step.
    fn stop(&self);
}

/// What the merge queue asks of the hub, so a batch's run goes through the same admission as every run. The hub's
/// own is `Host`, which `queue::open(host)` takes.
// queue.rs is its first user; until it lands only the tests call it.
#[allow(dead_code)]
pub(crate) trait QueueHost: Send + Sync {
    /// Starts one run for a batch's temporary branch in lane `land`; admission decides when and where.
    fn start_batch<'a>(
        &'a self,
        repo: &'a str,
        git_ref: &'a str,
        sha: &'a str,
        effect_id: &'a str,
    ) -> Fut<'a, Result<StartReply, Fault>>;

    /// Ends with the batch run's kept answer (no timeout of its own; `scope` cancels it). An `unknown` answer is
    /// final: the run never reached GitHub, or its result could not be read in `JUDGE_TRIES`. Waiting renews the held
    /// entry's lease.
    fn batch_answer(&self, run: RunId, scope: Scope) -> Fut<'_, Result<Answer, Fault>>;

    /// The owner paused admission: a refused batch start is tried again once it resumes.
    fn paused(&self) -> bool;

    /// An entry's result (`result.run_id` is the id `enqueue` answered): its waits end and its session is woken.
    fn finished(&self, result: RunResult, scope: Scope) -> Fut<'_, Result<(), Fault>>;

    /// The durable Drop outbox has removed the branch: this effect can no longer replay Test.
    fn forget_batch<'a>(&'a self, effect_id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>>;

    fn forget_answer<'a>(&'a self, id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>>;

    /// How git runs now (main's `gitRunner` from `checks.runners`), held to `scope`; None before main sent it or when
    /// git is not installed.
    fn git(&self, scope: Scope) -> Option<crate::git::run::Git>;

    /// The folder the queue keeps its clones and its saved state in; it survives a restart.
    fn queue_dir(&self) -> std::path::PathBuf;
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
/// The passes an ended run's answer is tried before it is answered unknown (20 passes of `SETTLE_EVERY`: 10 min).
const JUDGE_TRIES: u32 = 20;
/// The answers the snapshot keeps for the board.
const ANSWERS_SHOWN: usize = 50;
/// The decisions the snapshot keeps for the board's "Decided automatically" log.
const DECISIONS_SHOWN: usize = 100;
/// How often the Tests and cost tab is built again when no ledger changed (the day's queue peaks, the week's window).
const TRENDS_EVERY_MS: u64 = 5 * 60 * 1000;
const PAUSE_FILE: &str = "admission.json";
/// The hub's journal: the decisions and answers the board shows and the adoption counts (design §7.5), kept across a
/// restart, bounded by `DECISIONS_SHOWN` and `ANSWERS_SHOWN`.
const JOURNAL_FILE: &str = "journal.json";
/// The (session, repo, commit) a session was last told not green about, kept to tell a wrong green.
const NOT_GREEN_KEPT: usize = 200;

/// What the hub recorded of a run it started.
#[derive(Clone, Serialize, Deserialize)]
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
    /// GitHub's run whose failed jobs this entry runs again, instead of a dispatch.
    rerun_of: Option<u64>,
    #[serde(default)]
    rerun_attempt: Option<u32>,
}

/// The hub's memory of its runs, behind one lock (never held across an await).
#[derive(Default)]
struct Book {
    pending: HashMap<RunId, Pending>,
    answers: HashMap<RunId, Answer>,
    /// Why a dispatch failed, by run.
    failures: HashMap<RunId, String>,
    ledgers: HashMap<RepoId, Ledger>,
    /// Runs that ended but whose answer could not be read yet (GitHub unreadable, facts stale, the run not bound):
    /// judged again on every pass, with how many tries they had.
    unjudged: HashMap<RunId, (super::contract::Run, u32)>,
    /// A session was answered red or unknown for this commit of this repository and not green since: its `start
    /// {purpose: land}` of that commit is a wrong green (it went on as if the check had passed). Oldest first.
    not_green: Vec<NotGreen>,
    /// Runs placement put on a computer, until that computer answered or the run went to GitHub instead
    /// (`hub_local.rs`): what a fall back admits, and where it was.
    away: HashMap<RunId, (Pending, Lane, DeviceId)>,
    bindings: HashMap<RunId, GithubBinding>,
    batches: HashMap<String, BatchReceipt>,
    delivered: HashMap<RunId, RunResult>,
    notifications: HashMap<String, RunResult>,
}

/// One (session, repo, commit) a session was answered not green about.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct NotGreen {
    session: String,
    repo: RepoId,
    sha: Sha,
}

#[derive(Clone, Serialize, Deserialize)]
struct BatchReceipt {
    id: RunId,
    repo: RepoId,
    git_ref: String,
    sha: Sha,
    reply: Option<StartReply>,
}

/// What the journal keeps.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Journal {
    delivery_source: String,
    decisions: Vec<Decision>,
    answers: Vec<RunResult>,
    adoption: super::contract::Adoption,
    not_green: Vec<NotGreen>,
    pending: HashMap<RunId, Pending>,
    failures: HashMap<RunId, String>,
    bindings: HashMap<RunId, GithubBinding>,
    batches: HashMap<String, BatchReceipt>,
    delivered: HashMap<RunId, RunResult>,
    notifications: HashMap<String, RunResult>,
    admission: Option<Admission>,
    next_id: u64,
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
    /// Where the merge queue keeps its clones and lanes: `<dir>/queue`, or, for a hub with no state folder (a
    /// test's), a folder of its own that goes with the hub, so no two such hubs share saved lanes.
    queue_dir: PathBuf,
    key: Mutex<Option<AdmissionKey>>,
    /// How git runs (main's `gitRunner`), for the merge queue's clones.
    git: Mutex<Option<Runner>>,
    /// Something changed that may let a held run start.
    kick: Arc<Notify>,
    /// An answer was written.
    done: Notify,
    ids: AtomicU64,
    /// When the Tests and cost tab was last built; 0 when a ledger changed since.
    trends_at: AtomicU64,
    /// How a check runs on this computer (`local_run.rs`).
    runner: Arc<dyn LocalRunner>,
    /// Checks placed on a paired computer, for main to send over the link (`checks.remoteRun`).
    remote: broadcast::Sender<RemoteRun>,
    /// Itself, for the task a check placed on this computer runs in.
    me: std::sync::Weak<Core>,
    stop: Scope,
    /// Serializes journal snapshots and atomic writes; an older snapshot can never overwrite a newer one.
    journal_write: Mutex<()>,
    /// Serializes replayable batch creation until its durable receipt exists.
    batch_start: tokio::sync::Mutex<()>,
    journal_error: Option<String>,
    /// Journal-scoped random identity: local entry counters from different hubs cannot deduplicate each other.
    delivery_source: String,
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
        self.core.stop.cancel();
        self.core.queue.stop();
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
        Hub::build(
            github,
            local,
            poller,
            snapshot,
            None,
            Some(Arc::new(super::local_run::Unavailable)),
        )
    }

    /// `new`, with a runner of checks placed on this computer.
    #[cfg(test)]
    pub fn with_runner(
        github: Arc<dyn GithubSource>,
        local: Arc<dyn LocalSource>,
        runner: Arc<dyn LocalRunner>,
    ) -> Hub {
        let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(clock::now_ms())));
        let poller = Poller::new(Arc::clone(&github), Arc::clone(&local), snapshot.clone());
        Hub::build(github, local, poller, snapshot, None, Some(runner))
    }

    /// Over the person's gh and git and this computer's pool; its state (the owner's pause, the test ledgers) in
    /// `dir`. Its poller's rounds and its own loop start at once.
    pub fn real(dir: Option<PathBuf>) -> Hub {
        let snapshot = watch::Sender::new(Arc::new(Snapshot::empty(clock::now_ms())));
        let poller = Poller::real(snapshot.clone());
        let rounds = poller.start();
        let hub = Hub::build(poller.github(), poller.local(), poller, snapshot, dir, None);
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
        // None: `ompdesk check` in the hub's own checkouts, with git as main hands it over.
        runner: Option<Arc<dyn LocalRunner>>,
    ) -> Hub {
        let saved: Saved = dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join(PAUSE_FILE)).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let (limits, account, _) = places(&snapshot.borrow(), &HashMap::new());
        let mut admission = Admission::new(limits, account, LEASE_MS);
        admission.pause(saved.paused);
        let (journal, journal_error): (Journal, _) = match dir
            .as_ref()
            .map(|dir| std::fs::read(dir.join(JOURNAL_FILE)))
        {
            None => (Journal::default(), None),
            Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                (Journal::default(), None)
            }
            Some(Ok(bytes)) => match serde_json::from_slice(&bytes) {
                Ok(journal) => (journal, None),
                Err(error) => (
                    Journal::default(),
                    Some(format!(
                        "checks journal is unreadable: {error}; admission is blocked"
                    )),
                ),
            },
            Some(Err(error)) => (
                Journal::default(),
                Some(format!(
                    "checks journal cannot be read: {error}; admission is blocked"
                )),
            ),
        };
        let delivery_source = if journal.delivery_source.is_empty() {
            crate::remote::crypto::random_device_id()
        } else {
            journal.delivery_source.clone()
        };
        if let Some(restored) = journal.admission.clone() {
            admission = restored;
            admission.pause(saved.paused);
            admission.recovered(|id| journal.bindings.contains_key(id));
        }
        if journal_error.is_some() {
            admission.pause(true);
        }
        for binding in journal.bindings.values() {
            poller.bind(binding.clone());
            admission.reconcile_receipt(
                &binding.claim.run_id,
                journal
                    .answers
                    .iter()
                    .any(|result| result.run_id == binding.claim.run_id),
            );
        }
        let book = Book {
            answers: journal
                .answers
                .iter()
                .chain(journal.delivered.values())
                .map(|result| (result.run_id.clone(), result.answer.clone()))
                .collect(),
            not_green: journal.not_green,
            pending: journal.pending,
            failures: journal.failures,
            bindings: journal.bindings,
            batches: journal.batches,
            delivered: journal.delivered,
            notifications: journal.notifications,
            ..Book::default()
        };
        snapshot.send_modify(|current| {
            let mut next = Snapshot::clone(current);
            next.paused = saved.paused;
            next.decisions = journal.decisions;
            next.answers = journal.answers;
            next.adoption = journal.adoption;
            *current = Arc::new(next);
        });
        Hub {
            core: Arc::new_cyclic(|core| Core {
                github,
                local,
                snapshot,
                results: broadcast::Sender::new(RESULTS_KEPT),
                // The queue holds the hub weakly through `Host`, and asks it nothing until the hub exists.
                queue: super::queue::open(Arc::new(Host(core.clone()))),
                poller,
                admission: Mutex::new(admission),
                book: Mutex::new(book),
                store: dir.as_ref().map(|dir| Store::new(dir.join("results"))),
                queue_dir: dir.as_ref().map_or_else(
                    || {
                        static HUBS: AtomicU64 = AtomicU64::new(0);
                        std::env::temp_dir().join(format!(
                            "ompdesk-checks-hub-{}-{}",
                            std::process::id(),
                            HUBS.fetch_add(1, Ordering::Relaxed)
                        ))
                    },
                    |dir| dir.join("queue"),
                ),
                dir,
                key: Mutex::new(None),
                git: Mutex::new(None),
                kick: Arc::new(Notify::new()),
                done: Notify::new(),
                ids: AtomicU64::new(journal.next_id),
                trends_at: AtomicU64::new(0),
                runner: runner.unwrap_or_else(|| super::local_run::CheckRunner::of(core.clone())),
                remote: broadcast::Sender::new(RESULTS_KEPT),
                me: core.clone(),
                stop: Scope::detached(),
                journal_write: Mutex::new(()),
                batch_start: tokio::sync::Mutex::new(()),
                journal_error,
                delivery_source,
            }),
            tasks: Mutex::default(),
        }
    }

    /// What the merge queue asks of this hub (`queue::open(hub.queue_host())`); it holds the hub weakly.
    // queue.rs is its first user outside the tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn queue_host(&self) -> Arc<dyn QueueHost> {
        Arc::new(Host(Arc::downgrade(&self.core)))
    }

    /// The owner's admission key, from main (the keychain); None: dispatches carry no ticket.
    pub fn set_key(&self, key: Option<AdmissionKey>) {
        *locked(&self.key) = key;
    }

    /// The hub's loop: at each change the poller saw, at each start, at each change of the merge queue and every
    /// `SETTLE_EVERY`, it frees the places of runs that ended, answers them, reaps lapsed leases, admits what may start
    /// and brings the board's queue, gates and trends up to date.
    pub fn run(&self) -> AbortHandle {
        let core = Arc::downgrade(&self.core);
        let kick = Arc::clone(&self.kick);
        let mut changes = self.poller.changes();
        let mut queue = self.queue.entries();
        tokio::spawn(async move {
            loop {
                {
                    let Some(core) = core.upgrade() else {
                        return;
                    };
                    core.pass().await;
                    queue.borrow_and_update();
                }
                tokio::select! {
                    changed = changes.changed() => if changed.is_err() { return },
                    changed = queue.changed() => if changed.is_err() { return },
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

pub(crate) fn notification_id(result: &RunResult) -> String {
    format!("{}:{}", result.run_id, notification_phase(result))
}

fn notification_phase(result: &RunResult) -> &'static str {
    if result
        .answer
        .said
        .iter()
        .any(|note| note.code == NoteCode::DispatchUnconfirmed)
    {
        "unconfirmed"
    } else {
        "result"
    }
}

impl Core {
    fn delivery_id(&self, result: &RunResult) -> String {
        format!(
            "checks:{}:{}:{}",
            self.delivery_source,
            result.run_id,
            notification_phase(result)
        )
    }

    /// One pass of the hub's loop: settle what the poller saw, answer the runs that ended, admit what may start, and
    /// bring the board's queue, gates and trends up to date. A run whose answer could not be read is judged again next
    /// pass, and after `JUDGE_TRIES` it is answered unknown with the last reason, so the session that waits for it is
    /// woken either way.
    async fn pass(&self) {
        let ended = self.settle();
        let again: Vec<_> = locked(&self.book).unjudged.drain().collect();
        let ended = ended
            .into_iter()
            .map(|(id, run)| (id, run, 0))
            .chain(again.into_iter().map(|(id, (run, tries))| (id, run, tries)));
        for (id, run, tries) in ended {
            let answer = self.judge(&id, &run).await;
            if self.answered(&id).is_some() {
                continue;
            }
            if tries + 1 >= JUDGE_TRIES {
                self.finish(&id, answer);
            } else {
                locked(&self.book).unjudged.insert(id, (run, tries + 1));
            }
        }
        self.pump().await;
        self.board().await;
        if self.save_journal().is_ok() {
            for result in locked(&self.book).notifications.values() {
                let _ = self.results.send(result.clone());
            }
        }
    }

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
                if run.verdict.is_none() {
                    continue;
                }
                match admission.entry(&run.id).map(|entry| entry.stage) {
                    Some(Stage::Running) => {
                        // Completion frees capacity; only the final judged Answer may make this digest reusable.
                        admission.run_ended(&run.id, false);
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
                answer::unknown(&id, now, Next::Wait, Note::new(NoteCode::LeaseLapsed)),
            );
        }
        ended
    }

    /// Admits what may start, one dispatch at a time.
    async fn pump(&self) {
        while !self.stop.cancelled() {
            let admitted =
                admission::pump(&self.admission, clock::now_ms(), |ask| self.dispatch(ask)).await;
            if admitted.is_none() {
                break;
            }
            if self.durable(&self.stop).await.is_err() {
                return;
            }
        }
        self.publish_unconfirmed();
        // Held supersedes and definite dispatch refusals notify their owners without another status/wait call.
        let pending: Vec<_> = {
            let book = locked(&self.book);
            book.pending
                .keys()
                .filter(|id| !book.answers.contains_key(*id))
                .cloned()
                .collect()
        };
        for id in pending {
            if let Some(note) = self.over_before_github(&id) {
                self.finish(&id, answer::unknown(&id, clock::now_ms(), Next::Fix, note));
            }
        }
    }

    async fn authorize_rerun(&self, pending: &Pending, run: u64) -> Result<bool, WriteError> {
        let refused =
            |why: &str| WriteError::Refused(super::sources::SourceError::new("rejected", why));
        if !pending.plan.macos {
            return Ok(false);
        }
        let devices = self
            .github
            .variable(&pending.repo, "CHECKS_ADMISSION_DEVICES")
            .await
            .map_err(WriteError::Refused)?
            .unwrap_or_default();
        if devices.trim().is_empty() {
            return Ok(false);
        }
        let key = locked(&self.key)
            .clone()
            .ok_or_else(|| refused("rerun requires this computer's admission key"))?;
        if !policy::listed(key.device(), &devices) {
            return Err(refused("this computer is not in CHECKS_ADMISSION_DEVICES"));
        }
        let attempt = pending
            .rerun_attempt
            .ok_or_else(|| refused("the target rerun attempt is not known"))?;
        let grant = ticket::mint_rerun(
            &key,
            &ticket::RerunScope {
                repo: &pending.repo,
                git_ref: &pending.git_ref,
                sha: &pending.sha,
                run_id: run,
                attempt,
            },
            clock::now_ms().saturating_add(ticket::TICKET_TTL_MS),
        )
        .ok_or_else(|| refused("the rerun receipt scope is invalid"))?;
        if self.stop.cancelled() {
            return Err(refused("the checks hub closed before granting a rerun"));
        }
        self.github
            .authorize_rerun(&super::sources::CommitStatus {
                repo: pending.repo.clone(),
                sha: pending.sha.clone(),
                context: grant.context,
                description: grant.description,
                state: grant.state.into(),
            })
            .await
            .map(|()| true)
    }

    /// The reserved intent lands on disk before the first possible external write. A missing response is never a
    /// retryable refusal and never establishes ownership of a nearby run.
    async fn dispatch(&self, ask: Ask) -> admission::DispatchState {
        use admission::DispatchState::{Accepted, Refused, Unconfirmed};
        let Some(pending) = locked(&self.book).pending.get(&ask.id).cloned() else {
            return Refused;
        };
        if self.durable(&self.stop).await.is_err() {
            return Unconfirmed;
        }
        let claim = Claim {
            run_id: ask.id.clone(),
            origin: pending.origin.clone(),
            lane: ask.lane,
            gate: pending.gate.clone(),
            digest: pending.digest.clone(),
        };
        let sent = if let Some(run) = pending.rerun_of {
            match self.authorize_rerun(&pending, run).await {
                Ok(published) if !self.stop.cancelled() => self
                    .github
                    .rerun_failed(&pending.repo, run)
                    .await
                    .map(|()| run)
                    .map_err(|error| {
                        if published {
                            WriteError::Unconfirmed(error.error().clone())
                        } else {
                            error
                        }
                    }),
                Ok(_) => return Unconfirmed,
                Err(error) => Err(error),
            }
        } else {
            let tip = self.github.head(&pending.repo, &pending.git_ref).await;
            match tip {
                Ok(Some(tip)) if tip == pending.sha => {}
                other => {
                    let reason = match other {
                        Ok(Some(tip)) => format!(
                            "{} moved from {} to {}; start again to check the new tip",
                            pending.git_ref,
                            short(&pending.sha),
                            short(&tip)
                        ),
                        Ok(None) => format!("{} is no longer pushed", pending.git_ref),
                        Err(error) => format!("no dispatch was sent: {}", error.message),
                    };
                    locked(&self.book).failures.insert(ask.id, reason);
                    return Refused;
                }
            }
            if self.stop.cancelled() {
                return Refused;
            }
            let mut inputs = pending.plan.inputs.clone();
            if pending.ticketed
                && pending.plan.macos
                && let Some(key) = locked(&self.key).clone()
            {
                inputs.insert(
                    "ticket".into(),
                    ticket::mint(
                        &key,
                        &pending.repo,
                        &pending.git_ref,
                        &pending.sha,
                        clock::now_ms().saturating_add(ticket::TICKET_TTL_MS),
                    ),
                );
            }
            self.github
                .dispatch(&Dispatch {
                    repo: pending.repo.clone(),
                    workflow: pending.plan.workflow.clone(),
                    git_ref: pending.git_ref.clone(),
                    inputs,
                })
                .await
        };
        match sent {
            Ok(run) => {
                let binding = GithubBinding {
                    repo: pending.repo.clone(),
                    run,
                    attempt: pending.rerun_attempt.unwrap_or(1),
                    claim,
                };
                locked(&self.book).bindings.insert(ask.id, binding.clone());
                // If this write is interrupted, the prior durable intent stays Unconfirmed on recovery.
                if self.durable(&self.stop).await.is_err() {
                    return Unconfirmed;
                }
                self.poller.bind(binding);
                Accepted
            }
            Err(error) => {
                locked(&self.book)
                    .failures
                    .insert(ask.id, error.error().message.clone());
                match error {
                    WriteError::Refused(_) => Refused,
                    WriteError::Unconfirmed(_) => Unconfirmed,
                }
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
        let _ = self.save_journal();
    }

    /// Writes the journal (`JOURNAL_FILE`) as the snapshot and the book hold it now; a hub without a folder keeps it
    /// in memory. A write that fails (a full disk) is retried by `write_kept`.
    fn save_journal(&self) -> Result<(), Fault> {
        let _write = locked(&self.journal_write);
        if let Some(error) = &self.journal_error {
            return Err(Fault::new("checks_journal", error));
        }
        let Some(dir) = &self.dir else {
            return Ok(());
        };
        let snapshot = Arc::clone(&self.snapshot.borrow());
        let book = locked(&self.book);
        let keep: HashSet<_> = snapshot
            .answers
            .iter()
            .map(|result| &result.run_id)
            .chain(book.notifications.values().map(|result| &result.run_id))
            .chain(book.delivered.keys())
            .chain(book.batches.values().map(|receipt| &receipt.id))
            .chain(book.away.keys())
            .chain(book.unjudged.keys())
            .collect();
        let discarded: HashSet<_> = book
            .answers
            .keys()
            .filter(|id| !keep.contains(id))
            .cloned()
            .collect();
        let mut admission = locked(&self.admission).clone();
        admission.discard_completed(&discarded);
        let journal = Journal {
            delivery_source: self.delivery_source.clone(),
            decisions: snapshot.decisions.clone(),
            answers: snapshot
                .answers
                .iter()
                .filter(|result| book.answers.contains_key(&result.run_id))
                .cloned()
                .collect(),
            adoption: snapshot.adoption.clone(),
            not_green: book.not_green.clone(),
            pending: book
                .pending
                .iter()
                .filter(|(id, _)| !discarded.contains(*id))
                .map(|(id, pending)| (id.clone(), pending.clone()))
                .collect(),
            failures: book
                .failures
                .iter()
                .filter(|(id, _)| !discarded.contains(*id))
                .map(|(id, error)| (id.clone(), error.clone()))
                .collect(),
            bindings: book
                .bindings
                .iter()
                .filter(|(id, _)| !discarded.contains(*id))
                .map(|(id, binding)| (id.clone(), binding.clone()))
                .collect(),
            batches: book.batches.clone(),
            delivered: book.delivered.clone(),
            notifications: book.notifications.clone(),
            admission: Some(admission),
            next_id: self.ids.load(Ordering::Relaxed),
        };
        let bytes = serde_json::to_vec(&journal)
            .map_err(|error| Fault::new("checks_journal", error.to_string()))?;
        crate::disk::saves::write_kept(&dir.join(JOURNAL_FILE), &bytes, Some(0o600), 0o700)?;
        Ok(())
    }

    /// An effect or durable acknowledgement cannot pass a failed save. A restart replays the previous envelope.
    async fn durable(&self, scope: &Scope) -> Result<(), Fault> {
        loop {
            if scope.cancelled() || self.stop.cancelled() {
                return Err(Fault::cancelled());
            }
            if let Some(error) = &self.journal_error {
                return Err(Fault::new("checks_journal", error));
            }
            if self.save_journal().is_ok() {
                return Ok(());
            }
            tokio::select! {
                () = scope.on_cancel() => return Err(Fault::cancelled()),
                () = self.stop.on_cancel() => return Err(Fault::cancelled()),
                () = clock::sleep(Duration::from_secs(1)) => {},
            }
        }
    }

    /// One more of the "Are agents using it?" figures (design §7.5), kept in the journal.
    fn count(&self, change: impl FnOnce(&mut super::contract::Adoption)) {
        self.snapshot.send_modify(|current| {
            let mut next = Snapshot::clone(current);
            change(&mut next.adoption);
            *current = Arc::new(next);
        });
        let _ = self.save_journal();
    }

    /// A start's answer, counted: runs started through the tool (started now or held for a place) and refusals.
    fn counted(&self, reply: &Result<StartReply, Fault>) {
        match reply.as_ref().map(|reply| reply.decision) {
            Ok(StartDecision::Started | StartDecision::Held) => {
                self.count(|adoption| adoption.started += 1);
            }
            Ok(StartDecision::Refused) => self.count(|adoption| adoption.refused += 1),
            _ => {}
        }
    }

    /// Keeps a run's answer, tells every subscriber (main wakes the session that started it) and the board.
    fn finish(&self, id: &str, answer: Answer) {
        self.finish_with(id, None, answer);
    }

    /// `finish`, for whom `origin` names (a merge-queue entry's), else whoever started the run.
    fn finish_with(&self, id: &str, origin: Option<Origin>, answer: Answer) {
        let origin = {
            let mut book = locked(&self.book);
            if book.answers.contains_key(id) {
                return;
            }
            book.answers.insert(id.to_owned(), answer.clone());
            locked(&self.admission).judged(
                id,
                answer.verdict == AnswerVerdict::Green && answer.blocks_release.is_none(),
            );
            // What a session was told about a commit: not green until a green answer of the same commit.
            if let Some(pending) = book.pending.get(id).cloned()
                && let Origin::Session { session, .. } = &pending.origin
            {
                let told = NotGreen {
                    session: session.clone(),
                    repo: pending.repo,
                    sha: pending.sha,
                };
                book.not_green.retain(|kept| kept != &told);
                if answer.verdict != AnswerVerdict::Green {
                    book.not_green.push(told);
                    let over = book.not_green.len().saturating_sub(NOT_GREEN_KEPT);
                    book.not_green.drain(..over);
                }
            }
            origin.unwrap_or_else(|| {
                book.pending
                    .get(id)
                    .map_or(Origin::Person, |pending| pending.origin.clone())
            })
        };
        let result = RunResult {
            run_id: id.to_owned(),
            origin,
            answer,
        };
        locked(&self.book)
            .notifications
            .insert(self.delivery_id(&result), result.clone());
        self.snapshot.send_modify(|current| {
            let mut next = Snapshot::clone(current);
            next.answers.retain(|kept| kept.run_id != result.run_id);
            next.answers.push(result.clone());
            let over = next.answers.len().saturating_sub(ANSWERS_SHOWN);
            next.answers.drain(..over);
            *current = Arc::new(next);
        });
        if self.save_journal().is_ok() {
            let _ = self.results.send(result);
        }
        self.done.notify_waiters();
        // The board's gates read the answers.
        self.kick.notify_one();
    }

    /// The board's own parts: the merge queue as it stands, each release's gates from its runs and answers, and, when
    /// a ledger changed or `TRENDS_EVERY_MS` passed, the Tests and cost tab.
    async fn board(&self) {
        let queue = Arc::clone(&self.queue.entries().borrow());
        let now = clock::now_ms();
        let built = self.trends_at.load(Ordering::Relaxed);
        let trends = if built == 0 || now.saturating_sub(built) >= TRENDS_EVERY_MS {
            // Set before it is built: a ledger that changes meanwhile sets it back to 0 and the next pass builds again.
            self.trends_at.store(now.max(1), Ordering::Relaxed);
            Some(self.trends(now).await)
        } else {
            None
        };
        let gates = {
            let snapshot = Arc::clone(&self.snapshot.borrow());
            let book = locked(&self.book);
            super::board::gates(&snapshot.runs, &snapshot.answers, |id| {
                book.pending
                    .get(id)
                    .map(|pending| pending.plan.workflow.clone())
            })
        };
        self.snapshot.send_if_modified(|current| {
            let trends = trends.filter(|trends| *trends != current.trends);
            if current.queue == **queue && current.gates == gates && trends.is_none() {
                return false;
            }
            let mut next = Snapshot::clone(current);
            next.queue = queue.to_vec();
            next.gates = gates;
            if let Some(trends) = trends {
                next.trends = trends;
            }
            *current = Arc::new(next);
            true
        });
    }

    /// The Tests and cost tab from every watched repository's ledger and this computer's own checks. The pools' waiting
    /// jobs are noted as the day's queue peaks first; a ledger is saved only when a peak rose.
    async fn trends(&self, now: u64) -> super::contract::Trends {
        // Journals that cannot be read list no local quarantine this time.
        let flaky = self.local.flaky().await.unwrap_or_default();
        let pools = self.poller.local_pools();
        let waiting: Vec<(String, u32)> = self
            .snapshot
            .borrow()
            .pools
            .iter()
            .map(|pool| (pool.id.clone(), pool.queued))
            .collect();
        let repos = self.poller.repos();
        let mut book = locked(&self.book);
        for repo in repos {
            if let std::collections::hash_map::Entry::Vacant(slot) = book.ledgers.entry(repo) {
                let ledger = self
                    .store
                    .as_ref()
                    .map_or_else(Ledger::default, |store| store.load(slot.key()));
                slot.insert(ledger);
            }
        }
        for (repo, ledger) in &mut book.ledgers {
            let mut rose = false;
            for (pool, queued) in &waiting {
                rose |= ledger.note_queue(now, pool, *queued);
            }
            if rose && let Some(store) = &self.store {
                // A ledger that cannot be saved stays in memory; the next save tries again.
                let _ = store.save(repo, ledger);
            }
        }
        let ledgers: Vec<(&str, &Ledger)> = book
            .ledgers
            .iter()
            .map(|(repo, ledger)| (repo.as_str(), ledger))
            .collect();
        super::trends::tab::build(
            &ledgers,
            &super::trends::tab::Local {
                flaky: &flaky,
                os: super::poller::local::this_os(),
                pools: &pools,
            },
            now,
        )
    }

    /// What a reused green result saved: the time its run took, noted in the repository's ledger for the tab.
    fn reuse_saves(&self, repo: &str, from: &str, now: u64) -> u64 {
        let saved = self
            .snapshot
            .borrow()
            .runs
            .iter()
            .find(|run| run.id == from)
            .map_or(0, |run| {
                let started = run.jobs.iter().filter_map(|job| job.started_at).min();
                let ended = run.jobs.iter().filter_map(|job| job.ended_at).max();
                started
                    .zip(ended)
                    .map_or(0, |(started, ended)| ended.saturating_sub(started))
            });
        if saved > 0 {
            let mut book = locked(&self.book);
            let ledger = book.ledgers.entry(repo.to_owned()).or_insert_with(|| {
                self.store
                    .as_ref()
                    .map_or_else(Ledger::default, |store| store.load(repo))
            });
            ledger.note_reuse(now, saved);
            if let Some(store) = &self.store {
                // A ledger that cannot be saved stays in memory; the next save tries again.
                let _ = store.save(repo, ledger);
            }
            self.trends_at.store(0, Ordering::Relaxed);
        }
        saved
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
                Note {
                    run: Some(id.to_owned()),
                    ..Note::new(NoteCode::RunUnknown)
                },
            );
        };
        if let Some((as_of, false)) = self.poller.confirmed(&repo, github_run) {
            return answer::unknown(
                id,
                now,
                Next::Wait,
                Note {
                    at: Some(as_of),
                    error: self.poller.trouble().map(|trouble| trouble.message),
                    ..Note::new(NoteCode::FactsStale)
                },
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
                    Note {
                        error: Some(error.message),
                        ..Note::new(NoteCode::ResultsUnreadable)
                    },
                );
            }
        };
        let judged = {
            let mut book = locked(&self.book);
            let pending = book.pending.get(id).cloned();
            // The digest names the commit the hub asked for; a run of another commit gets one of its own.
            let moved = pending
                .as_ref()
                .filter(|pending| pending.sha != run.sha)
                .map(|pending| pending.sha.clone());
            let digest = match (&pending, &moved) {
                (Some(pending), None) => pending.digest.clone(),
                (Some(pending), Some(_)) => format!("{}@{}", pending.digest, run.sha),
                (None, _) => String::new(),
            };
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
                    digest: &digest,
                    by: pending.as_ref().map(|pending| &pending.origin),
                    gate: pending.as_ref().and_then(|pending| pending.gate.as_ref()),
                    now,
                },
            )
            .map(|mut answer| {
                if let Some(asked) = moved {
                    answer.verdict = AnswerVerdict::Unknown;
                    answer.next = Next::Fix;
                    answer.blocks_release = pending
                        .as_ref()
                        .and_then(|pending| pending.gate.clone())
                        .map(|gate| super::contract::BlocksRelease { gate });
                    answer.say(Note {
                        commit: Some(run.sha.clone()),
                        branch: Some(run.git_ref.clone()),
                        asked: Some(asked),
                        ..Note::new(NoteCode::BranchMoved)
                    });
                }
                answer
            });
            if let Some(store) = &self.store {
                // A ledger that cannot be saved stays in memory; the next save tries again.
                let _ = store.save(&repo, &ledger);
            }
            book.ledgers.insert(repo, ledger);
            self.trends_at.store(0, Ordering::Relaxed);
            answer
        };
        match judged {
            Some(answer) => {
                self.finish(id, answer);
                self.answered(id).unwrap_or_else(|| {
                    answer::unknown(id, now, Next::Wait, Note::new(NoteCode::NoAnswerKept))
                })
            }
            None => self.answered(id).unwrap_or_else(|| {
                answer::unknown(
                    id,
                    now,
                    Next::Wait,
                    Note::new(NoteCode::JudgedBeforeRestart),
                )
            }),
        }
    }

    fn unconfirmed_answer(&self, id: &str) -> Option<Answer> {
        if !locked(&self.admission)
            .entry(id)
            .is_some_and(|entry| entry.stage == Stage::Unconfirmed)
        {
            return None;
        }
        let book = locked(&self.book);
        let pending = book.pending.get(id)?;
        Some(answer::unknown(
            id,
            clock::now_ms(),
            Next::AskOwner,
            Note {
                error: Some(format!(
                    "{id}: {} {} at {} ({}) — {}",
                    pending.repo,
                    pending.git_ref,
                    pending.sha,
                    policy::pool(pending.plan.macos),
                    book.failures
                        .get(id)
                        .map(String::as_str)
                        .unwrap_or("the core restarted before an authoritative receipt was saved"),
                )),
                ..Note::new(NoteCode::DispatchUnconfirmed)
            },
        ))
    }

    fn publish_unconfirmed(&self) {
        let ids: Vec<_> = locked(&self.book).pending.keys().cloned().collect();
        for id in ids {
            let Some(answer) = self.unconfirmed_answer(&id) else {
                continue;
            };
            self.snapshot.send_if_modified(|current| {
                if current.answers.iter().any(|result| result.run_id == id) {
                    return false;
                }
                let mut next = Snapshot::clone(current);
                let origin = locked(&self.book)
                    .pending
                    .get(&id)
                    .map(|pending| pending.origin.clone())
                    .unwrap_or(Origin::Person);
                let result = RunResult {
                    run_id: id.clone(),
                    origin,
                    answer,
                };
                locked(&self.book)
                    .notifications
                    .insert(self.delivery_id(&result), result.clone());
                next.answers.push(result);
                *current = Arc::new(next);
                true
            });
        }
    }

    /// Why a run of the hub's will not end by itself, if it will not: it never reached GitHub.
    fn over_before_github(&self, id: &str) -> Option<Note> {
        let stage = locked(&self.admission).entry(id).map(|entry| entry.stage)?;
        match stage {
            Stage::Over(Ended::Failed) => Some(Note {
                error: locked(&self.book).failures.get(id).cloned(),
                ..Note::new(NoteCode::DispatchFailed)
            }),
            Stage::Over(Ended::Refused) => Some(Note::new(NoteCode::Refused)),
            Stage::Over(Ended::Expired) => Some(Note::new(NoteCode::LeaseLapsed)),
            Stage::Over(Ended::Cancelled) if locked(&self.admission).entry(id).is_some() => {
                Some(Note::new(NoteCode::Replaced))
            }
            _ => None,
        }
    }

    /// Ends with the run's kept answer, however long that takes; the caller bounds it. The caller is the run's owner
    /// asking, so a held entry's lease is renewed every `HEARTBEAT_EVERY` meanwhile. An answer that cannot be read yet
    /// is not returned: the hub's pass judges the run again and keeps the answer (`JUDGE_TRIES`).
    async fn answer_of(&self, id: &str) -> Answer {
        loop {
            if let Some(answer) = self.answered(id) {
                return answer;
            }
            if let Some(note) = self.over_before_github(id) {
                let answer = answer::unknown(id, clock::now_ms(), Next::Wait, note);
                self.finish(id, answer);
                continue;
            }
            let done = self.done.notified();
            tokio::pin!(done);
            tokio::select! {
                run = self.poller.ended(id) => {
                    self.judge(id, &run).await;
                    if self.answered(id).is_none() {
                        tokio::select! {
                            () = &mut done => {}
                            () = clock::sleep(SETTLE_EVERY) => {}
                        }
                    }
                }
                () = &mut done => {}
                () = clock::sleep(HEARTBEAT_EVERY) => {
                    locked(&self.admission).heartbeat(id, clock::now_ms());
                }
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
        let Some((_, run)) = self.poller.github_of(&id) else {
            return Ok(refused(format!("GitHub's run for {id} is not known")));
        };
        let Some(attempt) = self
            .poller
            .attempt(repo, run)
            .and_then(|attempt| attempt.checked_add(1))
        else {
            return Ok(refused(format!(
                "the current attempt of GitHub's run for {id} is not known"
            )));
        };
        let Some(lane) = locked(&self.admission)
            .entry(&id)
            .map(|entry| entry.ask.lane)
        else {
            return Ok(refused(format!("{id} is not in OMPdesk's queue any more")));
        };
        let Some(pending) = locked(&self.book).pending.get(&id).cloned() else {
            return Ok(refused(format!("{id} is not in OMPdesk's queue any more")));
        };
        // The rerun is a run of its own: it waits for a place like any start, under the owner's pause and the
        // pools' limits, and is answered by its own id.
        let mut reply = self
            .admit_entry(
                self.next_id(),
                Pending {
                    rerun_of: Some(run),
                    rerun_attempt: Some(attempt),
                    ..pending
                },
                lane,
            )
            .await?;
        if reply.decision == StartDecision::Started {
            reply.reason = format!("the failed jobs of {id} run again ({})", reply.reason);
        }
        Ok(reply)
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
        if self.stop.cancelled() {
            return Err(Fault::cancelled());
        }
        if let Some(error) = &self.journal_error {
            return refuse(error.clone());
        }
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
            // A session that was answered red or unknown for this commit and lands it anyway acts on a green it was
            // never given (design §7.5, "wrong green reports").
            let wrong = matches!(&origin, Origin::Session { session, .. }
            if locked(&self.book).not_green.iter().any(|told| {
                &told.session == session && told.repo == repo && told.sha == sha
            }));
            if wrong {
                self.count(|adoption| adoption.wrong_greens += 1);
            }
            let base = match self.github.default_branch(&repo).await {
                Ok(Some(base)) => base,
                _ => "main".to_owned(),
            };
            let title = match self.github.subject(&repo, &sha).await {
                Ok(Some(subject)) => subject,
                _ => git_ref.clone(),
            };
            return self
                .queue
                .enqueue(
                    origin,
                    LandRequest {
                        repo,
                        branch: git_ref,
                        sha,
                        base,
                        pr: None,
                        title,
                        scope: request.scope,
                    },
                )
                .await;
        }
        self.submit(
            self.next_id(),
            origin,
            request.purpose,
            request.workflow,
            false,
            repo,
            git_ref,
            sha,
        )
        .await
    }

    /// A resolved start (repo, ref and the commit it runs) through policy and admission. `land`: a merge-queue
    /// batch's run, in lane `land`.
    #[allow(clippy::too_many_arguments)]
    async fn submit(
        &self,
        id: RunId,
        origin: Origin,
        purpose: Purpose,
        named: Option<WorkflowAsk>,
        land: bool,
        repo: RepoId,
        git_ref: String,
        sha: Sha,
    ) -> Result<StartReply, Fault> {
        let refuse = |reason: String| {
            Ok(StartReply {
                run_id: None,
                decision: StartDecision::Refused,
                placement: None,
                expected_start_min: None,
                reason,
            })
        };
        let choice = match &named {
            Some(named) => policy::named(named),
            None => {
                let file = self
                    .github
                    .file(&repo, &sha, policy::REPO_FILE)
                    .await
                    .map_err(source_fault)?;
                match policy::choose(purpose, file.as_deref()) {
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
        // What a computer runs instead, when placement puts the check on one (`hub_local.rs`); a land batch never.
        let package = if land || named.is_some() || choice.local.is_some() {
            None
        } else {
            self.github
                .file(&repo, &sha, "package.json")
                .await
                .ok()
                .flatten()
        };
        let local = (!land)
            .then(|| policy::local_command(purpose, named.is_some(), &choice, package.as_deref()))
            .flatten();
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
        let lane = if land {
            Lane::Land
        } else {
            policy::lane(purpose, named.is_some(), plan.macos, &git_ref, &mac_refs)
        };
        let digest = policy::digest(&sha, &text, &plan.inputs);
        let workflow = plan.workflow.clone();
        let pending = Pending {
            origin,
            repo,
            git_ref,
            sha,
            plan,
            ticketed,
            digest,
            gate: (lane == Lane::Release).then(|| format!("release {workflow}")),
            rerun_of: None,
            rerun_attempt: None,
        };
        self.place_and_admit(id, pending, lane, local).await
    }

    /// One entry into admission: a start's, or a rerun's of a red run's failed jobs. It supersedes older runs of its
    /// key, may be reused from a green run of its digest, and is dispatched now or held.
    async fn admit_entry(
        &self,
        id: RunId,
        pending: Pending,
        lane: Lane,
    ) -> Result<StartReply, Fault> {
        let refuse = |reason: String| {
            Ok(StartReply {
                run_id: None,
                decision: StartDecision::Refused,
                placement: None,
                expected_start_min: None,
                reason,
            })
        };
        if self.stop.cancelled() {
            return Err(Fault::cancelled());
        }
        if let Some(error) = &self.journal_error {
            return refuse(error.clone());
        }
        let (origin, repo, git_ref) = (
            pending.origin.clone(),
            pending.repo.clone(),
            pending.git_ref.clone(),
        );
        let workflow = pending.plan.workflow.clone();
        let digest = pending.digest.clone();
        let pool = policy::pool(pending.plan.macos);
        locked(&self.book).pending.insert(id.clone(), pending);
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
                let saved_ms = self.reuse_saves(&repo, &from, now);
                let answer = match &green {
                    Some(green) => {
                        answer::reused(&id, green, &from, (saved_ms / 60_000) as u32, now)
                    }
                    None => answer::unknown(
                        &id,
                        now,
                        Next::Wait,
                        Note {
                            run: Some(from.clone()),
                            ..Note::new(NoteCode::ReuseLost)
                        },
                    ),
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
            Some(Stage::Unconfirmed) => {
                let answer = self.unconfirmed_answer(&id);
                reply(
                    StartDecision::Held,
                    answer
                        .map(|answer| answer.notes.join("; "))
                        .unwrap_or_else(|| {
                            "dispatch acceptance is unknown; its capacity remains reserved".into()
                        }),
                )
            }
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
                reason: self.over_before_github(&id).map_or_else(
                    || "it could not be dispatched".into(),
                    |note| note.english(),
                ),
            }),
        }
    }

    async fn wait(&self, request: WaitRequest, scope: Scope) -> Result<Answer, Fault> {
        let id = request.run_id;
        if let Some(answer) = self.unconfirmed_answer(&id) {
            return Ok(answer);
        }
        let seconds = request
            .timeout_seconds
            .unwrap_or(super::contract::WAIT_DEFAULT_SECONDS)
            .clamp(1, super::contract::WAIT_MAX_SECONDS);
        let deadline = clock::sleep(Duration::from_secs(seconds));
        tokio::pin!(deadline);
        let timed_out = |note: Note| answer::unknown(&id, clock::now_ms(), Next::Wait, note);
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
            return Ok(self
                .answered(&id)
                .unwrap_or_else(|| timed_out(Note::new(NoteCode::RunChanged))));
        }
        // `answer_of` renews a held entry's lease while it waits: the owner is still asking.
        tokio::select! {
            answer = self.answer_of(&id) => Ok(answer),
            () = &mut deadline => Ok(timed_out(Note {
                seconds: Some(seconds as u32),
                ..Note::new(NoteCode::WaitTimedOut)
            })),
            () = scope.on_cancel() => Err(Fault::new("cancelled", "the wait was cancelled")),
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
        Box::pin(async move {
            let reply = self.core.start(origin, request).await;
            self.core.counted(&reply);
            reply
        })
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

    fn delivery_id(&self, result: &RunResult) -> String {
        self.core.delivery_id(result)
    }

    fn notifications(&self) -> Vec<(String, RunResult)> {
        locked(&self.book)
            .notifications
            .iter()
            .map(|(id, result)| (id.clone(), result.clone()))
            .collect()
    }

    fn acknowledge<'a>(&'a self, delivery_id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>> {
        Box::pin(async move {
            locked(&self.book).notifications.remove(delivery_id);
            self.durable(&scope).await
        })
    }

    fn pause(&self, paused: bool) -> Fut<'_, Result<(), Fault>> {
        let done = self.core.pause(paused);
        Box::pin(async move { done })
    }

    fn told(&self, fact: MainFact) -> Fut<'_, Result<(), Fault>> {
        match fact {
            MainFact::Polls { polls } => self.core.count(|adoption| adoption.polls = polls),
            fact => self.poller.told(fact),
        }
        Box::pin(async { Ok(()) })
    }

    fn runners(&self, runners: Runners) -> Fut<'_, Result<(), Fault>> {
        *locked(&self.git) = runners.git.clone();
        self.poller.runners(runners);
        Box::pin(async { Ok(()) })
    }

    fn local_pool(&self) -> Fut<'_, Result<LocalPool, Fault>> {
        Box::pin(async move {
            let pools = self.local.pools().await.map_err(source_fault)?;
            pools
                .into_iter()
                .find(|pool| pool.device == "local")
                .ok_or_else(|| Fault::new("checks_source", "this computer's pool was not read"))
        })
    }

    fn run_local(&self, ask: LocalRunAsk, scope: Scope) -> Fut<'_, Result<Answer, Fault>> {
        Box::pin(async move { self.core.run_here(ask, scope).await })
    }

    fn remote_runs(&self) -> broadcast::Receiver<RemoteRun> {
        self.remote.subscribe()
    }

    fn remote_answer(
        &self,
        id: RunId,
        answer: Result<Answer, String>,
    ) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async move {
            self.core.remote_answer(id, answer).await;
            Ok(())
        })
    }
}

/// The hub as the merge queue sees it (`QueueHost`), holding it weakly: the hub owns the queue and the queue this.
// queue.rs is its first user; until it lands only the tests build one.
#[allow(dead_code)]
struct Host(std::sync::Weak<Core>);

#[allow(dead_code)]
impl Host {
    fn core(&self) -> Result<Arc<Core>, Fault> {
        self.0
            .upgrade()
            .ok_or_else(|| Fault::new("checks_closed", "the checks hub is closed"))
    }
}

impl QueueHost for Host {
    fn start_batch<'a>(
        &'a self,
        repo: &'a str,
        git_ref: &'a str,
        sha: &'a str,
        effect_id: &'a str,
    ) -> Fut<'a, Result<StartReply, Fault>> {
        Box::pin(async move {
            let core = self.core()?;
            let _start = core.batch_start.lock().await;
            let receipt = locked(&core.book).batches.get(effect_id).cloned();
            let receipt = match receipt {
                Some(receipt) => {
                    if receipt.repo != repo || receipt.git_ref != git_ref || receipt.sha != sha {
                        return Err(Fault::new(
                            "checks_batch",
                            "a batch effect id was reused with different inputs",
                        ));
                    }
                    if let Some(reply) = receipt.reply.clone() {
                        core.durable(&core.stop).await?;
                        return Ok(reply);
                    }
                    receipt
                }
                None => {
                    let receipt = BatchReceipt {
                        id: core.next_id(),
                        repo: repo.into(),
                        git_ref: git_ref.into(),
                        sha: sha.into(),
                        reply: None,
                    };
                    locked(&core.book)
                        .batches
                        .insert(effect_id.into(), receipt.clone());
                    receipt
                }
            };
            core.durable(&core.stop).await?;
            let exists = locked(&core.book).pending.contains_key(&receipt.id);
            let reply = if exists {
                StartReply {
                    run_id: Some(receipt.id.clone()), decision: StartDecision::Held,
                    placement: Some(Where::GithubHosted), expected_start_min: None,
                    reason: "the batch's durable check intent is already reserved; waiting for its authoritative outcome".into(),
                }
            } else {
                core.submit(
                    receipt.id,
                    Origin::Outside {
                        claimed_name: "OMPdesk merge queue".into(),
                    },
                    Purpose::Branch,
                    None,
                    true,
                    repo.into(),
                    git_ref.into(),
                    sha.into(),
                )
                .await?
            };
            if let Some(receipt) = locked(&core.book).batches.get_mut(effect_id) {
                receipt.reply = Some(reply.clone());
            }
            core.durable(&core.stop).await?;
            Ok(reply)
        })
    }

    fn batch_answer(&self, run: RunId, scope: Scope) -> Fut<'_, Result<Answer, Fault>> {
        Box::pin(async move {
            let core = self.core()?;
            tokio::select! {
                answer = core.answer_of(&run) => Ok(answer),
                () = scope.on_cancel() => Err(Fault::new("cancelled", "the batch's wait was cancelled")),
            }
        })
    }

    fn paused(&self) -> bool {
        self.0
            .upgrade()
            .is_some_and(|core| locked(&core.admission).paused())
    }

    fn finished(&self, result: RunResult, scope: Scope) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async move {
            let core = self.core()?;
            locked(&core.book)
                .delivered
                .insert(result.run_id.clone(), result.clone());
            core.finish_with(&result.run_id, Some(result.origin), result.answer);
            core.durable(&scope).await
        })
    }

    fn forget_batch<'a>(&'a self, effect_id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>> {
        Box::pin(async move {
            let core = self.core()?;
            locked(&core.book).batches.remove(effect_id);
            core.durable(&scope).await
        })
    }

    fn forget_answer<'a>(&'a self, id: &'a str, scope: Scope) -> Fut<'a, Result<(), Fault>> {
        Box::pin(async move {
            let core = self.core()?;
            locked(&core.book).delivered.remove(id);
            core.durable(&scope).await
        })
    }

    fn git(&self, scope: Scope) -> Option<crate::git::run::Git> {
        let core = self.0.upgrade()?;
        let runner = locked(&core.git).clone()?;
        Some(crate::git::run::Git::new(runner, scope))
    }

    fn queue_dir(&self) -> PathBuf {
        self.0.upgrade().map_or_else(
            || std::env::temp_dir().join("ompdesk-checks-closed"),
            |core| core.queue_dir.clone(),
        )
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        // A hub without a state folder keeps nothing past its life.
        if self.dir.is_none() {
            let _ = std::fs::remove_dir_all(&self.queue_dir);
        }
    }
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;

#[path = "hub_local.rs"]
mod local;
