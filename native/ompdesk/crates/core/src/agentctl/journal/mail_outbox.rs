//! A report reaches a busy receiver as a stock `aside`; stock journals it at the receiver's next step boundary, so an
//! omp killed first loses it (`mail-outbox.ts`). Main keeps each accepted report, per receiver session file (and paired
//! device), until the receiver's journal holds its id. Every pass asks the receiver's current omp again with the same
//! id: its bridge answers `{duplicate, journaled}` for an id it holds or queued and delivers one it has never seen.
//!
//! Kept in `<userData>/mail-outbox.json` (mode 0o600), written when a report is accepted, never in a quit hook.
//! Unconsumed reports do not expire. A failed keep retains memory and the disk writer's retry, but is not an ACK.
//!
//! Seams: `RedeliverDeps` (the tab pool's `tabOf` and the receiver's bridge answer). The outbox is
//! internally locked (`&self`), so a pass may await the bridge while the host keeps reports. `RedeliverDeps::send`
//! answers `None` where the TypeScript promise rejected or answered nothing: either keeps the report for the next pass.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

use super::attachments::{Attached, AttachedSet, read_attached};
use super::{Persistence, js_number, number, object, persist_text, read_array, string, stringify};
use crate::agentctl::rules::mail::MailDelivery;

#[derive(Debug, Clone, PartialEq)]
pub struct OutboxMail {
    /// The report's id (`details.id`): the key, and what the receiver's journal is asked for.
    pub id: String,
    /// The receiver's session file (a paired device's own path when `device` is set).
    pub session_path: String,
    pub device: Option<String>,
    /// The reporting session (its file, its tab id when it has none) and its computer: told when a delivery fails.
    pub from: Option<String>,
    pub from_device: Option<String>,
    pub content: String,
    /// What the transcript draws (any JSON value the file held; a report's own is an object).
    pub details: Value,
    pub delivery: MailDelivery,
    /// What the report carries: its pictures (bytes in the attachment store) and the files landed for its receiver.
    pub attachments: Option<AttachedSet>,
    /// Its record of attachments was damaged: it is never delivered as text alone.
    pub attachments_corrupt: bool,
    pub at: f64,
}

impl OutboxMail {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), self.id.clone().into());
        map.insert("sessionPath".into(), self.session_path.clone().into());
        if let Some(device) = self.device.as_ref().filter(|device| !device.is_empty()) {
            map.insert("device".into(), device.clone().into());
        }
        if let Some(from) = self.from.as_ref().filter(|from| !from.is_empty()) {
            map.insert("from".into(), from.clone().into());
        }
        if let Some(from_device) = self.from_device.as_ref().filter(|d| !d.is_empty()) {
            map.insert("fromDevice".into(), from_device.clone().into());
        }
        map.insert("content".into(), self.content.clone().into());
        map.insert("details".into(), self.details.clone());
        map.insert("delivery".into(), self.delivery.to_json());
        if let Some(attachments) = &self.attachments {
            map.insert("attachments".into(), attachments.to_json());
        }
        if self.attachments_corrupt {
            map.insert("attachmentsCorrupt".into(), true.into());
        }
        map.insert("at".into(), js_number(self.at));
        Value::Object(map)
    }
}

pub(crate) fn parse_entry(value: &Value) -> Option<OutboxMail> {
    let fields = object(value)?;
    let id = string(fields, "id").filter(|id| !id.is_empty())?;
    let session_path = string(fields, "sessionPath").filter(|path| !path.is_empty())?;
    let content = string(fields, "content")?;
    let details = fields
        .get("details")
        .filter(|details| object(details).is_some())?;
    let delivery = object(fields.get("delivery")?)?;
    let at = number(fields, "at")?;
    let (attachments, corrupt) = match read_attached(fields.get("attachments")) {
        Attached::None => (None, false),
        Attached::Set(set) => (Some(set), false),
        Attached::Corrupt => (None, true),
    };
    let trigger_turn = delivery.get("triggerTurn")?.as_bool()?;
    // `followUp`: what an earlier build kept; reports are asides now.
    let aside = match delivery.get("deliverAs") {
        None => false,
        Some(Value::String(kind)) if kind == "aside" || kind == "followUp" => true,
        Some(_) => return None,
    };
    Some(OutboxMail {
        id: id.to_owned(),
        session_path: session_path.to_owned(),
        device: string(fields, "device")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        from: string(fields, "from")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        from_device: string(fields, "fromDevice")
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        content: content.to_owned(),
        details: details.clone(),
        delivery: MailDelivery {
            trigger_turn,
            aside,
        },
        attachments,
        attachments_corrupt: corrupt
            || fields.get("attachmentsCorrupt") == Some(&Value::Bool(true)),
        at,
    })
}

struct State {
    file: Option<PathBuf>,
    save_failed: bool,
    /// Oldest first.
    entries: Vec<OutboxMail>,
}

impl State {
    fn save(&mut self) -> Result<Persistence, String> {
        let Some(file) = self.file.as_deref() else {
            self.save_failed = false;
            return persist_text(None, "", Some(0o600));
        };
        let text = stringify(self.entries.iter().map(OutboxMail::to_json).collect());
        let result = persist_text(Some(file), &text, Some(0o600));
        self.save_failed = result.is_err();
        if let Err(error) = &result {
            eprintln!("[mail-outbox] not saved: {error}");
        }
        result
    }
}

pub struct MailOutbox {
    state: Mutex<State>,
}

impl MailOutbox {
    pub fn new(file: Option<PathBuf>) -> MailOutbox {
        let mut state = State {
            file,
            save_failed: false,
            entries: Vec::new(),
        };
        if let Some(file) = state.file.clone() {
            for item in read_array(&file) {
                if let Some(entry) = parse_entry(&item) {
                    match state.entries.iter_mut().find(|held| held.id == entry.id) {
                        Some(held) => *held = entry,
                        None => state.entries.push(entry),
                    }
                }
            }
        }
        MailOutbox {
            state: Mutex::new(state),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keep an accepted report (the same id replaces its entry).
    pub(crate) fn keep(&self, entry: OutboxMail) -> Result<Persistence, String> {
        let mut state = self.state();
        match state.entries.iter_mut().find(|held| held.id == entry.id) {
            Some(held) => *held = entry,
            None => state.entries.push(entry),
        }
        state.save()
    }

    /// A failed admission cannot be sent by a later sweep before the same state is saved.
    pub(crate) fn retry_failed_save(&self) -> Result<(), String> {
        let mut state = self.state();
        if state.save_failed {
            state.save()?;
        }
        Ok(())
    }

    /// The files of a report landed again (their uploads were deleted): its text and files as they stand now.
    pub fn relanded(&self, id: &str, content: &str, details: &Value, attachments: &AttachedSet) {
        let mut state = self.state();
        let Some(kept) = state.entries.iter_mut().find(|held| held.id == id) else {
            return;
        };
        kept.content = content.to_owned();
        kept.details = details.clone();
        kept.attachments = Some(attachments.clone());
        let _ = state.save();
    }

    /// The SHA-256 of every attachment a report still waiting names: what the attachment store must keep.
    pub fn attachment_shas(&self) -> std::collections::HashSet<String> {
        self.pending()
            .iter()
            .flat_map(|entry| entry.attachments.iter())
            .flat_map(|set| set.shas().map(str::to_owned))
            .collect()
    }

    /// The receiver's journal holds `id`: nothing more to do for it.
    pub fn settle(&self, id: &str) {
        let mut state = self.state();
        let before = state.entries.len();
        state.entries.retain(|held| held.id != id);
        if state.entries.len() != before {
            let _ = state.save();
        }
    }

    /// The reports still waiting for their receiver's journal, oldest first.
    pub fn pending(&self) -> Vec<OutboxMail> {
        self.state().entries.clone()
    }
}

/// The receiver's bridge answer to a report (`agent_control_mail`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MailAnswer {
    pub duplicate: bool,
    pub journaled: bool,
}

pub trait RedeliverDeps: Sync {
    /// The live tab holding the receiver's session file now (it has a new id after a relaunch), if any.
    fn tab_of(&self, session_path: &str, device: Option<&str>) -> Option<String>;
    /// The receiver's bridge answer to the report; `None` when it could not be asked or said nothing.
    fn send(
        &self,
        tab_id: &str,
        mail: &OutboxMail,
    ) -> impl Future<Output = Option<MailAnswer>> + Send;
}

/// One pass over the outbox: each report whose receiver has a live tab is sent again with its id. An answer that says
/// the journal holds it settles it; any other answer keeps it for the next pass.
pub async fn redeliver_mail<D: RedeliverDeps>(outbox: &MailOutbox, deps: &D) {
    if outbox.retry_failed_save().is_err() {
        return;
    }
    for mail in outbox.pending() {
        let Some(tab_id) = deps.tab_of(&mail.session_path, mail.device.as_deref()) else {
            continue;
        };
        if let Some(answer) = deps.send(&tab_id, &mail).await
            && answer.duplicate
            && answer.journaled
        {
            outbox.settle(&mail.id);
        }
    }
}
