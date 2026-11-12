//! Records as they cross after the last one of the same kind (was `link-events.ts`'s `FieldDelta`, `ItemsDelta`, the
//! status, read and progress encoders and decoders): only the top-level fields that changed (`set`) and the keys that
//! went (`unset`), a list among them as its length and the items that differ, at an offset when it moved on (`shift`).
//! Encoder and decoder each keep the last record and mirror each other because the link is ordered.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value, json};

use super::js;

pub const DELTA: &str = "~delta";
const ITEMS: &str = "~items";
const ITEM_FIELDS: &str = "~fields";
const READ: &str = "~read";
/// The `~delta` id of an Autopilot status, and of a read's delta, as the first devices read it.
const STATUS: &str = "autopilot";

/// What the decoder gives for a delta against a record it never held.
#[derive(Debug, PartialEq)]
pub struct Unrebuilt;

/// A map whose oldest entry goes first past `limit`, an entry set again counting as new (a JavaScript `Map` with
/// `delete` then `set`): both ends of a link keep the same entries in the same order.
#[derive(Debug)]
pub struct Kept<T> {
    limit: usize,
    next: u64,
    entries: HashMap<String, (u64, T)>,
    order: BTreeMap<u64, String>,
}

impl<T> Kept<T> {
    pub fn new(limit: usize) -> Kept<T> {
        Kept {
            limit,
            next: 0,
            entries: HashMap::new(),
            order: BTreeMap::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&T> {
        self.entries.get(key).map(|(_, value)| value)
    }

    pub fn set(&mut self, key: String, value: T) {
        let place = self.next;
        self.next += 1;
        if let Some((old, _)) = self.entries.insert(key.clone(), (place, value)) {
            self.order.remove(&old);
        }
        self.order.insert(place, key);
        while self.entries.len() > self.limit {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}

/// The validated `FieldDelta` (`{"~delta": id, set?, unset?}`, other keys allowed): its id, set and unset.
pub struct FieldDelta<'a> {
    pub id: &'a str,
    pub set: Option<&'a Map<String, Value>>,
    pub unset: Option<Vec<&'a str>>,
}

pub fn as_delta(value: Option<&Value>) -> Option<FieldDelta<'_>> {
    let map = value?.as_object()?;
    let id = map.get(DELTA)?.as_str()?;
    let set = match map.get("set") {
        None => None,
        Some(Value::Object(set)) => Some(set),
        Some(_) => return None,
    };
    let unset = match map.get("unset") {
        None => None,
        Some(Value::Array(keys)) => {
            Some(keys.iter().map(Value::as_str).collect::<Option<Vec<_>>>()?)
        }
        Some(_) => return None,
    };
    Some(FieldDelta { id, set, unset })
}

/// The subagent a snapshot or its delta belongs to.
pub fn id_of(value: Option<&Value>) -> Option<&str> {
    let map = value?.as_object()?;
    if let Some(Value::String(id)) = map.get(DELTA) {
        return Some(id);
    }
    map.get("id")?.as_str()
}

/// `next` after `base`: the fields that are different now and the keys that are gone.
pub fn diff(id: &str, base: &Map<String, Value>, next: &Map<String, Value>) -> Map<String, Value> {
    let mut set = Map::new();
    for (key, value) in next {
        if !base
            .get(key)
            .is_some_and(|before| js::deep_equal(before, value))
        {
            js::set(&mut set, key.clone(), value.clone());
        }
    }
    let unset: Vec<Value> = base
        .keys()
        .filter(|key| !next.contains_key(*key))
        .map(|key| Value::String(key.clone()))
        .collect();
    let mut delta = Map::new();
    delta.insert(DELTA.into(), Value::String(id.into()));
    if !set.is_empty() {
        delta.insert("set".into(), Value::Object(set));
    }
    if !unset.is_empty() {
        delta.insert("unset".into(), Value::Array(unset));
    }
    delta
}

/// `{...base, ...set}` without `unset`.
pub fn patch(
    base: &Map<String, Value>,
    set: Option<&Map<String, Value>>,
    unset: Option<&[&str]>,
) -> Map<String, Value> {
    let mut next = match set {
        Some(set) => js::spread(base, set),
        None => base.clone(),
    };
    for key in unset.unwrap_or_default() {
        js::delete(&mut next, key);
    }
    next
}

fn items_at(base: &[Value], next: &[Value], shift: usize, fields: bool) -> Map<String, Value> {
    let mut at = Map::new();
    for (index, item) in next.iter().enumerate() {
        let before = index + shift;
        let prior = base.get(before);
        if prior.is_some_and(|prior| js::deep_equal(prior, item)) {
            continue;
        }
        // A roster's running agent changes its progress each poll and keeps its long assignment: only the fields.
        let value = match (fields, prior, item) {
            (true, Some(Value::Object(prior)), Value::Object(item)) => {
                json!({ ITEM_FIELDS: Value::Object(diff(STATUS, prior, item)) })
            }
            _ => item.clone(),
        };
        at.insert(index.to_string(), value);
    }
    at
}

/// A list field after the last one: its length now and the items at an index that differ (or are new), compared at
/// an offset when `shifts` and one fits better.
fn diff_items(base: &[Value], next: &[Value], shifts: bool, fields: bool) -> Value {
    let at = items_at(base, next, 0, fields);
    let plain = |at| json!({ ITEMS: next.len(), "at": Value::Object(at) });
    let Some(first) = next.first() else {
        return plain(at);
    };
    if !shifts || at.is_empty() {
        return plain(at);
    }
    let shift = base
        .iter()
        .enumerate()
        .position(|(index, item)| index > 0 && js::deep_equal(item, first));
    let Some(shift) = shift.filter(|shift| *shift >= 1) else {
        return plain(at);
    };
    let shifted = items_at(base, next, shift, false);
    if shifted.len() < at.len() {
        json!({ ITEMS: next.len(), "at": Value::Object(shifted), "shift": shift })
    } else {
        plain(at)
    }
}

/// A non-negative integer field, as `z.number().int().nonnegative()` reads it.
fn whole_number(value: Option<&Value>, positive: bool) -> Option<f64> {
    js::integer(value).filter(|number| {
        if positive {
            *number > 0.0
        } else {
            *number >= 0.0
        }
    })
}

/// The list [`diff_items`] describes; [`Unrebuilt`] when it names an item `base` never had. `None`: no `ItemsDelta`.
fn patch_items(base: Option<&Value>, delta: &Value) -> Option<Result<Value, Unrebuilt>> {
    let map = delta.as_object()?;
    let length = whole_number(map.get(ITEMS), false)?;
    let at = map.get("at")?.as_object()?;
    let shift = match map.get("shift") {
        None => 0.0,
        some => whole_number(some, true)?,
    };
    let before: &[Value] = base.and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let mut next = Vec::new();
    let mut index = 0usize;
    while (index as f64) < length {
        let from = index as f64 + shift;
        let prior = (from < before.len() as f64).then(|| &before[from as usize]);
        if let Some(item) = at.get(&index.to_string()) {
            let fields = item
                .as_object()
                .and_then(|item| as_delta(item.get(ITEM_FIELDS)));
            match fields {
                None => next.push(item.clone()),
                Some(fields) => match prior {
                    Some(Value::Object(prior)) => {
                        next.push(Value::Object(patch(
                            prior,
                            fields.set,
                            fields.unset.as_deref(),
                        )));
                    }
                    _ => return Some(Err(Unrebuilt)),
                },
            }
        } else if let Some(prior) = prior {
            next.push(prior.clone());
        } else {
            return Some(Err(Unrebuilt));
        }
        index += 1;
    }
    Some(Ok(Value::Array(next)))
}

/// A record after the last one sent: the top-level fields that changed, a list among them as [`diff_items`].
fn record_delta(
    base: &Map<String, Value>,
    status: &Map<String, Value>,
    shifts: bool,
    fields: bool,
) -> Map<String, Value> {
    let mut delta = diff(STATUS, base, status);
    if let Some(Value::Object(set)) = delta.get_mut("set") {
        for (key, value) in set.iter_mut() {
            if let (Value::Array(next), Some(Value::Array(before))) = (&*value, base.get(key)) {
                *value = diff_items(before, next, shifts, fields);
            }
        }
    }
    delta
}

/// The record [`record_delta`] describes.
fn patch_record(
    base: &Map<String, Value>,
    delta: &FieldDelta,
) -> Result<Map<String, Value>, Unrebuilt> {
    let mut set = Map::new();
    for (key, value) in delta.set.into_iter().flatten() {
        let next = match patch_items(base.get(key), value) {
            Some(rebuilt) => rebuilt?,
            None => value.clone(),
        };
        js::set(&mut set, key.clone(), next);
    }
    Ok(patch(base, Some(&set), delta.unset.as_deref()))
}

/// An Autopilot status after the last one: whole once, then as what changed.
#[derive(Debug, Default)]
pub struct StatusEncoder {
    last: Option<Map<String, Value>>,
}

impl StatusEncoder {
    /// The status as it crosses; `None` when it crosses as it is.
    pub fn encode(&mut self, status: Option<&Value>) -> Option<Value> {
        let Some(Value::Object(status)) = status else {
            self.last = None;
            return None;
        };
        let base = self.last.replace(status.clone());
        base.map(|base| Value::Object(record_delta(&base, status, false, false)))
    }
}

/// The inverse of [`StatusEncoder`].
#[derive(Debug, Default)]
pub struct StatusDecoder {
    last: Option<Map<String, Value>>,
}

impl StatusDecoder {
    /// The status the host's pool delivered; `Ok(None)` when the wire carries it as it is.
    pub fn decode(&mut self, wire: Option<&Value>) -> Result<Option<Value>, Unrebuilt> {
        let delta = as_delta(wire).filter(|delta| delta.id == STATUS);
        let Some(delta) = delta else {
            if let Some(Value::Object(status)) = wire {
                self.last = Some(status.clone());
            }
            return Ok(None);
        };
        let Some(last) = &self.last else {
            return Err(Unrebuilt);
        };
        let status = patch_record(last, &delta)?;
        self.last = Some(status.clone());
        Ok(Some(Value::Object(status)))
    }
}

/// A read's answers on one connection: whole once (or when `fresh`), then as a delta of the last one this encoder
/// sent, both numbered under an epoch unique to the encoder.
#[derive(Debug)]
pub struct ReadEncoder {
    epoch: String,
    next: u64,
    shifts: bool,
    fields: bool,
    last: Option<(String, Map<String, Value>)>,
}

impl ReadEncoder {
    /// `epoch`: the encoder's own id (`randomUUID()`); a device keeps its copies across a reconnect, and a new encoder
    /// must never name one of them.
    pub fn new(epoch: String, shifts: bool, fields: bool) -> ReadEncoder {
        ReadEncoder {
            epoch,
            next: 0,
            shifts,
            fields,
            last: None,
        }
    }

    pub fn encode(&mut self, status: Option<&Value>, fresh: bool) -> Value {
        self.next += 1;
        let id = format!("{}.{}", self.epoch, self.next);
        let mut out = Map::new();
        out.insert(READ.into(), Value::String(id.clone()));
        let Some(Value::Object(status)) = status else {
            self.last = None;
            if let Some(status) = status {
                out.insert("status".into(), status.clone());
            }
            return Value::Object(out);
        };
        let base = self.last.replace((id, status.clone()));
        match base.filter(|_| !fresh) {
            Some((base_id, base)) => {
                out.insert("base".into(), Value::String(base_id));
                out.insert(
                    "delta".into(),
                    Value::Object(record_delta(&base, status, self.shifts, self.fields)),
                );
            }
            None => {
                out.insert("status".into(), Value::Object(status.clone()));
            }
        }
        Value::Object(out)
    }
}

/// The device's side, one per read and tab.
#[derive(Debug, Default)]
pub struct ReadDecoder {
    /// The last few, by number, the oldest first.
    held: Vec<(String, Map<String, Value>)>,
}

impl ReadDecoder {
    fn hold(&mut self, id: &str, status: &Map<String, Value>) {
        match self.held.iter_mut().find(|(held, _)| held == id) {
            Some(slot) => slot.1 = status.clone(),
            None => self.held.push((id.into(), status.clone())),
        }
        while self.held.len() > 4 {
            self.held.remove(0);
        }
    }

    /// The answer the wire carries (null where it carried none); `None` when it is a delta of a copy this side lacks.
    pub fn decode(&mut self, wire: &Value) -> Option<Value> {
        let Some(map) = wire.as_object() else {
            return Some(wire.clone());
        };
        let Some(id) = map.get(READ).and_then(Value::as_str) else {
            // An older host answers the status itself.
            return Some(wire.clone());
        };
        let delta = match (map.get("base"), as_delta(map.get("delta"))) {
            (Some(Value::String(base)), Some(delta)) => Some((base, delta)),
            _ => None,
        };
        let Some((base, delta)) = delta else {
            let status = map.get("status");
            if let Some(Value::Object(status)) = status {
                self.hold(id, status);
            }
            return Some(status.cloned().unwrap_or(Value::Null));
        };
        let held = self.held.iter().find(|(held, _)| held == base)?;
        let status = patch_record(&held.1, &delta).ok()?;
        self.hold(id, &status);
        Some(Value::Object(status))
    }
}

/// The reads Settings makes on a host's tab each time it opens (`slimSettingsReads`).
const SETTINGS_READS: [&str; 4] = [
    "get_providers",
    "get_settings_schema",
    "get_model_roles",
    "get_settings",
];

/// Which answers cross as numbered deltas: the chain's key and the capability it needs.
pub fn encoded_read_key(command: &Value) -> Option<(String, &'static str)> {
    let kind = command.get("type").and_then(Value::as_str)?;
    let field = |key| command.get(key);
    match kind {
        "get_autopilot" => {
            let key = if field("allCycles") == Some(&Value::Bool(true)) {
                format!("{kind}:all")
            } else {
                kind.into()
            };
            Some((key, "autopilotReads"))
        }
        "get_available_commands" => Some((kind.into(), "listReads")),
        "get_transcript_page"
            if field("fromEnd") == Some(&Value::Bool(true)) && field("cursor").is_none() =>
        {
            Some((
                format!("{kind}:{}", js::string_of(field("limit"))),
                "listReads",
            ))
        }
        "get_subagents" => Some((kind.into(), "rosterReads")),
        "get_jobs" => Some((kind.into(), "jobsReads")),
        _ if SETTINGS_READS.contains(&kind) => {
            let args: Vec<String> = ["forceRefresh", "compact", "paths"]
                .iter()
                .map(|key| field(key).map(js::stringify).unwrap_or_default())
                .collect();
            Some((format!("{kind}:{}", args.join(":")), "settingsReads"))
        }
        _ => None,
    }
}

/// What a mapped snapshot became.
pub enum Mapped {
    Same,
    New(Value),
    Unrebuilt,
}

/// `event` with `map` applied to each snapshot of its `partialResult.details.progress`; `Err` when `map` gave up on
/// one, `Ok(None)` when nothing changed. `map` sees every snapshot, in order, either way.
pub fn map_snapshots(
    event: &Value,
    mut map: impl FnMut(&Value) -> Mapped,
) -> Result<Option<Value>, Unrebuilt> {
    let Some(partial) = event.get("partialResult").and_then(Value::as_object) else {
        return Ok(None);
    };
    let Some(details) = partial.get("details").and_then(Value::as_object) else {
        return Ok(None);
    };
    let Some(Value::Array(snapshots)) = details.get("progress") else {
        return Ok(None);
    };
    let mut mapped: Option<Vec<Value>> = None;
    let mut gave_up = false;
    for (index, snapshot) in snapshots.iter().enumerate() {
        match map(snapshot) {
            Mapped::Same => {}
            Mapped::Unrebuilt => gave_up = true,
            Mapped::New(next) => mapped.get_or_insert_with(|| snapshots.clone())[index] = next,
        }
    }
    if gave_up {
        return Err(Unrebuilt);
    }
    let Some(mapped) = mapped else {
        return Ok(None);
    };
    let details = js::with(details, "progress", Value::Array(mapped));
    let partial = js::with(partial, "details", Value::Object(details));
    let event = event
        .as_object()
        .map(|event| js::with(event, "partialResult", Value::Object(partial)));
    Ok(event.map(Value::Object))
}

/// A subagent's `AgentProgress` snapshots, whichever copy brought them (a `subagent_progress` frame or the parent's
/// task update): whole the first time, then what changed from the last one of that id. A frame's fields beside the
/// snapshot go the same way.
#[derive(Debug, Default)]
pub struct ProgressEncoder {
    snapshots: HashMap<String, Map<String, Value>>,
    payloads: HashMap<String, Map<String, Value>>,
}

impl ProgressEncoder {
    fn encode(&mut self, snapshot: &Value) -> Mapped {
        let (Some(id), Some(map)) = (id_of(Some(snapshot)), snapshot.as_object()) else {
            return Mapped::Same;
        };
        match self.snapshots.insert(id.into(), map.clone()) {
            Some(base) => Mapped::New(Value::Object(diff(id, &base, map))),
            None => Mapped::Same,
        }
    }

    /// The task update with each snapshot encoded; `None` when it crosses as it is.
    pub fn update(&mut self, event: &Value) -> Option<Value> {
        map_snapshots(event, |snapshot| self.encode(snapshot))
            .ok()
            .flatten()
    }

    /// The `subagent_progress` frame as it crosses; `None` when it crosses as it is.
    pub fn frame(&mut self, frame: &Value) -> Option<Value> {
        let payload = frame.get("payload")?.as_object()?;
        let progress = payload.get("progress");
        let id = id_of(progress)?.to_owned();
        let progress = progress?;
        let wire_progress = match self.encode(progress) {
            Mapped::New(next) => next,
            _ => progress.clone(),
        };
        let beside = js::without(payload, &["progress"]);
        let mut payload = match self.payloads.insert(id.clone(), beside.clone()) {
            Some(base) => diff(&id, &base, &beside),
            None => beside,
        };
        js::set(&mut payload, "progress", wire_progress);
        let mut out = Map::new();
        if let Some(kind) = frame.get("type") {
            out.insert("type".into(), kind.clone());
        }
        out.insert("payload".into(), Value::Object(payload));
        Some(Value::Object(out))
    }
}

/// The inverse of [`ProgressEncoder`]; what it holds no earlier record for (a delta) is never delivered.
#[derive(Debug, Default)]
pub struct ProgressDecoder {
    snapshots: HashMap<String, Map<String, Value>>,
    payloads: HashMap<String, Map<String, Value>>,
}

impl ProgressDecoder {
    fn decode(&mut self, wire: &Value) -> Mapped {
        if let Some(delta) = as_delta(Some(wire)) {
            let Some(base) = self.snapshots.get(delta.id) else {
                return Mapped::Unrebuilt;
            };
            let next = patch(base, delta.set, delta.unset.as_deref());
            self.snapshots.insert(delta.id.into(), next.clone());
            return Mapped::New(Value::Object(next));
        }
        if let (Some(id), Some(map)) = (id_of(Some(wire)), wire.as_object()) {
            self.snapshots.insert(id.into(), map.clone());
        }
        Mapped::Same
    }

    /// The task update as stock sent it; `Err` when a snapshot cannot be rebuilt, `Ok(None)` when it is as it came.
    pub fn update(&mut self, event: &Value) -> Result<Option<Value>, Unrebuilt> {
        map_snapshots(event, |snapshot| self.decode(snapshot))
    }

    /// The frame stock emitted; `Err` when it cannot be rebuilt, `Ok(None)` when it is the frame as it came.
    pub fn frame(&mut self, frame: &Value) -> Result<Option<Value>, Unrebuilt> {
        let Some(payload) = frame.get("payload").and_then(Value::as_object) else {
            return Ok(None);
        };
        let Some(wire_progress) = payload.get("progress") else {
            return Ok(None);
        };
        let Some(id) = id_of(Some(wire_progress)).map(str::to_owned) else {
            return Ok(None);
        };
        let progress = self.decode(wire_progress);
        let frame_delta = as_delta(frame.get("payload"));
        let beside = match &frame_delta {
            Some(delta) => self
                .payloads
                .get(&id)
                .map(|base| patch(base, delta.set, delta.unset.as_deref())),
            None => Some(js::without(payload, &["progress"])),
        };
        if let Some(beside) = &beside {
            self.payloads.insert(id, beside.clone());
        }
        let progress = match progress {
            Mapped::Unrebuilt => return Err(Unrebuilt),
            Mapped::Same if frame_delta.is_none() => return Ok(None),
            Mapped::Same => wire_progress.clone(),
            Mapped::New(progress) => progress,
        };
        let Some(mut beside) = beside else {
            return Err(Unrebuilt);
        };
        js::set(&mut beside, "progress", progress);
        let mut out = Map::new();
        if let Some(kind) = frame.get("type") {
            out.insert("type".into(), kind.clone());
        }
        out.insert("payload".into(), Value::Object(beside));
        Ok(Some(Value::Object(out)))
    }
}
