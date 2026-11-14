//! Producer outboxes hand responsibility to the authenticated receiver-native journal, never a bridge receipt.

use std::collections::HashSet;
use std::sync::Arc;

use super::{Runtime, check_mail_target, runtime_of};
use crate::agentctl::inbox::{
    InboxAddress, InboxAdmission, InboxIntent, InboxLogicalAttachments, InboxLogicalMessage,
    InboxLogicalPayload, InboxSourceExecution, NativeInboxAcceptance, NativeInboxKey,
    NativeInboxLookup, NativeInboxLookupEntry, NativeInboxLookupReply, NativeInboxLookupResult,
    NativeInboxTransfer, NativeInboxUpload,
};
use crate::agentctl::journal::Persistence;
use crate::agentctl::journal::attachments::{AttachmentRef, LandedFile};
use crate::agentctl::journal::mail_outbox::OutboxMail;
use crate::agentctl::journal::send_outbox::OutboxSend;
use crate::agentctl::rules::mail::{DeliveryReceipt, Mail, delivery_for, mail_details};
use crate::agentctl::service::attach::Landing;
use crate::agentctl::service::fail::{Fail, R};
use crate::agentctl::service::host::HostState;
use crate::agentctl::service::types::ControlTab;

pub(crate) async fn offer(port: u64, tab_id: &str) -> R<NativeInboxAcceptance> {
    let runtime = runtime_of(port).map_err(|error| Fail::other(error.message))?;
    runtime.host().fresh().await?;
    let target = runtime.source_target(tab_id, None)?;
    let sends = runtime
        .control
        .send_outbox
        .as_ref()
        .ok_or_else(|| Fail::other("The native source send journal is not configured"))?;
    let key = crate::agentctl::journal::send_outbox::receiver_key(
        target
            .session_path
            .as_deref()
            .ok_or_else(|| Fail::other("No current recipient session"))?,
        target.device.as_deref(),
    );
    sends.lane(&key, runtime.offer_inbox(tab_id)).await
}

/// The normal send admission already holds this same receiver's source lane.
pub(crate) async fn offer_locked(port: u64, tab_id: &str) -> R<NativeInboxAcceptance> {
    runtime_of(port)
        .map_err(|error| Fail::other(error.message))?
        .offer_inbox(tab_id)
        .await
}

pub(crate) fn keep_prompt(
    port: u64,
    entry: OutboxSend,
    execution: &InboxSourceExecution,
) -> R<Persistence> {
    runtime_of(port)
        .map_err(|error| Fail::other(error.message))?
        .keep_source(Source::Prompt(entry), execution)
}

/// Initial caller admission only; durable replay retains its producer after that execution ends.
pub(crate) async fn lookup(
    port: u64,
    tab_id: &str,
    entries: Vec<NativeInboxLookupEntry>,
    execution: &InboxSourceExecution,
) -> R<(NativeInboxLookup, NativeInboxLookupReply)> {
    let runtime = runtime_of(port).map_err(|error| Fail::other(error.message))?;
    runtime.host().fresh().await?;
    let target = runtime.source_target(tab_id, None)?;
    for entry in &entries {
        runtime.check_source_admission(&entry.logical, execution)?;
        entry
            .logical
            .validate_identity(entry.key.kind, &entry.key.delivery_id)
            .map_err(Fail::other)?;
    }
    let path = target
        .session_path
        .as_deref()
        .ok_or_else(|| Fail::other("No current recipient session"))?;
    let status = runtime
        .host()
        .inbox_status(tab_id, path, target.device.as_deref())
        .await?;
    runtime.host().fresh().await?;
    runtime.source_target(tab_id, Some(&target))?;
    if status.receiver.session_path != path
        || status.receiver.device.is_some()
        || status.receiver.instance.is_empty()
    {
        return Err(Fail::other("The native lookup bridge recipient changed"));
    }
    for entry in &entries {
        runtime.check_source_admission(&entry.logical, execution)?;
    }
    let query = NativeInboxLookup {
        receiver: status.receiver,
        entries,
    };
    let reply = runtime.host().lookup_inbox(tab_id, &query).await?;
    runtime.host().fresh().await?;
    runtime.source_target(tab_id, Some(&target))?;
    for entry in &query.entries {
        runtime.check_source_admission(&entry.logical, execution)?;
    }
    validate_lookup_reply(&query, &reply)?;
    Ok((query, reply))
}

fn validate_lookup_reply(query: &NativeInboxLookup, reply: &NativeInboxLookupReply) -> R<()> {
    if reply.receiver != query.receiver {
        return Err(Fail::other(
            "The native lookup reply names another receiving context",
        ));
    }
    let mut expected: HashSet<_> = query.entries.iter().map(|entry| &entry.key).collect();
    if expected.len() != query.entries.len() || reply.entries.len() != expected.len() {
        return Err(Fail::other(
            "The native lookup identity set differs from the query",
        ));
    }
    for result in &reply.entries {
        let key = match result {
            NativeInboxLookupResult::Missing { key }
            | NativeInboxLookupResult::ExistingPending { key, .. }
            | NativeInboxLookupResult::ExistingContextObserved { key, .. } => key,
        };
        if !expected.remove(key) {
            return Err(Fail::other(
                "The native lookup reply repeats or adds an identity",
            ));
        }
        if let NativeInboxLookupResult::ExistingContextObserved {
            context_receipt, ..
        } = result
            && (context_receipt.request_id.is_empty()
                || context_receipt.instance.is_empty()
                || context_receipt.session_path != query.receiver.session_path
                || context_receipt.ids.as_slice() != [key.provider_id()])
        {
            return Err(Fail::other(
                "The native lookup proof does not identify this exact delivery",
            ));
        }
    }
    Ok(())
}

pub(crate) async fn context_observed(port: u64, tab_id: &str, key: &NativeInboxKey) -> R<bool> {
    let runtime = runtime_of(port).map_err(|error| Fail::other(error.message))?;
    runtime.host().fresh().await?;
    let target = runtime.source_target(tab_id, None)?;
    let path = target
        .session_path
        .as_deref()
        .ok_or_else(|| Fail::other("No current receiving session"))?;
    let reply = runtime
        .host()
        .inbox_status(tab_id, path, target.device.as_deref())
        .await?;
    runtime.host().fresh().await?;
    runtime.source_target(tab_id, Some(&target))?;
    if reply.receiver.session_path != path
        || reply.receiver.device.is_some()
        || reply.receiver.instance.is_empty()
    {
        return Err(Fail::other("The native provider-context recipient changed"));
    }
    let mut observed = false;
    crate::agentctl::journal::inbox_ledger::visit_current_receipts(
        &reply.receiver,
        &reply,
        |current, _| observed |= current == *key,
    )
    .map_err(Fail::other)?;
    Ok(observed)
}
/// A report's initial keep and responsibility handoff share the existing source receiver lane.
/// Another batch cannot settle this caller's row before its exact Disk receipt is returned.
pub(crate) async fn post_report(
    port: u64,
    tab_id: &str,
    entry: OutboxMail,
    execution: &InboxSourceExecution,
) -> R<DeliveryReceipt> {
    let runtime = runtime_of(port).map_err(|error| Fail::other(error.message))?;
    runtime.host().fresh().await?;
    let target = runtime.source_target(tab_id, None)?;
    let sends = runtime
        .control
        .send_outbox
        .as_ref()
        .ok_or_else(|| Fail::other("The native source send journal is not configured"))?;
    let key = crate::agentctl::journal::send_outbox::receiver_key(
        target
            .session_path
            .as_deref()
            .ok_or_else(|| Fail::other("No current recipient session"))?,
        target.device.as_deref(),
    );
    let expected = NativeInboxKey {
        kind: crate::agentctl::inbox::InboxKind::Report,
        delivery_id: entry
            .delivery_id
            .clone()
            .ok_or_else(|| Fail::other("A report requires a native source identity"))?,
    };
    let logical = entry
        .native_source
        .bound()
        .map_err(Fail::other)?
        .ok_or_else(|| Fail::other("An unbound report cannot query native responsibility"))?;
    let query = NativeInboxLookupEntry {
        key: expected.clone(),
        logical: logical.clone(),
        attachments: entry
            .attachments
            .as_ref()
            .map(|set| InboxLogicalAttachments {
                images: set.images.clone(),
                files: set.files.iter().map(|landed| landed.file.clone()).collect(),
            }),
    };
    let (query, reply) = lookup(port, tab_id, vec![query], execution).await?;
    if !matches!(
        reply.entries.as_slice(),
        [NativeInboxLookupResult::Missing { .. }]
    ) {
        return Ok(DeliveryReceipt::Existing);
    }
    sends
        .lane(&key, async {
            let (_, reply) = lookup(port, tab_id, query.entries, execution).await?;
            if !matches!(
                reply.entries.as_slice(),
                [NativeInboxLookupResult::Missing { .. }]
            ) {
                return Ok(DeliveryReceipt::Existing);
            }
            if runtime.keep_source(Source::Report(entry), execution)? != Persistence::Disk {
                return Err(Fail::other(
                    "Source report disk responsibility is unconfirmed",
                ));
            }
            let acceptance = runtime.offer_inbox(tab_id).await?;
            let delivery = acceptance
                .deliveries
                .iter()
                .find(|delivery| delivery.key == expected)
                .ok_or_else(|| {
                    Fail::other("The receiver Disk receipt did not identify this exact report")
                })?;
            Ok(if delivery.existing {
                DeliveryReceipt::Existing
            } else {
                DeliveryReceipt::New
            })
        })
        .await
}

/// Original admission binds saved producer/target identities to current native facts. Replay uses the kept tuple.
pub(crate) fn addresses(
    state: &HostState,
    caller: &ControlTab,
    target: &ControlTab,
) -> R<(InboxAddress, InboxAddress)> {
    let current = state
        .tabs
        .iter()
        .chain(state.outside_callers.values())
        .find(|tab| tab.tab_id == caller.tab_id)
        .ok_or_else(|| Fail::other("The producing execution is no longer current"))?;
    if state.device_id.is_empty()
        || current.device.is_some()
        || caller.device.is_some()
        || current.session_path != caller.session_path
        || current.runtime_instance != caller.runtime_instance
    {
        return Err(Fail::other(
            "The logical producer must be the authenticated current execution host, not a forwarding peer",
        ));
    }
    let producer = InboxAddress {
        device_id: state.device_id.clone(),
        session_path: current
            .session_path
            .clone()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                Fail::other("A native inbox producer needs its actual saved session path")
            })?,
    };
    let target = InboxAddress {
        device_id: target
            .device
            .clone()
            .unwrap_or_else(|| state.device_id.clone()),
        session_path: target
            .session_path
            .clone()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                Fail::other("A native inbox recipient needs its actual saved session path")
            })?,
    };
    Ok((producer, target))
}

pub(crate) fn report_source(
    state: &HostState,
    caller: &ControlTab,
    target: &ControlTab,
    mail: &Mail,
    raw_text: &str,
) -> R<InboxAdmission> {
    let (producer, target) = addresses(state, caller, target)?;
    let mut details = mail_details(mail)
        .as_object()
        .expect("mail_details returns an object")
        .clone();
    details.remove("from");
    details.remove("fromTitle");
    // AttachmentRef carries exact content and consumer-visible metadata; paths are delivery materialization.
    details.remove("attachments");
    details.insert("text".into(), raw_text.into());
    Ok(InboxAdmission {
        logical: InboxLogicalMessage {
            producer,
            target,
            request_id: Some(mail.id.clone()),
            intent: InboxIntent::Immediate,
            trigger_turn: delivery_for(mail.kind).trigger_turn,
            payload: InboxLogicalPayload::Report {
                text: raw_text.to_owned(),
                details,
                instruction: mail.instruction.clone(),
                card: mail.card.clone(),
            },
        },
        execution: InboxSourceExecution {
            tab_id: caller.tab_id.clone(),
            runtime_instance: caller.runtime_instance.clone(),
        },
    })
}

enum Source {
    Prompt(OutboxSend),
    Report(OutboxMail),
}

impl Source {
    fn at(&self) -> f64 {
        match self {
            Self::Prompt(entry) => entry.at,
            Self::Report(entry) => entry.at,
        }
    }
}

impl Runtime {
    fn keep_source(&self, source: Source, execution: &InboxSourceExecution) -> R<Persistence> {
        // One ordinal, persisted in the existing at field, orders prompt/report admission across both journals.
        let mut last = super::lock(&self.source_at);
        let logical = match &source {
            Source::Prompt(entry) => entry.native_source.bound(),
            Source::Report(entry) => entry.native_source.bound(),
        }
        .map_err(Fail::other)?
        .ok_or_else(|| {
            Fail::other("Unbound legacy data cannot be promoted to native source authority")
        })?;
        self.check_source_admission(logical, execution)?;
        let at = self.control.now().max(*last + 1.0);
        *last = at;
        match source {
            Source::Prompt(mut entry) => {
                entry.at = at;
                self.control
                    .send_outbox
                    .as_ref()
                    .ok_or_else(|| Fail::other("The source send journal is not configured"))?
                    .keep(entry)
                    .map_err(Fail::other)
            }
            Source::Report(mut entry) => {
                entry.at = at;
                self.host()
                    .outbox()
                    .ok_or_else(|| Fail::other("The source report journal is not configured"))?
                    .keep(entry)
                    .map_err(Fail::other)
            }
        }
    }

    fn check_source_admission(
        &self,
        logical: &InboxLogicalMessage,
        execution: &InboxSourceExecution,
    ) -> R<()> {
        let state = self.host().state();
        let current = state
            .tabs
            .iter()
            .chain(state.outside_callers.values())
            .find(|tab| tab.tab_id == execution.tab_id)
            .ok_or_else(|| {
                Fail::other("The original producing execution ended before source admission")
            })?;
        if state.device_id != logical.producer.device_id
            || current.device.is_some()
            || current.runtime_instance != execution.runtime_instance
            || current.session_path.as_deref() != Some(logical.producer.session_path.as_str())
        {
            return Err(Fail::other(
                "The producing execution changed before source admission",
            ));
        }
        let recipient = state
            .tabs
            .iter()
            .chain(state.mail_targets.iter())
            .find(|tab| {
                tab.session_path.as_deref() == Some(logical.target.session_path.as_str())
                    && tab.device.as_deref().unwrap_or(&state.device_id) == logical.target.device_id
            })
            .ok_or_else(|| Fail::other("The logical recipient is no longer current"))?;
        check_mail_target(&state, recipient)?;
        Ok(())
    }

    pub(super) async fn resend_native_sources(self: &Arc<Self>) {
        let mut targets = HashSet::new();
        if let Some(sends) = &self.control.send_outbox {
            targets.extend(
                sends
                    .pending()
                    .into_iter()
                    .filter(|entry| entry.delivery_id.is_some())
                    .map(|entry| (entry.session_path, entry.device)),
            );
        }
        if let Some(mails) = self.host().outbox() {
            targets.extend(
                mails
                    .pending()
                    .into_iter()
                    .filter(|entry| entry.delivery_id.is_some())
                    .map(|entry| (entry.session_path, entry.device)),
            );
        }
        for (path, device) in targets {
            let state = self.host().state();
            let target = state
                .tabs
                .iter()
                .chain(state.mail_targets.iter())
                .find(|tab| {
                    tab.session_path.as_deref() == Some(path.as_str()) && tab.device == device
                });
            let Some(target) = target else {
                continue;
            };
            if let Err(error) = offer(self.host().port().id(), &target.tab_id).await {
                eprintln!(
                    "[agent-inbox] source responsibility retained: {}",
                    error.message()
                );
            }
        }
    }

    fn source_target(&self, tab_id: &str, previous: Option<&ControlTab>) -> R<ControlTab> {
        let state = self.host().state();
        let target = state
            .tabs
            .iter()
            .chain(state.mail_targets.iter())
            .find(|target| target.tab_id == tab_id)
            .ok_or_else(|| Fail::other("The inbox recipient is no longer open"))?;
        check_mail_target(&state, target)?;
        if let Some(previous) = previous
            && (previous.session_path != target.session_path
                || previous.device != target.device
                || previous.runtime_instance != target.runtime_instance)
        {
            return Err(Fail::other(
                "The inbox recipient runtime, path or device changed",
            ));
        }
        Ok(target.clone())
    }

    async fn offer_inbox(self: &Arc<Self>, tab_id: &str) -> R<NativeInboxAcceptance> {
        self.host().fresh().await?;
        let target = self.source_target(tab_id, None)?;
        let path = target
            .session_path
            .as_deref()
            .ok_or_else(|| Fail::other("The inbox recipient has no session file"))?;
        let device = target.device.as_deref();
        let sends = self
            .control
            .send_outbox
            .as_ref()
            .ok_or_else(|| Fail::other("The native source send journal is not configured"))?;
        let mails = self
            .host()
            .outbox()
            .ok_or_else(|| Fail::other("The native source report journal is not configured"))?;
        let status = self.host().inbox_status(tab_id, path, device).await?;
        self.host().fresh().await?;
        self.source_target(tab_id, Some(&target))?;
        if status.receiver.session_path != path
            || status.receiver.device.is_some()
            || status.receiver.instance.is_empty()
        {
            return Err(Fail::other(
                "The authenticated receiving bridge identity differs from the target",
            ));
        }
        let mut source: Vec<Source> = {
            let _admission = super::lock(&self.source_at);
            if sends.persist_pending().map_err(Fail::other)? != Persistence::Disk
                || mails.persist_pending().map_err(Fail::other)? != Persistence::Disk
            {
                return Err(Fail::other(
                    "Native source responsibility requires disk journals",
                ));
            }
            let mut source: Vec<Source> = sends
                .owed_to(path, device)
                .into_iter()
                .map(Source::Prompt)
                .collect();
            source.extend(
                mails
                    .pending()
                    .into_iter()
                    .filter(|mail| mail.session_path == path && mail.device.as_deref() == device)
                    .map(Source::Report),
            );
            source
        };
        source.sort_by(|left, right| left.at().total_cmp(&right.at()));
        let mut entries = Vec::with_capacity(source.len());
        let mut offered = Vec::with_capacity(source.len());
        for entry in source {
            let native = match &entry {
                Source::Prompt(entry) => entry.native_entry(),
                Source::Report(entry) => entry.native_entry(),
            }
            .map_err(Fail::other)?;
            // Legacy user-attributed or unidentified originals have no exact binding and remain in their producer.
            if let Some(native) = native {
                let host = self.host().state();
                native
                    .logical
                    .validate(&native.entry)
                    .map_err(Fail::other)?;
                if native.logical.producer.device_id != host.device_id
                    || native.logical.target.session_path != path
                    || native.logical.target.device_id
                        != target.device.as_deref().unwrap_or(&host.device_id)
                {
                    return Err(Fail::other(
                        "Persisted source identity differs from its authenticated execution host or intended recipient",
                    ));
                }
                entries.push(native);
                offered.push(entry);
            }
        }
        let shas = entries
            .iter()
            .flat_map(|entry| entry.attachments.iter().flat_map(|set| set.shas()));
        let store = self.host().attachment_store();
        let _pin = store.pin(shas).map_err(Fail::other)?;
        let mut uploads = Vec::new();
        let mut landed = HashSet::new();
        let file_reference: for<'a> fn(&'a LandedFile) -> &'a AttachmentRef = |file| &file.file;
        for entry in &entries {
            let Some(set) = &entry.attachments else {
                continue;
            };
            for reference in set
                .images
                .iter()
                .chain(set.files.iter().map(file_reference))
            {
                if !landed.insert(reference.sha256.clone()) {
                    continue;
                }
                let Some(bytes) = store.get(&reference.sha256).await else {
                    // After a received Disk ACK a failed source cleanup may replay an old row without its GC'd blob.
                    // Only the receiver's exact existing ledger ownership can accept this hash without a new upload.
                    continue;
                };
                self.host().fresh().await?;
                self.source_target(tab_id, Some(&target))?;
                if bytes.len() as u64 != reference.size {
                    return Err(Fail::other(
                        "Source attachment size differs from its hash reference",
                    ));
                }
                let path = match self.host().land(tab_id, &reference.name, &bytes).await {
                    Landing::Landed(path) => path,
                    Landing::Failed { error, .. } => return Err(Fail::other(error)),
                };
                self.host().fresh().await?;
                self.source_target(tab_id, Some(&target))?;
                uploads.push(NativeInboxUpload {
                    sha256: reference.sha256.clone(),
                    path,
                });
            }
        }
        let expected: HashSet<NativeInboxKey> =
            entries.iter().map(|entry| entry.entry.key()).collect();
        let transfer = NativeInboxTransfer {
            receiver: status.receiver.clone(),
            entries,
            uploads,
        };
        let acceptance = self.host().inbox(tab_id, &transfer).await?;
        self.host().fresh().await?;
        self.source_target(tab_id, Some(&target))?;
        if acceptance.persistence != Persistence::Disk
            || acceptance.receiver != status.receiver
            || acceptance.deliveries.len() != expected.len()
            || acceptance
                .deliveries
                .iter()
                .map(|delivery| delivery.key.clone())
                .collect::<HashSet<_>>()
                != expected
        {
            return Err(Fail::other(
                "Receiving native disk responsibility is unconfirmed; source originals retained",
            ));
        }
        for entry in offered {
            match entry {
                Source::Prompt(entry) => sends.settle_native(&entry),
                Source::Report(entry) => mails.settle_native(&entry),
            }
        }
        Ok(acceptance)
    }
}

#[cfg(test)]
#[path = "inbox_source/lookup_tests.rs"]
mod lookup_tests;
