//! The link's event encoding (native-rust ledger R4, built, not yet called; was `src/main/remote/link-events.ts`,
//! `src/main/message-update-slim.ts`, `subagent-frames.ts`'s `slimSubagentFrame` and `frame-bookkeeping.ts`'s
//! `withoutFrameBookkeeping`): what a host sends a device for `events` and `subagentFrame` when the device's hello
//! asked for slim ones, and how the device turns it back into what a local sidecar delivers to its pool. One copy of
//! the windows' slimmer ([`slim::Slimmer`]) for the link and, once the pool's events reach the core, the windows.
//!
//! Every frame a device reads is the text the TypeScript encoder sent ([`js::stringify`]: key order, number
//! spelling), and the decoder rebuilds what an older host's TypeScript encoder sent. Proved by rows captured from the
//! TypeScript (`captured/*.json.gz`, written by `src/main/remote/link-events-capture.ts`) replayed here and through the
//! real binary (`src/main/remote/link-events-core.test.ts`).
//!
//! Methods (the parity suite's; nothing in main calls them yet): `remote.events.open` {kind, options?, epoch?} →
//! {stream}, `remote.events.call` {stream, op, in?, fresh?, oks?} → {out?, sends?, arm?}, `remote.events.close`
//! {stream}.

pub mod decoder;
pub mod delta;
pub mod encoder;
pub mod js;
pub mod refs;
pub mod slim;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

use crate::server::{Call, Fault, Registry, Reply};

use decoder::Decoder;
use delta::{ReadDecoder, ReadEncoder, encoded_read_key};
use encoder::{Encoder, Options, Sender};
use slim::{Slimmer, slim_message_update, slim_subagent_frame, without_frame_bookkeeping};

/// One encoder, decoder, sender, slimmer or read chain, or the pure functions.
#[derive(Debug)]
pub enum Stream {
    Encoder(Encoder),
    Decoder(Decoder),
    Sender { sender: Sender, armed: Option<u64> },
    Slimmer(Slimmer),
    ReadEncoder(ReadEncoder),
    ReadDecoder(ReadDecoder),
    Pure,
}

/// One call on a stream: the op, its input (absent for `undefined`), a read's `fresh`, and what each send answers.
#[derive(Debug, Default, Deserialize)]
pub struct Op {
    pub op: String,
    #[serde(rename = "in", default, deserialize_with = "present")]
    pub input: Option<Value>,
    #[serde(default)]
    pub fresh: bool,
    /// For a sender: what `send` answers, in order (true where the list ends).
    #[serde(default)]
    pub oks: Vec<bool>,
}

/// What a call gave: its output as JSON text (`None` for `undefined`), a sender's tab events, a timer to start.
#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub out: Option<String>,
    pub sends: Vec<(String, String)>,
    pub arm: Option<u64>,
}

/// A field that is there, `null` included; absent is `None`.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

fn invalid(message: impl Into<String>) -> Fault {
    Fault::new("invalid_params", message)
}

fn list(input: Option<&Value>) -> Result<&[Value], Fault> {
    input
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid("an events batch is an array"))
}

fn out(value: &Value) -> Option<String> {
    Some(js::stringify(value))
}

impl Stream {
    pub fn open(kind: &str, options: Option<&Value>, epoch: Option<&str>) -> Result<Stream, Fault> {
        let options = options.unwrap_or(&Value::Null);
        let flag = |key| options.get(key) == Some(&Value::Bool(true));
        Ok(match kind {
            "encoder" => Stream::Encoder(Encoder::new(Options::from_value(options))),
            "decoder" => Stream::Decoder(Decoder::new()),
            "sender" => Stream::Sender {
                sender: Sender::new(Options::from_value(options)),
                armed: None,
            },
            "slimmer" => Stream::Slimmer(Slimmer::new()),
            "readEncoder" => Stream::ReadEncoder(ReadEncoder::new(
                epoch
                    .ok_or_else(|| invalid("a read encoder needs its epoch"))?
                    .into(),
                flag("shifts"),
                flag("fields"),
            )),
            "readDecoder" => Stream::ReadDecoder(ReadDecoder::default()),
            "pure" => Stream::Pure,
            _ => return Err(invalid(format!("no stream kind {kind}"))),
        })
    }

    pub fn call(&mut self, op: &Op) -> Result<Outcome, Fault> {
        let input = op.input.as_ref();
        let one = || input.ok_or_else(|| invalid(format!("{} needs an input", op.op)));
        let outcome = |out| Outcome {
            out,
            ..Outcome::default()
        };
        Ok(match (self, op.op.as_str()) {
            (Stream::Encoder(encoder), "events") => outcome(out(&Value::Array(
                encoder.events(list(input)?).into_owned(),
            ))),
            (Stream::Encoder(encoder), "subagentFrame") => {
                outcome(out(&encoder.subagent_frame(one()?)))
            }
            (Stream::Decoder(decoder), "events") => outcome(out(&Value::Array(
                decoder.events(list(input)?).into_owned(),
            ))),
            (Stream::Decoder(decoder), "subagentFrame") => outcome(out(&decoder
                .subagent_frame(one()?)
                .map_or(Value::Null, |frame| frame.into_owned()))),
            (Stream::Slimmer(slimmer), "events") => {
                outcome(out(&Value::Array(slimmer.slim(list(input)?).into_owned())))
            }
            (Stream::ReadEncoder(encoder), "call") => {
                outcome(out(&encoder.encode(input, op.fresh)))
            }
            (Stream::ReadDecoder(decoder), "call") => {
                outcome(out(&decoder.decode(one()?).unwrap_or(Value::Null)))
            }
            (Stream::Pure, "slimMessageUpdate") => outcome(out(&slim_message_update(one()?))),
            (Stream::Pure, "slimSubagentFrame") => {
                let frame = one()?;
                outcome(out(
                    &slim_subagent_frame(frame).unwrap_or_else(|| frame.clone())
                ))
            }
            (Stream::Pure, "withoutFrameBookkeeping") => {
                let frame = one()?;
                outcome(out(
                    &without_frame_bookkeeping(frame).unwrap_or_else(|| frame.clone())
                ))
            }
            (Stream::Pure, "encodedReadKey") => outcome(out(&encoded_read_key(one()?).map_or(
                Value::Null,
                |(key, needs)| json!({"key": key, "needs": needs}),
            ))),
            (Stream::Sender { sender, armed }, name) => {
                let mut sends = Vec::new();
                let mut answers = op.oks.iter().copied();
                let mut send = |name: &'static str, arg: Value| {
                    sends.push((name.to_owned(), js::stringify(&arg)));
                    answers.next().unwrap_or(true)
                };
                let mut arm = None;
                match name {
                    "events" => sender.events(list(input)?, &mut send),
                    "subagentFrame" => {
                        arm = sender.subagent_frame(one()?.clone(), &mut send);
                        if arm.is_some() {
                            *armed = arm;
                        }
                    }
                    "flush" => sender.flush(&mut send),
                    "timer" => {
                        if let Some(generation) = armed.take() {
                            sender.timer(generation, &mut send);
                        }
                    }
                    "dispose" => sender.dispose(),
                    _ => return Err(invalid(format!("no sender op {name}"))),
                }
                Outcome {
                    out: None,
                    sends,
                    arm,
                }
            }
            (_, name) => return Err(invalid(format!("no op {name} on this stream"))),
        })
    }
}

static STREAMS: LazyLock<Mutex<HashMap<u64, Stream>>> = LazyLock::new(Mutex::default);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn streams() -> std::sync::MutexGuard<'static, HashMap<u64, Stream>> {
    STREAMS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn register(registry: &mut Registry) {
    registry.add("remote.events.open", |call| Box::pin(open(call)));
    registry.add("remote.events.call", |call| Box::pin(call_stream(call)));
    registry.add("remote.events.close", |call| Box::pin(close(call)));
}

#[derive(Deserialize)]
struct OpenParams {
    kind: String,
    options: Option<Value>,
    epoch: Option<String>,
}

async fn open(call: Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    let stream = Stream::open(
        &params.kind,
        params.options.as_ref(),
        params.epoch.as_deref(),
    )?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    streams().insert(id, stream);
    Reply::json(&json!({ "stream": id }))
}

#[derive(Deserialize)]
struct CallParams {
    stream: u64,
    #[serde(flatten)]
    op: Op,
}

async fn call_stream(call: Call) -> Result<Reply, Fault> {
    let params: CallParams = call.params()?;
    let mut streams = streams();
    let stream = streams
        .get_mut(&params.stream)
        .ok_or_else(|| Fault::new("unknown_stream", format!("no stream {}", params.stream)))?;
    let outcome = stream.call(&params.op)?;
    let sends: Vec<Value> = outcome
        .sends
        .into_iter()
        .map(|(name, arg)| json!({"name": name, "arg": arg}))
        .collect();
    Reply::json(&json!({ "out": outcome.out, "sends": sends, "arm": outcome.arm }))
}

#[derive(Deserialize)]
struct CloseParams {
    stream: u64,
}

async fn close(call: Call) -> Result<Reply, Fault> {
    let params: CloseParams = call.params()?;
    streams().remove(&params.stream);
    Reply::json(&json!({}))
}
