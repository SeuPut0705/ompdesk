//! The device's side (was `link-events.ts`'s `createLinkEventDecoder`): one per tab. It undoes every encoding the
//! host's [`super::encoder::Encoder`] may apply and, for the tab's own stream, rebuilds the snapshot a window that
//! attaches mid-message needs (the text and thinking blocks from the deltas, the tool call a `toolcall_delta` names).
//! What it hands the pool slims to exactly what a local tab's window receives; whole updates (an older host) pass
//! through untouched. What it cannot rebuild (a delta or reference it holds nothing for) is dropped, never delivered
//! half.

use std::borrow::Cow;
use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::delta::{ProgressDecoder, StatusDecoder, Unrebuilt};
use super::js;
use super::refs::{
    ArgsDecoder, EndsDecoder, OutputDecoder, ToolResultDecoder, UsageRestorer, key_of,
};

/// The blocks of the message being streamed, rebuilt from the deltas after its first whole update, by content index.
#[derive(Debug)]
struct Rebuilt {
    timestamp: Option<Value>,
    blocks: BTreeMap<usize, Value>,
}

/// JavaScript's `a + b` of the text so far and a field (`String()` of what is no string).
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        value => js::string_of(value),
    }
}

fn advance(blocks: &mut BTreeMap<usize, Value>, increment: &Value) {
    let Some(index) = js::index_of(increment.get("contentIndex")) else {
        return;
    };
    let current = blocks.get(&index);
    let current_type = current.and_then(js::type_of);
    let delta = || match increment.get("delta") {
        None | Some(Value::Null) => String::new(),
        delta => text_of(delta),
    };
    let closed = || js::element(js::field(increment.get("partial"), "content"), Some(index));
    match js::type_of(increment) {
        Some("text_start") => {
            blocks.insert(index, json!({"type": "text", "text": ""}));
        }
        Some("thinking_start") => {
            blocks.insert(index, json!({"type": "thinking", "thinking": ""}));
        }
        Some("text_delta") => {
            let before = if current_type == Some("text") {
                text_of(current.and_then(|block| block.get("text")))
            } else {
                String::new()
            };
            blocks.insert(index, json!({"type": "text", "text": before + &delta()}));
        }
        Some("thinking_delta") => {
            let before = if current_type == Some("thinking") {
                text_of(current.and_then(|block| block.get("thinking")))
            } else {
                String::new()
            };
            blocks.insert(
                index,
                json!({"type": "thinking", "thinking": before + &delta()}),
            );
        }
        // The local slimmer keeps a block that closed as narration: the device's rebuilt message says so too, so its
        // renderer moves the block to the reply as this computer's does.
        Some("thinking_end") => {
            let closed = closed();
            if current_type == Some("thinking")
                && closed.and_then(js::type_of) == Some("thinking")
                && js::truthy(closed.and_then(|block| block.get("narration")))
                && let Some(Value::Object(current)) = current
            {
                let narrated = js::with(current, "narration", Value::Bool(true));
                blocks.insert(index, Value::Object(narrated));
            }
        }
        Some("toolcall_delta") => {
            if let Some(block) = closed().filter(|block| js::type_of(block) == Some("toolCall")) {
                blocks.insert(index, block.clone());
            }
        }
        _ => {}
    }
}

/// One per tab on the device.
#[derive(Debug, Default)]
pub struct Decoder {
    rebuilt: Option<Rebuilt>,
    restore: UsageRestorer,
    restore_subagent: UsageRestorer,
    progress: ProgressDecoder,
    status: StatusDecoder,
    ends: EndsDecoder,
    tools: ToolResultDecoder,
    outputs: OutputDecoder,
    args: ArgsDecoder,
}

/// `current` replaced by `f`'s result when it gave one.
fn then<'a>(
    current: Cow<'a, Value>,
    f: impl FnOnce(&Value) -> Result<Option<Value>, Unrebuilt>,
) -> Result<Cow<'a, Value>, Unrebuilt> {
    Ok(match f(&current)? {
        Some(next) => Cow::Owned(next),
        None => current,
    })
}

impl Decoder {
    pub fn new() -> Decoder {
        Decoder::default()
    }

    /// The tab's own `message_update`: whole ones start the rebuilt message, slim ones get it back.
    fn decode(&mut self, event: &Value) -> Option<Value> {
        match js::type_of(event) {
            Some("message_end" | "agent_end") => {
                self.rebuilt = None;
                return None;
            }
            Some("message_update") => {}
            _ => return None,
        }
        let message = event.get("message");
        let timestamp = js::field(message, "timestamp");
        if let Some(Value::Array(content)) = js::field(message, "content") {
            self.rebuilt = Some(Rebuilt {
                timestamp: timestamp.cloned(),
                blocks: content.iter().cloned().enumerate().collect(),
            });
            self.restore.restore("", event);
            return None;
        }
        let restored = self.restore.restore("", event);
        let update = restored.as_ref().unwrap_or(event);
        let stream = match self.rebuilt.take() {
            Some(previous) if js::strict_equal(previous.timestamp.as_ref(), timestamp) => previous,
            _ => Rebuilt {
                timestamp: timestamp.cloned(),
                blocks: BTreeMap::new(),
            },
        };
        let stream = self.rebuilt.insert(stream);
        let increment = update.get("assistantMessageEvent").unwrap_or(&Value::Null);
        advance(&mut stream.blocks, increment);
        let mut stream_event = increment.as_object().cloned();
        let index = js::index_of(increment.get("contentIndex"));
        let partial = increment.get("partial");
        let block = js::element(js::field(partial, "content"), index);
        if js::type_of(increment) == Some("toolcall_delta")
            && js::truthy(block)
            && js::truthy(partial)
            && let (Some(block), Some(index), Some(wire)) = (block, index, stream_event.as_mut())
        {
            // What the local slimmer sends: the block alone, in a sparse array (JSON turned the holes into null).
            let mut sparse = vec![Value::Null; index];
            sparse.push(block.clone());
            let mut partial_out = Map::new();
            if let Some(role) = js::field(partial, "role") {
                partial_out.insert("role".into(), role.clone());
            }
            partial_out.insert("content".into(), Value::Array(sparse));
            js::set(wire, "partial", Value::Object(partial_out));
        }
        let content: Vec<Value> = stream.blocks.values().cloned().collect();
        let message = update
            .get("message")
            .and_then(Value::as_object)
            .map(|message| js::with(message, "content", Value::Array(content.clone())))
            .unwrap_or_else(|| {
                let mut message = Map::new();
                message.insert("content".into(), Value::Array(content));
                message
            });
        let mut fields = vec![("message", Value::Object(message))];
        if let Some(stream_event) = stream_event {
            fields.push(("assistantMessageEvent", Value::Object(stream_event)));
        }
        Some(Value::Object(js::replaced(update.as_object()?, fields)))
    }

    fn update(&mut self, scope: &str, event: &Value) -> Result<Option<Value>, Unrebuilt> {
        let current = then(Cow::Borrowed(event), |event| self.args.decode(scope, event))?;
        let current = then(current, |event| self.outputs.update(scope, event))?;
        let current = then(current, |event| self.progress.update(event))?;
        Ok(match current {
            Cow::Owned(next) => Some(next),
            Cow::Borrowed(_) => None,
        })
    }

    fn event(&mut self, event: &Value) -> Result<Option<Value>, Unrebuilt> {
        self.outputs.forget("", event);
        self.args.forget("", event);
        let kind = js::type_of(event);
        if kind == Some("tool_execution_start") {
            let _ = self.args.decode("", event);
        }
        let current = then(Cow::Borrowed(event), |event| self.tools.decode(event))?;
        let current = match js::type_of(&current) {
            Some("message_start" | "message_end" | "agent_end") => {
                then(current, |event| self.ends.decode(event))?
            }
            _ => current,
        };
        let current = match js::type_of(&current) {
            Some("tool_execution_update") => then(current, |event| self.update("", event))?,
            Some("autopilot_update") => then(current, |event| {
                let status = self.status.decode(event.get("status"))?;
                Ok(status.and_then(|status| {
                    event
                        .as_object()
                        .map(|event| Value::Object(js::with(event, "status", status)))
                }))
            })?,
            _ => then(current, |event| Ok(self.decode(event)))?,
        };
        Ok(match current {
            Cow::Owned(next) => Some(next),
            Cow::Borrowed(_) => None,
        })
    }

    /// An `events` batch as the host's pool delivered it; borrowed when nothing changed.
    pub fn events<'a>(&mut self, batch: &'a [Value]) -> Cow<'a, [Value]> {
        let mut out: Option<Vec<Value>> = None;
        for (index, event) in batch.iter().enumerate() {
            match self.event(event) {
                Ok(None) => {
                    if let Some(out) = &mut out {
                        out.push(event.clone());
                    }
                }
                next => {
                    let out = out.get_or_insert_with(|| batch[..index].to_vec());
                    if let Ok(Some(next)) = next {
                        out.push(next);
                    }
                }
            }
        }
        out.map_or(Cow::Borrowed(batch), Cow::Owned)
    }

    /// The frame a local sidecar delivers; `None` when it is a delta of a snapshot this decoder never held.
    pub fn subagent_frame<'a>(&mut self, frame: &'a Value) -> Option<Cow<'a, Value>> {
        match js::type_of(frame) {
            Some("subagent_progress") => {
                then(Cow::Borrowed(frame), |frame| self.progress.frame(frame)).ok()
            }
            Some("subagent_event") => {
                let Some(payload) = frame.get("payload").and_then(Value::as_object) else {
                    return Some(Cow::Borrowed(frame));
                };
                let Some(event) = payload.get("event") else {
                    return Some(Cow::Borrowed(frame));
                };
                let scope = key_of(payload.get("id"));
                self.outputs.forget(&scope, event);
                self.args.forget(&scope, event);
                let next = match js::type_of(event) {
                    Some("tool_execution_start") => {
                        let _ = self.args.decode(&scope, event);
                        None
                    }
                    Some("tool_execution_update") => self.update(&scope, event).ok()?,
                    Some("message_update") => self.restore_subagent.restore(&scope, event),
                    _ => None,
                };
                let Some(next) = next else {
                    return Some(Cow::Borrowed(frame));
                };
                let mut out = Map::new();
                if let Some(kind) = frame.get("type") {
                    out.insert("type".into(), kind.clone());
                }
                out.insert(
                    "payload".into(),
                    Value::Object(js::with(payload, "event", next)),
                );
                Some(Cow::Owned(Value::Object(out)))
            }
            _ => Some(Cow::Borrowed(frame)),
        }
    }
}
