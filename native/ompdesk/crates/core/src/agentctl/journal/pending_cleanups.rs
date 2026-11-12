//! Cleanups a control tool refused: a stop, close or delete of a session the person typed into, or of one the caller
//! did not open that the person looks at, asked in a turn their own message did not start (`pending-cleanups.ts`). The
//! refusal is kept per caller, and the caller is told its list once, at the start of its next turn the person's own
//! message starts.
//!
//! Kept in `<userData>/agent-pending-cleanups.json` (mode 0o600), newest `PENDING_CLEANUPS_MAX`. No seams. See
//! `journal/mod.rs` for the deferred write that is a plain write here.

use std::path::PathBuf;

use serde_json::{Map, Value};

use super::{js_number, number, object, read_array, string, stringify, write_text};

pub const PENDING_CLEANUPS_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupAction {
    Stop,
    Close,
    Delete,
}

impl CleanupAction {
    pub fn as_str(self) -> &'static str {
        match self {
            CleanupAction::Stop => "stop",
            CleanupAction::Close => "close",
            CleanupAction::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingCleanup {
    /// Who asked: the caller's session file (with its computer), else its tab id.
    pub caller: String,
    /// The session it asked for: its file on the computer it runs on when it has one.
    pub path: Option<String>,
    pub device: Option<String>,
    /// The tab id it was named by.
    pub tab_id: String,
    /// "" for a session hidden from agents.
    pub title: String,
    pub action: CleanupAction,
    pub at: f64,
}

impl PendingCleanup {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("caller".into(), self.caller.clone().into());
        if let Some(path) = &self.path {
            map.insert("path".into(), path.clone().into());
        }
        if let Some(device) = &self.device {
            map.insert("device".into(), device.clone().into());
        }
        map.insert("tabId".into(), self.tab_id.clone().into());
        map.insert("title".into(), self.title.clone().into());
        map.insert("action".into(), self.action.as_str().into());
        map.insert("at".into(), js_number(self.at));
        Value::Object(map)
    }
}

pub(crate) fn parse_cleanup(value: &Value) -> Option<PendingCleanup> {
    let fields = object(value)?;
    let caller = string(fields, "caller").filter(|caller| !caller.is_empty())?;
    let tab_id = string(fields, "tabId").filter(|tab| !tab.is_empty())?;
    let action = match string(fields, "action")? {
        "stop" => CleanupAction::Stop,
        "close" => CleanupAction::Close,
        "delete" => CleanupAction::Delete,
        _ => return None,
    };
    let non_empty = |key: &str| {
        string(fields, key)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Some(PendingCleanup {
        caller: caller.to_owned(),
        path: non_empty("path"),
        device: non_empty("device"),
        tab_id: tab_id.to_owned(),
        title: string(fields, "title").unwrap_or("").to_owned(),
        action,
        at: number(fields, "at").unwrap_or(0.0),
    })
}

fn same_session(a: &PendingCleanup, b: &PendingCleanup) -> bool {
    if a.path.is_some() || b.path.is_some() {
        a.path == b.path && a.device == b.device
    } else {
        a.tab_id == b.tab_id
    }
}

pub struct PendingCleanups {
    file: Option<PathBuf>,
    /// Oldest first.
    entries: Vec<PendingCleanup>,
}

impl PendingCleanups {
    pub fn new(file: Option<PathBuf>) -> PendingCleanups {
        let entries = file
            .as_deref()
            .map(|file| read_array(file).iter().filter_map(parse_cleanup).collect())
            .unwrap_or_default();
        PendingCleanups { file, entries }
    }

    /// Keep a refused cleanup; the same caller asking for the same session again replaces its entry.
    pub fn add(&mut self, cleanup: PendingCleanup) {
        self.entries
            .retain(|entry| entry.caller != cleanup.caller || !same_session(entry, &cleanup));
        self.entries.push(cleanup);
        if self.entries.len() > PENDING_CLEANUPS_MAX {
            let extra = self.entries.len() - PENDING_CLEANUPS_MAX;
            self.entries.drain(..extra);
        }
        self.save();
    }

    /// `cleanup` was carried out: its caller's entry for that session goes.
    pub fn drop_cleanup(&mut self, cleanup: &PendingCleanup) {
        let before = self.entries.len();
        self.entries
            .retain(|entry| entry.caller != cleanup.caller || !same_session(entry, cleanup));
        if self.entries.len() != before {
            self.save();
        }
    }

    /// What waits for `caller`, removed: it is told once.
    pub fn take(&mut self, caller: &str) -> Vec<PendingCleanup> {
        let (taken, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.entries)
            .into_iter()
            .partition(|entry| entry.caller == caller);
        self.entries = kept;
        if !taken.is_empty() {
            self.save();
        }
        taken
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let text = stringify(self.entries.iter().map(PendingCleanup::to_json).collect());
        if let Err(error) = write_text(file, &text, Some(0o600)) {
            eprintln!("[pending-cleanups] not saved: {error}");
        }
    }
}
