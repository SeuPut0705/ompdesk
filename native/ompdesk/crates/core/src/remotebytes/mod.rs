//! The bytes a paired device keeps and carries for its hosts (native-rust ledger R8; was the I/O of
//! `src/main/remote/{transcript-cache,image-blob-cache,sign-in-relay,preview-relay-tunnels}.ts`): the device's copies
//! of its hosts' subagent journals and tail pages (`transcripts`), the pictures of those transcripts by content
//! address (`blobs`), the stand-in on this computer's loopback for a host's browser sign-in (`signin`), and on a
//! host, the socket to a tab's browser relay that a device's Preview page drives (`relay`).
//!
//! Main keeps every request on a link (ledger R1-R3), so what only the host has is asked of main: a `remotebytes.ask`
//! event names the caller main registered (`asker`) and main answers with `remotebytes.answer`.
//!
//! Methods: `remotebytes.readJournal`, `remotebytes.page`, `remotebytes.keepPage`, `remotebytes.resolveBlobs`,
//! `remotebytes.signInStart`, `remotebytes.relayOpen`, `remotebytes.answer`. Pushes: `remotebytes.signInClose`,
//! `remotebytes.relaySend`, `remotebytes.relayClose`. Events: `remotebytes.ask` (`journal`, `blob`, `signIn`),
//! `remotebytes.signInEnded`, `remotebytes.relay`.

mod blobs;
mod folder;
pub mod native;
mod relay;
mod signin;
mod transcripts;
pub(crate) use blobs::node_base64;

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use crate::server::{Call, Events, Fault, Registry, Reply, Scope};

pub fn register(registry: &mut Registry) {
    registry.add("remotebytes.answer", |call| Box::pin(answer(call)));
    registry.add("remotebytes.readJournal", |call| {
        Box::pin(transcripts::read_journal(call))
    });
    registry.add("remotebytes.page", |call| Box::pin(transcripts::page(call)));
    registry.add("remotebytes.keepPage", |call| {
        Box::pin(transcripts::keep_page(call))
    });
    registry.add("remotebytes.resolveBlobs", |call| {
        Box::pin(blobs::resolve(call))
    });
    registry.add("remotebytes.signInStart", |call| {
        Box::pin(signin::start(call))
    });
    registry.add_push("remotebytes.signInClose", signin::close);
    registry.add("remotebytes.relayOpen", |call| Box::pin(relay::open(call)));
    registry.add_push("remotebytes.relaySend", relay::send);
    registry.add_push("remotebytes.relayClose", relay::close);
}

/// What main has not answered yet, by the ask's number.
#[derive(Default)]
struct Asks {
    next: u64,
    waiting: HashMap<u64, oneshot::Sender<Box<RawValue>>>,
}

static ASKS: LazyLock<Mutex<Asks>> = LazyLock::new(Mutex::default);

fn asks() -> std::sync::MutexGuard<'static, Asks> {
    ASKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The ask's caller in main failed it (its own error is what main's call rethrows: `ask_failed`).
#[derive(Debug)]
pub(crate) struct Unanswered;

impl Unanswered {
    pub(crate) fn fault() -> Fault {
        Fault::new("ask_failed", "Main could not answer what the core asked")
    }
}

/// Asks main for what only it reaches (the host, over a link main speaks) on behalf of its caller `asker`, and waits
/// for the answer: the answer's JSON, or `Unanswered` when main's caller failed, main never answers (its core went),
/// or the request this ask serves was cancelled.
pub(crate) async fn ask(
    events: &Events,
    scope: Option<&Scope>,
    asker: u64,
    kind: &str,
    data: Map<String, Value>,
) -> Result<Box<RawValue>, Unanswered> {
    let (answer, answered) = oneshot::channel();
    let call = {
        let mut asks = asks();
        asks.next += 1;
        let call = asks.next;
        asks.waiting.insert(call, answer);
        call
    };
    let mut message = Map::new();
    message.insert("call".into(), call.into());
    message.insert("asker".into(), asker.into());
    message.insert("kind".into(), kind.into());
    message.extend(data);
    events.send("remotebytes.ask", &message);
    let answer = match scope {
        Some(scope) => tokio::select! {
            answer = answered => answer.ok(),
            () = scope.on_cancel() => None,
        },
        None => answered.await.ok(),
    };
    if answer.is_none() {
        asks().waiting.remove(&call);
    }
    answer.ok_or(Unanswered)
}

#[derive(Deserialize)]
struct AnswerParams {
    call: u64,
    #[serde(default)]
    result: Option<Box<RawValue>>,
    #[serde(default)]
    failed: bool,
}

/// Main's answer to an ask; a failed one drops the waiting side, which reads it as `Unanswered`.
async fn answer(call: Call) -> Result<Reply, Fault> {
    let params: AnswerParams = call.params()?;
    let waiting = asks().waiting.remove(&params.call);
    if let Some(waiting) = waiting
        && !params.failed
    {
        let result = params.result.unwrap_or_else(json_null);
        let _ = waiting.send(result);
    }
    Reply::json(&Value::Null)
}

pub(crate) fn json_null() -> Box<RawValue> {
    RawValue::from_string("null".into()).expect("null is JSON")
}

/// A blocking part of a request (the caches' file work) on tokio's blocking threads.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))
}

/// How JavaScript reads a JSON value's type, on its raw text (serde keeps no `undefined`, so a key present with
/// `null` stays present, as `JSON.parse` keeps it).
pub(crate) mod js {
    use serde_json::value::RawValue;

    pub fn is_number(raw: &RawValue) -> bool {
        number(raw).is_some()
    }

    pub fn number(raw: &RawValue) -> Option<f64> {
        let text = raw.get();
        if text.starts_with('-') || text.starts_with(|c: char| c.is_ascii_digit()) {
            text.parse().ok()
        } else {
            None
        }
    }

    pub fn is_string(raw: &RawValue) -> bool {
        raw.get().starts_with('"')
    }

    pub fn is_array(raw: &RawValue) -> bool {
        raw.get().starts_with('[')
    }

    /// `typeof value === "object" && value !== null`: an object or an array.
    pub fn is_object(raw: &RawValue) -> bool {
        raw.get().starts_with('{') || is_array(raw)
    }

    /// The elements of an array's raw text, without the brackets (empty for `[]`).
    pub fn elements(raw: &RawValue) -> &str {
        let text = raw.get();
        text[1..text.len() - 1].trim()
    }
}

#[cfg(test)]
mod tests;
