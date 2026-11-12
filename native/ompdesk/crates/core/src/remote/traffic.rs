//! What a host link carried, by kind, for the runtime log (was `src/main/remote/link-traffic.ts`'s `LinkTraffic` and
//! the line `logLinkTraffic` writes when it flushes): wire bytes and frame counts per kind (`tx evt tab.event events`,
//! `rx req tab.command`, ...) and, for a batch of omp events, how many of each type it held. It never holds a payload,
//! an address or a key. Pure: the link task runs the minute timer and calls `take` and `details`.
//!
//! Names are JavaScript strings in the TypeScript (UTF-16, cut at 64 code units, so a cut can split a surrogate pair
//! and `JSON.stringify` then writes the half as `\ud83d`); they are kept as code units here so the line is the same
//! text. Objects the TypeScript built with `Object.fromEntries` list integer-like keys first, ascending; `js_order`
//! does the same.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::codec::scan::{self, Value as Json};

/// A window that moved fewer bytes than this is not worth a line (an idle link sends about 1 KiB a minute in pings).
pub const TRAFFIC_LOG_MIN_BYTES: u64 = 256 * 1024;
pub const TRAFFIC_LOG_MS: u64 = 60_000;
/// Kinds and omp types written per line.
const TOP: usize = 5;
/// Kinds counted separately; a peer cannot grow the table past this by inventing method names.
const MAX_KINDS: usize = 128;
const MAX_OPEN_REQUESTS: usize = 256;
const MAX_NAME_UNITS: usize = 64;
/// What a message crossing as a reference to a copy already sent carries in place of itself (`link-events.ts`).
const SENT_REF: &str = "~sent";
const TAB_EVENT: &str = "tab.event";

type Js = Vec<u16>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Tx,
    Rx,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub kind: Js,
    pub frames: u64,
    pub bytes: u64,
}

/// What was counted since the last `take`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Window {
    pub tx: u64,
    pub rx: u64,
    /// Every kind seen, the biggest first.
    pub rows: Vec<Row>,
    /// omp events inside `tab.event events` batches and subagent frames inside batched `subagentFrame` ones, by type.
    pub batched: Vec<(Js, u64)>,
    /// Their JSON size by type (the item alone, without the frame around it).
    pub batched_bytes: Vec<(Js, u64)>,
    /// The messages of an `agent_end` that crossed whole instead of as a reference to the copy their `message_start`
    /// or `message_end` carried, their JSON size by role (`custom:<customType>` for a custom message).
    pub whole_ends: Vec<(Js, u64)>,
}

fn js(text: &str) -> Js {
    text.encode_utf16().collect()
}

fn concat(parts: &[&[u16]]) -> Js {
    parts.iter().flat_map(|part| part.iter().copied()).collect()
}

/// A string value cut to 64 code units, or `?` for anything else (`name()`).
fn name(value: Option<Json>) -> Js {
    match value.and_then(|value| value.string()) {
        Some(mut units) => {
            units.truncate(MAX_NAME_UNITS);
            units
        }
        None => js("?"),
    }
}

fn is_string(value: Option<Json>, wanted: &str) -> bool {
    value
        .and_then(|value| value.string())
        .is_some_and(|units| units == js(wanted))
}

/// `value?.key` of an object; absent for any other kind of value, as a property of a primitive or an array is.
fn field<'a>(value: Option<Json<'a>>, key: &str) -> Option<Json<'a>> {
    value.filter(Json::is_object)?.get(key)
}

/// Counts in the order a key first came, as a `Map` keeps them.
#[derive(Default)]
struct Counts {
    index: HashMap<Js, usize>,
    items: Vec<(Js, u64)>,
}

impl Counts {
    fn add(&mut self, key: Js, by: u64) {
        match self.index.get(&key) {
            Some(&at) => self.items[at].1 += by,
            None => {
                self.index.insert(key.clone(), self.items.len());
                self.items.push((key, by));
            }
        }
    }

    fn take(&mut self) -> Vec<(Js, u64)> {
        self.index.clear();
        js_order(std::mem::take(&mut self.items))
    }
}

/// The key as a JavaScript array index (`"0"`, `"17"`, up to 2^32 - 2), which an object lists first.
fn array_index(key: &[u16]) -> Option<u64> {
    let digits = key
        .iter()
        .map(|&unit| char::from_u32(u32::from(unit)).and_then(|c| c.to_digit(10)));
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value = 0u64;
    for digit in digits {
        value = value * 10 + u64::from(digit?);
    }
    (value <= 4_294_967_294).then_some(value)
}

/// The order `Object.fromEntries` and `Object.entries` give: integer-like keys ascending, then the rest as they came.
fn js_order(entries: Vec<(Js, u64)>) -> Vec<(Js, u64)> {
    let (mut indexed, rest): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|(key, _)| array_index(key).is_some());
    indexed.sort_by_key(|(key, _)| array_index(key));
    indexed.extend(rest);
    indexed
}

#[derive(Default)]
pub struct LinkTraffic {
    rows: Vec<Row>,
    row_index: HashMap<Js, usize>,
    batched: Counts,
    batched_bytes: Counts,
    whole_ends: Counts,
    /// Methods of requests seen, by id, until their answer passes: an answer is sized under its request's method.
    methods: HashMap<u64, Js>,
    tx: u64,
    rx: u64,
}

/// A request id as the `Map` the TypeScript keyed by it sees it: `-0` and `0` are one key.
fn id_key(id: f64) -> u64 {
    if id == 0.0 { 0 } else { id.to_bits() }
}

impl LinkTraffic {
    pub fn new() -> LinkTraffic {
        LinkTraffic::default()
    }

    /// Count one message: `json` is its text (what was written, or what arrived), `bytes` its wire size with the
    /// header and the encryption's overhead. An item's size is its text's: equal to `JSON.stringify(item)` for JSON
    /// that `JSON.stringify` wrote.
    pub fn record(&mut self, direction: Direction, json: &[u8], bytes: usize) {
        let bytes = bytes as u64;
        let prefix = js(match direction {
            Direction::Tx => "tx ",
            Direction::Rx => "rx ",
        });
        let kind = concat(&[&prefix, &self.kind_of(json)]);
        match direction {
            Direction::Tx => self.tx += bytes,
            Direction::Rx => self.rx += bytes,
        }
        let at = match self.row_index.get(&kind) {
            Some(&at) => at,
            None => {
                if self.rows.len() >= MAX_KINDS {
                    return;
                }
                self.row_index.insert(kind.clone(), self.rows.len());
                self.rows.push(Row {
                    kind,
                    frames: 0,
                    bytes: 0,
                });
                self.rows.len() - 1
            }
        };
        self.rows[at].frames += 1;
        self.rows[at].bytes += bytes;
    }

    /// What was counted since the last call; the next window starts empty. Requests still open stay, so an answer in
    /// the next window is still sized under its method.
    pub fn take(&mut self) -> Window {
        let mut rows = std::mem::take(&mut self.rows);
        self.row_index.clear();
        rows.sort_by_key(|row| std::cmp::Reverse(row.bytes));
        let window = Window {
            tx: self.tx,
            rx: self.rx,
            rows,
            batched: self.batched.take(),
            batched_bytes: self.batched_bytes.take(),
            whole_ends: self.whole_ends.take(),
        };
        self.tx = 0;
        self.rx = 0;
        window
    }

    fn kind_of(&mut self, json: &[u8]) -> Js {
        let root = Json::root(json).filter(Json::is_object);
        let (mut t, mut id, mut method, mut event, mut data, mut params) =
            (None, None, None, None, None, None);
        for (key, value) in root.iter().flat_map(Json::entries) {
            let slot = if scan::key_is(key, "t") {
                &mut t
            } else if scan::key_is(key, "id") {
                &mut id
            } else if scan::key_is(key, "method") {
                &mut method
            } else if scan::key_is(key, "event") {
                &mut event
            } else if scan::key_is(key, "data") {
                &mut data
            } else if scan::key_is(key, "params") {
                &mut params
            } else {
                continue;
            };
            *slot = Some(value);
        }
        let id = id.and_then(|id| id.number());
        if is_string(t, "req") {
            let asked = method_of(method, params);
            if let Some(id) = id
                && self.methods.len() < MAX_OPEN_REQUESTS
            {
                self.methods.insert(id_key(id), asked.clone());
            }
            return concat(&[&js("req "), &asked]);
        }
        if is_string(t, "res") {
            let asked = id.and_then(|id| self.methods.remove(&id_key(id)));
            return match asked {
                Some(asked) => concat(&[&js("res "), &asked]),
                None => js("res"),
            };
        }
        if is_string(t, "evt") {
            return if is_string(event, TAB_EVENT) {
                self.tab_event_kind(data)
            } else {
                concat(&[&js("evt "), &name(event)])
            };
        }
        name(t)
    }

    fn tab_event_kind(&mut self, data: Option<Json>) -> Js {
        let tab_event = field(data, "name");
        let arg = field(data, "arg");
        let base = concat(&[&js("evt "), &js(TAB_EVENT), &js(" "), &name(tab_event)]);
        let Some(tab_event) = tab_event.and_then(|value| value.string()) else {
            return base;
        };
        let events = tab_event == js("events");
        let typed = ["subagentFrame", "liveFrame", "btwFrame"]
            .iter()
            .any(|typed| tab_event == js(typed));
        if let Some(batch) = arg.filter(Json::is_array)
            && (events || typed)
        {
            for item in batch.items() {
                let kind = name(field(Some(item), "type"));
                self.batched.add(kind.clone(), 1);
                self.batched_bytes
                    .add(kind.clone(), item.raw().len() as u64);
                if kind == js("agent_end") {
                    self.count_whole_ends(item);
                }
            }
            // A flush of subagent frames (`slimProgress`) holds frames of several types: one kind, each type counted.
            return if events {
                base
            } else {
                concat(&[&base, &js("/batch")])
            };
        }
        if typed {
            return concat(&[&base, &js("/"), &name(field(arg, "type"))]);
        }
        base
    }

    fn count_whole_ends(&mut self, item: Json) {
        let Some(messages) = field(Some(item), "messages").filter(Json::is_array) else {
            return;
        };
        for message in messages.items() {
            if !(message.is_object() || message.is_array()) {
                continue;
            }
            if message.is_object() && message.has(SENT_REF) {
                continue;
            }
            let role = field(Some(message), "role");
            let key = if is_string(role, "custom") {
                concat(&[&js("custom:"), &name(field(Some(message), "customType"))])
            } else {
                name(role)
            };
            if !self.whole_ends.index.contains_key(&key) && self.whole_ends.items.len() >= MAX_KINDS
            {
                continue;
            }
            self.whole_ends.add(key, message.raw().len() as u64);
        }
    }
}

/// A request's method, and for `tab.command` the RPC command's type with it: every poll of a viewed host tab is a
/// `tab.command`, and a link moving 3 MB a minute of their answers said nothing of which one.
fn method_of(method: Option<Json>, params: Option<Json>) -> Js {
    let base = name(method);
    if base != js("tab.command") {
        return base;
    }
    let command_type =
        field(field(params, "command"), "type").filter(|value| value.string().is_some());
    match command_type {
        Some(_) => concat(&[&base, &js("/"), &name(command_type)]),
        None => base,
    }
}

/// `JSON.stringify` of a string: a lone surrogate becomes its `\u` escape, which is why names stay code units.
fn quote(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    for unit in char::decode_utf16(units.iter().copied()) {
        match unit {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if c < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

fn object_text(entries: &[(Js, u64)]) -> String {
    let body: Vec<String> = entries
        .iter()
        .map(|(key, count)| format!("{}:{count}", quote(key)))
        .collect();
    format!("{{{}}}", body.join(","))
}

fn rows_text(rows: &[Row]) -> String {
    let body: Vec<String> = rows
        .iter()
        .map(|row| {
            format!(
                "{{\"kind\":{},\"frames\":{},\"bytes\":{}}}",
                quote(&row.kind),
                row.frames,
                row.bytes
            )
        })
        .collect();
    format!("[{}]", body.join(","))
}

/// The biggest five of a count table, as the line writes them: `Object.entries(x).sort(by count).slice(0, 5)` made
/// into an object again.
fn top_text(entries: &[(Js, u64)]) -> String {
    let mut sorted = entries.to_vec();
    sorted.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    sorted.truncate(TOP);
    object_text(&js_order(sorted))
}

/// The line's details for a window that lasted `ms`, or none for a window under `TRAFFIC_LOG_MIN_BYTES`. Values the
/// runtime log keeps are primitives, so what is a table is its JSON text (every traffic line until 21 Oct 2026 read
/// `ms`, `tx`, `rx` and nothing of what the bytes were).
pub fn details(window: &Window, ms: u64) -> Option<Map<String, Value>> {
    if window.tx + window.rx < TRAFFIC_LOG_MIN_BYTES {
        return None;
    }
    let mut out = Map::new();
    out.insert("ms".into(), ms.into());
    out.insert("tx".into(), window.tx.into());
    out.insert("rx".into(), window.rx.into());
    out.insert(
        "top".into(),
        rows_text(&window.rows[..window.rows.len().min(TOP)]).into(),
    );
    out.insert("events".into(), top_text(&window.batched).into());
    out.insert("eventBytes".into(), top_text(&window.batched_bytes).into());
    if !window.whole_ends.is_empty() {
        out.insert("wholeEnds".into(), object_text(&window.whole_ends).into());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Vec<Value> {
        serde_json::from_str(include_str!("traffic-captured.json")).unwrap()
    }

    fn direction(text: &str) -> Direction {
        if text == "tx" {
            Direction::Tx
        } else {
            Direction::Rx
        }
    }

    /// The window as `JSON.stringify(window)` wrote it.
    fn window_text(window: &Window) -> String {
        format!(
            "{{\"tx\":{},\"rx\":{},\"rows\":{},\"batched\":{},\"batchedBytes\":{},\"wholeEnds\":{}}}",
            window.tx,
            window.rx,
            rows_text(&window.rows),
            object_text(&window.batched),
            object_text(&window.batched_bytes),
            object_text(&window.whole_ends)
        )
    }

    fn feed(traffic: &mut LinkTraffic, records: &Value) {
        for record in records.as_array().unwrap() {
            traffic.record(
                direction(record["dir"].as_str().unwrap()),
                record["json"].as_str().unwrap().as_bytes(),
                record["bytes"].as_u64().unwrap() as usize,
            );
        }
    }

    #[test]
    fn windows_and_lines_match_the_typescript() {
        let mut checked = 0;
        for scenario in captured() {
            let label = scenario["name"].as_str().unwrap();
            let mut traffic = LinkTraffic::new();
            if label == "windows" {
                feed(&mut traffic, &scenario["first"]);
                assert_eq!(
                    window_text(&traffic.take()),
                    scenario["w1"],
                    "{label}: first"
                );
                feed(&mut traffic, &scenario["second"]);
                assert_eq!(
                    window_text(&traffic.take()),
                    scenario["w2"],
                    "{label}: second"
                );
                assert_eq!(
                    window_text(&traffic.take()),
                    scenario["w3"],
                    "{label}: empty"
                );
                checked += 1;
                continue;
            }
            feed(&mut traffic, &scenario["records"]);
            let window = traffic.take();
            assert_eq!(window_text(&window), scenario["window"], "{label}");
            let line = details(&window, scenario["ms"].as_u64().unwrap()).map(Value::Object);
            match (&line, &scenario["details"]) {
                (None, Value::Null) => {}
                (Some(got), want) => assert_eq!(got.to_string(), want.to_string(), "{label}"),
                (None, want) => panic!("{label}: no line, the TypeScript wrote {want}"),
            }
            checked += 1;
        }
        assert!(checked >= 19, "{checked}");
    }

    fn tab_event(name: &str, arg: &str) -> String {
        format!(
            r#"{{"t":"evt","event":"tab.event","data":{{"rtab":"t1","name":"{name}","arg":{arg}}}}}"#
        )
    }

    fn record(traffic: &mut LinkTraffic, direction: Direction, json: &str, bytes: usize) {
        traffic.record(direction, json.as_bytes(), bytes);
    }

    fn rows(window: &Window) -> Vec<(String, u64, u64)> {
        window
            .rows
            .iter()
            .map(|row| (String::from_utf16_lossy(&row.kind), row.frames, row.bytes))
            .collect()
    }

    fn counts(entries: &[(Js, u64)]) -> Vec<(String, u64)> {
        entries
            .iter()
            .map(|(key, n)| (String::from_utf16_lossy(key), *n))
            .collect()
    }

    fn row(kind: &str, frames: u64, bytes: u64) -> (String, u64, u64) {
        (kind.to_owned(), frames, bytes)
    }

    #[test]
    fn sizes_an_answer_under_the_method_of_its_request_and_a_tab_event_under_its_name() {
        let mut traffic = LinkTraffic::new();
        record(
            &mut traffic,
            Direction::Rx,
            r#"{"t":"req","id":7,"method":"sessions.list","params":{}}"#,
            90,
        );
        record(
            &mut traffic,
            Direction::Tx,
            r#"{"t":"res","id":7,"ok":true,"result":[]}"#,
            8_000,
        );
        record(
            &mut traffic,
            Direction::Tx,
            &tab_event("status", r#"{"status":"ready"}"#),
            300,
        );
        record(&mut traffic, Direction::Tx, r#"{"t":"ping"}"#, 44);
        let window = traffic.take();
        assert_eq!(
            rows(&window),
            [
                row("tx res sessions.list", 1, 8_000),
                row("tx evt tab.event status", 1, 300),
                row("rx req sessions.list", 1, 90),
                row("tx ping", 1, 44),
            ]
        );
        assert_eq!((window.tx, window.rx), (8_344, 90));
    }

    #[test]
    fn names_a_tab_command_and_its_answer_by_the_rpc_commands_type() {
        let mut traffic = LinkTraffic::new();
        record(
            &mut traffic,
            Direction::Rx,
            r#"{"t":"req","id":3,"method":"tab.command","params":{"rtab":"t1","command":{"type":"get_jobs"}}}"#,
            150,
        );
        record(
            &mut traffic,
            Direction::Tx,
            r#"{"t":"res","id":3,"ok":true,"result":{"type":"response"}}"#,
            80_000,
        );
        record(
            &mut traffic,
            Direction::Rx,
            r#"{"t":"req","id":4,"method":"tab.command","params":{"rtab":"t1"}}"#,
            60,
        );
        record(
            &mut traffic,
            Direction::Tx,
            r#"{"t":"res","id":4,"ok":true,"result":{}}"#,
            40,
        );
        assert_eq!(
            rows(&traffic.take()),
            [
                row("tx res tab.command/get_jobs", 1, 80_000),
                row("rx req tab.command/get_jobs", 1, 150),
                row("rx req tab.command", 1, 60),
                row("tx res tab.command", 1, 40),
            ]
        );
    }

    #[test]
    fn names_the_frame_type_of_a_subagent_frame_and_counts_the_omp_events_of_a_batch_by_type() {
        let mut traffic = LinkTraffic::new();
        record(
            &mut traffic,
            Direction::Tx,
            &tab_event(
                "subagentFrame",
                r#"{"type":"subagent_progress","payload":{}}"#,
            ),
            3_000,
        );
        record(
            &mut traffic,
            Direction::Tx,
            &tab_event(
                "events",
                r#"[{"type":"message_update"},{"type":"message_update"},{"type":"message_end"}]"#,
            ),
            40_000,
        );
        let window = traffic.take();
        let kinds: Vec<String> = rows(&window).into_iter().map(|(kind, _, _)| kind).collect();
        assert_eq!(
            kinds,
            [
                "tx evt tab.event events",
                "tx evt tab.event subagentFrame/subagent_progress"
            ]
        );
        assert_eq!(
            counts(&window.batched),
            [
                ("message_update".to_owned(), 2),
                ("message_end".to_owned(), 1)
            ]
        );
    }

    #[test]
    fn weighs_each_event_type_of_a_batch_by_its_own_json() {
        let mut traffic = LinkTraffic::new();
        let update = r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"a"}}"#;
        let end = format!(
            r#"{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#,
            "가".repeat(1_000)
        );
        record(
            &mut traffic,
            Direction::Tx,
            &tab_event("events", &format!("[{update},{update},{update},{end}]")),
            4_000,
        );
        let window = traffic.take();
        assert_eq!(
            counts(&window.batched),
            [
                ("message_update".to_owned(), 3),
                ("message_end".to_owned(), 1)
            ]
        );
        // UTF-8 bytes, not characters: a Korean syllable is three.
        assert_eq!(
            counts(&window.batched_bytes),
            [
                ("message_update".to_owned(), 3 * update.len() as u64),
                ("message_end".to_owned(), end.len() as u64)
            ]
        );
        assert!(end.len() > 3_000);
    }

    #[test]
    fn weighs_the_messages_of_an_agent_end_that_crossed_whole_by_role_never_one_that_crossed_as_a_reference()
     {
        let mut traffic = LinkTraffic::new();
        let reply = r#"{"role":"assistant","content":[{"type":"text","text":"done"}]}"#;
        let brief = r#"{"role":"custom","customType":"goal-continuation","content":"go on"}"#;
        let end = format!(
            r#"{{"type":"agent_end","messages":[{{"~sent":"user:1"}},{reply},{{"~sent":"assistant:2","entryId":"e","set":{{"completedAt":3}}}},{brief}]}}"#
        );
        record(
            &mut traffic,
            Direction::Tx,
            &tab_event("events", &format!("[{end}]")),
            900,
        );
        assert_eq!(
            counts(&traffic.take().whole_ends),
            [
                ("assistant".to_owned(), reply.len() as u64),
                ("custom:goal-continuation".to_owned(), brief.len() as u64)
            ]
        );
    }

    #[test]
    fn names_a_tab_event_that_batches_subagent_frames_one_kind_and_counts_its_frames_by_type() {
        let mut traffic = LinkTraffic::new();
        let batch =
            r#"[{"type":"subagent_progress"},{"type":"subagent_event"},{"type":"subagent_event"}]"#;
        record(
            &mut traffic,
            Direction::Tx,
            &tab_event("subagentFrame", batch),
            900,
        );
        let window = traffic.take();
        assert_eq!(
            rows(&window),
            [row("tx evt tab.event subagentFrame/batch", 1, 900)]
        );
        assert_eq!(
            counts(&window.batched),
            [
                ("subagent_progress".to_owned(), 1),
                ("subagent_event".to_owned(), 2)
            ]
        );
    }

    #[test]
    fn starts_an_empty_window_after_take_and_keeps_no_more_kinds_than_a_peer_can_inflate() {
        let mut traffic = LinkTraffic::new();
        for method in 0..1_000 {
            record(
                &mut traffic,
                Direction::Rx,
                &format!(r#"{{"t":"req","id":{method},"method":"m{method}"}}"#),
                10,
            );
        }
        let window = traffic.take();
        assert!(window.rows.len() <= 128);
        assert_eq!(
            (window.tx, window.rx),
            (0, 10_000),
            "kinds past the table still count their bytes"
        );
        assert_eq!(traffic.take(), Window::default());
    }

    #[test]
    fn a_link_that_only_pinged_writes_no_line() {
        let mut traffic = LinkTraffic::new();
        // The 130 minutes the link test let pass: a ping and a pong each way every 10 s, 44 bytes a frame.
        for minute in 0..130 {
            for _ in 0..6 {
                record(&mut traffic, Direction::Tx, r#"{"t":"ping"}"#, 44);
                record(&mut traffic, Direction::Rx, r#"{"t":"pong"}"#, 44);
                record(&mut traffic, Direction::Rx, r#"{"t":"ping"}"#, 44);
                record(&mut traffic, Direction::Tx, r#"{"t":"pong"}"#, 44);
            }
            let window = traffic.take();
            assert_eq!(window.tx + window.rx, 6 * 4 * 44, "minute {minute}");
            assert!(
                details(&window, TRAFFIC_LOG_MS).is_none(),
                "minute {minute}"
            );
        }
    }

    #[test]
    fn a_window_under_the_line_writes_nothing_and_at_the_line_writes() {
        let under = Window {
            tx: TRAFFIC_LOG_MIN_BYTES - 1,
            ..Window::default()
        };
        assert!(details(&under, 1).is_none());
        let at = Window {
            rx: TRAFFIC_LOG_MIN_BYTES,
            ..Window::default()
        };
        let line = details(&at, 7).unwrap();
        assert_eq!(
            line.keys().collect::<Vec<_>>(),
            ["ms", "tx", "rx", "top", "events", "eventBytes"]
        );
        assert_eq!(line["events"], "{}");
    }

    #[test]
    fn integer_like_keys_go_first_ascending() {
        let key = |text: &str| js(text);
        let ordered = js_order(vec![
            (key("b"), 1),
            (key("10"), 2),
            (key("a"), 3),
            (key("2"), 4),
            (key("01"), 5),
            (key("4294967295"), 6),
            (key("4294967294"), 7),
            (key("0"), 8),
        ]);
        let keys: Vec<String> = ordered
            .iter()
            .map(|(k, _)| String::from_utf16_lossy(k))
            .collect();
        assert_eq!(
            keys,
            ["0", "2", "10", "4294967294", "b", "a", "01", "4294967295"]
        );
    }

    #[test]
    fn a_name_cut_inside_a_surrogate_pair_is_written_as_the_typescript_wrote_it() {
        let mut traffic = LinkTraffic::new();
        let method = format!("{}\u{1f600}b", "a".repeat(63));
        let json = format!(r#"{{"t":"req","id":1,"method":"{method}"}}"#);
        traffic.record(Direction::Tx, json.as_bytes(), 300_000);
        let line = details(&traffic.take(), 1).unwrap();
        let top = line["top"].as_str().unwrap();
        assert!(
            top.contains(&format!("tx req {}\\ud83d\"", "a".repeat(63))),
            "{top}"
        );
    }

    #[test]
    fn malformed_text_counts_as_a_message_of_no_type_and_never_panics() {
        let mut traffic = LinkTraffic::new();
        for json in [
            &b""[..],
            b"{",
            b"{\"t\":",
            b"[[[",
            b"{\"t\":\"req\",\"method\":\"\\u12",
            b"\xff\xfe",
        ] {
            traffic.record(Direction::Rx, json, 10);
        }
        let window = traffic.take();
        assert_eq!(window.rx, 60);
        assert!(window.rows.iter().all(|row| row.frames >= 1));
    }

    #[test]
    fn open_requests_stop_at_the_table_size_even_for_a_known_id() {
        let mut traffic = LinkTraffic::new();
        for id in 0..MAX_OPEN_REQUESTS {
            traffic.record(
                Direction::Tx,
                format!(r#"{{"t":"req","id":{id},"method":"a"}}"#).as_bytes(),
                1,
            );
        }
        traffic.record(Direction::Tx, br#"{"t":"req","id":3,"method":"b"}"#, 1);
        traffic.record(Direction::Rx, br#"{"t":"res","id":3}"#, 1);
        let window = traffic.take();
        assert!(window.rows.iter().any(|row| row.kind == js("rx res a")));
    }
}
