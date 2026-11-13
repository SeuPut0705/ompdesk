//! Check control (`docs/design/check-control.md`): agents start, wait for and judge checks through one hub that sees
//! every computer and GitHub runner as one pool. New, nothing moved from TypeScript.
//!
//! - `contract`: every shape that crosses a boundary, the one source (`src/shared/checks-contract.ts` mirrors it).
//! - `hub`: the `ChecksHub` trait and the real `Hub` over the two fact adapters.
//! - `sources`: `GithubSource` and `LocalSource`, with their in-memory fakes.
//! - `fake`: a scripted `ChecksHub` for tests and the dev harness.
//! - The real hub's parts, one file each: `admission` (when a start runs), `policy` (what it dispatches), `ticket`
//!   (the dispatch's admission ticket), `answer` (a run's result as an agent reads it), `poller` (the one reader of
//!   GitHub and the pools, and the real sources), `queue` (the merge queue), `results` (test reports into test
//!   results), `trends` (flaky tests, slowdowns, cost) and `place` (local or runner).
//!
//! The wire, each a request of main's with `hub`, main's id for the hub it opened:
//! `checks.open {hub, fake?}`, `checks.close {hub}`, `checks.start {hub, origin, request}` → `StartReply`,
//! `checks.wait {hub, origin, request}` → `Answer` (answers when the result arrived, the wait ran out or the request
//! was cancelled), `checks.status {hub, origin, request}` → `Snapshot`, `checks.watch {hub, on}` → `Snapshot` (and the
//! event `checks.snapshot {hub, snapshot}` at each change while on), `checks.pause {hub, paused}`,
//! `checks.facts {hub, fact}` (what main knows: `MainFact`), `checks.runners {hub, gh, git, home}` (how gh and git
//! run), and for a fake hub `checks.fake {hub, op}`. The event `checks.result {hub, result}` is sent for every result,
//! whoever waits. `origin` is main's word for who asks, never a caller's.
//!
//! The agent tool's body runs in this process (`agentctl`) and calls the hub directly: `checks::hub(id)`.

pub mod admission;
pub mod answer;
pub mod contract;
pub mod fake;
pub mod hub;
pub mod place;
pub mod policy;
pub mod poller;
pub mod queue;
pub mod results;
pub mod sources;
pub mod ticket;
pub mod trends;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use tokio::task::AbortHandle;

use self::contract::{
    MainFact, Origin, RunResult, Snapshot, StartRequest, StatusRequest, WaitRequest, wire,
};
use self::fake::{FakeHub, FakeOp};
use self::hub::{ChecksHub, Runners};
use crate::server::{Call, Events, Fault, Registry, Reply};

/// A hub main opened, and what it sends main.
struct Entry {
    hub: Arc<dyn ChecksHub>,
    /// The same hub when it is a fake one.
    fake: Option<Arc<FakeHub>>,
    events: Events,
    results: AbortHandle,
    watching: Mutex<Option<AbortHandle>>,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.results.abort();
        if let Some(watching) = locked(&self.watching).take() {
            watching.abort();
        }
    }
}

static HUBS: LazyLock<Mutex<HashMap<u64, Arc<Entry>>>> = LazyLock::new(Default::default);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn entry(id: u64) -> Result<Arc<Entry>, Fault> {
    locked(&HUBS)
        .get(&id)
        .cloned()
        .ok_or_else(|| Fault::new("no_hub", format!("no checks hub {id}")))
}

/// The hub main opened as `id`, for the code of this process that asks it (the agent tool's body).
pub fn hub(id: u64) -> Option<Arc<dyn ChecksHub>> {
    locked(&HUBS).get(&id).map(|entry| Arc::clone(&entry.hub))
}

/// A fake hub opened as `id`, for a test of code that asks `hub(id)` in-process; `close_fake` it at the test's end.
#[cfg(test)]
pub(crate) fn open_fake(id: u64) -> Arc<FakeHub> {
    let fake = Arc::new(FakeHub::default());
    let (events, frames, _) = Events::capture();
    std::mem::forget(frames);
    let entry = Arc::new(Entry {
        hub: fake.clone(),
        fake: Some(fake.clone()),
        events,
        results: tokio::spawn(async {}).abort_handle(),
        watching: Mutex::new(None),
    });
    locked(&HUBS).insert(id, entry);
    fake
}

#[cfg(test)]
pub(crate) fn close_fake(id: u64) {
    locked(&HUBS).remove(&id);
}

/// Closes every hub whose events go to `events`' output, or to none any more (`serve` calls it when its input ended).
pub fn close_all(events: &Events) {
    locked(&HUBS).retain(|_, entry| entry.events.reaches_another(events));
}

#[derive(Serialize)]
struct ResultEvent<'a> {
    hub: u64,
    result: &'a RunResult,
}

#[derive(Serialize)]
struct SnapshotEvent<'a> {
    hub: u64,
    snapshot: &'a Snapshot,
}

#[derive(Deserialize)]
struct OpenParams {
    hub: u64,
    /// A scripted hub (`fake.rs`) instead of the real one.
    #[serde(default)]
    fake: bool,
    /// This computer's admission key, from main's safeStorage (`ticket.rs`): `{device, key}` with the key in hex.
    /// Absent: dispatches carry no ticket.
    #[serde(default)]
    admission: Option<AdmissionParams>,
}

#[derive(Deserialize)]
struct AdmissionParams {
    device: String,
    key: String,
}

/// Where the real hub keeps its state: beside the check journals (`<cache>/ompdesk/checks/hub`).
fn hub_dir() -> Option<std::path::PathBuf> {
    poller::local::store_root(&|name| std::env::var(name).ok()).map(|root| root.join("hub"))
}

async fn open(call: Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    let (hub, fake): (Arc<dyn ChecksHub>, Option<Arc<FakeHub>>) = if params.fake {
        let fake = Arc::new(FakeHub::default());
        (fake.clone(), Some(fake))
    } else {
        let real = hub::Hub::real(hub_dir());
        real.set_key(
            params
                .admission
                .as_ref()
                .and_then(|given| ticket::AdmissionKey::from_hex(&given.device, &given.key)),
        );
        (Arc::new(real), None)
    };
    let (id, events) = (params.hub, call.events.clone());
    let mut results = hub.results();
    let results = tokio::spawn(async move {
        loop {
            match results.recv().await {
                Ok(result) => events.send(
                    wire::RESULT,
                    &ResultEvent {
                        hub: id,
                        result: &result,
                    },
                ),
                // A reader that fell behind lost the oldest results; the snapshot still holds each run's answer.
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            }
        }
    })
    .abort_handle();
    let entry = Arc::new(Entry {
        hub,
        fake,
        events: call.events,
        results,
        watching: Mutex::new(None),
    });
    locked(&HUBS).insert(id, entry);
    Reply::json(&())
}

#[derive(Deserialize)]
struct HubParams {
    hub: u64,
}

async fn close(call: Call) -> Result<Reply, Fault> {
    let params: HubParams = call.params()?;
    locked(&HUBS).remove(&params.hub);
    Reply::json(&())
}

#[derive(Deserialize)]
struct AskParams<T> {
    hub: u64,
    origin: Origin,
    request: T,
}

async fn start(call: Call) -> Result<Reply, Fault> {
    let params: AskParams<StartRequest> = call.params()?;
    let hub = entry(params.hub)?.hub.clone();
    Reply::json(&hub.start(params.origin, params.request).await?)
}

async fn wait(call: Call) -> Result<Reply, Fault> {
    let params: AskParams<WaitRequest> = call.params()?;
    let hub = entry(params.hub)?.hub.clone();
    Reply::json(
        &hub.wait(params.origin, params.request, call.scope.clone())
            .await?,
    )
}

async fn status(call: Call) -> Result<Reply, Fault> {
    let params: AskParams<StatusRequest> = call.params()?;
    let hub = entry(params.hub)?.hub.clone();
    Reply::json(&hub.status(params.origin, params.request).await?)
}

#[derive(Deserialize)]
struct WatchParams {
    hub: u64,
    on: bool,
}

async fn watch(call: Call) -> Result<Reply, Fault> {
    let params: WatchParams = call.params()?;
    let entry = entry(params.hub)?;
    let mut snapshots = entry.hub.watch();
    let now = Snapshot::clone(&snapshots.borrow_and_update());
    let mut watching = locked(&entry.watching);
    if let Some(before) = watching.take() {
        before.abort();
    }
    if params.on {
        let (id, events) = (params.hub, entry.events.clone());
        let task = tokio::spawn(async move {
            while snapshots.changed().await.is_ok() {
                let snapshot = Arc::clone(&snapshots.borrow_and_update());
                events.send(
                    wire::SNAPSHOT,
                    &SnapshotEvent {
                        hub: id,
                        snapshot: &snapshot,
                    },
                );
            }
        });
        *watching = Some(task.abort_handle());
    }
    Reply::json(&now)
}

#[derive(Deserialize)]
struct PauseParams {
    hub: u64,
    paused: bool,
}

async fn pause(call: Call) -> Result<Reply, Fault> {
    let params: PauseParams = call.params()?;
    let hub = entry(params.hub)?.hub.clone();
    hub.pause(params.paused).await?;
    Reply::json(&())
}

#[derive(Deserialize)]
struct FactParams {
    hub: u64,
    fact: MainFact,
}

async fn facts(call: Call) -> Result<Reply, Fault> {
    let params: FactParams = call.params()?;
    let hub = entry(params.hub)?.hub.clone();
    hub.told(params.fact).await?;
    Reply::json(&())
}

#[derive(Deserialize)]
struct RunnersParams {
    hub: u64,
    #[serde(flatten)]
    runners: Runners,
}

async fn runners(call: Call) -> Result<Reply, Fault> {
    let params: RunnersParams = call.params()?;
    let hub = entry(params.hub)?.hub.clone();
    hub.runners(params.runners).await?;
    Reply::json(&())
}

async fn local_pool(call: Call) -> Result<Reply, Fault> {
    let params: HubParams = call.params()?;
    let hub = entry(params.hub)?.hub.clone();
    Reply::json(&hub.local_pool().await?)
}

#[derive(Deserialize)]
struct FakeParams {
    hub: u64,
    op: FakeOp,
}

async fn fake(call: Call) -> Result<Reply, Fault> {
    let params: FakeParams = call.params()?;
    let entry = entry(params.hub)?;
    let Some(fake) = &entry.fake else {
        return Err(Fault::new(
            "not_fake",
            format!("checks hub {} is not a fake one", params.hub),
        ));
    };
    Reply::json(&fake.apply(params.op))
}

pub fn register(registry: &mut Registry) {
    registry.add(wire::OPEN, |call| Box::pin(open(call)));
    registry.add(wire::CLOSE, |call| Box::pin(close(call)));
    registry.add(wire::START, |call| Box::pin(start(call)));
    registry.add(wire::WAIT, |call| Box::pin(wait(call)));
    registry.add(wire::STATUS, |call| Box::pin(status(call)));
    registry.add(wire::WATCH, |call| Box::pin(watch(call)));
    registry.add(wire::PAUSE, |call| Box::pin(pause(call)));
    registry.add(wire::FACTS, |call| Box::pin(facts(call)));
    registry.add(wire::RUNNERS, |call| Box::pin(runners(call)));
    registry.add(wire::LOCAL_POOL, |call| Box::pin(local_pool(call)));
    registry.add(wire::FAKE, |call| Box::pin(fake(call)));
}
