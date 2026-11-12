//! Control-tool calls that change something, recorded by the call's own identity so a call made again after a relaunch
//! runs at most once (`call-journal.ts`). `begin` before the call's effect, `finish` with the result once known; a
//! finished record answers a repeated call, a pending one is reconciled by the service, never run blindly again.
//!
//! Kept in `<userData>/agent-control-calls.json` (written atomically, mode left to the umask as the TypeScript did):
//! only acknowledged records are forgotten, by age (`CALL_JOURNAL_TTL_MS`) and then oldest first past
//! `CALL_JOURNAL_MAX`.
//!
//! Seams: the clock. A write that fails is an `Err` (the TypeScript threw it); the in-memory change stays.
//! Differences: `begin` takes no `acked` (the service never passed one); `get` returns a copy, so a caller changes a
//! record only through `finish`, `note` and `acknowledge`.

use std::path::PathBuf;

use serde_json::{Map, Value};

use super::{
    Clock, THREE_DAYS_MS, js_number, number, object, read_array, string, stringify, strings,
    system_clock, write_text,
};

pub const CALL_JOURNAL_MAX: usize = 500;
pub const CALL_JOURNAL_TTL_MS: f64 = THREE_DAYS_MS;

/// What a pending call set out to do, enough to find its effect again after a relaunch.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CallIntent {
    /// `ompdesk_session_open`: the task title of each new session it opens.
    pub open: Option<Vec<String>>,
    /// `ompdesk_schedule` create: the device it saves on (absent = this computer) and the schedule's full name.
    pub schedule: Option<ScheduleIntent>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleIntent {
    pub device: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CallResult {
    pub text: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CallRecord {
    /// `<device>\n<caller's session file>\n<host call id>`.
    pub key: String,
    pub tool: String,
    /// The caller's tab when it began.
    pub caller_tab_id: String,
    pub at: f64,
    pub intent: Option<CallIntent>,
    /// Tabs the call opened so far (`note`).
    pub opened: Option<Vec<String>>,
    /// Absent while the call has not finished (pending).
    pub result: Option<CallResult>,
    /// The host took the result: only then may the record be forgotten.
    pub acked: bool,
    /// The keys the record holds, in the order the TypeScript object held them (a key set after the record was made
    /// comes last), so the file's text is the same.
    order: Vec<&'static str>,
}

/// A call about to run (`Omit<CallRecord, "at" | "result">`).
#[derive(Debug, Clone, PartialEq)]
pub struct CallBegin {
    pub key: String,
    pub tool: String,
    pub caller_tab_id: String,
    pub intent: Option<CallIntent>,
    pub opened: Option<Vec<String>>,
}

fn intent_json(intent: &CallIntent) -> Value {
    let mut map = Map::new();
    if let Some(open) = &intent.open {
        map.insert(
            "open".into(),
            Value::Array(open.iter().cloned().map(Value::String).collect()),
        );
    }
    if let Some(schedule) = &intent.schedule {
        let mut inner = Map::new();
        inner.insert("name".into(), Value::String(schedule.name.clone()));
        if let Some(device) = schedule.device.as_ref().filter(|device| !device.is_empty()) {
            inner.insert("device".into(), Value::String(device.clone()));
        }
        map.insert("schedule".into(), Value::Object(inner));
    }
    Value::Object(map)
}

/// `intent` of a CallBegin from its JSON (the shape `callIntent` makes).
pub fn parse_intent(value: &Value) -> Option<CallIntent> {
    let fields = object(value)?;
    let mut intent = CallIntent {
        open: strings(fields, "open"),
        schedule: None,
    };
    if let Some(schedule) = fields.get("schedule").and_then(object)
        && let Some(name) = string(schedule, "name")
    {
        intent.schedule = Some(ScheduleIntent {
            name: name.to_owned(),
            device: string(schedule, "device")
                .filter(|device| !device.is_empty())
                .map(str::to_owned),
        });
    }
    Some(intent)
}

fn parse_record(value: &Value) -> Option<CallRecord> {
    let fields = object(value)?;
    let key = string(fields, "key").filter(|key| !key.is_empty())?;
    let tool = string(fields, "tool")?;
    let at = number(fields, "at")?;
    let caller_tab_id = string(fields, "callerTabId")?;
    let mut record = CallRecord {
        key: key.to_owned(),
        tool: tool.to_owned(),
        caller_tab_id: caller_tab_id.to_owned(),
        at,
        intent: None,
        opened: None,
        result: None,
        acked: false,
        order: vec!["key", "tool", "callerTabId", "at"],
    };
    if let Some(intent) = fields.get("intent").and_then(parse_intent) {
        record.intent = Some(intent);
        record.order.push("intent");
    }
    if let Some(opened) = strings(fields, "opened") {
        record.opened = Some(opened);
        record.order.push("opened");
    }
    if let Some(result) = fields.get("result").and_then(object)
        && let (Some(text), Some(is_error)) = (
            string(result, "text"),
            result.get("isError").and_then(Value::as_bool),
        )
    {
        record.result = Some(CallResult {
            text: text.to_owned(),
            is_error,
        });
        record.order.push("result");
    }
    if fields.get("acked") == Some(&Value::Bool(true)) && record.result.is_some() {
        record.acked = true;
        record.order.push("acked");
    }
    Some(record)
}

impl CallRecord {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        for name in &self.order {
            let value = match *name {
                "key" => Value::String(self.key.clone()),
                "tool" => Value::String(self.tool.clone()),
                "callerTabId" => Value::String(self.caller_tab_id.clone()),
                "at" => js_number(self.at),
                "intent" => intent_json(self.intent.as_ref().unwrap_or(&CallIntent::default())),
                "opened" => Value::Array(
                    self.opened
                        .iter()
                        .flatten()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
                "result" => {
                    let Some(result) = &self.result else { continue };
                    let mut inner = Map::new();
                    inner.insert("text".into(), Value::String(result.text.clone()));
                    inner.insert("isError".into(), Value::Bool(result.is_error));
                    Value::Object(inner)
                }
                _ => Value::Bool(true),
            };
            map.insert((*name).to_owned(), value);
        }
        Value::Object(map)
    }

    fn has(&self, name: &str) -> bool {
        self.order.contains(&name)
    }

    fn set(&mut self, name: &'static str) {
        if !self.has(name) {
            self.order.push(name);
        }
    }
}

pub struct CallJournal {
    file: Option<PathBuf>,
    now: Clock,
    /// Oldest first, as the TypeScript `Map` held them.
    records: Vec<CallRecord>,
}

impl CallJournal {
    /// Reads `file` when there is one (a missing or damaged file records nothing); the wall clock.
    pub fn new(file: Option<PathBuf>) -> CallJournal {
        CallJournal::with_clock(file, system_clock())
    }

    pub fn with_clock(file: Option<PathBuf>, now: Clock) -> CallJournal {
        let mut journal = CallJournal {
            file,
            now,
            records: Vec::new(),
        };
        if let Some(file) = journal.file.clone() {
            for item in read_array(&file) {
                if let Some(record) = parse_record(&item) {
                    journal.put(record);
                }
            }
        }
        journal
    }

    /// `Map.set`: a key already held keeps its place.
    fn put(&mut self, record: CallRecord) {
        match self.records.iter_mut().find(|held| held.key == record.key) {
            Some(held) => *held = record,
            None => self.records.push(record),
        }
    }

    /// The record of a call, however old: one the host has not acknowledged is never forgotten.
    pub fn get(&self, key: &str) -> Option<CallRecord> {
        self.records
            .iter()
            .find(|record| record.key == key)
            .cloned()
    }

    /// Record a call before its effect; written before this returns.
    pub fn begin(&mut self, call: CallBegin) -> Result<(), String> {
        self.records.retain(|record| record.key != call.key);
        let mut order = vec!["key", "tool", "callerTabId"];
        if call.intent.is_some() {
            order.push("intent");
        }
        if call.opened.is_some() {
            order.push("opened");
        }
        order.push("at");
        let at = (self.now)();
        self.records.push(CallRecord {
            key: call.key,
            tool: call.tool,
            caller_tab_id: call.caller_tab_id,
            at,
            intent: call.intent,
            opened: call.opened,
            result: None,
            acked: false,
            order,
        });
        self.write()
    }

    /// The call's result: a later call with the same identity gets it.
    pub fn finish(&mut self, key: &str, result: CallResult) -> Result<(), String> {
        let Some(record) = self.records.iter_mut().find(|record| record.key == key) else {
            return Ok(());
        };
        record.result = Some(result);
        record.set("result");
        self.write()
    }

    /// The call opened tab `tab_id`: written at once.
    pub fn note(&mut self, key: &str, tab_id: &str) -> Result<(), String> {
        let Some(record) = self.records.iter_mut().find(|record| record.key == key) else {
            return Ok(());
        };
        record
            .opened
            .get_or_insert_with(Vec::new)
            .push(tab_id.to_owned());
        record.set("opened");
        self.write()
    }

    /// The host took the result of the call whose host call id is `call_id` (the key's last part): the record may now
    /// be forgotten by age or count.
    pub fn acknowledge(&mut self, call_id: &str) -> Result<(), String> {
        let suffix = format!("\n{call_id}");
        let Some(record) = self.records.iter_mut().find(|record| {
            record.key.ends_with(&suffix) && record.result.is_some() && !record.acked
        }) else {
            return Ok(());
        };
        record.acked = true;
        record.set("acked");
        self.write()
    }

    /// Only acknowledged records go, by age and then oldest first past `CALL_JOURNAL_MAX`.
    fn write(&mut self) -> Result<(), String> {
        let cutoff = (self.now)() - CALL_JOURNAL_TTL_MS;
        self.records
            .retain(|record| !(record.acked && record.at < cutoff));
        let mut excess = self.records.len().saturating_sub(CALL_JOURNAL_MAX);
        self.records.retain(|record| {
            if excess == 0 || !record.acked {
                return true;
            }
            excess -= 1;
            false
        });
        match &self.file {
            Some(file) => write_text(
                file,
                &stringify(self.records.iter().map(CallRecord::to_json).collect()),
                None,
            ),
            None => Ok(()),
        }
    }
}
