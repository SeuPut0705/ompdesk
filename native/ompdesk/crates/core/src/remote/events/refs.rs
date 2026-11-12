//! What a connection already carried, sent again as a reference to it (was `link-events.ts`'s usage dropper and
//! restorer, ends, tool result, output and arguments encoders and decoders). Each end keeps what crossed in a
//! [`Kept`] of [`ENDS_KEPT`] entries, the oldest going first, the same on both ends because the link is ordered.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::delta::{Kept, Unrebuilt};
use super::js;

/// The messages a connection keeps for references; the oldest go first, the same on both ends.
pub const ENDS_KEPT: usize = 256;

const SENT: &str = "~sent";
const TOOL: &str = "~tool";
const OUTPUT: &str = "~output";
const ARGS: &str = "~args";
const READ_GROUP: &str = "__ompReadGroup";

/// At most this many places in `before` are tried as the start of `after`; a log of one repeated line matches
/// everywhere.
pub const CONTINUATION_TRIES: usize = 4;

/// `String(value)` as a key, `None` being `undefined`.
pub fn key_of(value: Option<&Value>) -> String {
    js::string_of(value)
}

fn is_terminal_end(event: &Value) -> bool {
    js::type_of(event) == Some("agent_end") && event.get("isTerminal") != Some(&Value::Bool(false))
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `{...event, key: value}` as a value.
fn event_with(event: &Value, key: &str, value: Value) -> Value {
    match event.as_object() {
        Some(map) => Value::Object(js::with(map, key, value)),
        None => event.clone(),
    }
}

/// Drops `message.usage` from an update that repeats the last one of its stream, keyed by the stream.
#[derive(Debug, Default)]
pub struct UsageDropper {
    sent: HashMap<String, (Option<Value>, Value)>,
}

impl UsageDropper {
    pub fn drop(&mut self, key: &str, update: &Value) -> Option<Value> {
        let message = update.get("message")?.as_object()?;
        let (usage, timestamp) = (message.get("usage")?, message.get("timestamp")?);
        if let Some((last_timestamp, last_usage)) = self.sent.get(key)
            && js::strict_equal(last_timestamp.as_ref(), Some(timestamp))
            && js::same_json(last_usage, usage)
        {
            return Some(event_with(
                update,
                "message",
                Value::Object(js::without(message, &["usage"])),
            ));
        }
        self.sent
            .insert(key.into(), (Some(timestamp.clone()), usage.clone()));
        None
    }
}

/// The inverse of [`UsageDropper`]: an update without `usage` gets the last one of its stream and message.
#[derive(Debug, Default)]
pub struct UsageRestorer {
    known: HashMap<String, (Value, Value)>,
}

impl UsageRestorer {
    pub fn restore(&mut self, key: &str, update: &Value) -> Option<Value> {
        let message = update.get("message")?.as_object()?;
        let timestamp = message.get("timestamp")?;
        if let Some(usage) = message.get("usage") {
            self.known
                .insert(key.into(), (timestamp.clone(), usage.clone()));
            return None;
        }
        let (last_timestamp, usage) = self.known.get(key)?;
        js::strict_equal(Some(last_timestamp), Some(timestamp)).then(|| {
            event_with(
                update,
                "message",
                Value::Object(js::with(message, "usage", usage.clone())),
            )
        })
    }
}

/// `role\0timestamp[\0toolCallId]`, as `String()` spells each.
fn message_key(message: &Value) -> String {
    let field = |key| js::field(Some(message), key);
    let mut key = format!(
        "{}\u{0}{}",
        js::string_of(field("role")),
        js::string_of(field("timestamp"))
    );
    if let Some(Value::String(call)) = field("toolCallId") {
        key.push('\u{0}');
        key.push_str(call);
    }
    key
}

/// A committed message without the read groups the bridge adds to its read calls, and those groups by content index.
fn without_read_groups(message: &Value) -> Option<(Value, Map<String, Value>)> {
    let content = message.get("content")?.as_array()?;
    let mut reads = Map::new();
    let plain: Vec<Value> = content
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let args = js::field(Some(block), "arguments").and_then(Value::as_object);
            match args {
                Some(args)
                    if js::type_of(block) == Some("toolCall") && args.contains_key(READ_GROUP) =>
                {
                    reads.insert(index.to_string(), args[READ_GROUP].clone());
                    let rest = js::without(args, &[READ_GROUP]);
                    event_with(block, "arguments", Value::Object(rest))
                }
                _ => block.clone(),
            }
        })
        .collect();
    (!reads.is_empty()).then(|| (event_with(message, "content", Value::Array(plain)), reads))
}

/// The inverse of [`without_read_groups`]: each group back on its read call, last among its arguments.
fn with_read_groups(message: Value, reads: &Map<String, Value>) -> Value {
    let Some(content) = message.get("content").and_then(Value::as_array) else {
        return message;
    };
    let content: Vec<Value> = content
        .iter()
        .enumerate()
        .map(|(index, block)| match reads.get(&index.to_string()) {
            Some(group) => {
                let mut args = js::field(Some(block), "arguments")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                js::set(&mut args, READ_GROUP, group.clone());
                event_with(block, "arguments", Value::Object(args))
            }
            None => block.clone(),
        })
        .collect();
    event_with(&message, "content", Value::Array(content))
}

/// What a message's top-level fields became since `before` crossed, when that is small beside the message itself;
/// `None` when the message must cross whole.
fn field_patch(before: &Value, message: &Value) -> Option<Map<String, Value>> {
    let (old, now) = (before.as_object()?, message.as_object()?);
    let mut set = Map::new();
    for (key, value) in now {
        if !old.get(key).is_some_and(|old| js::deep_equal(old, value)) {
            js::set(&mut set, key.clone(), value.clone());
        }
    }
    let unset: Vec<Value> = old
        .keys()
        .filter(|key| !now.contains_key(*key))
        .map(|key| Value::String(key.clone()))
        .collect();
    let set = Value::Object(set);
    if js::stringified_length(&set) * 4 > js::stringified_length(before) {
        return None;
    }
    let mut patch = Map::new();
    if set.as_object().is_some_and(|set| !set.is_empty()) {
        patch.insert("set".into(), set);
    }
    if !unset.is_empty() {
        patch.insert("unset".into(), Value::Array(unset));
    }
    Some(patch)
}

/// Sends a message whole the first time this connection carries it, and as `{"~sent": key}` (with the journal
/// `entryId` an `agent_end` adds, the read groups and the fields that changed when the device reads them) when a
/// `message_end` or `agent_end` carries the same message again.
#[derive(Debug)]
pub struct EndsEncoder {
    sent: Kept<Value>,
    read_groups: bool,
    fields: bool,
}

impl EndsEncoder {
    pub fn new(read_groups: bool, fields: bool) -> EndsEncoder {
        EndsEncoder {
            sent: Kept::new(ENDS_KEPT),
            read_groups,
            fields,
        }
    }

    pub fn encode(&mut self, event: &Value) -> Option<Value> {
        match js::type_of(event)? {
            "message_start" => {
                let message = event.get("message")?;
                self.sent.set(message_key(message), message.clone());
                None
            }
            "message_end" => {
                let message = event.get("message")?;
                let key = message_key(message);
                let again = self
                    .sent
                    .get(&key)
                    .is_some_and(|before| js::same_json(before, message));
                // Set again either way: the decoder keeps every message_end it resolves, and both ends evict in one
                // order.
                self.sent.set(key.clone(), message.clone());
                again.then(|| event_with(event, "message", json!({ SENT: key })))
            }
            "agent_end" => {
                let messages = event.get("messages")?.as_array()?;
                let mut changed = false;
                let messages: Vec<Value> = messages
                    .iter()
                    .map(|message| match self.reference(message) {
                        Some(reference) => {
                            changed = true;
                            reference
                        }
                        None => message.clone(),
                    })
                    .collect();
                if is_terminal_end(event) {
                    self.sent.clear();
                }
                changed.then(|| event_with(event, "messages", Value::Array(messages)))
            }
            _ => None,
        }
    }

    fn reference(&self, message: &Value) -> Option<Value> {
        let map = object(message)?;
        let (bare, entry_id) = match map.get("entryId") {
            Some(Value::String(id)) => (
                Value::Object(js::without(map, &["entryId"])),
                Some(id.clone()),
            ),
            _ => (message.clone(), None),
        };
        let (plain, reads) = match self
            .read_groups
            .then(|| without_read_groups(&bare))
            .flatten()
        {
            Some((plain, reads)) => (plain, Some(reads)),
            None => (bare, None),
        };
        let key = message_key(&plain);
        let before = self.sent.get(&key);
        let patch = match before {
            Some(before) if js::same_json(before, &plain) => Map::new(),
            Some(before) if self.fields => field_patch(before, &plain)?,
            _ => return None,
        };
        let mut reference = Map::new();
        reference.insert(SENT.into(), Value::String(key));
        if let Some(entry_id) = entry_id {
            reference.insert("entryId".into(), Value::String(entry_id));
        }
        if let Some(reads) = reads {
            reference.insert("reads".into(), Value::Object(reads));
        }
        reference.extend(patch);
        Some(Value::Object(reference))
    }
}

/// The inverse of [`EndsEncoder`]; `Err` for a reference to a message this decoder never held.
#[derive(Debug)]
pub struct EndsDecoder {
    kept: Kept<Value>,
}

impl Default for EndsDecoder {
    fn default() -> Self {
        EndsDecoder {
            kept: Kept::new(ENDS_KEPT),
        }
    }
}

/// A `SentRef` (strict: no other keys), as `link-events.ts` validated it.
struct SentRef<'a> {
    key: &'a str,
    entry_id: Option<&'a str>,
    reads: Option<&'a Map<String, Value>>,
    set: Option<&'a Map<String, Value>>,
    unset: Option<Vec<&'a str>>,
}

fn sent_ref(message: &Value) -> Option<SentRef<'_>> {
    let map = message.as_object()?;
    if map
        .keys()
        .any(|key| !matches!(key.as_str(), SENT | "entryId" | "reads" | "set" | "unset"))
    {
        return None;
    }
    let optional_record = |key| match map.get(key) {
        None => Some(None),
        Some(Value::Object(record)) => Some(Some(record)),
        Some(_) => None,
    };
    Some(SentRef {
        key: map.get(SENT)?.as_str()?,
        entry_id: match map.get("entryId") {
            None => None,
            Some(Value::String(id)) => Some(id),
            Some(_) => return None,
        },
        reads: optional_record("reads")?,
        set: optional_record("set")?,
        unset: match map.get("unset") {
            None => None,
            Some(Value::Array(keys)) => {
                Some(keys.iter().map(Value::as_str).collect::<Option<Vec<_>>>()?)
            }
            Some(_) => return None,
        },
    })
}

impl EndsDecoder {
    fn resolve(&self, message: &Value) -> Result<Option<Value>, Unrebuilt> {
        let Some(reference) = sent_ref(message) else {
            return Ok(None);
        };
        let held = self.kept.get(reference.key).ok_or(Unrebuilt)?;
        let mut whole = held.clone();
        if (reference.set.is_some() || reference.unset.is_some())
            && let Value::Object(map) = &whole
        {
            let empty = Map::new();
            let mut patched = js::spread(map, reference.set.unwrap_or(&empty));
            for key in reference.unset.as_deref().unwrap_or_default() {
                js::delete(&mut patched, key);
            }
            whole = Value::Object(patched);
        }
        if let Some(reads) = reference.reads {
            whole = with_read_groups(whole, reads);
        }
        if let Some(entry_id) = reference.entry_id {
            whole = event_with(&whole, "entryId", Value::String(entry_id.into()));
        }
        Ok(Some(whole))
    }

    pub fn decode(&mut self, event: &Value) -> Result<Option<Value>, Unrebuilt> {
        match js::type_of(event) {
            Some("message_start" | "message_end") => {
                let Some(message) = event.get("message") else {
                    return Ok(None);
                };
                let resolved = self.resolve(message)?;
                let whole = resolved.as_ref().unwrap_or(message);
                self.kept.set(message_key(whole), whole.clone());
                Ok(resolved.map(|whole| event_with(event, "message", whole)))
            }
            Some("agent_end") => {
                let Some(messages) = event.get("messages").and_then(Value::as_array) else {
                    return Ok(None);
                };
                let mut changed = false;
                let mut out = Vec::with_capacity(messages.len());
                for message in messages {
                    match self.resolve(message)? {
                        Some(whole) => {
                            changed = true;
                            out.push(whole);
                        }
                        None => out.push(message.clone()),
                    }
                }
                if is_terminal_end(event) {
                    self.kept.clear();
                }
                Ok(changed.then(|| event_with(event, "messages", Value::Array(out))))
            }
            _ => Ok(None),
        }
    }
}

/// What a tool result's `message_start` repeats of its `tool_execution_end`: `{content, details}` as JSON keeps them.
fn tool_output(content: Option<&Value>, details: Option<&Value>) -> Value {
    let mut output = Map::new();
    if let Some(content) = content {
        output.insert("content".into(), content.clone());
    }
    if let Some(details) = details {
        output.insert("details".into(), details.clone());
    }
    Value::Object(output)
}

fn tool_end(event: &Value) -> Option<(String, Value)> {
    if js::type_of(event) != Some("tool_execution_end") {
        return None;
    }
    let result = event.get("result");
    Some((
        key_of(event.get("toolCallId")),
        tool_output(js::field(result, "content"), js::field(result, "details")),
    ))
}

/// Sends a tool result's `message_start` as `{"~tool": toolCallId, ...the rest}` when its `content` and `details`
/// are what that call's `tool_execution_end`, already sent, carried.
#[derive(Debug)]
pub struct ToolResultEncoder {
    outputs: Kept<Value>,
}

impl Default for ToolResultEncoder {
    fn default() -> Self {
        ToolResultEncoder {
            outputs: Kept::new(ENDS_KEPT),
        }
    }
}

impl ToolResultEncoder {
    pub fn encode(&mut self, event: &Value) -> Option<Value> {
        if let Some((id, output)) = tool_end(event) {
            self.outputs.set(id, output);
            return None;
        }
        if is_terminal_end(event) {
            self.outputs.clear();
        }
        if js::type_of(event) != Some("message_start") {
            return None;
        }
        let message = event.get("message")?.as_object()?;
        let Some(Value::String(id)) = message.get("toolCallId") else {
            return None;
        };
        if message.get("role").and_then(Value::as_str) != Some("toolResult") {
            return None;
        }
        let output = tool_output(message.get("content"), message.get("details"));
        if !self
            .outputs
            .get(id)
            .is_some_and(|sent| js::same_json(sent, &output))
        {
            return None;
        }
        let mut reference = Map::new();
        reference.insert(TOOL.into(), Value::String(id.clone()));
        // `{"~tool": id, ...rest}`: an index-like key of the rest goes first, as JavaScript orders it.
        for (key, value) in js::without(message, &["content", "details"]) {
            js::set(&mut reference, key, value);
        }
        Some(event_with(event, "message", Value::Object(reference)))
    }
}

/// The inverse of [`ToolResultEncoder`]; `Err` for a reference to a call this decoder never saw end.
#[derive(Debug)]
pub struct ToolResultDecoder {
    outputs: Kept<Value>,
}

impl Default for ToolResultDecoder {
    fn default() -> Self {
        ToolResultDecoder {
            outputs: Kept::new(ENDS_KEPT),
        }
    }
}

impl ToolResultDecoder {
    pub fn decode(&mut self, event: &Value) -> Result<Option<Value>, Unrebuilt> {
        if let Some((id, output)) = tool_end(event) {
            self.outputs.set(id, output);
            return Ok(None);
        }
        if is_terminal_end(event) {
            self.outputs.clear();
        }
        if js::type_of(event) != Some("message_start") {
            return Ok(None);
        }
        let Some(message) = event.get("message").and_then(Value::as_object) else {
            return Ok(None);
        };
        let Some(Value::String(id)) = message.get(TOOL) else {
            return Ok(None);
        };
        let output = self.outputs.get(id).ok_or(Unrebuilt)?;
        let mut whole = js::without(message, &[TOOL]);
        for key in ["content", "details"] {
            if let Some(value) = output.get(key) {
                js::set(&mut whole, key, value.clone());
            }
        }
        Ok(Some(event_with(event, "message", Value::Object(whole))))
    }
}

/// The text of an update whose output is one text block, as stock's bash, eval and task tools stream it.
fn output_text(event: &Value) -> Option<&str> {
    let content = js::field(event.get("partialResult"), "content")?.as_array()?;
    let [block] = content.as_slice() else {
        return None;
    };
    (js::type_of(block) == Some("text"))
        .then(|| block.get("text")?.as_str())
        .flatten()
}

fn output_key(scope: &str, event: &Value) -> String {
    format!("{scope}\u{0}{}", key_of(event.get("toolCallId")))
}

enum Forget {
    All,
    Call(String),
}

fn forgets(event: &Value) -> Option<Forget> {
    if is_terminal_end(event) {
        return Some(Forget::All);
    }
    (js::type_of(event) == Some("tool_execution_end"))
        .then(|| Forget::Call(key_of(event.get("toolCallId"))))
}

/// `haystack.indexOf(needle, from)` over UTF-16 units.
fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    let first = needle[0];
    let last = haystack.len().checked_sub(needle.len())?;
    (from..=last).find(|&at| haystack[at] == first && haystack[at..at + needle.len()] == *needle)
}

/// Where in `before` the start of `after` picks up, so that `after` begins with `before[from..]`; `None` for nowhere.
/// Each try compares up to the whole text, so the tries are bounded and a text that matches nowhere tried goes whole.
pub fn continuation_of(before: &[u16], after: &[u16]) -> Option<usize> {
    if after.starts_with(before) {
        return Some(0);
    }
    let probe = &after[..after.len().min(64)];
    if probe.is_empty() {
        return None;
    }
    let mut at = index_of(before, probe, 1);
    let mut tries = 0;
    while let Some(found) = at {
        if tries >= CONTINUATION_TRIES {
            break;
        }
        // The kept part of `before` must fit inside `after`: a shorter `after` that matches only its start is no
        // continuation.
        let kept = before.len() - found;
        if kept <= after.len() && before[found..] == after[..kept] {
            return Some(found);
        }
        at = index_of(before, probe, found + 1);
        tries += 1;
    }
    None
}

fn with_content(event: &Value, content: Value) -> Value {
    let partial = event.get("partialResult").and_then(Value::as_object);
    let partial = match partial {
        Some(partial) => js::with(partial, "content", content),
        None => {
            let mut partial = Map::new();
            partial.insert("content".into(), content);
            partial
        }
    };
    event_with(event, "partialResult", Value::Object(partial))
}

/// A running call's whole output so far, after the first update of the call, crosses as what follows the last one:
/// `{"~output": {from, add}}` in place of `content` (UTF-16 offsets, as the TypeScript counted).
#[derive(Debug)]
pub struct OutputEncoder {
    sent: Kept<Vec<u16>>,
}

impl Default for OutputEncoder {
    fn default() -> Self {
        OutputEncoder {
            sent: Kept::new(ENDS_KEPT),
        }
    }
}

impl OutputEncoder {
    pub fn forget(&mut self, scope: &str, event: &Value) {
        match forgets(event) {
            Some(Forget::All) => self.sent.clear(),
            Some(Forget::Call(call)) => self.sent.set(format!("{scope}\u{0}{call}"), Vec::new()),
            None => {}
        }
    }

    pub fn update(&mut self, scope: &str, event: &Value) -> Option<Value> {
        let text: Vec<u16> = output_text(event)?.encode_utf16().collect();
        let key = output_key(scope, event);
        let before = self.sent.get(&key).cloned().unwrap_or_default();
        let length = text.len();
        let from = (!before.is_empty())
            .then(|| continuation_of(&before, &text))
            .flatten();
        let add = from.map(|from| String::from_utf16_lossy(&text[before.len() - from..]));
        let added = from.map(|from| length - (before.len() - from));
        self.sent.set(key, text);
        let (from, add) = (from?, add?);
        if added? * 2 > length {
            return None;
        }
        Some(with_content(
            event,
            json!({ OUTPUT: { "from": from, "add": add } }),
        ))
    }
}

/// The inverse of [`OutputEncoder`]; `Err` for an output that continues one this decoder never held.
#[derive(Debug)]
pub struct OutputDecoder {
    held: Kept<Vec<u16>>,
}

impl Default for OutputDecoder {
    fn default() -> Self {
        OutputDecoder {
            held: Kept::new(ENDS_KEPT),
        }
    }
}

impl OutputDecoder {
    pub fn forget(&mut self, scope: &str, event: &Value) {
        match forgets(event) {
            Some(Forget::All) => self.held.clear(),
            Some(Forget::Call(call)) => self.held.set(format!("{scope}\u{0}{call}"), Vec::new()),
            None => {}
        }
    }

    pub fn update(&mut self, scope: &str, event: &Value) -> Result<Option<Value>, Unrebuilt> {
        let key = output_key(scope, event);
        let content = js::field(event.get("partialResult"), "content");
        let delta = content
            .filter(|content| content.is_object())
            .and_then(|content| content.get(OUTPUT))
            .and_then(Value::as_object)
            .and_then(|delta| {
                let from = js::integer(delta.get("from")).filter(|from| *from >= 0.0)?;
                Some((from, delta.get("add")?.as_str()?))
            });
        let Some((from, add)) = delta else {
            if let Some(text) = output_text(event) {
                self.held.set(key, text.encode_utf16().collect());
            }
            return Ok(None);
        };
        let before = self
            .held
            .get(&key)
            .filter(|before| !before.is_empty())
            .ok_or(Unrebuilt)?;
        let start = (from.min(before.len() as f64)) as usize;
        let mut text = before[start..].to_vec();
        text.extend(add.encode_utf16());
        let whole = String::from_utf16_lossy(&text);
        self.held.set(key, text);
        Ok(Some(with_content(
            event,
            json!([{ "type": "text", "text": whole }]),
        )))
    }
}

/// A call's arguments as a tool event carries them: `tool_execution_start` and every `tool_execution_update`.
fn args_of(event: &Value) -> Option<(String, &Value)> {
    match js::type_of(event)? {
        "tool_execution_start" | "tool_execution_update" => {
            Some((key_of(event.get("toolCallId")), event.get("args")?))
        }
        _ => None,
    }
}

/// After the call's start the link carries `{"~args": true}` for arguments equal to the last ones it sent for that
/// call; changed arguments go whole.
#[derive(Debug)]
pub struct ArgsEncoder {
    sent: Kept<Option<Value>>,
}

impl Default for ArgsEncoder {
    fn default() -> Self {
        ArgsEncoder {
            sent: Kept::new(ENDS_KEPT),
        }
    }
}

impl ArgsEncoder {
    pub fn forget(&mut self, scope: &str, event: &Value) {
        match forgets(event) {
            Some(Forget::All) => self.sent.clear(),
            Some(Forget::Call(call)) => self.sent.set(format!("{scope}\u{0}{call}"), None),
            None => {}
        }
    }

    pub fn encode(&mut self, scope: &str, event: &Value) -> Option<Value> {
        let (call, args) = args_of(event)?;
        let key = format!("{scope}\u{0}{call}");
        let again =
            matches!(self.sent.get(&key), Some(Some(before)) if js::same_json(before, args));
        self.sent.set(key, Some(args.clone()));
        (again && js::type_of(event) == Some("tool_execution_update"))
            .then(|| event_with(event, "args", json!({ ARGS: true })))
    }
}

/// The inverse of [`ArgsEncoder`]; `Err` for an update that names arguments this decoder never held.
#[derive(Debug)]
pub struct ArgsDecoder {
    held: Kept<Option<Value>>,
}

impl Default for ArgsDecoder {
    fn default() -> Self {
        ArgsDecoder {
            held: Kept::new(ENDS_KEPT),
        }
    }
}

impl ArgsDecoder {
    pub fn forget(&mut self, scope: &str, event: &Value) {
        match forgets(event) {
            Some(Forget::All) => self.held.clear(),
            Some(Forget::Call(call)) => self.held.set(format!("{scope}\u{0}{call}"), None),
            None => {}
        }
    }

    pub fn decode(&mut self, scope: &str, event: &Value) -> Result<Option<Value>, Unrebuilt> {
        let Some((call, args)) = args_of(event) else {
            return Ok(None);
        };
        let key = format!("{scope}\u{0}{call}");
        let reference = args
            .as_object()
            .is_some_and(|args| args.len() == 1 && args.get(ARGS) == Some(&Value::Bool(true)));
        if !reference {
            self.held.set(key, Some(args.clone()));
            return Ok(None);
        }
        let held = self.held.get(&key).cloned().flatten().ok_or(Unrebuilt)?;
        // The encoder refreshed this call's place when it sent the reference: both ends evict the same calls.
        self.held.set(key, Some(held.clone()));
        Ok(Some(event_with(event, "args", held)))
    }
}
