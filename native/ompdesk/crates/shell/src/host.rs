//! Node's side of the host protocol (PROTOCOL.md): the socket, the `hello` handshake, requests both ways and the
//! writer that keeps frames from interleaving. Every handler gets a `Call` and answers it exactly once.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use shell_core::conn::{Conn, Listener};
use shell_core::wire::{self, Incoming, WireError};

use crate::log::log;

type Callback = Box<dyn FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send>;

/// An answer path shared by the writer queue; cloned into every `Call`.
pub struct Host {
    tx: Mutex<Sender<Vec<u8>>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Callback>>,
    cancels: Mutex<HashMap<u64, Box<dyn FnOnce() + Send>>>,
}

static HOST: OnceLock<Arc<Host>> = OnceLock::new();

fn host() -> Option<&'static Arc<Host>> {
    HOST.get()
}

#[cfg(target_os = "macos")]
pub fn connected() -> bool {
    HOST.get().is_some()
}

fn send_bytes(bytes: Vec<u8>) {
    if let Some(h) = host() {
        let _ = h.tx.lock().unwrap().send(bytes);
    }
}

/// An event to Node (no answer). Dropped before Node connected.
pub fn event(name: &str, data: Value) {
    send_bytes(wire::event(name, data, None));
}

pub fn event_bin(name: &str, data: Value, bin: &[u8]) {
    send_bytes(wire::event(name, data, Some(bin)));
}

/// A request to Node; `callback` runs on the reader thread when the answer arrives.
pub fn request(
    method: &str,
    params: Value,
    bin: Option<&[u8]>,
    callback: impl FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send + 'static,
) -> u64 {
    let Some(h) = host() else {
        callback(Err(WireError::new("gone", "Node is not connected")), None);
        return 0;
    };
    let id = h.next_id.fetch_add(1, Ordering::Relaxed);
    h.pending.lock().unwrap().insert(id, Box::new(callback));
    send_bytes(wire::request(id, method, params, bin));
    id
}

/// A request that waits for its answer on this thread, at most `timeout`; `Err(timeout)` then. Never call it from the
/// reader thread (it would wait for itself).
pub fn request_blocking(
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, WireError> {
    let (tx, rx) = mpsc::channel();
    let id = request(method, params, None, move |result, _| {
        let _ = tx.send(result);
    });
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            if let Some(h) = host() {
                h.pending.lock().unwrap().remove(&id);
            }
            send_bytes(wire::cancel(id));
            Err(WireError::new(
                "timeout",
                format!("{method} was not answered in {} ms", timeout.as_millis()),
            ))
        }
    }
}

/// Runs `f` when Node cancels its request `id`.
pub fn on_cancel(id: u64, f: impl FnOnce() + Send + 'static) {
    if let Some(h) = host() {
        h.cancels.lock().unwrap().insert(id, Box::new(f));
    }
}

pub fn forget_cancel(id: u64) {
    if let Some(h) = host() {
        h.cancels.lock().unwrap().remove(&id);
    }
}

/// Where a `Call` made inside the shell (`Call::local`) delivers its answer.
type LocalReply = Box<dyn FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send>;

/// A request from Node, answered once. Dropping it unanswered answers `failed`, so Node never waits for nothing.
pub struct Call {
    pub method: String,
    pub params: Value,
    pub bin: Option<Vec<u8>>,
    id: u64,
    answered: bool,
    local: Option<LocalReply>,
}

impl Call {
    /// A request the shell makes of its own handlers (a module running `win.op` on a window it owns): the answer goes
    /// to `reply` instead of the wire, a drop answers `failed` there too.
    pub fn local(
        method: &str,
        params: Value,
        reply: impl FnOnce(Result<Value, WireError>, Option<Vec<u8>>) + Send + 'static,
    ) -> Self {
        Self {
            method: method.to_string(),
            params,
            bin: None,
            id: 0,
            answered: false,
            local: Some(Box::new(reply)),
        }
    }

    /// `Call::local` whose answer nobody reads (a failure is logged).
    pub fn fire(method: &str, params: Value) -> Self {
        let name = method.to_string();
        Self::local(method, params, move |answer, _| {
            if let Err(error) = answer {
                log(
                    "call.local_failed",
                    json!({ "method": name, "error": error.message }),
                );
            }
        })
    }

    fn reply(&mut self, answer: Result<Value, WireError>, bin: Option<&[u8]>) {
        self.answered = true;
        match self.local.take() {
            Some(reply) => reply(answer, bin.map(<[u8]>::to_vec)),
            None => send_bytes(match answer {
                Ok(result) => wire::answer_ok(self.id, result, bin),
                Err(error) => wire::answer_err(self.id, &error),
            }),
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn ok(mut self, result: Value) {
        self.reply(Ok(result), None);
    }

    pub fn ok_bin(mut self, result: Value, bin: &[u8]) {
        self.reply(Ok(result), Some(bin));
    }

    pub fn err(mut self, code: &str, message: impl Into<String>) {
        self.reply(Err(WireError::new(code, message)), None);
    }

    pub fn unsupported(self) {
        let message = format!("{} is not implemented by this shell", self.method);
        self.err("unsupported", message);
    }

    /// A string parameter, or an `invalid` answer.
    pub fn str(&self, key: &str) -> Option<String> {
        self.params
            .get(key)
            .and_then(Value::as_str)
            .map(String::from)
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if !self.answered {
            let message = format!("{} was dropped without an answer", self.method);
            self.reply(Err(WireError::new("failed", message)), None);
        }
    }
}

/// What the connection's reader hands the rest of the shell.
pub struct Handlers {
    pub request: fn(Call),
    pub event: fn(&str, Value, Option<Vec<u8>>),
    /// Node's connection ended (it exited or crashed).
    pub closed: fn(),
}

/// Waits for Node on `listener`, checks `hello`'s token and answers it with `facts`; then reads frames until the
/// connection ends. A connection that does not open with the right token is closed and the wait goes on.
pub fn serve(mut listener: Listener, token: String, facts: Value, handlers: Handlers) {
    std::thread::Builder::new()
        .name("host-accept".into())
        .spawn(move || {
            loop {
                let conn = match listener.accept() {
                    Ok(conn) => conn,
                    Err(error) => {
                        log("host.accept_failed", json!({ "error": error.to_string() }));
                        return;
                    }
                };
                if let Some(reader) = handshake(conn, &token, &facts) {
                    read_loop(reader, handlers);
                    return;
                }
            }
        })
        .expect("host accept thread");
}

fn handshake(conn: Conn, token: &str, facts: &Value) -> Option<BufReader<Conn>> {
    let writer = conn.try_clone().ok()?;
    let mut reader = BufReader::new(conn);
    let Ok(Some(Incoming::Request {
        id, method, params, ..
    })) = wire::read_frame(&mut reader)
    else {
        log("host.hello_missing", json!({}));
        return None;
    };
    if method != "hello" || params["token"].as_str() != Some(token) {
        log("host.hello_refused", json!({ "method": method }));
        return None;
    }
    let (tx, rx) = mpsc::channel();
    let host = Arc::new(Host {
        tx: Mutex::new(tx),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        cancels: Mutex::new(HashMap::new()),
    });
    if HOST.set(host.clone()).is_err() {
        return None;
    }
    spawn_writer(writer, rx);
    send_bytes(wire::answer_ok(
        id,
        json!({ "protocol": 1, "facts": facts }),
        None,
    ));
    log("host.hello", json!({ "pid": params["pid"] }));
    Some(reader)
}

fn spawn_writer(mut writer: Conn, rx: Receiver<Vec<u8>>) {
    std::thread::Builder::new()
        .name("host-writer".into())
        .spawn(move || {
            while let Ok(bytes) = rx.recv() {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    return;
                }
            }
        })
        .expect("host writer thread");
}

fn read_loop<R: Read + std::io::BufRead>(mut reader: R, handlers: Handlers) {
    loop {
        match wire::read_frame(&mut reader) {
            Ok(Some(Incoming::Request {
                id,
                method,
                params,
                bin,
            })) => {
                (handlers.request)(Call {
                    method,
                    params,
                    bin,
                    id,
                    answered: false,
                    local: None,
                });
            }
            Ok(Some(Incoming::Answer { id, result, bin })) => {
                let callback = host().and_then(|h| h.pending.lock().unwrap().remove(&id));
                if let Some(callback) = callback {
                    callback(result, bin);
                }
            }
            Ok(Some(Incoming::Event { event, data, bin })) => (handlers.event)(&event, data, bin),
            Ok(Some(Incoming::Cancel(id))) => {
                let cancel = host().and_then(|h| h.cancels.lock().unwrap().remove(&id));
                if let Some(cancel) = cancel {
                    cancel();
                }
            }
            Ok(Some(Incoming::Skipped(why))) => log("host.skipped", json!({ "why": why })),
            Ok(None) => break,
            Err(error) => {
                log("host.read_failed", json!({ "error": error.to_string() }));
                break;
            }
        }
    }
    (handlers.closed)();
}
