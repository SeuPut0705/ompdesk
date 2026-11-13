//! `ChecksHub`: the one deep module of check control. Three calls (`start`, `wait`, `status`), one read-only stream for
//! screens (`watch`) and the owner's one control (`pause`). Everything else is behind it.
//!
//! `Hub` is the real one, built over the two fact adapters (`sources.rs`). It is a skeleton: every call answers
//! `not_built` until its part lands. Parts, one file each under `hub/` so they are built side by side:
//! admission (`start`: lanes, the queue, reuse, the ticket), the poller and pools (what `status` and `watch` show),
//! results (`wait`, the `Answer`), the merge queue, and tests and trends.

use std::pin::Pin;
use std::sync::Arc;

use serde::Deserialize;
use tokio::sync::{broadcast, watch};

use super::contract::{
    Answer, MainFact, Origin, RunResult, Snapshot, StartReply, StartRequest, StatusRequest,
    WaitRequest,
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

/// The real hub.
pub struct Hub {
    pub github: Arc<dyn GithubSource>,
    pub local: Arc<dyn LocalSource>,
    pub snapshot: watch::Sender<Arc<Snapshot>>,
    pub results: broadcast::Sender<RunResult>,
}

impl Hub {
    pub fn new(github: Arc<dyn GithubSource>, local: Arc<dyn LocalSource>) -> Hub {
        Hub {
            github,
            local,
            snapshot: watch::Sender::new(Arc::new(Snapshot::empty(crate::clock::now_ms()))),
            results: broadcast::Sender::new(RESULTS_KEPT),
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
