//! The hub: one thread that runs the subsystems whose rules call one another in the same tick, as they did in main's
//! one JavaScript thread (the sidecar pool and turn resume, batch H2: `docs/rust-remaining-units.md` §2.4, 9d–9f).
//!
//! A JavaScript handler runs to its end, then every promise continuation it made ready runs, and only then does the
//! next message (an IPC call, a socket's data, a timer) start. The hub keeps that order: a job (one request from main)
//! runs to its end on the hub thread, then the hub yields once, so the local tasks the job woke (the continuations of
//! its `async` rules) run before the next job starts. Subsystems hold their state in `Rc<RefCell<…>>` on this thread
//! and call one another directly; one rule borrows another's state only for a moment and never across a call out,
//! because a JavaScript rule may re-enter another (the pool's `onRunningChange` runs turn resume's `sync`, which sets
//! the pool's `awaitingConnection`).
//!
//! An instance (one `SidecarPool`, one `TurnResume`, one `ConnectivityMonitor` of main's) is opened by `hub.open`,
//! which answers only when the instance is closed, so main learns of a lost core by its rejection. Main names the id.
//! Everything an instance tells main goes out as items of one `hub.out` event per instance and flush, in order; the
//! answer of the request that caused them comes after them, so main's mirror holds a request's effects by the time
//! its caller reads the answer. An item may ask main a question (`ask`), answered by `hub.answer`.
//!
//! Requests: `hub.open {id, kind, opts}` → `{}` once closed; `hub.call {to, method, params}` → the method's value;
//! `hub.close {id}`; `hub.answer {ask, value?, error?}`. Event: `hub.out {to, items: [...]}`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot};

use crate::server::{Answer, Call, Events, Fault, Registry, Reply};

#[cfg(test)]
mod tests;

/// A future that lives on the hub thread.
pub type LocalFuture<T> = Pin<Box<dyn Future<Output = T>>>;

/// What a method answers: at once, or once its `async` rule is done (its continuation runs on the hub thread).
pub enum Outcome {
    Now(Result<Value, Fault>),
    Later(LocalFuture<Result<Value, Fault>>),
}

impl Outcome {
    pub fn ok<T: Serialize>(value: &T) -> Outcome {
        Outcome::Now(to_value(value))
    }

    pub fn done() -> Outcome {
        Outcome::Now(Ok(Value::Object(Default::default())))
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
    /// Forgets instance `id` (its timers and tasks end with it).
    pub close: fn(id: u64),
}

/// Every kind the hub runs.
fn kinds() -> &'static [Kind] {
    &[
        #[cfg(test)]
        tests::PROBE_KIND,
    ]
}

// ---- the thread ---------------------------------------------------------------------------------------------------

type Job = Box<dyn FnOnce() + Send>;

static JOBS: LazyLock<mpsc::UnboundedSender<Job>> = LazyLock::new(|| {
    let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
    let started = std::thread::Builder::new()
        .name("ompdesk-hub".into())
        .spawn(move || {
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
            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, async move {
                while let Some(job) = queue.recv().await {
                    job();
                    // The continuations the job made ready run before the next job, as microtasks do.
                    tokio::task::yield_now().await;
                }
            });
        });
    if let Err(error) = started {
        eprintln!("ompdesk-core: the hub thread did not start: {error}");
    }
    jobs
});

/// Runs `job` on the hub thread, after every job posted before it.
pub fn post(job: impl FnOnce() + Send + 'static) {
    let _ = JOBS.send(Box::new(job));
}

/// Starts a task on the hub thread; call only from it.
pub fn spawn<F: Future<Output = ()> + 'static>(task: F) {
    tokio::task::spawn_local(task);
}

// ---- instances and what they tell main ----------------------------------------------------------------------------

struct Instance {
    kind: &'static Kind,
    events: Events,
    /// Items not yet sent.
    items: Vec<Value>,
    /// Answers `hub.open` when the instance closes.
    closed: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Hub {
    instances: HashMap<u64, Instance>,
    /// Answers waiting for the flush that sends what their request made.
    replies: Vec<(oneshot::Sender<Result<Value, Fault>>, Result<Value, Fault>)>,
    /// Asks waiting for main, with the instance that asked: its close fails them.
    asks: HashMap<u64, (u64, oneshot::Sender<Result<Value, Fault>>)>,
    next_ask: u64,
}

thread_local! {
    static HUB: RefCell<Hub> = RefCell::default();
    static FLUSH_PENDING: Cell<bool> = const { Cell::new(false) };
}

fn with_hub<T>(work: impl FnOnce(&mut Hub) -> T) -> T {
    HUB.with(|hub| work(&mut hub.borrow_mut()))
}

/// Sends what is buffered once the work that is ready now is done.
fn schedule_flush() {
    if FLUSH_PENDING.with(|pending| pending.replace(true)) {
        return;
    }
    spawn(async {
        flush();
    });
}

/// Sends every instance's buffered items, then the answers whose effects they were.
pub fn flush() {
    FLUSH_PENDING.with(|pending| pending.set(false));
    let (sends, replies) = with_hub(|hub| {
        let sends: Vec<(Events, u64, Vec<Value>)> = hub
            .instances
            .iter_mut()
            .filter(|(_, instance)| !instance.items.is_empty())
            .map(|(id, instance)| {
                (
                    instance.events.clone(),
                    *id,
                    std::mem::take(&mut instance.items),
                )
            })
            .collect();
        (sends, std::mem::take(&mut hub.replies))
    });
    let mut sends = sends;
    // Instances flush in the order they were opened, so one main reads the same order every time.
    sends.sort_by_key(|(_, id, _)| *id);
    for (events, to, items) in sends {
        events.send("hub.out", &OutFrame { to, items });
    }
    for (reply, result) in replies {
        let _ = reply.send(result);
    }
}

#[derive(Serialize)]
struct OutFrame {
    to: u64,
    items: Vec<Value>,
}

/// An instance's way to tell main things. Cheap to copy; items to an instance that closed are dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Out {
    id: u64,
}

impl Out {
    pub fn id(self) -> u64 {
        self.id
    }

    /// Buffers `item` (an object with a `k`); it goes out with the next flush, after every item before it.
    pub fn push<T: Serialize>(self, item: &T) {
        let value = match serde_json::to_value(item) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("ompdesk-core: a hub item did not serialize: {error}");
                return;
            }
        };
        let pushed = with_hub(|hub| match hub.instances.get_mut(&self.id) {
            Some(instance) => {
                instance.items.push(value);
                true
            }
            None => false,
        });
        if pushed {
            schedule_flush();
        }
    }

    /// Asks main `q` (an item `{k: "ask", ask, q, ...payload}`); resolves with main's answer, or fails when the
    /// instance closes first.
    pub fn ask<T: Serialize>(self, q: &str, payload: &T) -> LocalFuture<Result<Value, Fault>> {
        let (answer, answered) = oneshot::channel();
        let mut item = match serde_json::to_value(payload) {
            Ok(Value::Object(map)) => map,
            Ok(Value::Null) => Default::default(),
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

/// Closes instance `id`: its kind forgets it, its `hub.open` answers.
fn close_instance(id: u64) {
    let instance = with_hub(|hub| {
        // Dropping an ask's sender fails it: nobody will answer for an instance that is gone.
        hub.asks.retain(|_, (asker, _)| *asker != id);
        hub.instances.remove(&id)
    });
    if let Some(mut instance) = instance {
        (instance.kind.close)(id);
        if let Some(closed) = instance.closed.take() {
            let _ = closed.send(());
        }
    }
}

// ---- requests -----------------------------------------------------------------------------------------------------

pub fn register(registry: &mut Registry) {
    registry.add("hub.open", open);
    registry.add("hub.call", call);
    registry.add("hub.close", close);
    registry.add("hub.answer", answer);
}

fn failed(fault: Fault) -> Answer {
    Box::pin(async move { Err(fault) })
}

#[derive(Deserialize)]
struct OpenParams {
    id: u64,
    kind: String,
    #[serde(default = "empty_object")]
    opts: Box<RawValue>,
}

fn empty_object() -> Box<RawValue> {
    RawValue::from_string("{}".into()).expect("{} is JSON")
}

#[derive(Serialize)]
struct Done {}

fn open(call: Call) -> Answer {
    let params: OpenParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let Some(kind) = kind_of(&params.kind) else {
        return failed(Fault::new(
            "unknown_kind",
            format!("The hub runs no {}", params.kind),
        ));
    };
    let (opened, opened_answer) = oneshot::channel::<Result<(), Fault>>();
    let (closed, closed_answer) = oneshot::channel();
    let events = call.events.clone();
    post(move || {
        let id = params.id;
        let exists = with_hub(|hub| hub.instances.contains_key(&id));
        if exists {
            let _ = opened.send(Err(Fault::new(
                "instance_open",
                format!("Instance {id} is already open"),
            )));
            return;
        }
        with_hub(|hub| {
            hub.instances.insert(
                id,
                Instance {
                    kind,
                    events,
                    items: Vec::new(),
                    closed: Some(closed),
                },
            )
        });
        match (kind.open)(id, &params.opts, Out { id }) {
            Ok(()) => {
                let _ = opened.send(Ok(()));
            }
            Err(fault) => {
                with_hub(|hub| hub.instances.remove(&id));
                let _ = opened.send(Err(fault));
            }
        }
    });
    Box::pin(async move {
        match opened_answer.await {
            Ok(Ok(())) => {}
            Ok(Err(fault)) => return Err(fault),
            Err(_) => return Err(Fault::new("hub_gone", "The hub thread is gone")),
        }
        let _ = closed_answer.await;
        Reply::json(&Done {})
    })
}

#[derive(Deserialize)]
struct CallParams {
    to: u64,
    method: String,
    #[serde(default = "empty_object")]
    params: Box<RawValue>,
}

fn call(call: Call) -> Answer {
    let params: CallParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let (reply, answered) = oneshot::channel();
    // Posted here, before the server reads the next line: the hub runs main's calls in the order main made them.
    post(move || {
        let kind = with_hub(|hub| hub.instances.get(&params.to).map(|instance| instance.kind));
        let Some(kind) = kind else {
            let _ = reply.send(Err(Fault::new(
                "no_instance",
                format!("No instance {}", params.to),
            )));
            return;
        };
        match (kind.call)(params.to, &params.method, &params.params) {
            Outcome::Now(result) => answer_after_flush(reply, result),
            Outcome::Later(future) => spawn(async move {
                let result = future.await;
                answer_after_flush(reply, result);
            }),
        }
    });
    Box::pin(async move {
        let value = answered
            .await
            .unwrap_or_else(|_| Err(Fault::new("hub_gone", "The hub thread is gone")))?;
        Reply::json(&value)
    })
}

fn answer_after_flush(reply: oneshot::Sender<Result<Value, Fault>>, result: Result<Value, Fault>) {
    with_hub(|hub| hub.replies.push((reply, result)));
    schedule_flush();
}

#[derive(Deserialize)]
struct CloseParams {
    id: u64,
}

fn close(call: Call) -> Answer {
    let params: CloseParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let (reply, answered) = oneshot::channel();
    post(move || {
        close_instance(params.id);
        answer_after_flush(reply, Ok(Value::Object(Default::default())));
    });
    Box::pin(async move {
        let _ = answered.await;
        Reply::json(&Done {})
    })
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

fn answer(call: Call) -> Answer {
    let params: AnswerParams = match call.params() {
        Ok(params) => params,
        Err(fault) => return failed(fault),
    };
    let (reply, answered) = oneshot::channel();
    post(move || {
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
        answer_after_flush(reply, Ok(Value::Object(Default::default())));
    });
    Box::pin(async move {
        let _ = answered.await;
        Reply::json(&Done {})
    })
}

/// Ends every instance opened over `events`' output (the connection ended): their `hub.open` requests are moot.
pub fn close_all(events: &Events) {
    let events = events.clone();
    post(move || {
        let ids: Vec<u64> = with_hub(|hub| {
            hub.instances
                .iter()
                .filter(|(_, instance)| !instance.events.reaches_another(&events))
                .map(|(id, _)| *id)
                .collect()
        });
        for id in ids {
            close_instance(id);
        }
    });
}
