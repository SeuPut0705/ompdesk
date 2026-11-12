//! What became of the sessions an id was handed out for: its tab closed (by whom, when), or it was deleted (by whom,
//! when) (`session-fates.ts`). The one record every control tool resolves a gone tab's id from, across relaunches.
//!
//! A session has one entry, by the computer it is saved on and its file (an entry with no file is kept by its ids
//! alone). Closing it again, or deleting it, replaces the entry and keeps every id it ever had. Kept in
//! `<userData>/agent-session-fates.json` (mode 0o600), newest `SESSION_FATES_MAX`.
//!
//! Seams: the clock. See `journal/mod.rs` for the deferred write that is a plain write here.

use std::path::PathBuf;

use serde_json::{Map, Value};

use super::{
    Clock, js_number, number, object, read_array, string, stringify, system_clock, write_text,
};

pub const SESSION_FATES_MAX: usize = 1000;
/// Ids one session keeps: its saved id, and a tab id per reopen or relaunch.
const FATE_IDS_MAX: usize = 24;

/// A session an id named, as it was when it went.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FatedSession {
    /// Every id that named it.
    pub ids: Vec<String>,
    /// Its session file on the computer it is saved on; absent when stock had written none.
    pub path: Option<String>,
    /// The paired host it is saved on; absent = this computer.
    pub device: Option<String>,
    /// "" for a session hidden from agents.
    pub title: String,
    pub hidden: bool,
    pub cwd: String,
    /// The session file of the session that opened it, when known.
    pub opened_by_session: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FateState {
    Closed,
    Deleted,
}

impl FateState {
    pub fn as_str(self) -> &'static str {
        match self {
            FateState::Closed => "closed",
            FateState::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionFate {
    pub session: FatedSession,
    pub state: FateState,
    /// Epoch ms; 0 when the record predates this file.
    pub at: f64,
    /// Who closed or deleted it, in words an agent reads; "" when unknown.
    pub by: String,
}

impl SessionFate {
    pub fn to_json(&self) -> Value {
        let session = &self.session;
        let mut map = Map::new();
        map.insert(
            "ids".into(),
            Value::Array(session.ids.iter().cloned().map(Value::String).collect()),
        );
        if let Some(path) = &session.path {
            map.insert("path".into(), path.clone().into());
        }
        if let Some(device) = &session.device {
            map.insert("device".into(), device.clone().into());
        }
        map.insert("title".into(), session.title.clone().into());
        if session.hidden {
            map.insert("hidden".into(), true.into());
        }
        map.insert("cwd".into(), session.cwd.clone().into());
        if let Some(opened) = &session.opened_by_session {
            map.insert("openedBySession".into(), opened.clone().into());
        }
        map.insert("state".into(), self.state.as_str().into());
        map.insert("at".into(), js_number(self.at));
        map.insert("by".into(), self.by.clone().into());
        Value::Object(map)
    }
}

pub(crate) fn parse_fate(value: &Value) -> Option<SessionFate> {
    let fields = object(value)?;
    let ids: Vec<String> = match fields.get("ids") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|id| id.as_str().filter(|id| !id.is_empty()).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    let state = match string(fields, "state") {
        Some("closed") => FateState::Closed,
        Some("deleted") => FateState::Deleted,
        _ => return None,
    };
    if ids.is_empty() {
        return None;
    }
    let non_empty = |key: &str| {
        string(fields, key)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Some(SessionFate {
        session: FatedSession {
            ids: ids.into_iter().take(FATE_IDS_MAX).collect(),
            path: non_empty("path"),
            device: non_empty("device"),
            title: string(fields, "title").unwrap_or("").to_owned(),
            hidden: fields.get("hidden") == Some(&Value::Bool(true)),
            cwd: string(fields, "cwd").unwrap_or("").to_owned(),
            opened_by_session: non_empty("openedBySession"),
        },
        state,
        at: number(fields, "at").unwrap_or(0.0),
        by: string(fields, "by").unwrap_or("").to_owned(),
    })
}

pub struct SessionFates {
    file: Option<PathBuf>,
    now: Clock,
    /// Oldest first.
    fates: Vec<SessionFate>,
}

impl SessionFates {
    pub fn new(file: Option<PathBuf>) -> SessionFates {
        SessionFates::with_clock(file, system_clock())
    }

    pub fn with_clock(file: Option<PathBuf>, now: Clock) -> SessionFates {
        let fates = file
            .as_deref()
            .map(|file| read_array(file).iter().filter_map(parse_fate).collect())
            .unwrap_or_default();
        SessionFates { file, now, fates }
    }

    /// The newest entry `id` names.
    pub fn find(&self, id: &str) -> Option<SessionFate> {
        self.fates
            .iter()
            .rev()
            .find(|fate| fate.session.ids.iter().any(|named| named == id))
            .cloned()
    }

    /// The entry of the session saved at `path` on `device`.
    pub fn of(&self, path: &str, device: Option<&str>) -> Option<SessionFate> {
        self.fates
            .iter()
            .rev()
            .find(|fate| {
                fate.session.path.as_deref() == Some(path)
                    && fate.session.device.as_deref() == device
            })
            .cloned()
    }

    /// Its tab closed and the session stays saved. A deleted session stays deleted: a late close never revives it.
    pub fn closed(&mut self, session: FatedSession, by: &str) {
        let at = (self.now)();
        self.put(session, FateState::Closed, by, at);
    }

    /// It was deleted; `at` when the delete is older than this call (a tombstone's time).
    pub fn deleted(&mut self, session: FatedSession, by: &str, at: Option<f64>) {
        let at = at.unwrap_or_else(|| (self.now)());
        self.put(session, FateState::Deleted, by, at);
    }

    fn put(&mut self, session: FatedSession, state: FateState, by: &str, at: f64) {
        let (named_path, named_device, named_ids) = (
            session.path.clone(),
            session.device.clone(),
            session.ids.clone(),
        );
        let same = |fate: &SessionFate| match &named_path {
            Some(path) => {
                fate.session.path.as_ref() == Some(path) && fate.session.device == named_device
            }
            None => {
                fate.session.path.is_none()
                    && fate.session.ids.iter().any(|id| named_ids.contains(id))
            }
        };
        let before: Vec<&SessionFate> = self.fates.iter().filter(|fate| same(fate)).collect();
        if state == FateState::Closed && before.iter().any(|fate| fate.state == FateState::Deleted)
        {
            return;
        }
        let earlier = before.last().map(|fate| fate.session.clone());
        let mut ids: Vec<String> = Vec::new();
        for id in session
            .ids
            .iter()
            .chain(before.iter().flat_map(|fate| fate.session.ids.iter()))
        {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        ids.truncate(FATE_IDS_MAX);
        let opened_by_session = session
            .opened_by_session
            .clone()
            .or_else(|| {
                earlier
                    .as_ref()
                    .and_then(|earlier| earlier.opened_by_session.clone())
            })
            .filter(|opened| !opened.is_empty());
        // A delete that knows less than the close before it (a saved id alone) keeps what the close recorded.
        let title = if session.title.is_empty() {
            earlier
                .as_ref()
                .map(|earlier| earlier.title.clone())
                .unwrap_or_default()
        } else {
            session.title.clone()
        };
        let cwd = if session.cwd.is_empty() {
            earlier
                .as_ref()
                .map(|earlier| earlier.cwd.clone())
                .unwrap_or_default()
        } else {
            session.cwd.clone()
        };
        let fate = SessionFate {
            session: FatedSession {
                ids,
                title,
                cwd,
                opened_by_session,
                ..session
            },
            state,
            at,
            by: by.to_owned(),
        };
        self.fates.retain(|held| !same(held));
        self.fates.push(fate);
        if self.fates.len() > SESSION_FATES_MAX {
            let extra = self.fates.len() - SESSION_FATES_MAX;
            self.fates.drain(..extra);
        }
        let Some(file) = &self.file else { return };
        let text = stringify(self.fates.iter().map(SessionFate::to_json).collect());
        if let Err(error) = write_text(file, &text, Some(0o600)) {
            eprintln!("[session-fates] not saved: {error}");
        }
    }
}

/// "on 2026-11-10 04:12 UTC by <who>", each part only when known.
pub fn fate_when(at: f64, by: &str) -> String {
    let when = if at > 0.0 {
        format!(" on {} UTC", utc_minutes(at))
    } else {
        String::new()
    };
    let who = if by.is_empty() {
        String::new()
    } else {
        format!(" by {by}")
    };
    format!("{when}{who}")
}

/// `new Date(at).toISOString().slice(0, 16).replace("T", " ")`.
fn utc_minutes(at: f64) -> String {
    let minutes = (at / 60_000.0).floor() as i64;
    let days = minutes.div_euclid(1440);
    let of_day = minutes.rem_euclid(1440);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    // `toISOString` writes a year past 9999 or before 0 with a sign and six digits.
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    let stamp = format!(
        "{year}-{month:02}-{day:02} {:02}:{:02}",
        of_day / 60,
        of_day % 60
    );
    stamp.chars().take(16).collect()
}

/// Who a fate names when no session's own call closed or deleted it.
pub mod fate_by {
    /// A tab nobody closed through the control tools.
    pub const PERSON: &str = "the user or its window (its tab was closed in OMPdesk)";
    /// The control tools' own close of a finished child.
    pub const AUTO_CLOSE: &str = "OMPdesk (its result had reached the session that opened it)";
    /// The control tools' own delete of a throwaway session.
    pub const THROWAWAY: &str = "OMPdesk (it was opened as throwaway, and its Result: ok answer had reached the session that opened it)";
    /// A delete the control tools did not make: only its tombstone tells of it.
    pub const APP: &str = "someone in OMPdesk (the sidebar's Delete, /delete or a paired device)";
}
