//! The edge serving (native-rust ledger 8b; was `src/main/web/server.ts`): `web.start {host, userData, port,
//! staticRoot}` → `{port}` listens on `127.0.0.1` (`port` 0 picks one; a taken port is the fault `EADDRINUSE`, as
//! node's `listen` failed), `web.stop {host}` ends the accept loop, gives the page sockets a second to close and lets the
//! port go. `host` is main's number for its `WebServer`: every ask and socket event of the edge carries it
//! (`relay.rs`). The edge reads the paired devices, the blocks, the uploads, the blob tokens and the kept builds from
//! the core's own stores of that `userData`, the very objects main's clients change.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::json;

use super::assets::Assets;
use super::auth::Policy;
use super::relay::{Relay, RelayRouter};
use super::server::{Deps, Edge, Running, SERVER_HOST};
use crate::server::{Call, Fault, Registry, Reply};

static RUNNING: LazyLock<Mutex<HashMap<u64, Running>>> = LazyLock::new(Mutex::default);

fn running() -> MutexGuard<'static, HashMap<u64, Running>> {
    RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The built renderer main named at the start, and the builds kept beside it.
struct Built {
    root: Option<PathBuf>,
    user_data: PathBuf,
}

impl Assets for Built {
    fn root(&self) -> Option<PathBuf> {
        self.root.clone()
    }

    fn previous_builds(&self) -> Vec<PathBuf> {
        super::archive::open(&self.user_data).roots()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    host: u64,
    user_data: PathBuf,
    port: u16,
    static_root: Option<PathBuf>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

async fn start(call: Call) -> Result<Reply, Fault> {
    let params: StartParams = call.params()?;
    if let Some(running) = running().get(&params.host) {
        return Reply::json(&json!({ "port": running.port }));
    }
    let user_data = params.user_data;
    let stores = super::store::stores(&user_data);
    let blobs = super::blobs::open(&user_data);
    blobs.attach_events(call.events.clone());
    let relay = Relay::new(call.events.clone(), params.host);
    let key_dir = user_data.clone();
    let edge = Edge::new(Deps {
        // Main's policy is read for every request (`Desktop::policy`); this one only stands in until it answers.
        policy: Policy {
            host: SERVER_HOST.to_owned(),
            public_port: 0,
            secure: false,
            serve_prefix: None,
            pending_prefix: None,
            allowed_users: Vec::new(),
        },
        devices: stores.devices.clone(),
        blocks: stores.blocks.clone(),
        whois: relay.clone(),
        desktop: relay.clone(),
        router: Arc::new(RelayRouter(relay.clone())),
        uploads: super::uploads::open(&user_data),
        blobs,
        hooks: Some(relay),
        assets: Arc::new(Built {
            root: params.static_root,
            user_data,
        }),
        push_public_key: Arc::new(move || {
            super::push::loaded(&key_dir)
                .map_or_else(String::new, |vapid| vapid.public_key().to_owned())
        }),
        clock: Arc::new(now_ms),
    });
    let started = edge.start(params.port).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            // node's words for the same failure.
            Fault::new(
                "EADDRINUSE",
                format!(
                    "listen EADDRINUSE: address already in use {SERVER_HOST}:{}",
                    params.port
                ),
            )
        } else {
            Fault::new(
                "web_listen",
                format!("listen {SERVER_HOST}:{}: {error}", params.port),
            )
        }
    })?;
    let port = started.port;
    // Two starts of one host raced: the first one listening stays.
    let raced = {
        let mut table = running();
        match table.get(&params.host) {
            Some(existing) => Some((existing.port, started)),
            None => {
                table.insert(params.host, started);
                None
            }
        }
    };
    if let Some((port, started)) = raced {
        started.stop().await;
        return Reply::json(&json!({ "port": port }));
    }
    Reply::json(&json!({ "port": port }))
}

#[derive(Deserialize)]
struct StopParams {
    host: u64,
}

async fn stop(call: Call) -> Result<Reply, Fault> {
    let params: StopParams = call.params()?;
    let started = running().remove(&params.host);
    if let Some(started) = started {
        started.stop().await;
    }
    Reply::json(&serde_json::Value::Null)
}

pub fn register(registry: &mut Registry) {
    registry.add("web.start", |call| Box::pin(start(call)));
    registry.add("web.stop", |call| Box::pin(stop(call)));
    super::relay::register(registry);
}
