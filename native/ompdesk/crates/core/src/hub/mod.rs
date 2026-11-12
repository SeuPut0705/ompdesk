//! The hub: one thread that runs the subsystems whose rules main calls synchronously and that call one another in the
//! same tick, as they did in main's one JavaScript thread (the sidecar pool and turn resume, batch H2:
//! `docs/rust-remaining-units.md` §2.4, 9d–9f).
//!
//! **Main waits for every call.** Main's code reads the pool in the same tick it changed it (179 call sites, event
//! listeners that change and read), so main's thread blocks on each call (`Atomics.wait`, `src/main/core/hub.ts`)
//! while a worker thread of main holds the connection. A call is a job that runs to its end here and answers with
//! every item it made before its answer; the core never waits on main inside one (it could not answer: main waits),
//! so a question to main (`Out::ask`) is asked only from an async continuation, which runs after the call answered.
//!
//! **JavaScript's order.** A job (a call, or a wake of a timer or of an answer from elsewhere) is a macrotask: it runs
//! to its end, then every task it made ready runs until none is (the microtasks), then what they told main goes out,
//! and only then does the next job start. Tasks are this thread's own (`spawn`), polled by `drain`; a tokio timer or
//! channel they await wakes them from any thread.
//!
//! **What goes to main.** One ordered list per connection: items an instance pushes (`hub.out {to, items}`, consecutive
//! items of one instance in one frame) and answers (`{id, ok, result|error}`), in the order they were made, and after
//! each job with its microtasks a `{"tick": true}`. Main handles what came before its call's answer inside the call,
//! and what came after it, up to the tick, in a microtask after the call returned: the order JavaScript gave a method's
//! own code and the promise continuations it woke.
//!
//! **Connection.** Main names a private socket (Unix) or pipe (Windows) and a token in the core's environment
//! (`OMPDESK_HUB`, `OMPDESK_HUB_TOKEN`); the core listens there from its start (`listen_from_env`). The first line of a
//! connection is `{"token": …}`; a connection without the token is closed. An instance belongs to the connection that
//! opened it and closes with it.
//!
//! Requests (one JSON object per line): `hub.open {id, kind, opts}`, `hub.call {to, method, params}`,
//! `hub.close {id}`, `hub.answer {ask, value?, error?}`, `hub.sync {}` (a barrier).

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Wake, Waker};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::server::Fault;

mod listen;
mod probe;
#[cfg(test)]
mod tests;

pub use listen::listen_from_env;

/// A future that lives on the hub thread.
pub type LocalFuture<T> = Pin<Box<dyn Future<Output = T>>>;

/// What a method answers: at once, or once its `async` rule is done.
pub enum Outcome {
    Now(Result<Value, Fault>),
    Later(LocalFuture<Result<Value, Fault>>),
}

impl Outcome {
    pub fn ok<T: Serialize>(value: &T) -> Outcome {
        Outcome::Now(to_value(value))
    }

    pub fn done() -> Outcome {
        Outcome::Now(Ok(Value::Null))
    }

    pub fn fault(code: &'static str, message: impl Into<String>) -> Outcome {
        Outcome::Now(Err(Fault::new(code, message)))
    }
}

pub fn to_value<T: Serialize>(value: &T) -> Result<Value, Fault> {
    serde_json::to_value(value).map_err(|error| Fault::new("internal", error.to_string()))
}

/// The params of a method as `T`; a mismatch is `invalid_params`.
pub fn params<T: serde::de::DeserializeOwned>(params: &RawValue) -> Result<T, Fault> {
    serde_json::from_str(params.get())
        .map_err(|error| Fault::new("invalid_params", error.to_string()))
}

/// One kind of instance: how it is opened, how its methods run and how it ends.
pub struct Kind {
    pub name: &'static str,
    /// Makes the instance `id` from main's `opts`; it keeps `out` to tell main things.
    pub open: fn(id: u64, opts: &RawValue, out: Out) -> Result<(), Fault>,
    /// Runs `method` of instance `id`.
    pub call: fn(id: u64, method: &str, params: &RawValue) -> Outcome,
    /// Forgets instance `id` (its tasks see it gone and end).
    pub close: fn(id: u64),
}

/// Every kind the hub runs.
fn kinds() -> &'static [Kind] {
    &[
        probe::KIND,
        crate::pool::KIND,
        crate::pool::layout::KIND,
        crate::resume::RESUME_KIND,
        crate::resume::CONNECTIVITY_KIND,
    ]
}

// ---- the executor -------------------------------------------------------------------------------------------------

type Job = Box<dyn FnOnce() + Send>;

/// Woken tasks, by id: a waker may run on any thread.
struct Ready {
    ids: Mutex<VecDeque<u64>>,
    notify: Notify,
}

static READY: LazyLock<Arc<Ready>> = LazyLock::new(|| {
    Arc::new(Ready {
        ids: Mutex::default(),
        notify: Notify::new(),
    })
});

struct TaskWaker {
    id: u64,
}

impl Wake for TaskWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        let ready = &*READY;
        ready
            .ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(self.id);
        ready.notify.notify_one();
    }
}

#[derive(Default)]
struct Tasks {
    next: u64,
    /// A task's future; `None` while it is being polled.
    live: HashMap<u64, Option<LocalFuture<()>>>,
}

thread_local! {
    static TASKS: RefCell<Tasks> = RefCell::default();
}

static JOBS: LazyLock<mpsc::UnboundedSender<Job>> = LazyLock::new(|| {
    let (jobs, queue) = mpsc::unbounded_channel::<Job>();
    let started = std::thread::Builder::new()
        .name("ompdesk-hub".into())
        .spawn(move || run(queue));
    if let Err(error) = started {
        eprintln!("ompdesk-core: the hub thread did not start: {error}");
    }
    jobs
});

fn run(mut queue: mpsc::UnboundedReceiver<Job>) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("ompdesk-core: the hub cannot start its runtime: {error}");
            return;
        }
    };
    runtime.block_on(async move {
        let ready = Arc::clone(&READY);
        loop {
            tokio::select! {
                biased;
                job = queue.recv() => match job {
                    Some(job) => job(),
                    None => break,
                },
                () = ready.notify.notified() => {}
            }
            drain();
            flush();
        }
    });
}

/// Polls every ready task until none is: the microtasks of the job that just ran.
fn drain() {
    loop {
        let next = READY
            .ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front();
        let Some(id) = next else { return };
        // Taken out while it is polled: polling may spawn or wake other tasks.
        let future =
            TASKS.with(|tasks| tasks.borrow_mut().live.get_mut(&id).and_then(Option::take));
        let Some(mut future) = future else { continue };
        let waker = Waker::from(Arc::new(TaskWaker { id }));
        let mut context = Context::from_waker(&waker);
        let done = future.as_mut().poll(&mut context).is_ready();
        TASKS.with(|tasks| {
            let mut tasks = tasks.borrow_mut();
            if done {
                tasks.live.remove(&id);
            } else if let Some(slot) = tasks.live.get_mut(&id) {
                *slot = Some(future);
            }
        });
    }
}

/// Runs `job` on the hub thread after every job posted before it.
pub fn post(job: impl FnOnce() + Send + 'static) {
    let _ = JOBS.send(Box::new(job));
}

/// Starts a task on the hub thread (call only from it); it first runs in this job's microtasks.
pub fn spawn(task: impl Future<Output = ()> + 'static) {
    let id = TASKS.with(|tasks| {
        let mut tasks = tasks.borrow_mut();
        tasks.next += 1;
        let id = tasks.next;
        tasks.live.insert(id, Some(Box::pin(task)));
        id
    });
    Arc::new(TaskWaker { id }).wake();
}

// ---- connections, instances and what goes to main -----------------------------------------------------------------

type ConnId = u64;

enum Line {
    Items {
        to: u64,
        items: Vec<Value>,
    },
    Answer {
        id: u64,
        result: Result<Value, Fault>,
    },
}

struct Conn {
    lines: mpsc::UnboundedSender<String>,
    /// What this connection is owed, in the order it was made.
    pending: Vec<Line>,
}

struct Instance {
    kind: &'static Kind,
    conn: ConnId,
}

#[derive(Default)]
struct Hub {
    conns: HashMap<ConnId, Conn>,
    next_conn: ConnId,
    instances: HashMap<u64, Instance>,
    /// Asks waiting for main, with the instance that asked: its close fails them.
    asks: HashMap<u64, (u64, oneshot::Sender<Result<Value, Fault>>)>,
    next_ask: u64,
}

thread_local! {
    static HUB: RefCell<Hub> = RefCell::default();
}

fn with_hub<T>(work: impl FnOnce(&mut Hub) -> T) -> T {
    HUB.with(|hub| work(&mut hub.borrow_mut()))
}

#[derive(Serialize)]
struct ItemsFrame<'a> {
    event: &'static str,
    data: ItemsData<'a>,
}

#[derive(Serialize)]
struct ItemsData<'a> {
    to: u64,
    items: &'a [Value],
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

/// Writes what every connection is owed.
fn flush() {
    with_hub(|hub| {
        for conn in hub.conns.values_mut() {
            let wrote = !conn.pending.is_empty();
            for line in conn.pending.drain(..) {
                let text = match line {
                    Line::Items { to, items } => serde_json::to_string(&ItemsFrame {
                        event: "hub.out",
                        data: ItemsData { to, items: &items },
                    }),
                    Line::Answer {
                        id,
                        result: Ok(value),
                    } => serde_json::to_string(
                        &serde_json::json!({"id": id, "ok": true, "result": value}),
                    ),
                    Line::Answer {
                        id,
                        result: Err(fault),
                    } => serde_json::to_string(&serde_json::json!({
                        "id": id,
                        "ok": false,
                        "error": ErrorBody { code: &fault.code, message: &fault.message },
                    })),
                };
                match text {
                    Ok(text) => {
                        let _ = conn.lines.send(text);
                    }
                    Err(error) => eprintln!("ompdesk-core: a hub line did not serialize: {error}"),
                }
            }
            // The end of a job and its microtasks: what main's caller reads after its answer up to here ran in
            // microtasks of the call, and main hands it over as such.
            if wrote {
                let _ = conn.lines.send(r#"{"tick":true}"#.to_owned());
            }
        }
    });
}

fn answer(conn: ConnId, id: u64, result: Result<Value, Fault>) {
    with_hub(|hub| {
        if let Some(conn) = hub.conns.get_mut(&conn) {
            conn.pending.push(Line::Answer { id, result });
        }
    });
}

/// An instance's way to tell main things. Cheap to copy; items of an instance that closed are dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Out {
    id: u64,
}

impl Out {
    pub fn id(self) -> u64 {
        self.id
    }

    /// Whether the instance is still open.
    pub fn open(self) -> bool {
        with_hub(|hub| hub.instances.contains_key(&self.id))
    }

    /// Queues `item` (an object with a `k`) after everything this connection is owed so far.
    pub fn push<T: Serialize>(self, item: &T) {
        let value = match serde_json::to_value(item) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("ompdesk-core: a hub item did not serialize: {error}");
                return;
            }
        };
        with_hub(|hub| {
            let Some(conn) = hub.instances.get(&self.id).map(|instance| instance.conn) else {
                return;
            };
            let Some(conn) = hub.conns.get_mut(&conn) else {
                return;
            };
            match conn.pending.last_mut() {
                Some(Line::Items { to, items }) if *to == self.id => items.push(value),
                _ => conn.pending.push(Line::Items {
                    to: self.id,
                    items: vec![value],
                }),
            }
        });
    }

    /// Asks main `q` and waits for what main's handler returns at once (an item `{k: "ask", ask, q, sync: true,
    /// …payload}`): main answers it before it does anything else, also while it waits for the call this is part of.
    /// A method that awaits this suspends there, and what main does meanwhile (a sidecar that emits as it is started,
    /// a hook) reaches the hub as nested calls, as a listener ran inside the TypeScript method. Resolves with main's
    /// answer, or fails `closed` once the instance closes first.
    pub fn ask<T: Serialize>(self, q: &str, payload: &T) -> LocalFuture<Result<Value, Fault>> {
        self.ask_with(q, payload, true)
    }

    /// Asks main `q` for something it answers later (a promise of main's: an RPC command, a probe). Never awaited
    /// inside a synchronous call: main cannot answer while it waits for that call.
    pub fn ask_later<T: Serialize>(
        self,
        q: &str,
        payload: &T,
    ) -> LocalFuture<Result<Value, Fault>> {
        self.ask_with(q, payload, false)
    }

    fn ask_with<T: Serialize>(
        self,
        q: &str,
        payload: &T,
        sync: bool,
    ) -> LocalFuture<Result<Value, Fault>> {
        let (answer, answered) = oneshot::channel();
        let mut item = match serde_json::to_value(payload) {
            Ok(Value::Object(map)) => map,
            Ok(Value::Null) => serde_json::Map::new(),
            Ok(_) | Err(_) => {
                return Box::pin(async {
                    Err(Fault::new("internal", "an ask's payload is no object"))
                });
            }
        };
        let ask = with_hub(|hub| {
            hub.next_ask += 1;
            hub.asks.insert(hub.next_ask, (self.id, answer));
            hub.next_ask
        });
        item.insert("k".into(), Value::from("ask"));
        item.insert("ask".into(), Value::from(ask));
        item.insert("q".into(), Value::from(q));
        item.insert("sync".into(), Value::from(sync));
        self.push(&Value::Object(item));
        Box::pin(async move {
            answered.await.unwrap_or_else(|_| {
                Err(Fault::new(
                    "closed",
                    "The instance closed before main answered",
                ))
            })
        })
    }
}

fn kind_of(name: &str) -> Option<&'static Kind> {
    kinds().iter().find(|kind| kind.name == name)
}

/// Closes instance `id`: its asks fail, its kind forgets it.
fn close_instance(id: u64) {
    let instance = with_hub(|hub| {
        // Dropping an ask's sender fails it: nobody will answer for an instance that is gone.
        hub.asks.retain(|_, (asker, _)| *asker != id);
        hub.instances.remove(&id)
    });
    if let Some(instance) = instance {
        (instance.kind.close)(id);
    }
}

// ---- requests -----------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Request {
    id: u64,
    method: String,
    params: Box<RawValue>,
}

#[derive(Deserialize)]
struct OpenParams {
    id: u64,
    kind: String,
    opts: Box<RawValue>,
}

#[derive(Deserialize)]
struct CallParams {
    to: u64,
    method: String,
    params: Box<RawValue>,
}

#[derive(Deserialize)]
struct CloseParams {
    id: u64,
}

#[derive(Deserialize)]
struct AnswerParams {
    ask: u64,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    error: Option<AnswerError>,
}

#[derive(Deserialize)]
struct AnswerError {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: String,
}

/// Runs one request on the hub thread. Its answer is queued now (`Now`) or by its continuation (`Later`).
fn handle(conn: ConnId, request: Request) {
    let id = request.id;
    let outcome = match request.method.as_str() {
        "hub.open" => Outcome::Now(open(conn, &request.params)),
        "hub.call" => match params::<CallParams>(&request.params) {
            Ok(call) => {
                let kind =
                    with_hub(|hub| hub.instances.get(&call.to).map(|instance| instance.kind));
                match kind {
                    Some(kind) => (kind.call)(call.to, &call.method, &call.params),
                    None => Outcome::fault("no_instance", format!("No instance {}", call.to)),
                }
            }
            Err(fault) => Outcome::Now(Err(fault)),
        },
        "hub.close" => Outcome::Now(params::<CloseParams>(&request.params).map(|close| {
            close_instance(close.id);
            Value::Null
        })),
        "hub.answer" => Outcome::Now(params::<AnswerParams>(&request.params).map(|params| {
            let waiting = with_hub(|hub| hub.asks.remove(&params.ask));
            // An answer to an ask nobody waits for any more (its instance closed) is dropped.
            if let Some((_, waiting)) = waiting {
                let result = match params.error {
                    Some(error) => Err(Fault::new(
                        error.code.unwrap_or_else(|| "main_error".into()),
                        error.message,
                    )),
                    None => Ok(params.value),
                };
                let _ = waiting.send(result);
            }
            Value::Null
        })),
        // A barrier: answered once every job before it ran, so main has handled all they told it when it returns.
        "hub.sync" => Outcome::done(),
        other => Outcome::fault("no_method", format!("The hub has no method {other}")),
    };
    match outcome {
        Outcome::Now(result) => answer(conn, id, result),
        Outcome::Later(future) => spawn(async move {
            let result = future.await;
            answer(conn, id, result);
        }),
    }
}

fn open(conn: ConnId, params: &RawValue) -> Result<Value, Fault> {
    let params: OpenParams = self::params(params)?;
    let kind = kind_of(&params.kind)
        .ok_or_else(|| Fault::new("unknown_kind", format!("The hub runs no {}", params.kind)))?;
    let id = params.id;
    if with_hub(|hub| hub.instances.contains_key(&id)) {
        return Err(Fault::new(
            "instance_open",
            format!("Instance {id} is already open"),
        ));
    }
    with_hub(|hub| hub.instances.insert(id, Instance { kind, conn }));
    if let Err(fault) = (kind.open)(id, &params.opts, Out { id }) {
        with_hub(|hub| hub.instances.remove(&id));
        return Err(fault);
    }
    Ok(Value::Null)
}

/// Serves one connection of main's: its requests run on the hub thread in the order their lines came, its answers
/// and items go out in the order they were made. Returns when the connection ends; its instances close then.
/// With `token`, the first line must be `{"token": token}`, or the connection is closed unserved.
pub async fn serve_conn<R, W>(reader: R, mut writer: W, token: Option<String>)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    if let Some(token) = token {
        #[derive(Deserialize)]
        struct Hello {
            token: String,
        }
        let read = reader.read_line(&mut line).await;
        let hello = serde_json::from_str::<Hello>(line.trim_end());
        let proved = matches!(read, Ok(n) if n > 0)
            && hello
                .is_ok_and(|hello| crate::control::conn::token_matches(Some(hello.token), &token));
        if !proved {
            eprintln!("ompdesk-core: the hub closed a connection without its token");
            return;
        }
    }
    let (lines, mut outgoing) = mpsc::unbounded_channel::<String>();
    let (registered, conn) = oneshot::channel();
    post(move || {
        let conn = with_hub(|hub| {
            hub.next_conn += 1;
            let conn = hub.next_conn;
            hub.conns.insert(
                conn,
                Conn {
                    lines,
                    pending: Vec::new(),
                },
            );
            conn
        });
        let _ = registered.send(conn);
    });
    let Ok(conn) = conn.await else { return };
    let writing = tokio::spawn(async move {
        while let Some(mut line) = outgoing.recv().await {
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() {
                return;
            }
        }
        let _ = writer.flush().await;
    });
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        match serde_json::from_str::<Request>(line.trim_end()) {
            Ok(request) => post(move || handle(conn, request)),
            Err(error) => eprintln!("ompdesk-core: the hub skipped a line: {error}"),
        }
    }
    post(move || {
        let ids: Vec<u64> = with_hub(|hub| {
            hub.instances
                .iter()
                .filter(|(_, instance)| instance.conn == conn)
                .map(|(id, _)| *id)
                .collect()
        });
        for id in ids {
            close_instance(id);
        }
        // Dropping the sender ends the writer once it wrote what was owed.
        with_hub(|hub| hub.conns.remove(&conn));
    });
    let _ = writing.await;
}
