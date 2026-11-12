//! The control socket's server side (was `src/main/control-socket/{server,endpoint,events,router}.ts`): anything on
//! this computer that holds the token (a terminal omp, a script, another agent CLI) drives OMPdesk the way its own
//! agents do with the `ompdesk_*` tools. The `ompdesk` CLI (`crates/cli`) is its client; the wire between them is
//! `src/shared/control-protocol.ts` as main spelled it, kept byte for byte.
//!
//! Here: the folder, token and endpoint file (`endpoint`), the listener (`listen`), a connection's framing, auth and
//! limits (`conn`), the requests with their waits and timeouts (`router`), the event ring (`events`). What a tool
//! call does and which session a name means stay main's, where the agent-control service lives: `link` is how this
//! side asks it.
//!
//! Methods: `control.prepareDir`, `control.token` (what `prepareControlDir` and `readOrCreateToken` were),
//! `control.listen` (bind, serve, publish `endpoint.json`), `control.close`, `control.closed` (the request main
//! keeps open on a listener: its failure is how main learns the core died), `control.push` (main's answers and
//! news). A listener that is still up when the core's input ends is closed then (`close_all`), so the socket file and
//! `endpoint.json` go even when main never asked.

mod conn;
mod endpoint;
mod events;
mod frame;
pub(crate) mod js;
mod link;
mod listen;
mod router;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::sync::watch;

use crate::server::{Call, Events, Fault, Registry, Reply};
use link::{Ask, Link, Push};
use listen::Listening;

/// A session as the waits see it. `blocked`: it waits on the person; `working`: a turn runs; `idle`: neither;
/// `starting`: its omp is on its way; `stopped`: its omp exited or failed. Main decides which (`sessionState`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Working,
    Blocked,
    Idle,
    Starting,
    Stopped,
}

/// One open session agents may see.
#[derive(Clone, Debug, Deserialize)]
pub struct View {
    pub session: String,
    pub title: String,
    pub state: SessionState,
}

/// What a tab did, as main's pool tells it (`TabActivity`): `busy`, `ask`, `idle`, `released`, and others that only
/// say "look at the sessions again".
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    #[serde(rename = "type")]
    pub kind: String,
    pub tab_id: String,
    pub request_id: Option<String>,
    pub text: Option<String>,
    pub stop_reason: Option<String>,
}

/// A process outside OMPdesk on one connection (main's `OutsideCaller`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Caller {
    pub id: String,
    pub name: String,
    pub title: String,
    pub cwd: String,
}

/// The server's limits and beats. Main sends none of them; its tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Tuning {
    /// The first line must be the hello within this.
    pub hello_timeout_ms: u64,
    /// Connections at once; the next is turned away.
    pub max_connections: usize,
    /// A connection's requests running at once.
    pub max_in_flight: usize,
    /// A wait asks for the sessions on this beat: a plan proposal raises no activity.
    pub poll_ms: u64,
    /// How long a send-and-wait waits to see the session start working (or ask) before `agent_prompt_stalled`.
    pub start_wait_ms: u64,
    /// The event ring's size.
    pub event_capacity: usize,
    /// The event stream asks for the sessions on this beat.
    pub event_poll_ms: u64,
}

impl Default for Tuning {
    fn default() -> Tuning {
        Tuning {
            hello_timeout_ms: 10_000,
            max_connections: 64,
            max_in_flight: 16,
            poll_ms: 500,
            start_wait_ms: 5_000,
            event_capacity: 1024,
            event_poll_ms: 1_000,
        }
    }
}

/// A listening control socket, by the number main gave it.
struct Server {
    link: Arc<Link>,
    listening: Listening,
    path: String,
    /// The folder `endpoint.json` was published in.
    published: Option<String>,
    /// Where its asks go: the `serve` whose input's end closes it.
    events: Events,
    /// Set once it closed, for the request main holds on it (`control.closed`).
    closed: Arc<watch::Sender<bool>>,
}

static SERVERS: LazyLock<Mutex<HashMap<u64, Server>>> = LazyLock::new(Default::default);

fn servers() -> MutexGuard<'static, HashMap<u64, Server>> {
    SERVERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn register(registry: &mut Registry) {
    registry.add("control.prepareDir", |call| Box::pin(prepare_dir(call)));
    registry.add("control.token", |call| Box::pin(token(call)));
    registry.add("control.listen", |call| Box::pin(listen(call)));
    registry.add("control.close", |call| Box::pin(close(call)));
    registry.add("control.closed", |call| Box::pin(closed(call)));
    registry.add("control.push", |call| Box::pin(push(call)));
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The control folder call panicked"))?
}

#[derive(Deserialize)]
struct DirParams {
    dir: String,
    uid: Option<u32>,
    #[serde(default)]
    exposed: bool,
}

#[derive(Serialize)]
struct Repaired {
    repaired: bool,
}

async fn prepare_dir(call: Call) -> Result<Reply, Fault> {
    let params: DirParams = call.params()?;
    let repaired = blocking(move || endpoint::prepare_dir(&params.dir, params.uid)).await?;
    Reply::json(&Repaired { repaired })
}

#[derive(Serialize)]
struct Token {
    token: String,
}

async fn token(call: Call) -> Result<Reply, Fault> {
    let params: DirParams = call.params()?;
    let token = blocking(move || endpoint::token(&params.dir, params.uid, params.exposed)).await?;
    Reply::json(&Token { token })
}

/// Where the listener publishes itself: `endpoint.json` in `dir`, holding `endpoint` as main wrote it.
#[derive(Deserialize)]
struct Publish {
    dir: String,
    endpoint: Box<RawValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenParams {
    server: u64,
    path: String,
    token: String,
    home: String,
    #[serde(default)]
    caller_prefix: String,
    publish: Option<Publish>,
    hello_timeout_ms: Option<u64>,
    max_connections: Option<usize>,
    max_in_flight: Option<usize>,
    poll_ms: Option<u64>,
    start_wait_ms: Option<u64>,
    event_capacity: Option<usize>,
    event_poll_ms: Option<u64>,
}

/// An ask as main reads it: the event `control`.
#[derive(Serialize)]
struct AskEvent<'a> {
    server: u64,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    call: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    caller: Option<&'a Caller>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    on: Option<bool>,
}

fn ask_event(server: u64, ask: &Ask) -> AskEvent<'_> {
    let mut event = AskEvent {
        server,
        kind: "poll",
        call: None,
        caller: None,
        tool: None,
        args: None,
        name: None,
        on: None,
    };
    match ask {
        Ask::Run {
            call,
            caller,
            tool,
            args,
        } => {
            event.kind = "run";
            event.call = Some(*call);
            event.caller = Some(caller);
            event.tool = Some(tool);
            event.args = args.as_deref();
        }
        Ask::Resolve { call, caller, name } => {
            event.kind = "resolve";
            event.call = Some(*call);
            event.caller = Some(caller);
            event.name = Some(name);
        }
        Ask::Release { caller } => {
            event.kind = "release";
            event.caller = Some(caller);
        }
        Ask::Watch { on } => {
            event.kind = "watch";
            event.on = Some(*on);
        }
        Ask::Poll => {}
    }
    event
}

async fn listen(call: Call) -> Result<Reply, Fault> {
    let params: ListenParams = call.params()?;
    let defaults = Tuning::default();
    let tuning = Tuning {
        hello_timeout_ms: params.hello_timeout_ms.unwrap_or(defaults.hello_timeout_ms),
        max_connections: params.max_connections.unwrap_or(defaults.max_connections),
        max_in_flight: params.max_in_flight.unwrap_or(defaults.max_in_flight),
        poll_ms: params.poll_ms.unwrap_or(defaults.poll_ms).max(1),
        start_wait_ms: params.start_wait_ms.unwrap_or(defaults.start_wait_ms),
        event_capacity: params.event_capacity.unwrap_or(defaults.event_capacity),
        event_poll_ms: params
            .event_poll_ms
            .unwrap_or(defaults.event_poll_ms)
            .max(1),
    };
    if servers().contains_key(&params.server) {
        return Err(Fault::new(
            "invalid_params",
            format!("control server {} already listens", params.server),
        ));
    }
    let events = call.events.clone();
    let server = params.server;
    let link = Link::new(tuning, {
        let events = events.clone();
        move |ask| events.send("control", &ask_event(server, &ask))
    });
    let serving = conn::Serving {
        link: Arc::clone(&link),
        token: params.token.into(),
        home: params.home.into(),
        caller_prefix: params.caller_prefix.into(),
        hello_timeout: Duration::from_millis(tuning.hello_timeout_ms),
        max_in_flight: tuning.max_in_flight,
        half_close: cfg!(unix),
    };
    let listening = listen::listen(&params.path, serving, tuning.max_connections).await?;
    let mut published = None;
    if let Some(publish) = params.publish {
        let dir = publish.dir.clone();
        let written =
            blocking(move || endpoint::write_endpoint(&publish.dir, publish.endpoint.get())).await;
        if let Err(fault) = written {
            listening.close().await;
            return Err(fault);
        }
        published = Some(dir);
    }
    servers().insert(
        params.server,
        Server {
            link,
            listening,
            path: params.path,
            published,
            events,
            closed: Arc::new(watch::channel(false).0),
        },
    );
    Reply::json(&serde_json::Map::new())
}

async fn close_server(server: Server) {
    server.listening.close().await;
    server.link.close();
    if let Some(dir) = server.published {
        // Only while it still names this socket: a newer OMPdesk's file is not ours to delete.
        let _ = blocking(move || endpoint::remove_endpoint(&dir, &server.path)).await;
    }
    server.closed.send_replace(true);
}

#[derive(Deserialize)]
struct CloseParams {
    server: u64,
}

async fn close(call: Call) -> Result<Reply, Fault> {
    let params: CloseParams = call.params()?;
    let server = servers().remove(&params.server);
    if let Some(server) = server {
        close_server(server).await;
    }
    Reply::json(&serde_json::Map::new())
}

/// Answers once the listener closed (at once when it is not there): the request main keeps open on a listener. An
/// answer says it closed in order, by `control.close` or at the end of the core's input; a core that dies fails the
/// request instead, which is how main learns its socket is gone.
async fn closed(call: Call) -> Result<Reply, Fault> {
    let params: CloseParams = call.params()?;
    let closed = servers()
        .get(&params.server)
        .map(|server| server.closed.subscribe());
    if let Some(mut closed) = closed {
        tokio::select! {
            // A sender that is gone closed too.
            _ = closed.wait_for(|closed| *closed) => {}
            () = call.scope.on_cancel() => return Err(Fault::cancelled()),
        }
    }
    Reply::json(&serde_json::Map::new())
}

/// Closes every listener whose asks go to `events`' output, or to none any more. `serve` calls it when its input
/// ended: main stops the core in its quit teardown before anything could ask for the close, and a main that died
/// never asks. The socket file and `endpoint.json` go with it.
pub async fn close_all(events: &Events) {
    let open: Vec<Server> = {
        let mut servers = servers();
        let numbers: Vec<u64> = servers
            .iter()
            .filter(|(_, server)| !server.events.reaches_another(events))
            .map(|(number, _)| *number)
            .collect();
        numbers
            .into_iter()
            .filter_map(|number| servers.remove(&number))
            .collect()
    };
    for server in open {
        close_server(server).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushParams {
    server: u64,
    seq: u64,
    kind: String,
    views: Option<Vec<View>>,
    call: Option<u64>,
    began: Option<u64>,
    ok: Option<bool>,
    value: Option<Box<RawValue>>,
    message: Option<String>,
    activity: Option<Activity>,
    to: Option<String>,
    text: Option<String>,
}

async fn push(call: Call) -> Result<Reply, Fault> {
    let params: PushParams = call.params()?;
    let invalid = |what: &str| Fault::new("invalid_params", format!("control.push: {what}"));
    let push = match params.kind.as_str() {
        "reply" => Push::Reply {
            call: params
                .call
                .ok_or_else(|| invalid("a reply names its call"))?,
            result: match (params.ok, params.value) {
                (Some(true), Some(value)) => Ok(value),
                _ => Err(params.message.unwrap_or_default()),
            },
            began: params.began,
        },
        "activity" => Push::Activity(
            params
                .activity
                .ok_or_else(|| invalid("an activity is missing"))?,
        ),
        "views" => Push::Views,
        "mail" => Push::Mail {
            to: params
                .to
                .ok_or_else(|| invalid("a report names its caller"))?,
            text: params.text.unwrap_or_default(),
        },
        other => return Err(invalid(&format!("unknown kind {other}"))),
    };
    let link = servers()
        .get(&params.server)
        .map(|server| Arc::clone(&server.link));
    // A push for a listener that closed meanwhile has nobody to tell.
    if let Some(link) = link {
        link.push(params.seq, push, params.views).await?;
    }
    Reply::json(&serde_json::Map::new())
}
