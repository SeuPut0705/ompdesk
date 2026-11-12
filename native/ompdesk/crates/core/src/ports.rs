//! How a subsystem in the core reaches what main still owns: its state, read synchronously in the TypeScript, and its
//! code (Electron, the pool, the windows). One port per live object main opened (`CorePort`, `src/main/core/ports.ts`).
//!
//! - The core asks with the event `port` `{port, ask, method, args}` and main answers with the request `ports.answer`
//!   `{port, ask, ok: true, value}` or `{port, ask, ok: false, message, code?}`. A tell is the same event without `ask`:
//!   nothing answers it, and it reaches main in the order the core sent it (one writer).
//! - Main's state (what a TypeScript caller read synchronously) is a snapshot main takes at the moment it observes a
//!   change and pushes (`ports.push {port, seq, state}`), and also hands with every answer (`state`, `seq`): a step
//!   that resumes after an ask reads main as it was when main answered, never older. Answers and snapshots apply in
//!   the order main wrote them (each in its request's synchronous part), and the numbers keep an older snapshot from
//!   replacing a newer one. After a wait on the core's own clock a step asks for the state (`fresh`), as the
//!   TypeScript read it after its timer.
//! - `ports.held {port}` answers once the port closed (`ports.close`, or the subsystem dropped it); a core that dies
//!   fails it, which is how main learns its port is gone.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot, watch};

use crate::server::{Call, Events, Fault, Registry, Reply};

/// Main's answer to an ask that failed: what it threw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortError {
    pub message: String,
    /// The thrown error's `code`, when it had a string one.
    pub code: Option<String>,
}

impl PortError {
    fn closed() -> PortError {
        PortError {
            message: "the port to main closed".into(),
            code: Some("port_closed".into()),
        }
    }
}

impl std::fmt::Display for PortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<PortError> for Fault {
    fn from(error: PortError) -> Fault {
        Fault::new(
            error.code.unwrap_or_else(|| "port_error".into()),
            error.message,
        )
    }
}

type Pending = HashMap<u64, oneshot::Sender<Result<Box<RawValue>, PortError>>>;

/// What the registry holds of a port, whatever its state's type.
trait Sink: Send + Sync {
    fn answer(&self, ask: u64, result: Result<Box<RawValue>, PortError>);
    fn state(&self, seq: u64, state: &RawValue) -> Result<(), Fault>;
    fn close(&self);
    fn closed(&self) -> watch::Receiver<bool>;
    fn events(&self) -> &Events;
}

static PORTS: LazyLock<Mutex<HashMap<u64, Arc<dyn Sink>>>> = LazyLock::new(Default::default);

fn ports() -> MutexGuard<'static, HashMap<u64, Arc<dyn Sink>>> {
    PORTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Inner<S> {
    pending: Pending,
    state: Arc<S>,
    seq: u64,
    closed: bool,
    /// Every waiter that reads each snapshot main pushes, in order (`changes`).
    watchers: Vec<mpsc::UnboundedSender<Arc<S>>>,
}

/// One port to main: its asks, its tells and main's latest state `S`.
pub struct Port<S> {
    id: u64,
    events: Events,
    next_ask: AtomicU64,
    inner: Mutex<Inner<S>>,
    closed: watch::Sender<bool>,
}

#[derive(Serialize)]
struct AskEvent<'a, A: Serialize> {
    port: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask: Option<u64>,
    method: &'a str,
    args: &'a A,
}

impl<S: DeserializeOwned + Send + Sync + 'static> Port<S> {
    /// Opens port `id` (main's number) with the state main sent first. Refuses an id already open.
    pub fn open(events: &Events, id: u64, state: S) -> Result<Arc<Port<S>>, Fault> {
        let port = Arc::new(Port {
            id,
            events: events.clone(),
            next_ask: AtomicU64::new(1),
            inner: Mutex::new(Inner {
                pending: HashMap::new(),
                state: Arc::new(state),
                seq: 0,
                closed: false,
                watchers: Vec::new(),
            }),
            closed: watch::channel(false).0,
        });
        let mut all = ports();
        if all.contains_key(&id) {
            return Err(Fault::new(
                "port_taken",
                format!("port {id} is already open"),
            ));
        }
        all.insert(id, port.clone());
        Ok(port)
    }

    /// Opens a port from a request's raw state.
    pub fn open_raw(events: &Events, id: u64, state: &RawValue) -> Result<Arc<Port<S>>, Fault> {
        let state = serde_json::from_str(state.get())
            .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
        Port::open(events, id, state)
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    fn lock(&self) -> MutexGuard<'_, Inner<S>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Main's state as main last said it.
    pub fn state(&self) -> Arc<S> {
        self.lock().state.clone()
    }

    /// Every snapshot main sends from now on, in the order main took them, also one replaced a moment later: a wait
    /// that looks for a state sees it even when it held only between two of main's steps (3a's `Glance`). The stream
    /// ends when the port closes.
    pub fn changes(&self) -> mpsc::UnboundedReceiver<Arc<S>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut inner = self.lock();
        if !inner.closed {
            inner.watchers.push(tx);
        }
        rx
    }

    /// Main's state now: one ask, answered with the state.
    pub async fn fresh(&self) -> Result<Arc<S>, PortError> {
        self.ask_raw("state", &()).await?;
        Ok(self.state())
    }

    /// Calls `method` in main and reads its answer as `T`.
    pub async fn ask<T: DeserializeOwned, A: Serialize>(
        &self,
        method: &str,
        args: &A,
    ) -> Result<T, PortError> {
        let raw = self.ask_raw(method, args).await?;
        serde_json::from_str(raw.get()).map_err(|error| PortError {
            message: format!("{method}: main answered {error}"),
            code: Some("port_answer".into()),
        })
    }

    /// Calls `method` in main and hands its answer back unread.
    pub async fn ask_raw<A: Serialize>(
        &self,
        method: &str,
        args: &A,
    ) -> Result<Box<RawValue>, PortError> {
        let ask = self.next_ask.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut inner = self.lock();
            if inner.closed {
                return Err(PortError::closed());
            }
            inner.pending.insert(ask, tx);
        }
        self.events.send(
            "port",
            &AskEvent {
                port: self.id,
                ask: Some(ask),
                method,
                args,
            },
        );
        rx.await.unwrap_or_else(|_| Err(PortError::closed()))
    }

    /// Tells main something it does not answer. Ordered with every other frame the core sends.
    pub fn tell<A: Serialize>(&self, method: &str, args: &A) {
        if self.lock().closed {
            return;
        }
        self.events.send(
            "port",
            &AskEvent {
                port: self.id,
                ask: None,
                method,
                args,
            },
        );
    }

    /// Closes the port: every ask still waiting fails, and later ones fail at once.
    pub fn close(&self) {
        Sink::close(self);
    }

    /// Resolves once the port is closed.
    pub async fn until_closed(&self) {
        let mut closed = self.closed.subscribe();
        let _ = closed.wait_for(|closed| *closed).await;
    }
}

impl<S: DeserializeOwned + Send + Sync + 'static> Sink for Port<S> {
    fn answer(&self, ask: u64, result: Result<Box<RawValue>, PortError>) {
        let waiter = self.lock().pending.remove(&ask);
        if let Some(waiter) = waiter {
            let _ = waiter.send(result);
        }
    }

    fn state(&self, seq: u64, state: &RawValue) -> Result<(), Fault> {
        if seq <= self.lock().seq {
            return Ok(());
        }
        let state: S = serde_json::from_str(state.get()).map_err(|error| {
            Fault::new("invalid_params", format!("port {} state: {error}", self.id))
        })?;
        let mut inner = self.lock();
        if seq > inner.seq {
            let state = Arc::new(state);
            inner.seq = seq;
            inner.state = state.clone();
            inner
                .watchers
                .retain(|watcher| watcher.send(state.clone()).is_ok());
        }
        Ok(())
    }

    fn close(&self) {
        let pending = {
            let mut inner = self.lock();
            inner.closed = true;
            inner.watchers.clear();
            std::mem::take(&mut inner.pending)
        };
        for (_, waiter) in pending {
            let _ = waiter.send(Err(PortError::closed()));
        }
        ports().remove(&self.id);
        self.closed.send_replace(true);
    }

    fn closed(&self) -> watch::Receiver<bool> {
        self.closed.subscribe()
    }

    fn events(&self) -> &Events {
        &self.events
    }
}

impl<S> Drop for Port<S> {
    fn drop(&mut self) {
        self.closed.send_replace(true);
    }
}

/// Applies a snapshot as `ports.push` would: what a test of a subsystem uses to play main.
#[cfg(test)]
pub(crate) fn apply_state<S: DeserializeOwned + Send + Sync + 'static>(
    port: &Port<S>,
    seq: u64,
    state: &str,
) -> Result<(), Fault> {
    let state = RawValue::from_string(state.to_owned())
        .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
    Sink::state(port, seq, &state)
}

/// Answers ask `ask` as `ports.answer` would: `Ok(json)` or `Err((message, code))`.
#[cfg(test)]
pub(crate) fn apply_answer<S: DeserializeOwned + Send + Sync + 'static>(
    port: &Port<S>,
    ask: u64,
    result: Result<&str, (&str, Option<&str>)>,
) {
    let result = match result {
        Ok(json) => Ok(RawValue::from_string(json.to_owned()).expect("an answer is JSON")),
        Err((message, code)) => Err(PortError {
            message: message.to_owned(),
            code: code.map(str::to_owned),
        }),
    };
    Sink::answer(port, ask, result);
}

/// `ports.answer`, `ports.push` and `ports.close` act in their handler's synchronous part, which the server runs in
/// its read loop before it reads the next line (`server.rs` `begin`): each applies in the order main wrote it, so a
/// step reads main's answers and snapshots in the order main observed them, and a call main sends after a push
/// starts on that push's state. Nothing here waits.
pub fn register(registry: &mut Registry) {
    registry.add("ports.answer", |call| now(answer(&call)));
    registry.add("ports.push", |call| now(push(&call)));
    registry.add("ports.close", |call| now(close(&call)));
    registry.add("ports.held", |call| Box::pin(held(call)));
}

fn now(result: Result<Reply, Fault>) -> crate::server::Answer {
    Box::pin(std::future::ready(result))
}

/// Closes every port whose asks go to `events`' output, or to none any more: `serve` calls it when its input ended,
/// because main stops the core in its quit teardown before it could close them, and a main that died never does.
/// What waits on such a port (an ask, `ports.held`, a subsystem's `until_closed`) ends with it, so nothing held open
/// for main keeps the core from exiting.
pub fn close_all(events: &Events) {
    let open: Vec<Arc<dyn Sink>> = ports()
        .values()
        .filter(|port| !port.events().reaches_another(events))
        .cloned()
        .collect();
    for port in open {
        port.close();
    }
}

fn sink(port: u64) -> Option<Arc<dyn Sink>> {
    ports().get(&port).cloned()
}

#[derive(Deserialize)]
struct AnswerParams {
    port: u64,
    ask: u64,
    ok: bool,
    #[serde(default)]
    value: Option<Box<RawValue>>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    seq: Option<u64>,
    #[serde(default)]
    state: Option<Box<RawValue>>,
}

fn answer(call: &Call) -> Result<Reply, Fault> {
    let params: AnswerParams = call.params()?;
    let Some(port) = sink(params.port) else {
        return Reply::json(&());
    };
    // The state first: the step the answer wakes reads it.
    if let (Some(seq), Some(state)) = (params.seq, params.state.as_deref()) {
        port.state(seq, state)?;
    }
    let result = if params.ok {
        Ok(params
            .value
            .unwrap_or_else(|| RawValue::from_string("null".into()).expect("null is JSON")))
    } else {
        Err(PortError {
            message: params.message.unwrap_or_default(),
            code: params.code,
        })
    };
    port.answer(params.ask, result);
    Reply::json(&())
}

#[derive(Deserialize)]
struct PushParams {
    port: u64,
    seq: u64,
    state: Box<RawValue>,
}

fn push(call: &Call) -> Result<Reply, Fault> {
    let params: PushParams = call.params()?;
    if let Some(port) = sink(params.port) {
        port.state(params.seq, &params.state)?;
    }
    Reply::json(&())
}

#[derive(Deserialize)]
struct PortParams {
    port: u64,
}

fn close(call: &Call) -> Result<Reply, Fault> {
    let params: PortParams = call.params()?;
    if let Some(port) = sink(params.port) {
        port.close();
    }
    Reply::json(&())
}

async fn held(call: Call) -> Result<Reply, Fault> {
    let params: PortParams = call.params()?;
    let Some(port) = sink(params.port) else {
        return Reply::json(&());
    };
    let mut closed = port.closed();
    drop(port);
    let _ = closed.wait_for(|closed| *closed).await;
    Reply::json(&())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize, Default)]
    struct State {
        n: u64,
    }

    fn raw(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.into()).unwrap()
    }

    #[test]
    fn an_older_snapshot_never_replaces_a_newer_one() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let events = crate::server::test_events(&tx);
        let port: Arc<Port<State>> = Port::open(&events, 9_001, State::default()).unwrap();
        Sink::state(&*port, 2, &raw(r#"{"n":2}"#)).unwrap();
        Sink::state(&*port, 1, &raw(r#"{"n":1}"#)).unwrap();
        assert_eq!(port.state().n, 2);
        port.close();
    }

    #[tokio::test]
    async fn the_end_of_main_s_input_closes_its_ports_and_ends_what_holds_them() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let events = crate::server::test_events(&tx);
        let (other_tx, _other_rx) = tokio::sync::mpsc::unbounded_channel();
        let other = crate::server::test_events(&other_tx);
        let port: Arc<Port<State>> = Port::open(&events, 9_004, State::default()).unwrap();
        let kept: Arc<Port<State>> = Port::open(&other, 9_005, State::default()).unwrap();
        let held = {
            let port = port.clone();
            tokio::spawn(async move { port.until_closed().await })
        };
        let asked = {
            let port = port.clone();
            tokio::spawn(async move { port.ask_raw("x", &()).await })
        };
        tokio::task::yield_now().await;
        close_all(&events);
        held.await.unwrap();
        assert!(asked.await.unwrap().is_err());
        assert!(sink(9_004).is_none());
        // Another connection's port is none of this input's.
        assert!(sink(9_005).is_some());
        kept.close();
    }

    #[tokio::test]
    async fn a_watcher_sees_every_snapshot_in_order_also_one_replaced_at_once() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let events = crate::server::test_events(&tx);
        let port: Arc<Port<State>> = Port::open(&events, 9_003, State::default()).unwrap();
        let mut changes = port.changes();
        Sink::state(&*port, 1, &raw(r#"{"n":1}"#)).unwrap();
        Sink::state(&*port, 2, &raw(r#"{"n":2}"#)).unwrap();
        Sink::state(&*port, 2, &raw(r#"{"n":9}"#)).unwrap();
        assert_eq!(changes.recv().await.unwrap().n, 1);
        assert_eq!(changes.recv().await.unwrap().n, 2);
        port.close();
        assert!(changes.recv().await.is_none());
    }

    #[tokio::test]
    async fn a_closed_port_fails_what_waits_and_what_comes() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let events = crate::server::test_events(&tx);
        let port: Arc<Port<State>> = Port::open(&events, 9_002, State::default()).unwrap();
        let waiting = {
            let port = port.clone();
            tokio::spawn(async move { port.ask_raw("x", &()).await })
        };
        tokio::task::yield_now().await;
        port.close();
        assert_eq!(
            waiting.await.unwrap().unwrap_err().code.as_deref(),
            Some("port_closed")
        );
        assert!(port.ask_raw("y", &()).await.is_err());
        assert!(sink(9_002).is_none());
    }
}
