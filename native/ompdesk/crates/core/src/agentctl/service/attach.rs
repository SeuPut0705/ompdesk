//! What a message, a report or an answer carries besides text (`journal/attachments.rs` owns the records and the store).
//!
//! The caller's own omp reads each attachment (`agent_control_attachment`), so a caller on a paired host hands over its
//! own computer's bytes. Pictures go inline; any other file lands on the RECEIVER's computer through main's upload
//! store (`land`, a host ask, this computer's or a paired host's) and the text names its path there. Everything is read
//! and landed before anything is numbered, kept or sent: a failure leaves nothing behind.
//!
//! Replay fails closed: a stored message or report that names an attachment is delivered with it or not at all. A
//! damaged record, bytes the store no longer holds and an expired upload that cannot land again are a `Problem`: the
//! entry stays queued and retried, and the sender is told once per cause.

use std::sync::Arc;

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use super::AgentControl;
use super::fail::{Fail, R, fail, unanswered_text};
use super::host::{Deadline, Host};
use super::js::one_line;
use super::text::saved_id_of_path;
use super::types::{Attachment, ControlTab, RpcResponse};
use crate::agentctl::journal::attachments::{
    ATTACHMENT_MAX_BYTES, AttachedSet, AttachmentRef, LandedCache, LandedFile, Problem, Resolved,
    dedupe_by_sha, image_block, move_paths, move_paths_deep, plan, sha256_hex, shas_sig,
};
use crate::agentctl::journal::mail_outbox::{MailAnswer, OutboxMail};
use crate::agentctl::journal::send_outbox::OutboxSend;
use crate::agentctl::rules::mail::{
    Mail, MailDelivery, MailKind, delivery_for, mail_details, mail_text,
};

/// A caller's omp reads one attachment (a file of up to 10 MiB, base64) within this.
const ATTACHMENT_READ_MS: u64 = 60_000;

/// A file put on the receiver's computer: its path there, or why not.
#[derive(Debug, Clone, PartialEq)]
pub enum Landing {
    Landed(String),
    Failed { error: String, code: Option<String> },
}

/// What goes to one session: the pictures that go inline, and what was landed.
pub(super) struct Carried {
    pub inline: Vec<Resolved>,
    pub set: AttachedSet,
    pub count: usize,
}

/// A note that carries an answer's attachments ahead of the answer.
pub(super) struct Companion {
    pub content: Value,
    pub details: Value,
    pub delivery: MailDelivery,
    /// Names this answer's step on the target's computer: a resend of it appends nothing twice.
    pub request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    name: String,
    mime_type: String,
    data_base64: String,
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn failure_text(error: Option<&str>) -> String {
    error.unwrap_or("no reason given").to_owned()
}

impl Host {
    /// The pictures a stored message carries, as stock `images`; one whose bytes are gone is a `Problem`.
    pub(super) async fn stored_images_p(
        &self,
        set: Option<&AttachedSet>,
    ) -> Result<Vec<Value>, Problem> {
        let mut blocks = Vec::new();
        for image in set.iter().flat_map(|set| set.images.iter()) {
            let Some(bytes) = self.attachments.get(&image.sha256).await else {
                return Err(Problem(format!(
                    "the picture {} is no longer held by OMPdesk",
                    image.name
                )));
            };
            blocks.push(image_block(image, &bytes));
        }
        Ok(blocks)
    }

    pub(super) async fn stored_images(&self, set: Option<&AttachedSet>) -> R<Vec<Value>> {
        self.stored_images_p(set)
            .await
            .map_err(|problem| Fail::other(problem.0))
    }

    /// `land(tabId, name, bytes)`: put a file on the computer `tab_id`'s session runs on, where its omp reads it by path.
    pub async fn land(&self, tab_id: &str, name: &str, bytes: &[u8]) -> Landing {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let answer: R<Value> = self
            .ask(
                "land",
                json!({ "tabId": tab_id, "name": name, "dataBase64": data }),
            )
            .await;
        match answer {
            Ok(answer) => match answer.get("path").and_then(Value::as_str) {
                Some(path) if answer.get("ok").and_then(Value::as_bool) == Some(true) => {
                    Landing::Landed(path.to_owned())
                }
                _ => Landing::Failed {
                    error: answer
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("The upload failed")
                        .to_owned(),
                    code: answer
                        .get("code")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
            },
            Err(error) => Landing::Failed {
                error: error.message(),
                code: None,
            },
        }
    }

    /// A stored message delivered again after its files' upload lifetime: each file whose path may be gone is landed
    /// again from the store. Returns the files as they stand, the path changes, and whether any file moved.
    pub(super) async fn rehome(
        &self,
        tab_id: &str,
        files: &[LandedFile],
    ) -> Result<(Vec<LandedFile>, Vec<(String, String)>, bool), Problem> {
        let now = (self.clock)();
        let mut moved = Vec::new();
        let mut out = Vec::new();
        let mut changed = false;
        for file in files {
            if LandedCache::fresh(file.landed_at, now) {
                out.push(file.clone());
                continue;
            }
            let name = &file.file.name;
            let Some(bytes) = self.attachments.get(&file.file.sha256).await else {
                return Err(Problem(format!(
                    "{name} was put on that computer long ago and its upload is gone, and OMPdesk no longer holds its bytes to put it there again"
                )));
            };
            let path = match self.land(tab_id, name, &bytes).await {
                Landing::Landed(path) => path,
                Landing::Failed { error, .. } => {
                    return Err(Problem(format!(
                        "{name} was put on that computer long ago and its upload is gone, and putting it there again failed ({})",
                        if error.is_empty() {
                            "no reason given"
                        } else {
                            &error
                        }
                    )));
                }
            };
            if path != file.path {
                moved.push((file.path.clone(), path.clone()));
            }
            changed = true;
            out.push(LandedFile {
                file: file.file.clone(),
                path,
                landed_at: now,
            });
        }
        Ok((out, moved, changed))
    }

    /// A note into the session `key` names (its file, or its tab id when it has none, on `device`) that something it
    /// sent did not arrive; it wakes that session. False when no open session holds it or its omp took no note.
    pub(super) async fn tell_sender(
        &self,
        key: &str,
        device: Option<&str>,
        text: &str,
        id: &str,
    ) -> bool {
        let tab = {
            let state = self.state();
            let device = device.filter(|device| !device.is_empty());
            state
                .tabs
                .iter()
                .find(|tab| {
                    tab.session_path.as_deref() == Some(key)
                        && tab.device.as_deref().filter(|d| !d.is_empty()) == device
                })
                .or_else(|| state.tabs.iter().find(|tab| tab.tab_id == key))
                .map(|tab| tab.tab_id.clone())
        };
        let Some(tab) = tab else { return false };
        let mail = Mail::new(
            id,
            "ompdesk",
            "OMPdesk",
            &tab,
            MailKind::Note,
            text,
            (self.clock)(),
        );
        let delivery = MailDelivery {
            trigger_turn: true,
            aside: true,
        };
        self.send_mail(&tab, &mail_text(&mail), &mail_details(&mail), delivery)
            .await
            .is_ok()
    }

    /// Tell a sender what did not arrive, once per `told_key`; not remembered while the note itself could not be
    /// delivered, so the next pass tries again.
    pub(super) async fn trouble(
        &self,
        key: &str,
        device: Option<&str>,
        told_key: &str,
        text: &str,
    ) {
        let known = self
            .troubled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(told_key);
        if known {
            return;
        }
        if self.tell_sender(key, device, text, told_key).await {
            self.troubled
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(told_key.to_owned());
        }
    }

    /// A report an omp lost, delivered again to the omp that holds the session now: its files land again once their
    /// uploads may be gone. Never delivered without what it promised: a `Problem` keeps it queued and tells the sender.
    pub async fn redeliver_mail(&self, tab_id: &str, mail: &OutboxMail) -> Option<MailAnswer> {
        match self.redeliver_mail_inner(tab_id, mail).await {
            Ok(answer) => answer,
            Err(problem) => {
                if let Some(from) = &mail.from {
                    let kind = mail
                        .details
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("report");
                    self.trouble(
                        from,
                        mail.from_device.as_deref(),
                        &format!("attach-{}-{}", mail.id, problem.0),
                        &format!(
                            "A report you sent ({kind}) was NOT delivered: {}. It stays queued and OMPdesk tries again; if the attachment cannot come back, report again with the attachment.",
                            problem.0
                        ),
                    )
                    .await;
                }
                None
            }
        }
    }

    async fn redeliver_mail_inner(
        &self,
        tab_id: &str,
        mail: &OutboxMail,
    ) -> Result<Option<MailAnswer>, Problem> {
        if mail.attachments_corrupt {
            return Err(Problem(
                "the record of what it carried is damaged, so which attachments it had is lost"
                    .into(),
            ));
        }
        let (mut content, mut details, mut attached) = (
            mail.content.clone(),
            mail.details.clone(),
            mail.attachments.clone(),
        );
        if let Some(set) = mail
            .attachments
            .as_ref()
            .filter(|set| !set.files.is_empty())
        {
            let (files, moved, changed) = self.rehome(tab_id, &set.files).await?;
            if changed {
                let now = (self.clock)();
                for file in &files {
                    self.landed
                        .set(mail.device.as_deref(), &file.file.sha256, &file.path, now);
                }
                let renewed = AttachedSet {
                    images: set.images.clone(),
                    files,
                };
                content = move_paths(&content, &moved);
                details = move_paths_deep(&details, &moved);
                if let Some(outbox) = self.outbox() {
                    outbox.relanded(&mail.id, &content, &details, &renewed);
                }
                attached = Some(renewed);
            }
        }
        let images = self.stored_images_p(attached.as_ref()).await?;
        Ok(self
            .send_mail_with(tab_id, &content, &details, mail.delivery, &images)
            .await
            .ok()
            .flatten())
    }

    /// The answer's one step on the target's computer (`agent_control_answer`): its attachments' note, then the answer.
    pub(super) async fn answer_with_companion(
        &self,
        tab_id: &str,
        what: Value,
        companion: &Companion,
    ) -> R<()> {
        let mut command = json!({
            "type": "agent_control_answer",
            "companion": {
                "content": companion.content,
                "details": companion.details,
                "delivery": companion.delivery.to_json(),
            },
            "requestId": companion.request_id,
        });
        if let (Value::Object(into), Value::Object(from)) = (&mut command, what) {
            into.extend(from);
        }
        let lost = || {
            Fail::Tool(
                "The answer may or may not have arrived: its session did not say. Check it with ompdesk_session_result; sending the same answer again is safe (its attachments are never added twice, and an answer to a question no longer open is refused).".into(),
            )
        };
        match self.command(tab_id, &command, Deadline::Ms(60_000)).await {
            Ok(response) if response.success => Ok(()),
            Ok(response) if unanswered_text(response.error.as_deref()) => Err(lost()),
            Ok(response) => Err(Fail::Tool(format!(
                "Not answered: {}",
                failure_text(response.error.as_deref())
            ))),
            Err(error) if error.unanswered() => Err(lost()),
            Err(error) => Err(error),
        }
    }
}

impl AgentControl {
    /// Every attachment of a call, read where the caller's omp runs, the same bytes once. One that cannot be read
    /// (missing, a folder, over `ATTACHMENT_MAX_BYTES`, no such picture) refuses the whole call: nothing is delivered
    /// partially.
    pub(super) async fn resolve_attachments(
        &self,
        caller: &ControlTab,
        list: Option<&[Attachment]>,
    ) -> R<Vec<Resolved>> {
        let Some(list) = list.filter(|list| !list.is_empty()) else {
            return Ok(Vec::new());
        };
        if self
            .host
            .state()
            .outside_callers
            .contains_key(&caller.tab_id)
        {
            return fail(
                "A caller outside OMPdesk (the control socket, the ompdesk CLI) carries no attachments: it has no session whose omp could read them. Put the file on the receiving computer yourself and name its path in the message.",
            );
        }
        let mut read = Vec::new();
        for (index, item) in list.iter().enumerate() {
            let what = format!(
                "attachment {} ({})",
                index + 1,
                match (&item.path, item.image) {
                    (Some(path), _) => path.clone(),
                    (None, Some(image)) => format!("image {image}"),
                    (None, None) => "image undefined".to_owned(),
                }
            );
            let command = match (&item.path, item.image) {
                (Some(path), _) => json!({ "type": "agent_control_attachment", "path": path }),
                (None, image) => json!({ "type": "agent_control_attachment", "image": image }),
            };
            let response = self
                .host
                .command(&caller.tab_id, &command, Deadline::Ms(ATTACHMENT_READ_MS))
                .await
                .unwrap_or_else(|error| RpcResponse::refused(error.message()));
            let wire = response
                .success
                .then(|| response.data.clone())
                .flatten()
                .and_then(|data| serde_json::from_value::<Wire>(data).ok())
                .filter(|wire| {
                    (1..=1000).contains(&units(&wire.name))
                        && (1..=200).contains(&units(&wire.mime_type))
                });
            let Some(wire) = wire else {
                let why = if response.success {
                    "its omp answered no file".to_owned()
                } else {
                    failure_text(response.error.as_deref())
                };
                return fail(format!(
                    "Not sent: {what} could not be read: {}. Nothing was delivered.",
                    one_line(&why, 300)
                ));
            };
            let over = format!(
                "Not sent: {what} is over {} MiB, the most one attachment may be. Nothing was delivered.",
                ATTACHMENT_MAX_BYTES / (1024 * 1024)
            );
            if wire.data_base64.len() > ATTACHMENT_MAX_BYTES.div_ceil(3) * 4 + 4 {
                return fail(over);
            }
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&wire.data_base64)
            else {
                return fail(format!(
                    "Not sent: {what} could not be read: its omp answered no file. Nothing was delivered."
                ));
            };
            if bytes.len() > ATTACHMENT_MAX_BYTES {
                return fail(over);
            }
            let name: String = wire
                .name
                .chars()
                .map(|c| {
                    if matches!(c, '\\' | '/' | '\0') {
                        '_'
                    } else {
                        c
                    }
                })
                .take(200)
                .collect();
            read.push(Resolved {
                file: AttachmentRef {
                    sha256: sha256_hex(&bytes),
                    name: if name.is_empty() {
                        "attachment".to_owned()
                    } else {
                        name
                    },
                    mime_type: wire.mime_type,
                    size: bytes.len() as u64,
                },
                bytes: Arc::new(bytes),
            });
        }
        Ok(dedupe_by_sha(read))
    }

    /// What goes to `tab_id`'s session: the pictures that go inline, and the other files landed on its computer (a path
    /// landed there today for the same bytes is reused). `remember` keeps every byte in the store, so an outbox entry
    /// can deliver it again after a relaunch.
    pub(super) async fn carry(
        &self,
        tab_id: &str,
        device: Option<&str>,
        resolved: Vec<Resolved>,
        inline: bool,
        remember: bool,
    ) -> R<Carried> {
        let (images, to_land) = plan(resolved, inline);
        let mut files = Vec::new();
        for file in &to_land {
            if let Some((path, at)) = self.host.landed.get(device, &file.file.sha256, self.now()) {
                files.push(LandedFile {
                    file: file.file.clone(),
                    path,
                    landed_at: at,
                });
                continue;
            }
            let path = self.land_one(tab_id, file).await?;
            let now = self.now();
            self.host.landed.set(device, &file.file.sha256, &path, now);
            files.push(LandedFile {
                file: file.file.clone(),
                path,
                landed_at: now,
            });
        }
        if remember {
            for item in images.iter().chain(to_land.iter()) {
                if let Err(error) = self.host.attachments.put(item.bytes.clone()).await {
                    return fail(format!(
                        "Not sent: {} could not be kept by OMPdesk ({}). Nothing was delivered.",
                        item.file.name,
                        one_line(&error, 200)
                    ));
                }
            }
        }
        let set = AttachedSet {
            images: images.iter().map(|item| item.file.clone()).collect(),
            files,
        };
        let count = set.count();
        Ok(Carried {
            inline: images,
            set,
            count,
        })
    }

    async fn land_one(&self, tab_id: &str, file: &Resolved) -> R<String> {
        match self.host.land(tab_id, &file.file.name, &file.bytes).await {
            Landing::Landed(path) => Ok(path),
            Landing::Failed { error, code } => {
                let why = match code.as_deref() {
                    Some("file_too_large") => {
                        "it is more than that computer takes as one file".to_owned()
                    }
                    Some("upload_refused") => {
                        "that computer refused it: its upload limit for today is used up".to_owned()
                    }
                    Some("unsupported") => {
                        "OMPdesk on that computer is too old to take attached files".to_owned()
                    }
                    _ => one_line(
                        if error.is_empty() {
                            "no reason given"
                        } else {
                            &error
                        },
                        200,
                    ),
                };
                fail(format!(
                    "Not sent: {} could not be put on that session's computer ({why}). Nothing was delivered.",
                    file.file.name
                ))
            }
        }
    }

    /// The prompt an owed message is handed over as, with its pictures: `Err` when it cannot go with what it
    /// promised (the sender is told once, the entry stays queued).
    pub(super) async fn owed_command(&self, tab_id: &str, entry: &OutboxSend) -> Result<Value, ()> {
        match self.owed_prompt(tab_id, entry).await {
            Ok(command) => Ok(command),
            Err(problem) => {
                self.host
                    .trouble(
                        &entry.from,
                        entry.from_device.as_deref(),
                        &format!("attach-{}-{}", entry.mark, problem.0),
                        &format!(
                            "A message you sent ({}) was NOT delivered to {}: {}. It stays queued and OMPdesk tries again; if the attachment cannot come back, send the message again with the attachment.",
                            entry.mark,
                            saved_id_of_path(Some(&entry.session_path))
                                .unwrap_or_else(|| "its session".to_owned()),
                            problem.0
                        ),
                    )
                    .await;
                Err(())
            }
        }
    }

    async fn owed_prompt(&self, tab_id: &str, entry: &OutboxSend) -> Result<Value, Problem> {
        if entry.attachments_corrupt {
            return Err(Problem(
                "the record of what it carried is damaged, so which attachments it had is lost"
                    .into(),
            ));
        }
        let mut message = entry.message.clone();
        let mut attached = entry.attachments.clone();
        if let Some(set) = entry
            .attachments
            .as_ref()
            .filter(|set| !set.files.is_empty())
        {
            let (files, moved, changed) = self.host.rehome(tab_id, &set.files).await?;
            if changed {
                let now = self.now();
                for file in &files {
                    self.host.landed.set(
                        entry.device.as_deref(),
                        &file.file.sha256,
                        &file.path,
                        now,
                    );
                }
                let renewed = AttachedSet {
                    images: set.images.clone(),
                    files,
                };
                message = move_paths(&message, &moved);
                if let Some(outbox) = &self.send_outbox {
                    outbox.relanded(entry, &message, &renewed);
                }
                attached = Some(renewed);
            }
        }
        let images = self.host.stored_images_p(attached.as_ref()).await?;
        let mut command = json!({
            "type": "prompt",
            "message": message,
            "streamingBehavior": entry.streaming_behavior.as_str(),
        });
        if !images.is_empty() {
            command["images"] = Value::Array(images);
        }
        Ok(command)
    }

    /// What an answer attaches goes first, as a note into the answered session (the way a report's attachments do:
    /// pictures inline, files landed and their paths named), carried by the answer's own step on the session's computer.
    pub(super) async fn companion(
        &self,
        caller: &ControlTab,
        target: &ControlTab,
        about: &str,
        ask_id: &str,
        resolved: Vec<Resolved>,
    ) -> R<Option<Companion>> {
        if resolved.is_empty() {
            return Ok(None);
        }
        let sig = shas_sig(resolved.iter().map(|item| item.file.sha256.as_str()));
        let carried = self
            .carry(
                &target.tab_id,
                target.device.as_deref(),
                resolved,
                true,
                true,
            )
            .await?;
        let joined = [
            caller.session_path.as_deref().unwrap_or(&caller.tab_id),
            target.session_path.as_deref().unwrap_or(&target.tab_id),
            about,
            sig.as_str(),
        ]
        .join("\u{0}");
        let id = format!("answer-{}", &sha256_hex(joined.as_bytes())[..24]);
        let mut mail = Mail::new(
            &id,
            &caller.tab_id,
            &caller.title,
            &target.tab_id,
            MailKind::Note,
            &format!(
                "What goes with my answer to \"{}\" (the answer follows):",
                one_line(about, 100)
            ),
            self.now(),
        );
        mail.attachments = Some(carried.set.clone());
        let mut blocks = vec![json!({ "type": "text", "text": mail_text(&mail) })];
        for item in &carried.inline {
            blocks.push(image_block(&item.file, &item.bytes));
        }
        Ok(Some(Companion {
            content: if carried.inline.is_empty() {
                json!(mail_text(&mail))
            } else {
                Value::Array(blocks)
            },
            details: mail_details(&mail),
            delivery: delivery_for(MailKind::Note),
            request_id: format!("{id}|{ask_id}"),
        }))
    }

    /// The attachments no owed message names go (an entry being made is safe: the store keeps what is young).
    pub fn sweep_attachments(&self) -> usize {
        let mut keep = self
            .send_outbox
            .as_ref()
            .map(|outbox| outbox.attachment_shas())
            .unwrap_or_default();
        if let Some(outbox) = self.host.outbox() {
            keep.extend(outbox.attachment_shas());
        }
        self.host.attachments.sweep(&keep)
    }
}

#[cfg(test)]
#[path = "attach_tests.rs"]
mod tests;
