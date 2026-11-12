//! Methods and dispatch. A handler is an async function from a request's params (and its `bin` tail) to a result or
//! a coded error. Requests run concurrently and are answered in completion order; at end of input the server waits
//! for the ones in flight, then returns. A `{"cancel": id}` frame stops the request `id` where its handler looks
//! (every git it runs, `Scope`), and a request answers only once every process it started has ended. What a request
//! leaves running on purpose (a watch) reports through `Events` and ends with the process.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{Semaphore, mpsc, watch};
use tokio::task::JoinSet;

use crate::wire::{self, Frame, Incoming};

/// The wire's version, announced in `ready`.
pub const PROTOCOL: u32 = 1;

/// A failure a request answers with: a stable code and a message.
#[derive(Debug, Clone, PartialEq)]
pub struct Fault {
    pub code: Cow<'static, str>,
    pub message: String,
}

impl Fault {
    pub fn new(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Fault {
        Fault {
            code: code.into(),
            message: message.into(),
        }
    }

    /// What a request stopped by its `cancel` frame answers.
    pub fn cancelled() -> Fault {
        Fault::new("cancelled", "The request was cancelled")
    }
}

/// A request's hold on what it started. `cancel` is set by the request's `{"cancel": id}` frame; the request is
/// answered only once every clone of its scope is gone, so a task that keeps one (a git being ended after its timeout
/// or its cancel) holds the answer until its process exited.
#[derive(Clone)]
pub struct Scope {
    cancel: Arc<watch::Sender<bool>>,
    _alive: mpsc::Sender<()>,
}

impl Scope {
    /// Whether the request was cancelled.
    pub fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    /// Resolves once the request is cancelled (at once when it already was).
    pub async fn on_cancel(&self) {
        let mut cancelled = self.cancel.subscribe();
        // The sender lives in this scope, so the wait ends only by the flag.
        let _ = cancelled.wait_for(|cancelled| *cancelled).await;
    }

    /// A scope no frame cancels and nothing waits on, for code run outside a request (tests).
    #[cfg(test)]
    pub fn detached() -> Scope {
        Scope {
            cancel: Arc::new(watch::channel(false).0),
            _alive: mpsc::channel(1).0,
        }
    }

    /// Cancels the request as its `cancel` frame would (tests).
    #[cfg(test)]
    pub fn cancel(&self) {
        self.cancel.send_replace(true);
    }
}

/// Sends events to main. It outlives the request that was given it (a watch one request starts reports until another
/// stops it), and holds the output only weakly: once the input ended and the requests in flight answered, nothing
/// left running keeps the connection open, and an event sent after that is dropped.
#[derive(Clone)]
pub struct Events {
    frames: mpsc::WeakUnboundedSender<Frame>,
}

impl Events {
    pub fn send<T: Serialize>(&self, event: &str, data: &T) {
        if let Some(frames) = self.frames.upgrade() {
            let _ = frames.send(Frame::event(event, data));
        }
    }

    /// Whether this sends to a live output that is not `other`'s: what one `serve` left running is none of another's.
    pub fn reaches_another(&self, other: &Events) -> bool {
        match (self.frames.upgrade(), other.frames.upgrade()) {
            (Some(mine), Some(theirs)) => !mine.same_channel(&theirs),
            (Some(_), None) => true,
            (None, _) => false,
        }
    }
}

/// What a handler is given.
pub struct Call {
    pub params: Box<RawValue>,
    pub bin: Option<Vec<u8>>,
    pub scope: Scope,
    pub events: Events,
}

impl Call {
    /// The params as `T`; a mismatch is `invalid_params`.
    pub fn params<T: DeserializeOwned>(&self) -> Result<T, Fault> {
        serde_json::from_str(self.params.get())
            .map_err(|error| Fault::new("invalid_params", error.to_string()))
    }
}

/// A handler's answer: its JSON result and an optional `bin` tail.
pub struct Reply {
    pub result: Box<RawValue>,
    pub bin: Option<Vec<u8>>,
}

impl Reply {
    pub fn json<T: Serialize>(value: &T) -> Result<Reply, Fault> {
        let result = serde_json::value::to_raw_value(value)
            .map_err(|error| Fault::new("internal", error.to_string()))?;
        Ok(Reply { result, bin: None })
    }

    pub fn with_bin(mut self, bin: Vec<u8>) -> Reply {
        self.bin = Some(bin);
        self
    }
}

pub type Answer = Pin<Box<dyn Future<Output = Result<Reply, Fault>> + Send>>;
pub type Handler = fn(Call) -> Answer;

/// Method name → handler.
#[derive(Default)]
pub struct Registry {
    methods: HashMap<&'static str, Handler>,
}

impl Registry {
    pub fn add(&mut self, name: &'static str, handler: Handler) {
        let previous = self.methods.insert(name, handler);
        assert!(previous.is_none(), "method {name} registered twice");
    }

    fn get(&self, name: &str) -> Option<Handler> {
        self.methods.get(name).copied()
    }
}

/// Every method the core serves.
pub fn registry() -> Registry {
    let mut registry = Registry::default();
    registry.add("core.echo", |call| Box::pin(echo(call)));
    crate::aimemory::register(&mut registry);
    crate::browsers::register(&mut registry);
    crate::disk::register(&mut registry);
    crate::ext::register(&mut registry);
    crate::fs::register(&mut registry);
    crate::git::register(&mut registry);
    crate::gh::register(&mut registry);
    crate::memory::register(&mut registry);
    crate::models::register(&mut registry);
    crate::omp::register(&mut registry);
    crate::procs::register(&mut registry);
    crate::routines::register(&mut registry);
    crate::schedules::register(&mut registry);
    crate::sessions::register(&mut registry);
    crate::setup::register(&mut registry);
    crate::control::register(&mut registry);
    crate::tailscale::register(&mut registry);
    crate::ssh::register(&mut registry);
    crate::stock::register(&mut registry);
    registry
}

#[derive(Serialize)]
struct Ready {
    version: &'static str,
    protocol: u32,
}

/// The cancel flag of each request in flight, by id.
type InFlight = Arc<Mutex<HashMap<u64, Arc<watch::Sender<bool>>>>>;

fn in_flight(
    requests: &InFlight,
) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<watch::Sender<bool>>>> {
    requests
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Serves requests from `input`, answering on `output`, until `input` ends. Announces `ready` first.
pub async fn serve<R, W>(input: R, output: W, registry: Registry) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let registry = Arc::new(registry);
    let (frames, writer) = wire::spawn_writer(output);
    let ready = Ready {
        version: env!("CARGO_PKG_VERSION"),
        protocol: PROTOCOL,
    };
    let _ = frames.send(Frame::event("ready", &ready));
    let mut reader = BufReader::new(input);
    let mut line = Vec::new();
    let mut tasks = JoinSet::new();
    let requests: InFlight = Arc::default();
    let read_result = loop {
        match wire::read_request(&mut reader, &mut line).await {
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
            Ok(Some(Incoming::Skipped(reason))) => {
                eprintln!("ompdesk-core: skipped a frame: {reason}")
            }
            // A request that already answered (or never came) has nothing to stop.
            Ok(Some(Incoming::Cancel(id))) => {
                if let Some(cancel) = in_flight(&requests).get(&id) {
                    cancel.send_replace(true);
                }
            }
            Ok(Some(Incoming::Request(request))) => {
                let registry = Arc::clone(&registry);
                let frames = frames.clone();
                let requests = Arc::clone(&requests);
                // Registered before the next frame is read, so a cancel that follows always finds it.
                let cancel = Arc::new(watch::channel(false).0);
                in_flight(&requests).insert(request.id, Arc::clone(&cancel));
                let events = Events {
                    frames: frames.downgrade(),
                };
                tasks.spawn(async move {
                    let id = request.id;
                    let frame = match answer(&registry, request, cancel, events).await {
                        Ok(reply) => Frame::result(id, &reply.result, reply.bin),
                        Err(fault) => Frame::error(id, &fault.code, &fault.message),
                    };
                    in_flight(&requests).remove(&id);
                    let _ = frames.send(frame);
                });
            }
        }
        while tasks.try_join_next().is_some() {}
    };
    // Listeners outlive their starting request, but not the input. Check again as each in-flight request ends,
    // including one that was still binding a listener when EOF arrived.
    let ending = Events {
        frames: frames.downgrade(),
    };
    crate::control::close_all(&ending).await;
    crate::ssh::close_all(&ending);
    crate::schedules::close_all(&ending);
    crate::aimemory::service::close_all(&ending);
    crate::stock::close_all(&ending).await;
    while tasks.join_next().await.is_some() {
        crate::control::close_all(&ending).await;
        crate::ssh::close_all(&ending);
        crate::schedules::close_all(&ending);
        crate::aimemory::service::close_all(&ending);
        crate::stock::close_all(&ending).await;
    }
    drop(frames);
    let written = writer.await.map_err(io::Error::other)?;
    read_result.and(written)
}

async fn answer(
    registry: &Registry,
    request: wire::Request,
    cancel: Arc<watch::Sender<bool>>,
    events: Events,
) -> Result<Reply, Fault> {
    let Some(handler) = registry.get(&request.method) else {
        return Err(Fault::new(
            "unknown_method",
            format!("Unknown method \"{}\"", request.method),
        ));
    };
    let (alive, mut ended) = mpsc::channel(1);
    let call = Call {
        params: request.params,
        bin: request.bin,
        scope: Scope {
            cancel,
            _alive: alive,
        },
        events,
    };
    // Its own task, so a panic fails this request instead of the connection.
    let outcome = match tokio::spawn(handler(call)).await {
        Ok(outcome) => outcome,
        Err(error) if error.is_panic() => {
            Err(Fault::new("internal", "The request's handler panicked"))
        }
        Err(_) => Err(Fault::new(
            "internal",
            "The request's handler was cancelled",
        )),
    };
    // Nothing is ever sent: `recv` ends once the last scope (a process's supervisor) is gone.
    let _ = ended.recv().await;
    outcome
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EchoParams {
    #[serde(default)]
    value: serde_json::Value,
    wait_for: Option<String>,
    release: Option<String>,
}

#[derive(Serialize)]
struct EchoResult {
    value: serde_json::Value,
}

/// Named gates for `core.echo`: a `release` opens one for exactly one `waitFor`, in either order.
fn gate(name: &str) -> Arc<Semaphore> {
    static GATES: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
        LazyLock::new(Default::default);
    let mut gates = GATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        gates
            .entry(name.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(0))),
    )
}

/// The wire's own check: answers `value` and the `bin` tail it was given. `waitFor` holds the answer until another
/// request `release`s that name, or until the request is cancelled, which is how the plumbing tests get answers out
/// of order and cancellations without timing.
async fn echo(call: Call) -> Result<Reply, Fault> {
    let params: EchoParams = call.params()?;
    if let Some(name) = &params.release {
        gate(name).add_permits(1);
    }
    if let Some(name) = &params.wait_for {
        let gate = gate(name);
        tokio::select! {
            permit = gate.acquire() => permit
                .map_err(|error| Fault::new("internal", error.to_string()))?
                .forget(),
            () = call.scope.on_cancel() => return Err(Fault::cancelled()),
        }
    }
    let reply = Reply::json(&EchoResult {
        value: params.value,
    })?;
    Ok(match call.bin {
        Some(bin) => reply.with_bin(bin),
        None => reply,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{
        AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf,
    };

    type Lines = tokio::io::BufReader<ReadHalf<DuplexStream>>;

    async fn start(
        registry: Registry,
    ) -> (
        Lines,
        WriteHalf<DuplexStream>,
        tokio::task::JoinHandle<io::Result<()>>,
    ) {
        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(serve(server_read, server_write, registry));
        let (client_read, client_write) = tokio::io::split(client);
        let mut lines = tokio::io::BufReader::new(client_read);
        let mut line = String::new();
        lines.read_line(&mut line).await.unwrap();
        assert!(
            line.starts_with("{\"event\":\"ready\",\"data\":{\"version\":"),
            "{line}"
        );
        (lines, client_write, server)
    }

    async fn next(lines: &mut Lines) -> serde_json::Value {
        let mut line = String::new();
        lines.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test]
    async fn answers_in_completion_order_and_ends_with_its_input() {
        let (mut lines, mut client_write, server) = start(registry()).await;
        client_write
            .write_all(b"{\"id\":1,\"method\":\"core.echo\",\"params\":{\"value\":1,\"waitFor\":\"unit\"}}\n")
            .await
            .unwrap();
        client_write
            .write_all(b"{\"id\":2,\"method\":\"core.echo\",\"params\":{\"value\":2,\"release\":\"unit\"},\"bin\":3}\nxyz")
            .await
            .unwrap();
        client_write
            .write_all(b"garbage\n{\"id\":3,\"method\":\"nope\"}\n")
            .await
            .unwrap();
        let mut answers = Vec::new();
        for _ in 0..3 {
            let head = next(&mut lines).await;
            if head["bin"] == 3 {
                let mut bin = [0; 3];
                lines.read_exact(&mut bin).await.unwrap();
                assert_eq!(&bin, b"xyz");
            }
            answers.push(head);
        }
        let position = |id: u64| answers.iter().position(|a| a["id"] == id).unwrap();
        assert!(position(2) < position(1), "{answers:?}");
        assert_eq!(answers[position(1)]["result"]["value"], 1);
        assert_eq!(answers[position(3)]["error"]["code"], "unknown_method");
        client_write.shutdown().await.unwrap();
        drop(client_write);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_cancel_frame_stops_its_request_and_no_other() {
        let (mut lines, mut client_write, server) = start(registry()).await;
        client_write
            .write_all(b"{\"id\":1,\"method\":\"core.echo\",\"params\":{\"waitFor\":\"cancel-unit\"}}\n{\"id\":2,\"method\":\"core.echo\",\"params\":{\"value\":2,\"waitFor\":\"cancel-other\"}}\n{\"cancel\":9}\n{\"cancel\":1}\n")
            .await
            .unwrap();
        let first = next(&mut lines).await;
        assert_eq!(first["id"], 1);
        assert_eq!(first["error"]["code"], "cancelled");
        client_write
            .write_all(b"{\"cancel\":1}\n{\"id\":3,\"method\":\"core.echo\",\"params\":{\"release\":\"cancel-other\"}}\n")
            .await
            .unwrap();
        let mut ids = [next(&mut lines).await, next(&mut lines).await];
        ids.sort_by_key(|answer| answer["id"].as_u64());
        assert_eq!(ids[0]["result"]["value"], 2);
        assert_eq!(ids[1]["id"], 3);
        client_write.shutdown().await.unwrap();
        drop(client_write);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn answers_only_once_what_the_request_left_running_has_ended() {
        static LEFT: LazyLock<Mutex<Option<tokio::sync::oneshot::Sender<()>>>> =
            LazyLock::new(Default::default);
        let mut registry = Registry::default();
        registry.add("test.leave", |call| {
            Box::pin(async move {
                let (finish, finished) = tokio::sync::oneshot::channel::<()>();
                *LEFT.lock().unwrap() = Some(finish);
                let scope = call.scope;
                tokio::spawn(async move {
                    let _ = finished.await;
                    drop(scope);
                });
                Reply::json(&"left")
            })
        });
        let (mut lines, mut client_write, server) = start(registry).await;
        client_write
            .write_all(b"{\"id\":1,\"method\":\"test.leave\"}\n")
            .await
            .unwrap();
        let answered =
            tokio::time::timeout(std::time::Duration::from_millis(200), next(&mut lines)).await;
        assert!(answered.is_err(), "answered while its task still ran");
        let finish = LEFT.lock().unwrap().take().unwrap();
        finish.send(()).unwrap();
        assert_eq!(next(&mut lines).await["result"], "left");
        client_write.shutdown().await.unwrap();
        drop(client_write);
        server.await.unwrap().unwrap();
    }
}
