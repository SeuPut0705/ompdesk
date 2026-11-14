//! Native receiving-hop acceptance and delivery. Bridge output never substitutes for disk responsibility.

use std::sync::Arc;

use serde::Deserialize;

use super::{Runtime, check_mail_target, fault_of, runtime_of};
use crate::agentctl::inbox::{
    InboxBlock, InboxContent, InboxPayload, InboxReceiver, NativeInboxAcceptance,
    NativeInboxRequest, NativeInboxTransfer,
};
use crate::agentctl::journal::Persistence;
use crate::agentctl::journal::attachments::with_attached;
use crate::agentctl::service::types::ControlTab;
use crate::server::{Call, Fault, Registry, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptParams {
    port: u64,
    tab_id: String,
    transfer: NativeInboxTransfer,
    /// Injected by the authenticated receiving route, never forwarded from the producer's payload.
    upload_device_id: String,
    /// Original producer host, overwritten from the authenticated direct peer/local host by the route.
    expected_producer_device_id: String,
    /// Host execution identity. This is distinct from the bridge AgentSession's receiver.instance.
    expected_runtime_instance: String,
}

impl Runtime {
    pub(super) fn redeliver_inbox(self: &Arc<Self>) {
        if self.control.receiving_inbox.is_none() {
            return;
        }
        {
            let mut state = self.rt();
            if state.inbox_delivering {
                state.inbox_again = true;
                return;
            }
            state.inbox_delivering = true;
        }
        let runtime = self.clone();
        tokio::spawn(async move {
            loop {
                runtime.deliver_pending_inbox().await;
                let mut state = runtime.rt();
                if !state.inbox_again {
                    state.inbox_delivering = false;
                    break;
                }
                state.inbox_again = false;
            }
        });
    }

    async fn deliver_pending_inbox(self: &Arc<Self>) {
        let Some(inbox) = &self.control.receiving_inbox else {
            return;
        };
        let receivers = match inbox.ledger.receivers() {
            Ok(receivers) => receivers,
            Err(error) => {
                eprintln!("[agent-inbox] receiver inventory unavailable: {error}");
                return;
            }
        };
        for address in receivers {
            if address.device.is_some() {
                continue;
            }
            if self.host().fresh().await.is_err() {
                return;
            }
            let target = {
                let state = self.host().state();
                state
                    .tabs
                    .iter()
                    .chain(state.mail_targets.iter())
                    .find(|target| {
                        target.session_path.as_deref() == Some(address.session_path.as_str())
                            && target.device.is_none()
                            && check_mail_target(&state, target).is_ok()
                    })
                    .cloned()
            };
            let Some(target) = target else {
                continue;
            };
            let Some(expected) = target.runtime_instance.filter(|id| !id.is_empty()) else {
                continue;
            };
            let status = match self
                .host()
                .inbox_status(&target.tab_id, &address.session_path, None)
                .await
            {
                Ok(status) => status,
                Err(_) => continue,
            };
            if let Err(error) = self
                .deliver_inbox(&target.tab_id, &status.receiver, &expected)
                .await
            {
                eprintln!(
                    "[agent-inbox] receiving delivery remains pending: {}",
                    error.message
                );
            }
        }
    }

    fn inbox_target(
        &self,
        tab_id: &str,
        receiver: &InboxReceiver,
        expected_runtime_instance: &str,
    ) -> Result<ControlTab, Fault> {
        let state = self.host().state();
        let target = state
            .tabs
            .iter()
            .chain(state.mail_targets.iter())
            .find(|target| target.tab_id == tab_id)
            .ok_or_else(|| {
                Fault::new(
                    "inbox_target_changed",
                    "The receiving tab is no longer open",
                )
            })?;
        check_mail_target(&state, target).map_err(|error| fault_of(&error))?;
        if receiver.device.is_some()
            || target.device.is_some()
            || target.session_path.as_deref() != Some(receiver.session_path.as_str())
            || expected_runtime_instance.is_empty()
            || target.runtime_instance.as_deref() != Some(expected_runtime_instance)
        {
            return Err(Fault::new(
                "inbox_target_changed",
                "The receiving native runtime, path or device changed",
            ));
        }
        Ok(target.clone())
    }

    async fn check_inbox_instance(
        &self,
        tab_id: &str,
        receiver: &InboxReceiver,
        expected_runtime_instance: &str,
    ) -> Result<crate::agentctl::inbox::NativeInboxReply, Fault> {
        self.host()
            .fresh()
            .await
            .map_err(|error| fault_of(&error))?;
        self.inbox_target(tab_id, receiver, expected_runtime_instance)?;
        let status = self
            .host()
            .inbox_status(tab_id, &receiver.session_path, None)
            .await
            .map_err(|error| fault_of(&error))?;
        self.host()
            .fresh()
            .await
            .map_err(|error| fault_of(&error))?;
        self.inbox_target(tab_id, receiver, expected_runtime_instance)?;
        if status.receiver != *receiver {
            return Err(Fault::new(
                "inbox_instance_changed",
                "The receiving bridge context changed",
            ));
        }
        Ok(status)
    }

    async fn accept_inbox(
        self: &Arc<Self>,
        params: AcceptParams,
    ) -> Result<NativeInboxAcceptance, Fault> {
        let inbox = self.control.receiving_inbox.as_ref().ok_or_else(|| {
            Fault::new(
                "inbox_unconfigured",
                "The native receiving journal is not configured",
            )
        })?;
        if params.upload_device_id.is_empty() {
            return Err(Fault::new(
                "inbox_upload_owner",
                "An authenticated upload namespace is required",
            ));
        }
        let receiver = &params.transfer.receiver;
        let _lane = inbox.lane(receiver).await;
        self.check_inbox_instance(&params.tab_id, receiver, &params.expected_runtime_instance)
            .await?;
        let host_device_id = self.host().state().device_id.clone();
        if host_device_id.is_empty() || params.expected_producer_device_id.is_empty() {
            return Err(Fault::new(
                "inbox_producer",
                "Authenticated persistent host identities are required",
            ));
        }
        for entry in &params.transfer.entries {
            entry
                .logical
                .validate(&entry.entry)
                .map_err(|error| Fault::new("inbox_logical", error))?;
            if entry.logical.producer.device_id != params.expected_producer_device_id
                || entry.logical.target.device_id != host_device_id
                || entry.logical.target.session_path != receiver.session_path
            {
                return Err(Fault::new(
                    "inbox_producer",
                    "The native source or recipient differs from its authenticated host",
                ));
            }
        }
        let owned = inbox
            .ledger
            .known(receiver, &params.transfer.entries)
            .map_err(|error| Fault::new("inbox_conflict", error))?;
        let fence = || {
            self.inbox_target(&params.tab_id, receiver, &params.expected_runtime_instance)
                .map(|_| ())
                .map_err(|error| error.message)
        };
        let imported = super::inbox_attachments::import(
            params.transfer.clone(),
            &owned,
            &inbox.store,
            &inbox.uploads,
            &params.upload_device_id,
            &inbox.clock,
            &fence,
        )
        .await
        .map_err(|error| Fault::new("inbox_attachment", error))?;
        self.check_inbox_instance(&params.tab_id, receiver, &params.expected_runtime_instance)
            .await?;
        let accepted = inbox.ledger.keep(receiver, &imported.transfer.entries);
        // Promote even failed in-memory keeps before releasing the import pin. write_kept owns disk-full retries.
        let retained = inbox.refresh_retention();
        let mut accepted = accepted.map_err(|error| Fault::new("inbox_not_saved", error))?;
        retained.map_err(|error| Fault::new("inbox_retention", error))?;
        if imported.persistence == Some(Persistence::Memory) {
            accepted.persistence = Persistence::Memory;
        }
        self.inbox_target(&params.tab_id, receiver, &params.expected_runtime_instance)?;
        drop(imported.pin);
        if accepted.persistence == Persistence::Disk {
            let runtime = self.clone();
            let tab = params.tab_id;
            let receiver = receiver.clone();
            let expected = params.expected_runtime_instance;
            tokio::spawn(async move {
                if let Err(error) = runtime.deliver_inbox(&tab, &receiver, &expected).await {
                    eprintln!(
                        "[agent-inbox] pending receiving delivery: {}",
                        error.message
                    );
                }
            });
        }
        Ok(accepted)
    }

    async fn deliver_inbox(
        self: &Arc<Self>,
        tab_id: &str,
        receiver: &InboxReceiver,
        expected_runtime_instance: &str,
    ) -> Result<(), Fault> {
        let inbox = self.control.receiving_inbox.as_ref().ok_or_else(|| {
            Fault::new(
                "inbox_unconfigured",
                "The native receiving journal is not configured",
            )
        })?;
        let _lane = inbox.lane(receiver).await;
        let status = self
            .check_inbox_instance(tab_id, receiver, expected_runtime_instance)
            .await?;
        inbox
            .ledger
            .reconcile(receiver, &status)
            .map_err(|error| Fault::new("inbox_receipt_not_saved", error))?;
        inbox
            .refresh_retention()
            .map_err(|error| Fault::new("inbox_retention", error))?;
        let (persistence, pending) = inbox
            .ledger
            .pending(receiver)
            .map_err(|error| Fault::new("inbox_not_saved", error))?;
        if persistence != Persistence::Disk || pending.is_empty() {
            return Ok(());
        }
        let mut entries = Vec::with_capacity(pending.len());
        for mut item in pending {
            self.inbox_target(tab_id, receiver, expected_runtime_instance)?;
            if let Some(set) = &mut item.attachments {
                for file in &mut set.files {
                    let bytes = inbox.store.get(&file.file.sha256).await.ok_or_else(|| {
                        Fault::new(
                            "inbox_attachment",
                            "Receiving attachment bytes are unavailable",
                        )
                    })?;
                    self.inbox_target(tab_id, receiver, expected_runtime_instance)?;
                    if bytes.len() as u64 != file.file.size {
                        return Err(Fault::new(
                            "inbox_attachment",
                            "Receiving attachment size differs from its identity",
                        ));
                    }
                    file.path = inbox
                        .store
                        .file_path(&file.file.sha256)
                        .ok_or_else(|| {
                            Fault::new(
                                "inbox_attachment",
                                "Receiving attachment has no durable local path",
                            )
                        })?
                        .to_string_lossy()
                        .into_owned();
                    file.landed_at = (inbox.clock)();
                }
                let images = self
                    .host()
                    .stored_images_p(Some(set))
                    .await
                    .map_err(|error| Fault::new("inbox_attachment", error.0))?;
                self.inbox_target(tab_id, receiver, expected_runtime_instance)?;
                inbox
                    .ledger
                    .materialized(receiver, &item.entry.key(), set)
                    .map_err(|error| Fault::new("inbox_not_saved", error))?;
                materialize_report_details(&mut item.entry, set)
                    .map_err(|error| Fault::new("inbox_attachment_details", error))?;
                let content = match &mut item.entry.payload {
                    InboxPayload::Prompt { content } | InboxPayload::Report { content, .. } => {
                        content
                    }
                };
                if !set.files.is_empty() {
                    match content {
                        InboxContent::Text(text) => *text = with_attached(text, &set.files),
                        InboxContent::Blocks(blocks) => blocks.push(InboxBlock::Text {
                            text: with_attached("", &set.files),
                        }),
                    }
                }
                if !images.is_empty() {
                    let image_blocks = images
                        .into_iter()
                        .map(serde_json::from_value::<InboxBlock>)
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| Fault::new("inbox_attachment", error.to_string()))?;
                    match content {
                        InboxContent::Text(text) => {
                            let mut blocks = Vec::with_capacity(image_blocks.len() + 1);
                            blocks.push(InboxBlock::Text {
                                text: std::mem::take(text),
                            });
                            blocks.extend(image_blocks);
                            *content = InboxContent::Blocks(blocks);
                        }
                        InboxContent::Blocks(blocks) => blocks.extend(image_blocks),
                    }
                }
            }
            entries.push(item.entry);
        }
        self.check_inbox_instance(tab_id, receiver, expected_runtime_instance)
            .await?;
        let request = NativeInboxRequest {
            receiver: receiver.clone(),
            entries,
        };
        let reply = self
            .host()
            .deliver_inbox(tab_id, &request)
            .await
            .map_err(|error| fault_of(&error))?;
        self.host()
            .fresh()
            .await
            .map_err(|error| fault_of(&error))?;
        self.inbox_target(tab_id, receiver, expected_runtime_instance)?;
        inbox
            .ledger
            .reconcile(receiver, &reply)
            .map_err(|error| Fault::new("inbox_receipt_not_saved", error))?;
        inbox
            .refresh_retention()
            .map_err(|error| Fault::new("inbox_retention", error))?;
        Ok(())
    }
}

/// Only the native mail renderer's attachment slots move. User-authored text and arbitrary nested paths never do.
fn materialize_report_details(
    entry: &mut crate::agentctl::inbox::NativeInboxEntry,
    set: &crate::agentctl::journal::attachments::AttachedSet,
) -> Result<(), String> {
    let InboxPayload::Report { details, .. } = &mut entry.payload else {
        return Ok(());
    };
    let Some(list) = details.get_mut("attachments") else {
        return Ok(());
    };
    let list = list
        .as_array_mut()
        .ok_or("Invalid native report attachment metadata")?;
    if list.len() != set.images.len() + set.files.len() {
        return Err("Native report attachment metadata differs from its content references".into());
    }
    for (index, file) in set.files.iter().enumerate() {
        let metadata = &mut list[set.images.len() + index];
        if metadata.get("kind").and_then(serde_json::Value::as_str) != Some("file")
            || metadata.get("name").and_then(serde_json::Value::as_str)
                != Some(file.file.name.as_str())
        {
            return Err("Native report file metadata differs from its content reference".into());
        }
        metadata["path"] = file.path.clone().into();
    }
    Ok(())
}

async fn accept(call: Call) -> Result<Reply, Fault> {
    let params: AcceptParams = call.params()?;
    let runtime = runtime_of(params.port)?;
    Reply::json(&runtime.accept_inbox(params).await?)
}

pub(super) fn register(registry: &mut Registry) {
    registry.add("agentRuntime.acceptInbox", |call| Box::pin(accept(call)));
}

#[cfg(test)]
mod tests;
