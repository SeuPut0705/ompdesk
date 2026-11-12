//! The stateless requests of Autopilot's parts, the way the parity suites of `audit`, `branches`, `land_check` and `ship`
//! drive them (the run itself uses the same functions in this process): `autopilot.snapshot`, `autopilot.audit`,
//! `autopilot.branchEntries`, `autopilot.branchInfo`, `autopilot.landCheck` and the ship queue's `autopilot.ship.*`.
//! A request that needs main (the land check's checkout preparation and shell, a ship queue's hooks) is handed a port
//! (`crate::ports`) as the coordinator is.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::MainPort;
use super::audit::{self, Scope, Snapshot};
use super::branches;
use super::land_check::{self, Input, LandCheck};
use super::ship::{Fut, Hooks, PrInput, QueueItem, Request, ShipRunner, Target};
use crate::git::run::Git;
use crate::ports::Port;
use crate::run::Runner;
use crate::server::{Answer, Call, Fault, Registry, Reply};

fn failed(fault: Fault) -> Answer {
    Box::pin(async move { Err(fault) })
}

/// A request whose params are `P`, answered with `work`'s value or fault.
fn serve<P, T, F>(call: Call, work: impl FnOnce(P, Call) -> F) -> Answer
where
    P: serde::de::DeserializeOwned,
    T: serde::Serialize,
    F: Future<Output = Result<T, Fault>> + Send + 'static,
{
    let params: P = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let scope_call = Call {
        params: call.params.clone(),
        bin: None,
        scope: call.scope.clone(),
        events: call.events.clone(),
    };
    let work = work(params, scope_call);
    Box::pin(async move { Reply::json(&work.await?) })
}

/// A request whose work is done now, in the order the requests came: the ship queue's calls change one queue state, and a
/// call made right after another must find what that one did.
fn sync<P, T>(call: Call, work: impl FnOnce(P, &Call) -> Result<T, Fault>) -> Answer
where
    P: serde::de::DeserializeOwned,
    T: serde::Serialize + Send + 'static,
{
    let done = call.params().and_then(|params| work(params, &call));
    Box::pin(async move { Reply::json(&done?) })
}

/// `sync` for work that goes on after its start (the drain): `work` runs now and returns what is left to wait for.
fn launch<P, T, F>(call: Call, work: impl FnOnce(P, &Call) -> Result<F, Fault>) -> Answer
where
    P: serde::de::DeserializeOwned,
    T: serde::Serialize,
    F: Future<Output = T> + Send + 'static,
{
    match call.params().and_then(|params| work(params, &call)) {
        Ok(rest) => Box::pin(async move { Reply::json(&rest.await) }),
        Err(fault) => failed(fault),
    }
}

#[derive(Deserialize)]
struct SnapshotParams {
    git: Runner,
    root: String,
    #[serde(default, rename = "checkoutRoot")]
    checkout_root: Option<String>,
}

#[derive(Deserialize)]
struct AuditParams {
    git: Runner,
    root: String,
    before: Snapshot,
    after: Snapshot,
    scope: Scope,
}

#[derive(Deserialize)]
struct BranchParams {
    git: Runner,
    cwd: String,
    remote: String,
    #[serde(default)]
    toplevel: Option<String>,
}

#[derive(Deserialize)]
struct LandParams {
    port: u64,
    state: Box<serde_json::value::RawValue>,
    git: Runner,
    input: Input,
    #[serde(default, rename = "stopGraceMs")]
    stop_grace_ms: Option<u64>,
}

// ---- the ship queue ---------------------------------------------------------------------------------------------

static SHIPS: LazyLock<Mutex<HashMap<u64, Arc<ShipRunner>>>> = LazyLock::new(Default::default);

fn ship_of(port: u64) -> Result<Arc<ShipRunner>, Fault> {
    SHIPS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&port)
        .cloned()
        .ok_or_else(|| Fault::new("ship_closed", "The ship queue is not open on this port"))
}

/// The ship queue's hooks as asks of the port's owner: a parity suite's recording stand-ins.
struct PortHooks {
    port: MainPort,
    custom_check: bool,
}

fn asked<T: serde::de::DeserializeOwned + Send + 'static>(
    port: &MainPort,
    method: &'static str,
    args: Value,
) -> Fut<Result<T, String>> {
    let port = port.clone();
    Box::pin(async move {
        port.ask::<T, _>(method, &args)
            .await
            .map_err(|error| error.message)
    })
}

impl Hooks for PortHooks {
    fn journal(&self, action: Value) -> Fut<Result<(), String>> {
        let ask = asked::<Value>(&self.port, "shipJournal", action);
        Box::pin(async move { ask.await.map(|_| ()) })
    }

    fn changed(&self, queue: Vec<QueueItem>) {
        self.port.tell("shipChanged", &queue);
    }

    fn reverted(&self, cycle: i64) -> Fut<Result<(), String>> {
        let ask = asked::<Value>(&self.port, "shipReverted", json!({"cycle": cycle}));
        Box::pin(async move { ask.await.map(|_| ()) })
    }

    fn pr_text(&self) -> Fut<Result<(String, String), String>> {
        #[derive(Deserialize)]
        struct Text {
            title: String,
            body: String,
        }
        let ask = asked::<Text>(&self.port, "shipPrText", json!({}));
        Box::pin(async move { ask.await.map(|text| (text.title, text.body)) })
    }

    fn pr_create(&self, cwd: String, input: PrInput) -> Fut<Result<(String, i64), String>> {
        #[derive(Deserialize)]
        struct Created {
            url: String,
            number: i64,
        }
        let ask = asked::<Created>(
            &self.port,
            "shipPrCreate",
            json!({"cwd": cwd, "input": input}),
        );
        Box::pin(async move { ask.await.map(|created| (created.url, created.number)) })
    }

    fn check_candidate(&self, input: &Input) -> Option<Fut<LandCheck>> {
        if !self.custom_check {
            return None;
        }
        let port = self.port.clone();
        let args = json!({
            "root": input.root, "primary": input.primary, "sha": input.sha, "base": input.base,
            "command": input.command,
        });
        Some(Box::pin(async move {
            port.ask::<LandCheck, _>("shipCheck", &args)
                .await
                .unwrap_or_else(|error| LandCheck {
                    ok: false,
                    exit_code: None,
                    timed_out: false,
                    duration_ms: 0,
                    tail: error.message,
                })
        }))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShipOpen {
    port: u64,
    state: Box<serde_json::value::RawValue>,
    #[serde(default)]
    drain_max_ms: Option<u64>,
    #[serde(default)]
    stop_grace_ms: Option<u64>,
    #[serde(default)]
    custom_check: bool,
}

#[derive(Deserialize)]
struct ShipEnqueue {
    port: u64,
    request: Request,
    id: String,
    at: i64,
}

#[derive(Deserialize)]
struct ShipTrack {
    port: u64,
    #[serde(default)]
    detail: Option<String>,
    id: String,
    at: i64,
}

#[derive(Deserialize)]
struct ShipFinish {
    port: u64,
    id: String,
    state: String,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize)]
struct ShipId {
    port: u64,
    id: String,
}

#[derive(Deserialize)]
struct ShipOn {
    port: u64,
}

#[derive(Deserialize)]
struct ShipDrain {
    port: u64,
    target: Target,
}

pub fn register(registry: &mut Registry) {
    registry.add("autopilot.snapshot", |call| {
        serve(call, |params: SnapshotParams, call| async move {
            let git = Git::new(params.git, call.scope);
            audit::take_snapshot(&git, &params.root, params.checkout_root.as_deref()).await
        })
    });
    registry.add("autopilot.audit", |call| {
        serve(call, |params: AuditParams, call| async move {
            let git = Git::new(params.git, call.scope);
            audit::audit_cycle(
                &git,
                &params.root,
                &params.before,
                &params.after,
                &params.scope,
            )
            .await
        })
    });
    registry.add("autopilot.branchEntries", |call| {
        serve(call, |params: BranchParams, call| async move {
            let git = Git::new(params.git, call.scope);
            let (entries, default_branch) =
                branches::read_entries(&git, &params.cwd, &params.remote).await;
            Ok(json!({"entries": entries, "defaultBranch": default_branch}))
        })
    });
    registry.add("autopilot.branchInfo", |call| {
        serve(call, |params: BranchParams, call| async move {
            let git = Git::new(params.git, call.scope);
            let toplevel = params.toplevel.unwrap_or_else(|| params.cwd.clone());
            Ok(branches::read_info(&git, &params.cwd, &toplevel, &params.remote).await)
        })
    });
    registry.add("autopilot.landCheck", |call| {
        serve(call, |params: LandParams, call| async move {
            let port: MainPort = Port::open_raw(&call.events, params.port, &params.state)?;
            let git = Git::new(params.git, call.scope.clone());
            let grace = params.stop_grace_ms.unwrap_or(land_check::STOP_GRACE_MS);
            let checked = land_check::check_candidate(
                &git,
                &port,
                &params.input,
                Duration::from_millis(grace),
                &call.scope,
            )
            .await;
            port.close();
            Ok(checked)
        })
    });
    registry.add("autopilot.ship.open", |call| {
        sync(call, |params: ShipOpen, call| {
            let port: MainPort = Port::open_raw(&call.events, params.port, &params.state)?;
            let hooks = Arc::new(PortHooks {
                port: port.clone(),
                custom_check: params.custom_check,
            });
            let runner = ShipRunner::new(
                port.clone(),
                hooks,
                Duration::from_millis(
                    params
                        .drain_max_ms
                        .unwrap_or(super::ship::SHIP_DRAIN_MAX_MS),
                ),
                Duration::from_millis(params.stop_grace_ms.unwrap_or(land_check::STOP_GRACE_MS)),
            );
            SHIPS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(params.port, runner);
            let id = params.port;
            tokio::spawn(async move {
                port.until_closed().await;
                SHIPS
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&id);
            });
            Ok(json!({}))
        })
    });
    registry.add("autopilot.ship.enqueue", |call| {
        sync(call, |params: ShipEnqueue, _| {
            Ok(ship_of(params.port)?.enqueue(&params.request, params.id, params.at))
        })
    });
    registry.add("autopilot.ship.track", |call| {
        sync(call, |params: ShipTrack, _| {
            Ok(ship_of(params.port)?.track(params.detail, params.id, params.at))
        })
    });
    registry.add("autopilot.ship.finish", |call| {
        sync(call, |params: ShipFinish, _| {
            ship_of(params.port)?.finish(&params.id, &params.state, params.detail, params.url);
            Ok(json!({}))
        })
    });
    registry.add("autopilot.ship.cancel", |call| {
        sync(call, |params: ShipId, _| {
            Ok(ship_of(params.port)?.cancel(&params.id))
        })
    });
    registry.add("autopilot.ship.queue", |call| {
        sync(call, |params: ShipOn, _| Ok(ship_of(params.port)?.queue()))
    });
    registry.add("autopilot.ship.drain", |call| {
        launch(call, |params: ShipDrain, _| {
            let runner = ship_of(params.port)?;
            Ok(async move { runner.drain(params.target, None).await })
        })
    });
}
