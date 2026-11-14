//! The page ⇄ Node relay's shell side. The page (`src/preload/shell.ts`, injected into `index.html`) talks to the
//! shell over `app://ompdesk/__ipc/…` with `fetch`; the scheme handler (`scheme.rs`) hands each request here.
//!
//! - `POST /__ipc/invoke {channel, args}` → `ipc.invoke` to Node → `{value}` or `{error}`.
//! - `POST /__ipc/send {channel, args}` → `ipc.send` event (no answer).
//! - `GET /__ipc/events` → a never-ending response of one JSON line per `wc.send`, in order, per page.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde_json::{Value, json};
use shell_core::chunks::fill;
use shell_core::wire::WireError;

/// Lines no reader took yet are kept up to this many per page (a reloading page is briefly without a reader).
const MAX_QUEUED: usize = 4096;

type Waker = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct Stream {
    queue: VecDeque<Vec<u8>>,
    waiting: Option<Waker>,
}

static STREAMS: Mutex<Option<HashMap<u64, Stream>>> = Mutex::new(None);

fn with_streams<R>(f: impl FnOnce(&mut HashMap<u64, Stream>) -> R) -> R {
    f(STREAMS.lock().unwrap().get_or_insert_with(HashMap::new))
}

/// Node's `wc.send`: queue the line, wake the page's parked reader (outside the lock: it calls back into CEF).
pub fn push(wc_id: u64, channel: &str, args: &Value) {
    let mut line = json!({ "channel": channel, "args": args })
        .to_string()
        .into_bytes();
    line.push(b'\n');
    let waker = with_streams(|streams| {
        let stream = streams.entry(wc_id).or_default();
        stream.queue.push_back(line);
        while stream.queue.len() > MAX_QUEUED {
            stream.queue.pop_front();
        }
        stream.waiting.take()
    });
    if let Some(waker) = waker {
        waker();
    }
}

/// A reader asks for bytes: `Some(n)` when lines were queued (copied into `out`), else `waker` is parked and runs at
/// the next `push`, where the reader calls `pull`.
pub fn read_or_park(wc_id: u64, out: &mut [u8], waker: Waker) -> Option<usize> {
    with_streams(|streams| {
        let stream = streams.entry(wc_id).or_default();
        if stream.queue.is_empty() {
            stream.waiting = Some(waker);
            None
        } else {
            Some(fill(&mut stream.queue, out))
        }
    })
}

/// What a woken reader copies.
pub fn pull(wc_id: u64, out: &mut [u8]) -> usize {
    with_streams(|streams| {
        streams
            .get_mut(&wc_id)
            .map(|s| fill(&mut s.queue, out))
            .unwrap_or(0)
    })
}

/// The page's reader went away (a reload, a navigation): nothing waits any more, queued lines stay for the next one.
pub fn reader_gone(wc_id: u64) {
    with_streams(|streams| {
        if let Some(stream) = streams.get_mut(&wc_id) {
            stream.waiting = None;
        }
    });
}

/// A page is destroyed: its stream goes.
pub fn drop_page(wc_id: u64) {
    with_streams(|streams| {
        streams.remove(&wc_id);
    });
}

/// The invoke response body: `{"value": …}` or `{"error": {code, message}}`.
pub fn invoke_body(result: Result<Value, WireError>) -> Vec<u8> {
    match result {
        Ok(result) => json!({ "value": result.get("value").cloned().unwrap_or(Value::Null) }),
        Err(error) => json!({ "error": { "code": error.code, "message": error.message } }),
    }
    .to_string()
    .into_bytes()
}
