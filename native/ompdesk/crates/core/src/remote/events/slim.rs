//! What a window and a device both receive of the live stream (was `src/main/message-update-slim.ts`,
//! `frame-bookkeeping.ts` and `subagent-frames.ts`'s `slimSubagentFrame`).
//!
//! omp's default `set_event_filter` (messageUpdates "full") attaches the whole accumulated message to every streaming
//! `message_update`, twice (`message` and `assistantMessageEvent.partial`): O(reply²) over a run. The renderer reads
//! `message.role`/`timestamp`, the provider's `message.usage`, the snapshot's text/thinking blocks on the first update of
//! a message it missed the start of, and for `toolcall_delta` the toolCall block at `partial.content[contentIndex]` (its
//! id and name). So the first update of each message goes whole and every later one reduced ([`slim_message_update`]).
//! Kept over stock's own delta projection (`modes/rpc/rpc-session-events`), which drops every snapshot: a renderer that
//! joins mid-stream needs the first one.

use std::borrow::Cow;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::js;

/// Reduce one `message_update` to the fields the renderer reads after the first update of its message.
pub fn slim_message_update(event: &Value) -> Value {
    let Some(base) = event.as_object() else {
        return event.clone();
    };
    let source = js::field(Some(event), "message");
    let mut message = Map::new();
    for key in ["role", "timestamp", "usage"] {
        if let Some(value) = js::field(source, key) {
            message.insert(key.into(), value.clone());
        }
    }
    let stream = base.get("assistantMessageEvent").and_then(Value::as_object);
    let empty = Map::new();
    let stream = stream.unwrap_or(&empty);
    let mut increment = js::without(
        stream,
        &["partial", "content", "toolCall", "message", "error"],
    );
    let partial = stream.get("partial");
    let index = js::index_of(increment.get("contentIndex"));
    if js::truthy(partial)
        && let Some(blocks) = js::field(partial, "content").and_then(Value::as_array)
        && let Some(block) = index.and_then(|index| blocks.get(index))
        && let Some(index) = index
    {
        let kind = increment.get("type").and_then(Value::as_str);
        let reduced = match (kind, js::type_of(block)) {
            (Some("toolcall_delta"), Some("toolCall")) => {
                let mut call = Map::new();
                call.insert("type".into(), json!("toolCall"));
                for key in ["id", "name"] {
                    if let Some(value) = block.get(key) {
                        call.insert(key.into(), value.clone());
                    }
                }
                call.insert("arguments".into(), json!({}));
                Some(Value::Object(call))
            }
            // Only now does stock know the block is narration (its signature closes it): the renderer moves it to the
            // reply.
            (Some("thinking_end"), Some("thinking")) if js::truthy(block.get("narration")) => {
                let mut thinking = Map::new();
                thinking.insert("type".into(), json!("thinking"));
                if let Some(text) = block.get("thinking") {
                    thinking.insert("thinking".into(), text.clone());
                }
                thinking.insert("narration".into(), Value::Bool(true));
                Some(Value::Object(thinking))
            }
            _ => None,
        };
        if let Some(reduced) = reduced {
            // Sparse on purpose: consumers index by contentIndex; JSON spells the holes as null.
            let mut content = vec![Value::Null; index];
            content.push(reduced);
            let mut wire = Map::new();
            if let Some(role) = js::field(partial, "role") {
                wire.insert("role".into(), role.clone());
            }
            wire.insert("content".into(), Value::Array(content));
            js::set(&mut increment, "partial", Value::Object(wire));
        }
    }
    Value::Object(js::replaced(
        base,
        vec![
            ("message", Value::Object(message)),
            ("assistantMessageEvent", Value::Object(increment)),
        ],
    ))
}

/// Where a slimmer stands: no message yet, or the message whose first update it sent whole (`None`: one without a
/// timestamp, which stands for itself as `undefined` did).
#[derive(Clone, Debug)]
pub enum Mark {
    NoMessage,
    At(Option<Value>),
}

impl Mark {
    fn is(&self, timestamp: Option<&Value>) -> bool {
        match self {
            Mark::NoMessage => false,
            Mark::At(at) => js::strict_equal(at.as_ref(), timestamp),
        }
    }

    /// `===` of two marks: an object timestamp never equals another.
    pub fn same(&self, other: &Mark) -> bool {
        match (self, other) {
            (Mark::NoMessage, Mark::NoMessage) => true,
            (Mark::At(a), Mark::At(b)) => js::strict_equal(a.as_ref(), b.as_ref()),
            _ => false,
        }
    }
}

fn is_update(event: &Value) -> bool {
    js::type_of(event) == Some("message_update")
}

/// One per receiver of a tab's stream (a window's attachment, a device's link). The first `message_update` of each
/// message it passes keeps the full snapshot, because a receiver that just attached never saw that message's
/// `message_start`; every later update of the same message is slimmed. Messages stream one at a time per session, so
/// the last full message's timestamp is the whole state.
#[derive(Debug)]
pub struct Slimmer {
    full: Mark,
}

impl Default for Slimmer {
    fn default() -> Self {
        Slimmer::new()
    }
}

impl Slimmer {
    pub fn new() -> Slimmer {
        Slimmer {
            full: Mark::NoMessage,
        }
    }

    /// Starts over, as a fresh slimmer (a receiver that needs the snapshot again).
    pub fn reset(&mut self) {
        self.full = Mark::NoMessage;
    }

    /// Where it stands.
    pub fn mark(&self) -> &Mark {
        &self.full
    }

    /// The batch as this receiver gets it; borrowed when nothing changed.
    pub fn slim<'a>(&mut self, events: &'a [Value]) -> Cow<'a, [Value]> {
        let mut out: Option<Vec<Value>> = None;
        for (index, event) in events.iter().enumerate() {
            let slimmed = is_update(event)
                .then(|| {
                    js::field(Some(event), "message").and_then(|message| message.get("timestamp"))
                })
                .and_then(|timestamp| {
                    if self.full.is(timestamp) {
                        Some(slim_message_update(event))
                    } else {
                        self.full = Mark::At(timestamp.cloned());
                        None
                    }
                });
            match (slimmed, &mut out) {
                (Some(slimmed), None) => {
                    let mut copy = Vec::with_capacity(events.len());
                    copy.extend_from_slice(&events[..index]);
                    copy.push(slimmed);
                    out = Some(copy);
                }
                (Some(slimmed), Some(copy)) => copy.push(slimmed),
                (None, Some(copy)) => copy.push(event.clone()),
                (None, None) => {}
            }
        }
        out.map_or(Cow::Borrowed(events), Cow::Owned)
    }

    /// [`Slimmer::slim`] of a batch several receivers slim one after another: those that stand at the same message get
    /// the very result the first made (`None`: the batch goes as it is), so what is made of it downstream can be made
    /// once too.
    pub fn slim_shared(
        &mut self,
        events: &[Value],
        shared: &mut SharedBatch,
    ) -> Option<Arc<[Value]>> {
        if let Some(known) = shared.kept.iter().find(|batch| batch.from.same(&self.full)) {
            self.full = known.to.clone();
            return known.out.clone();
        }
        let from = self.full.clone();
        let out = match self.slim(events) {
            Cow::Borrowed(_) => None,
            Cow::Owned(out) => Some(Arc::from(out)),
        };
        if shared.kept.len() < BATCH_STARTS_KEPT {
            shared.kept.push(SlimmedBatch {
                from,
                to: self.full.clone(),
                out: out.clone(),
            });
        }
        out
    }
}

/// Starting points kept per batch; the slimmers of one tab almost always stand at the same message.
const BATCH_STARTS_KEPT: usize = 4;

#[derive(Debug)]
struct SlimmedBatch {
    from: Mark,
    to: Mark,
    out: Option<Arc<[Value]>>,
}

/// What one batch became from each starting point; kept beside the batch while its receivers slim it.
#[derive(Debug, Default)]
pub struct SharedBatch {
    kept: Vec<SlimmedBatch>,
}

/// Provider request bookkeeping stock keeps on each assistant message (`resources/gui-bridge/transcript-page.ts`
/// `REQUEST_BOOKKEEPING`): nothing renders it.
const REQUEST_BOOKKEEPING: [&str; 3] =
    ["inputTransformations", "requestControls", "contextSnapshot"];

/// The message without request bookkeeping; `None` when it carries none.
fn without_request_bookkeeping(message: &Value) -> Option<Value> {
    let map = message.as_object()?;
    REQUEST_BOOKKEEPING
        .iter()
        .any(|key| map.contains_key(*key))
        .then(|| Value::Object(js::without(map, &REQUEST_BOOKKEEPING)))
}

/// A live frame without the bookkeeping on the messages it carries, and a `turn_end` with its type alone: its message
/// and tool results were each already sent by their own events. `None` when the frame stays as it is.
pub fn without_frame_bookkeeping(frame: &Value) -> Option<Value> {
    let map = frame.as_object()?;
    if js::type_of(frame) == Some("turn_end")
        && (map.contains_key("message") || map.contains_key("toolResults"))
    {
        return Some(Value::Object(js::without(map, &["message", "toolResults"])));
    }
    let mut fields: Vec<(&str, Value)> = Vec::new();
    if let Some(slim) = map.get("message").and_then(without_request_bookkeeping) {
        fields.push(("message", slim));
    }
    if let Some(messages) = map.get("messages").and_then(Value::as_array) {
        let slim: Vec<Option<Value>> = messages.iter().map(without_request_bookkeeping).collect();
        if slim.iter().any(Option::is_some) {
            let messages = messages
                .iter()
                .zip(slim)
                .map(|(message, slim)| slim.unwrap_or_else(|| message.clone()))
                .collect();
            fields.push(("messages", Value::Array(messages)));
        }
    }
    if let Some(stream) = map.get("assistantMessageEvent").and_then(Value::as_object)
        && let Some(partial) = stream.get("partial").and_then(without_request_bookkeeping)
    {
        fields.push((
            "assistantMessageEvent",
            Value::Object(js::with(stream, "partial", partial)),
        ));
    }
    (!fields.is_empty()).then(|| Value::Object(js::replaced(map, fields)))
}

/// A subagent's event reduced to what the renderer reads; `None` for a frame that stays as it is.
pub fn slim_subagent_frame(frame: &Value) -> Option<Value> {
    if js::type_of(frame) != Some("subagent_event") {
        return None;
    }
    let payload = frame.get("payload")?.as_object()?;
    let source = payload.get("event")?;
    let trimmed = without_frame_bookkeeping(source);
    let trimmed_ref = trimmed.as_ref().unwrap_or(source);
    let event = if is_update(trimmed_ref) {
        slim_message_update(trimmed_ref)
    } else {
        trimmed?
    };
    let mut out = Map::new();
    if let Some(kind) = frame.get("type") {
        out.insert("type".into(), kind.clone());
    }
    out.insert(
        "payload".into(),
        Value::Object(js::with(payload, "event", event)),
    );
    Some(Value::Object(out))
}

/// [`slim_subagent_frame`]'s frame, borrowed when unchanged.
pub fn slimmed_subagent_frame(frame: &Value) -> Cow<'_, Value> {
    slim_subagent_frame(frame).map_or(Cow::Borrowed(frame), Cow::Owned)
}
