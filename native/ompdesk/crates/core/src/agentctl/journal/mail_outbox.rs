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
use super::{Persistence, js_number, number, object, persist_text, read_outbox, string, stringify};
use crate::agentctl::inbox::{
    InboxContent, InboxIntent, InboxLogicalSource, InboxPayload, InboxSender, NativeInboxEntry,
    NativeInboxTransferEntry,
};
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
    /// Native-created report identity and attachment-free original content. Legacy records remain ambiguous.
    pub delivery_id: Option<String>,
    pub logical_content: Option<String>,
    pub(crate) native_source: InboxLogicalSource,
    pub delivery: MailDelivery,
    /// What the report carries: its pictures (bytes in the attachment store) and the files landed for its receiver.
    pub attachments: Option<AttachedSet>,
    /// Its record of attachments was damaged: it is never delivered as text alone.
    pub attachments_corrupt: bool,
    pub at: f64,
}

fn same_key(left: &OutboxMail, right: &OutboxMail) -> bool {
    match (&left.delivery_id, &right.delivery_id) {
        (Some(left_id), Some(right_id)) => {
            left_id == right_id
                && left.session_path == right.session_path
                && left.device == right.device
        }
        _ => left.id == right.id,
    }
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
        if let Some(id) = &self.delivery_id {
            map.insert("deliveryId".into(), id.clone().into());
        }
        if let Some(content) = &self.logical_content {
            map.insert("logicalContent".into(), content.clone().into());
        }
        if let Some(source) = self.native_source.json() {
            map.insert("nativeSource".into(), source);
        }
        Value::Object(map)
    }

    pub(crate) fn native_entry(&self) -> Result<Option<NativeInboxTransferEntry>, String> {
        let (Some(id), Some(content)) = (&self.delivery_id, &self.logical_content) else {
            return Ok(None);
        };
        let Some(source) = self.native_source.bound()? else {
            return Ok(None);
        };
        if self.attachments_corrupt {
            return Err(
                "The native report attachment record is damaged; original remains pending".into(),
            );
        }
        let details = self
            .details
            .as_object()
            .ok_or("Native report details are not an object")?;
        Ok(Some(NativeInboxTransferEntry {
            entry: NativeInboxEntry {
                delivery_id: id.clone(),
                sender: InboxSender {
                    session: self.from.as_deref().unwrap_or("ompdesk").to_owned(),
                    device: self.from_device.clone(),
                },
                intent: InboxIntent::Immediate,
                trigger_turn: self.delivery.trigger_turn,
                legacy: false,
                payload: InboxPayload::Report {
                    content: InboxContent::Text(content.clone()),
                    details: details.clone(),
                },
            },
            logical: source.clone(),
            dispatch: None,
            attachments: self.attachments.clone(),
        }))
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
        delivery_id: string(fields, "deliveryId")
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        logical_content: string(fields, "logicalContent").map(str::to_owned),
        native_source: InboxLogicalSource::read(fields.get("nativeSource")),
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
    read_error: Option<String>,
    /// Oldest first.
    entries: Vec<OutboxMail>,
}

impl State {
    fn readable(&self) -> Result<(), String> {
        self.read_error
            .as_ref()
            .map_or(Ok(()), |error| Err(error.clone()))
    }

    fn save(&mut self) -> Result<Persistence, String> {
        self.readable()?;
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
            read_error: None,
            entries: Vec::new(),
        };
        if let Some(file) = state.file.clone() {
            match read_outbox(&file) {
                Err(error) => state.read_error = Some(error),
                Ok(items) => {
                    for item in items {
                        let Some(entry) = parse_entry(&item) else {
                            state.read_error =
                                Some("Unreadable mail outbox row; original retained".into());
                            break;
                        };
                        match state.entries.iter_mut().find(|held| same_key(held, &entry)) {
                            Some(held)
                                if held.delivery_id.is_some() || entry.delivery_id.is_some() =>
                            {
                                let result = held.native_entry().and_then(|previous| {
                                    entry.native_entry().and_then(|incoming| {
                                        crate::agentctl::inbox::same_native_source(
                                            previous, incoming,
                                        )
                                    })
                                });
                                if let Err(error) = result {
                                    state.read_error = Some(error);
                                    break;
                                }
                            }
                            Some(held) => *held = entry,
                            None => state.entries.push(entry),
                        }
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

    /// Native retries retain the first presentation; legacy reports keep their existing replacement behavior.
    pub(crate) fn keep(&self, entry: OutboxMail) -> Result<Persistence, String> {
        let mut state = self.state();
        state.readable()?;
        match state.entries.iter_mut().find(|held| same_key(held, &entry)) {
            Some(held) => {
                if held.delivery_id.is_some() || entry.delivery_id.is_some() {
                    crate::agentctl::inbox::same_native_source(
                        held.native_entry()?,
                        entry.native_entry()?,
                    )?;
                } else {
                    *held = entry;
                }
            }
            None => state.entries.push(entry),
        }
        state.save()
    }

    /// A failed admission cannot be sent by a later sweep before the same state is saved.
    pub(crate) fn retry_failed_save(&self) -> Result<(), String> {
        let mut state = self.state();
        state.readable()?;
        if state.save_failed {
            state.save()?;
        }
        Ok(())
    }

    pub(crate) fn verify_readable(&self) -> Result<(), String> {
        self.state().readable()
    }

    pub(crate) fn persist_pending(&self) -> Result<Persistence, String> {
        self.state().save()
    }

    /// The files of a report landed again (their uploads were deleted): its text and files as they stand now.
    pub fn relanded(&self, id: &str, content: &str, details: &Value, attachments: &AttachedSet) {
        let mut state = self.state();
        let Some(kept) = state
            .entries
            .iter_mut()
            .find(|held| held.delivery_id.is_none() && held.id == id)
        else {
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
        state
            .entries
            .retain(|held| held.delivery_id.is_some() || held.id != id);
        if state.entries.len() != before {
            let _ = state.save();
        }
    }

    /// Called only after matching receiver-native disk responsibility, not a stock transcript marker.
    pub(crate) fn settle_native(&self, entry: &OutboxMail) {
        let mut state = self.state();
        let before = state.entries.len();
        state.entries.retain(|held| !same_key(held, entry));
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
    for mail in outbox
        .pending()
        .into_iter()
        .filter(|entry| entry.delivery_id.is_none())
    {
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
