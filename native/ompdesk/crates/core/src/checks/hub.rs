//! `ChecksHub`: the one deep module of check control. Three calls (`start`, `wait`, `status`), one read-only stream for
//! screens (`watch`) and the owner's one control (`pause`). Everything else is behind it.
//!
//! `Hub` is the real one, built over the two fact adapters (`sources.rs`). It is a skeleton: every call answers
//! `not_built` until its part lands (`mod.rs` lists the parts and their files). The seams between parts are here:
//! `LandQueue` and `QueueHost` between admission and the merge queue.

use std::pin::Pin;
use std::sync::Arc;

use serde::Deserialize;
use tokio::sync::{broadcast, watch};

use super::contract::{
    Answer, MainFact, Origin, QueueEntry, RepoId, RunId, RunResult, Sha, Snapshot, StartReply,
    StartRequest, StartScope, StatusRequest, WaitRequest,
};
use super::sources::{GithubSource, LocalSource};
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
pub trait QueueHost: Send + Sync {
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

/// The real hub.
pub struct Hub {
    pub github: Arc<dyn GithubSource>,
    pub local: Arc<dyn LocalSource>,
    pub snapshot: watch::Sender<Arc<Snapshot>>,
    pub results: broadcast::Sender<RunResult>,
    /// Where `start {purpose: land}` goes once admission resolved it.
    pub queue: Arc<dyn LandQueue>,
}

impl Hub {
    pub fn new(github: Arc<dyn GithubSource>, local: Arc<dyn LocalSource>) -> Hub {
        Hub {
            github,
            local,
            snapshot: watch::Sender::new(Arc::new(Snapshot::empty(crate::clock::now_ms()))),
            results: broadcast::Sender::new(RESULTS_KEPT),
            // The merge queue's part replaces this one line with its own queue (`queue::open(host)`).
            queue: Arc::new(NoQueue(watch::Sender::new(Arc::default()))),
        }
    }
}

impl ChecksHub for Hub {
    fn start(&self, _origin: Origin, _request: StartRequest) -> Fut<'_, Result<StartReply, Fault>> {
        Box::pin(async { Err(not_built("start")) })
    }

    fn wait(
        &self,
        _origin: Origin,
        _request: WaitRequest,
        _scope: Scope,
    ) -> Fut<'_, Result<Answer, Fault>> {
        Box::pin(async { Err(not_built("wait")) })
    }

    fn status(&self, _origin: Origin, _request: StatusRequest) -> Fut<'_, Result<Snapshot, Fault>> {
        Box::pin(async { Err(not_built("status")) })
    }

    fn watch(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.snapshot.subscribe()
    }

    fn results(&self) -> broadcast::Receiver<RunResult> {
        self.results.subscribe()
    }

    fn pause(&self, _paused: bool) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async { Err(not_built("pause")) })
    }

    fn told(&self, _fact: MainFact) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async { Err(not_built("what main tells the hub")) })
    }

    fn runners(&self, _runners: Runners) -> Fut<'_, Result<(), Fault>> {
        Box::pin(async { Err(not_built("the gh and git runners")) })
    }
}
