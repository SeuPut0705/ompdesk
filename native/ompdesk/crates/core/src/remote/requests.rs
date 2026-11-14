//! Application requests on an already authenticated remote link. This consumes the link in the core instead of
//! forwarding its application frames to the former Node callback. Dial, handshake, codec and liveness stay in `link`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::link::{Command, Link};
use crate::server::Fault;

#[derive(Clone, Debug)]
pub struct RemoteEvent {
    pub event: String,
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteError {
    pub fault: Fault,
    /// A validated `session_open_in_tab` holder; an unknown version's malformed holder is ignored.
    pub holder: Option<Value>,
}

impl From<Fault> for RemoteError {
    fn from(fault: Fault) -> Self {
        Self {
            fault,
            holder: None,
        }
    }
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.fault.message)
    }
}

impl std::error::Error for RemoteError {}

pub struct IncomingRequest {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

struct Pending {
    next: u64,
    online: bool,
    replies: HashMap<u64, oneshot::Sender<Result<Value, RemoteError>>>,
}

type Listener = Box<dyn Fn(&RemoteEvent) -> bool + Send + Sync>;

pub(super) struct Inner {
    link: Option<Link>,
    pending: Mutex<Pending>,
    events: broadcast::Sender<RemoteEvent>,
    listeners: Mutex<Vec<Listener>>,
    changes: watch::Sender<bool>,
    incoming: mpsc::UnboundedSender<IncomingRequest>,
    requests: Mutex<Option<mpsc::UnboundedReceiver<IncomingRequest>>>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|p| p.into_inner())
}

fn offline() -> RemoteError {
    Fault::new("remote_offline", "The device running this tab is offline").into()
}

/// A capability to use one link, never a device identity. Only the authenticated connection handoff binds it;
/// nothing in the page's JSON can construct this handle.
#[derive(Clone)]
pub struct RemoteRequests(Arc<Inner>);
pub(crate) struct WeakRequests(std::sync::Weak<Inner>);
impl WeakRequests {
    pub(crate) fn upgrade(&self) -> Option<RemoteRequests> {
        self.0.upgrade().map(RemoteRequests)
    }
}

impl RemoteRequests {
    pub(crate) fn bind(id: u64) -> Result<Self, Fault> {
        let requests = Self::bind_paused(id)?;
        requests.listen();
        Ok(requests)
    }
    pub(crate) fn bind_paused(id: u64) -> Result<Self, Fault> {
        let mut state = super::state();
        if let Some(inner) = state
            .applications
            .get(&id)
            .and_then(std::sync::Weak::upgrade)
        {
            return Ok(Self(inner));
        }
        let link = state
            .links
            .get(&id)
            .cloned()
            .ok_or_else(|| offline().fault)?;
        let requests = Self::with_link(Some(link));
        state.applications.insert(id, Arc::downgrade(&requests.0));
        Ok(requests)
    }
    /// A known saved host may have no transport yet. This endpoint cannot send or grant any authority.
    pub(crate) fn disconnected() -> Self {
        Self::with_link(None)
    }
    fn with_link(link: Option<Link>) -> Self {
        let online = link.is_some();
        let (incoming, requests) = mpsc::unbounded_channel();
        Self(Arc::new(Inner {
            link,
            pending: Mutex::new(Pending {
                next: 0,
                online,
                replies: HashMap::new(),
            }),
            events: broadcast::channel(256).0,
            listeners: Mutex::new(Vec::new()),
            changes: watch::channel(online).0,
            incoming,
            requests: Mutex::new(Some(requests)),
        }))
    }
    pub(crate) fn listen(&self) {
        if let Some(link) = &self.0.link {
            link.command(Command::Listen);
        }
    }
    pub(crate) fn downgrade(&self) -> WeakRequests {
        WeakRequests(Arc::downgrade(&self.0))
    }

    pub fn is_online(&self) -> bool {
        lock(&self.0.pending).online
    }

    pub fn changes(&self) -> watch::Receiver<bool> {
        self.0.changes.subscribe()
    }

    /// Runs in receive order before a following response completes. A false result removes the subscriber.
    /// Callbacks only enqueue work; they must not block or call back into this link.
    pub fn on_event(&self, listener: impl Fn(&RemoteEvent) -> bool + Send + Sync + 'static) {
        lock(&self.0.listeners).push(Box::new(listener));
    }

    pub fn events(&self) -> broadcast::Receiver<RemoteEvent> {
        self.0.events.subscribe()
    }

    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    #[cfg(test)]
    pub(crate) fn disconnect_for_test(&self) {
        if let Some(link) = &self.0.link {
            link.command(Command::Destroy(super::link::Reason::Local));
        }
    }

    /// Exactly one native host dispatcher consumes requests. A second caller never receives a duplicate stream.
    pub fn take_requests(&self) -> Option<mpsc::UnboundedReceiver<IncomingRequest>> {
        lock(&self.0.requests).take()
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RemoteError> {
        let (reply, answer) = oneshot::channel();
        let id = {
            let mut pending = lock(&self.0.pending);
            if !pending.online {
                return Err(offline());
            }
            let id = pending.next;
            // JavaScript peers use exact integer request IDs.
            pending.next = pending
                .next
                .checked_add(1)
                .filter(|id| *id <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    RemoteError::from(Fault::new(
                        "request_ids_exhausted",
                        "Remote request IDs exhausted",
                    ))
                })?;
            let bytes = encode(&json!({"t":"req", "id":id, "method":method, "params":params}))?;
            pending.replies.insert(id, reply);
            if !self
                .0
                .link
                .as_ref()
                .is_some_and(|link| link.try_command(Command::Send(bytes)))
            {
                pending.replies.remove(&id);
                return Err(offline());
            }
            id
        };
        let _pending = Waiting { inner: &self.0, id };
        match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(offline()),
            Err(_) => Err(Fault::new(
                "timeout",
                format!("{method} timed out after {} ms", timeout.as_millis()),
            )
            .into()),
        }
    }

    pub fn emit(&self, event: &str, data: &Value) -> Result<(), RemoteError> {
        self.send(&json!({"t":"evt", "event":event, "data":data}))
    }

    pub fn answer(&self, id: u64, result: Result<Value, RemoteError>) -> Result<(), RemoteError> {
        let message = match result {
            Ok(result) => json!({"t":"res", "id":id, "ok":true, "result":result}),
            Err(error) => {
                let mut value = json!({"t":"res", "id":id, "ok":false,
                    "error":{"code":error.fault.code, "message":error.fault.message}});
                if let Some(holder) = error.holder {
                    value["error"]["holder"] = holder;
                }
                value
            }
        };
        match self.send(&message) {
            Err(error) if error.fault.code == "too_large" => {
                self.send(&json!({"t":"res", "id":id, "ok":false,
                "error":{"code":"too_large", "message":"Remote response exceeds the frame limit"}}))
            }
            result => result,
        }
    }

    fn send(&self, value: &Value) -> Result<(), RemoteError> {
        let bytes = encode(value)?;
        let pending = lock(&self.0.pending);
        if !pending.online
            || !self
                .0
                .link
                .as_ref()
                .is_some_and(|link| link.try_command(Command::Send(bytes)))
        {
            return Err(offline());
        }
        Ok(())
    }
}

struct Waiting<'a> {
    inner: &'a Inner,
    id: u64,
}
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        lock(&self.inner.pending).replies.remove(&self.id);
    }
}

fn encode(value: &Value) -> Result<Vec<u8>, RemoteError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| RemoteError::from(Fault::new("invalid_json", error.to_string())))?;
    // Sealed frames carry a 12-byte nonce and a 16-byte GCM tag even when deflate does not shrink the message.
    if bytes.len() > super::codec::MAX_FRAME_BYTES - 28 {
        return Err(Fault::new("too_large", "Remote message exceeds the frame limit").into());
    }
    Ok(bytes)
}

fn holder(value: &Value) -> Option<Value> {
    let text = |key: &str, min, max| {
        value
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| (min..=max).contains(&text.encode_utf16().count()))
    };
    (text("device", 1, 128) && text("rtab", 1, 128) && text("name", 0, 128))
        .then(|| json!({"device":value["device"], "rtab":value["rtab"], "name":value["name"]}))
}

/// Returns true only when a native application owns the frame; the legacy path gets no second delivery.
pub(super) fn receive(id: u64, bytes: &[u8]) -> bool {
    let inner = super::state()
        .applications
        .get(&id)
        .and_then(std::sync::Weak::upgrade);
    let Some(inner) = inner else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return true;
    };
    match value["t"].as_str() {
        Some("res") => {
            let Some(id) = value["id"].as_u64() else {
                return true;
            };
            let result = match value["ok"].as_bool() {
                Some(true) => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                Some(false) => {
                    let error = &value["error"];
                    let (Some(code), Some(message)) =
                        (error["code"].as_str(), error["message"].as_str())
                    else {
                        return true;
                    };
                    Err(RemoteError {
                        fault: Fault::new(code.to_owned(), message),
                        holder: holder(&error["holder"]),
                    })
                }
                None => return true,
            };
            if let Some(reply) = lock(&inner.pending).replies.remove(&id) {
                let _ = reply.send(result);
            }
        }
        Some("evt") => {
            if let Some(event) = value["event"]
                .as_str()
                .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 128)
            {
                let event = RemoteEvent {
                    event: event.to_owned(),
                    data: value.get("data").cloned().unwrap_or(Value::Null),
                };
                lock(&inner.listeners).retain(|listener| listener(&event));
                if inner.events.receiver_count() > 0 {
                    let _ = inner.events.send(event);
                }
            }
        }
        Some("req") => {
            if let (Some(id), Some(method)) = (
                value["id"].as_u64(),
                value["method"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 128),
            ) {
                let _ = inner.incoming.send(IncomingRequest {
                    id,
                    method: method.to_owned(),
                    params: value.get("params").cloned().unwrap_or(Value::Null),
                });
            }
        }
        _ => {}
    }
    true
}

pub(super) fn closed(id: u64) {
    let inner = super::state()
        .applications
        .remove(&id)
        .and_then(|weak| weak.upgrade());
    if let Some(inner) = inner {
        let replies = {
            let mut pending = lock(&inner.pending);
            pending.online = false;
            std::mem::take(&mut pending.replies)
        };
        inner.changes.send_replace(false);
        lock(&inner.listeners).clear();
        for (_, reply) in replies {
            let _ = reply.send(Err(offline()));
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::remote::link::{Conn, LinkOptions, Liveness};
    use crate::server::Events;
    use tokio::net::{TcpListener, TcpStream};

    pub(crate) async fn pair() -> (
        RemoteRequests,
        RemoteRequests,
        mpsc::UnboundedSender<crate::wire::Frame>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (dial, accept) = tokio::join!(
            TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept()
        );
        let mut a = Conn::new(dial.unwrap());
        let mut b = Conn::new(accept.unwrap().0);
        a.secure(&[1; 32], &[2; 32]);
        b.secure(&[2; 32], &[1; 32]);
        let (events, keep, _) = Events::capture();
        let a_id = crate::remote::next_id();
        let b_id = crate::remote::next_id();
        let (a_link, a_queue) = crate::remote::link::channel();
        let (b_link, b_queue) = crate::remote::link::channel();
        crate::remote::state().links.insert(a_id, a_link);
        crate::remote::state().links.insert(b_id, b_link);
        let a_requests = RemoteRequests::bind(a_id).unwrap();
        let b_requests = RemoteRequests::bind(b_id).unwrap();
        a.run(
            a_id,
            events.clone(),
            Liveness::default(),
            LinkOptions::default(),
            a_queue,
        );
        b.run(
            b_id,
            events,
            Liveness::default(),
            LinkOptions::default(),
            b_queue,
        );
        (a_requests, b_requests, keep)
    }

    #[tokio::test]
    async fn encrypted_requests_answer_in_completion_order_and_events_cross_without_node() {
        let (a, b, _keep) = pair().await;
        let mut incoming = b.take_requests().unwrap();
        let mut events = a.events();
        let one = a.request("one", json!({"n":1}), Duration::from_secs(2));
        let two = a.request("two", json!({"n":2}), Duration::from_secs(2));
        let server = async {
            let first = incoming.recv().await.unwrap();
            let second = incoming.recv().await.unwrap();
            assert_eq!(first.method, "one");
            assert_eq!(second.params, json!({"n":2}));
            b.answer(second.id, Ok(json!(2))).unwrap();
            b.emit("tab.event", &json!({"rtab":"t", "name":"status"}))
                .unwrap();
            b.answer(first.id, Ok(json!(1))).unwrap();
        };
        let (one, two, ()) = tokio::join!(one, two, server);
        assert_eq!(one.unwrap(), json!(1));
        assert_eq!(two.unwrap(), json!(2));
        assert_eq!(events.recv().await.unwrap().event, "tab.event");
        a.disconnect_for_test();
        b.disconnect_for_test();
    }

    #[tokio::test]
    async fn dropping_link_rejects_inflight_request_and_old_answer_cannot_reach_another_link() {
        let (a, b, _keep) = pair().await;
        let mut incoming = b.take_requests().unwrap();
        let requested = a.request("pending", Value::Null, Duration::from_secs(60));
        let stop = async {
            incoming.recv().await.unwrap();
            a.disconnect_for_test();
        };
        let (result, ()) = tokio::join!(requested, stop);
        assert_eq!(result.unwrap_err().fault.code, "remote_offline");
        assert!(!a.is_online());
        b.disconnect_for_test();
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_removes_reply_and_preserves_remote_holder() {
        let (a, b, _keep) = pair().await;
        let mut incoming = b.take_requests().unwrap();
        let requested = a.request("slow", Value::Null, Duration::from_secs(1));
        let server = async {
            let request = incoming.recv().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
            b.answer(request.id, Ok(json!("late"))).unwrap();
        };
        let (result, ()) = tokio::join!(requested, server);
        assert_eq!(result.unwrap_err().fault.code, "timeout");
        assert!(lock(&a.0.pending).replies.is_empty());
        a.disconnect_for_test();
        b.disconnect_for_test();
    }
}
