//! Memory's quality upkeep (7c, was `src/main/ai-memory/{upkeep,distill,retitle,rules-file,distill-model,ambiguous-names,supersede}.ts`)
//! and what 7d shares with it: the asks of main (`asks`), the memory operations (`store`), the prompt facts (`facts`)
//! and the model call (`model`).
//!
//! Requests of the upkeep (`upkeep.*`), each carrying its `service` (main names it `${process.pid}-<n>`), the `asks`
//! main answers (see `asks.rs`) and, for a request that reads memory, the `server` main knows and the `stockHost` the
//! prompt facts come from:
//! - `upkeep.tick` and `upkeep.repair` `{service, asks, server?, stockHost?, locale, stateFile, modelCwd, now?}`: one
//!   look at the conversations (`TickOutcome`), the repair at launch (`RetitleReport`, or null when it failed);
//! - `upkeep.retitle` `{service, asks, server?, stockHost?, locale, dryRun}`: the retitle repair alone (`RetitleReport`);
//! - `upkeep.renameAmbiguous` `{service, asks, server?}`: the name repair alone (`NameRepair`);
//! - `upkeep.close` `{service}`: what the service remembered is dropped.
//!
//! `now` is the clock a test drives (ms): the core then reads it wherever the TypeScript read its clock.

pub mod asks;
pub mod distill;
pub mod engine;
pub mod facts;
pub mod model;
pub mod names;
pub mod retitle;
pub mod rules_file;
pub mod store;
pub mod supersede;

#[cfg(test)]
mod engine_tests;

use std::path::PathBuf;

use serde::Deserialize;

use self::asks::Asker;
use self::engine::{Clock, Memory, Upkeep};
use self::facts::Facts;
use self::model::Model;
use self::names::rename_ambiguous_projects;
use self::retitle::retitle_session_pages;
use self::store::Store;
use crate::aimemory::client::Server;
use crate::server::{Call, Fault, Registry, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    service: String,
    #[serde(default)]
    asks: Vec<String>,
    #[serde(default)]
    server: Option<Server>,
    #[serde(default)]
    stock_host: Option<String>,
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    state_file: Option<String>,
    #[serde(default)]
    model_cwd: Option<String>,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    now: Option<f64>,
}

impl Params {
    fn asker(&self, call: &Call) -> Asker {
        Asker::new(self.service.clone(), call.events.clone())
    }

    fn store(&self, asker: &Asker) -> Store {
        let server = self
            .server
            .as_ref()
            .map_or_else(Server::default, |server| Server {
                url: server.url.clone(),
                data_dir: server.data_dir.clone(),
            });
        Store::choose(asker, &self.asks, server)
    }

    fn facts(&self, asker: &Asker) -> Facts {
        Facts::choose(
            asker,
            &self.asks,
            self.stock_host.as_deref().unwrap_or_default(),
        )
    }

    fn locale(&self) -> &str {
        self.locale.as_deref().unwrap_or_default()
    }

    /// The engine of a `tick` or a `repair`.
    fn upkeep(&self, call: &Call) -> Result<Upkeep, Fault> {
        let asker = self.asker(call);
        let state_file = self
            .state_file
            .as_deref()
            .ok_or_else(|| Fault::new("invalid_params", "stateFile: missing"))?;
        let model_cwd = self.model_cwd.clone().unwrap_or_default();
        Ok(Upkeep {
            store: self.store(&asker),
            facts: self.facts(&asker),
            model: Model::choose(&asker, &self.asks, PathBuf::from(model_cwd)),
            asker,
            asks: self.asks.clone(),
            locale: self.locale().to_owned(),
            state_file: PathBuf::from(state_file),
            clock: Clock(self.now),
            memory: Memory::of(&self.service),
        })
    }
}

/// A request that ends when its caller withdraws it.
macro_rules! until_cancelled {
    ($call:expr, $work:expr) => {
        tokio::select! {
            result = $work => result,
            () = $call.scope.on_cancel() => Err(Fault::cancelled()),
        }
    };
}

async fn tick(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let upkeep = params.upkeep(&call)?;
    let outcome = until_cancelled!(call, upkeep.tick())?;
    Reply::json(&outcome)
}

async fn repair(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let upkeep = params.upkeep(&call)?;
    let report = until_cancelled!(call, async { Ok::<_, Fault>(upkeep.repair().await) })?;
    Reply::json(&report)
}

async fn retitle(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let asker = params.asker(&call);
    let (store, facts) = (params.store(&asker), params.facts(&asker));
    let report = until_cancelled!(
        call,
        retitle_session_pages(&store, &facts, params.locale(), params.dry_run)
    )?;
    Reply::json(&report)
}

async fn rename_ambiguous(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let store = params.store(&params.asker(&call));
    let repair = until_cancelled!(call, rename_ambiguous_projects(&store))?;
    Reply::json(&repair)
}

async fn close(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    Memory::forget(&params.service);
    Reply::json(&serde_json::Value::Null)
}

pub fn register(registry: &mut Registry) {
    asks::register(registry);
    model::register(registry);
    register_requests(registry);
}

/// The upkeep's own requests (`upkeep.answer` and `upkeep.runSmol` are the asks' and the model's).
fn register_requests(registry: &mut Registry) {
    registry.add("upkeep.tick", |call| Box::pin(tick(call)));
    registry.add("upkeep.repair", |call| Box::pin(repair(call)));
    registry.add("upkeep.retitle", |call| Box::pin(retitle(call)));
    registry.add("upkeep.renameAmbiguous", |call| {
        Box::pin(rename_ambiguous(call))
    });
    registry.add("upkeep.close", |call| Box::pin(close(call)));
}
