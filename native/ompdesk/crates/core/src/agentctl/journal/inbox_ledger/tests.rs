use std::path::PathBuf;

use serde_json::json;

use super::InboxLedger;
use crate::agentctl::inbox::{
    InboxAddress, InboxContent, InboxContextReceipt, InboxEvidence, InboxIntent, InboxKind,
    InboxLogicalMessage, InboxLogicalPayload, InboxPayload, InboxReceiver, InboxSender,
    NativeInboxEntry, NativeInboxReply, NativeInboxTransferEntry,
};
use crate::agentctl::journal::Persistence;

pub(super) struct Dir(PathBuf);
impl Dir {
    pub(super) fn new() -> Self {
        Self(crate::fs::disk::make_temp_dir("ompdesk-inbox-ledger-").unwrap())
    }
    pub(super) fn file(&self) -> PathBuf {
        self.0.join("inbox.json")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn receiver(instance: &str) -> InboxReceiver {
    InboxReceiver {
        session_path: "/isolated/receiver.jsonl".into(),
        device: None,
        instance: instance.into(),
    }
}
pub(super) fn entry(id: &str, kind: InboxKind) -> NativeInboxTransferEntry {
    NativeInboxTransferEntry {
        entry: NativeInboxEntry {
            delivery_id: id.into(),
            sender: InboxSender {
                session: "isolated-source".into(),
                device: None,
            },
            intent: InboxIntent::Immediate,
            trigger_turn: true,
            legacy: false,
            payload: match kind {
                InboxKind::Prompt => InboxPayload::Prompt {
                    content: InboxContent::Text(format!("do {id}")),
                },
                InboxKind::Report => InboxPayload::Report {
                    content: InboxContent::Text(format!("report {id}")),
                    details: json!({"id":"original-id","kind":"question","nested":{"keep":true}})
                        .as_object()
                        .unwrap()
                        .clone(),
                },
            },
        },
        logical: InboxLogicalMessage {
            producer: InboxAddress {
                device_id: "source-host".into(),
                session_path: "/isolated/source.jsonl".into(),
            },
            target: InboxAddress {
                device_id: "receiver-host".into(),
                session_path: "/isolated/receiver.jsonl".into(),
            },
            request_id: None,
            intent: InboxIntent::Immediate,
            trigger_turn: true,
            payload: match kind {
                InboxKind::Prompt => InboxLogicalPayload::Prompt {
                    text: format!("do {id}"),
                },
                InboxKind::Report => InboxLogicalPayload::Report {
                    text: format!("report {id}"),
                    details: json!({"id":"original-id","kind":"question","nested":{"keep":true}})
                        .as_object()
                        .unwrap()
                        .clone(),
                    instruction: None,
                    card: None,
                },
            },
        },
        dispatch: Some(1),
        attachments: None,
    }
}
pub(super) fn receipt(
    receiver: &InboxReceiver,
    entries: &[NativeInboxTransferEntry],
) -> NativeInboxReply {
    NativeInboxReply {
        receiver: receiver.clone(),
        entries: Vec::new(),
        receipts: vec![InboxContextReceipt {
            request_id: "real-provider-request".into(),
            session_path: receiver.session_path.clone(),
            instance: receiver.instance.clone(),
            ids: entries
                .iter()
                .map(|entry| entry.entry.key().provider_id())
                .collect(),
            evidence: InboxEvidence::ContextIdAndProviderOutput,
        }],
    }
}
fn pending(ledger: &InboxLedger, receiver: &InboxReceiver) -> Vec<String> {
    ledger
        .pending(receiver)
        .unwrap()
        .1
        .iter()
        .map(|entry| entry.entry.key().provider_id())
        .collect()
}

#[test]
fn receiver_restart_preserves_pending_order_source_kind_and_original_details() {
    let dir = Dir::new();
    let before = receiver("before");
    let entries = [
        entry("same", InboxKind::Report),
        entry("same", InboxKind::Prompt),
        entry("later", InboxKind::Prompt),
    ];
    let ledger = InboxLedger::new(Some(dir.file()));
    let accepted = ledger.keep(&before, &entries).unwrap();
    assert_eq!(accepted.persistence, Persistence::Disk);
    assert_eq!(
        accepted
            .deliveries
            .iter()
            .map(|delivery| delivery.key.clone())
            .collect::<Vec<_>>(),
        entries
            .iter()
            .map(|entry| entry.entry.key())
            .collect::<Vec<_>>()
    );
    drop(ledger);
    let reopened = InboxLedger::new(Some(dir.file()));
    assert_eq!(
        reopened.pending(&receiver("after")).unwrap(),
        (Persistence::Disk, entries.to_vec())
    );
}

#[test]
fn lost_disk_ack_replay_is_idempotent_before_and_after_context_receipt() {
    let dir = Dir::new();
    let before = receiver("before");
    let entries = [
        entry("one", InboxKind::Prompt),
        entry("two", InboxKind::Prompt),
    ];
    let ledger = InboxLedger::new(Some(dir.file()));
    ledger.keep(&before, &entries).unwrap();
    ledger.keep(&before, &entries).unwrap();
    assert_eq!(ledger.pending(&before).unwrap().1, entries);
    ledger
        .reconcile(&before, &receipt(&before, &entries))
        .unwrap();
    drop(ledger);
    let after = receiver("after");
    let reopened = InboxLedger::new(Some(dir.file()));
    assert_eq!(
        reopened.keep(&after, &entries).unwrap().persistence,
        Persistence::Disk
    );
    assert!(pending(&reopened, &after).is_empty());
    let text = std::fs::read_to_string(dir.file()).unwrap();
    assert!(!text.contains("do one"));
    assert!(text.contains("real-provider-request"));
}

#[test]
fn conflicting_identity_refuses_the_entire_new_batch_without_overwriting_original() {
    let dir = Dir::new();
    let receiver = receiver("current");
    let original = entry("existing", InboxKind::Report);
    let ledger = InboxLedger::new(Some(dir.file()));
    ledger
        .keep(&receiver, std::slice::from_ref(&original))
        .unwrap();
    let mut changed = original.clone();
    changed.entry.intent = InboxIntent::FollowUp;
    assert!(
        ledger
            .keep(
                &receiver,
                &[entry("new", InboxKind::Prompt), changed.clone()]
            )
            .is_err()
    );
    assert_eq!(ledger.pending(&receiver).unwrap().1, [original.clone()]);
    ledger
        .reconcile(
            &receiver,
            &receipt(&receiver, std::slice::from_ref(&original)),
        )
        .unwrap();
    assert!(ledger.keep(&receiver, &[changed]).is_err());
    assert!(pending(&ledger, &receiver).is_empty());
}

#[test]
fn object_key_order_does_not_create_a_false_replay_conflict() {
    let ledger = InboxLedger::new(None);
    let receiver = receiver("current");
    let first = entry("report", InboxKind::Report);
    let mut second = first.clone();
    if let InboxLogicalPayload::Report { details, .. } = &mut second.logical.payload {
        *details = serde_json::from_str(
            r#"{"nested":{"keep":true},"kind":"question","id":"original-id"}"#,
        )
        .unwrap();
    }
    assert_eq!(
        ledger.keep(&receiver, &[first]).unwrap().persistence,
        Persistence::Memory
    );
    assert_eq!(
        ledger.keep(&receiver, &[second]).unwrap().persistence,
        Persistence::Memory
    );
    assert_eq!(
        pending(&ledger, &receiver),
        [entry("report", InboxKind::Report).entry.key().provider_id()]
    );
}

#[test]
fn failed_disk_keep_retains_memory_but_no_disk_acceptance_or_delivery_until_saved() {
    let dir = Dir::new();
    let receiver = receiver("current");
    let ledger = InboxLedger::new(Some(dir.file()));
    std::fs::create_dir(dir.file()).unwrap();
    let entries = [entry("one", InboxKind::Prompt)];
    assert!(ledger.keep(&receiver, &entries).is_err());
    assert!(ledger.pending(&receiver).is_err());
    std::fs::remove_dir(dir.file()).unwrap();
    assert_eq!(
        ledger.keep(&receiver, &entries).unwrap().persistence,
        Persistence::Disk
    );
    assert_eq!(
        InboxLedger::new(Some(dir.file()))
            .pending(&receiver)
            .unwrap()
            .1,
        entries
    );
}

#[test]
fn failed_consumed_save_keeps_terminal_memory_and_old_disk_payload_until_receipt_recovery() {
    let dir = Dir::new();
    let receiver = receiver("current");
    let ledger = InboxLedger::new(Some(dir.file()));
    let entries = [entry("one", InboxKind::Prompt)];
    ledger.keep(&receiver, &entries).unwrap();
    let backup = dir.0.join("previous.json");
    std::fs::rename(dir.file(), &backup).unwrap();
    std::fs::create_dir(dir.file()).unwrap();
    let observed = receipt(&receiver, &entries);
    assert!(ledger.reconcile(&receiver, &observed).is_err());
    assert!(ledger.pending(&receiver).is_err());
    std::fs::remove_dir(dir.file()).unwrap();
    std::fs::rename(&backup, dir.file()).unwrap();
    let reopened = InboxLedger::new(Some(dir.file()));
    assert_eq!(reopened.pending(&receiver).unwrap().1, entries);
    assert_eq!(
        reopened.reconcile(&receiver, &observed).unwrap(),
        Persistence::Disk
    );
    assert!(pending(&reopened, &receiver).is_empty());
    assert!(pending(&ledger, &receiver).is_empty());
}

#[test]
fn journaled_status_without_provider_receipt_never_consumes_and_stale_receiver_is_refused() {
    let ledger = InboxLedger::new(None);
    let receiver = receiver("current");
    let entries = [entry("one", InboxKind::Prompt)];
    ledger.keep(&receiver, &entries).unwrap();
    let mut reply = receipt(&receiver, &entries);
    reply.receipts.clear();
    ledger.reconcile(&receiver, &reply).unwrap();
    assert_eq!(ledger.pending(&receiver).unwrap().1, entries);
    reply.receiver.instance = "old".into();
    assert!(ledger.reconcile(&receiver, &reply).is_err());
    assert_eq!(ledger.pending(&receiver).unwrap().1, entries);
}

#[test]
fn unreadable_ledger_fails_closed_and_preserves_original_bytes() {
    let dir = Dir::new();
    let original = "{damaged accepted responsibility";
    std::fs::write(dir.file(), original).unwrap();
    let ledger = InboxLedger::new(Some(dir.file()));
    let receiver = receiver("current");
    assert!(
        ledger
            .keep(&receiver, &[entry("new", InboxKind::Prompt)])
            .is_err()
    );
    assert!(ledger.pending(&receiver).is_err());
    assert_eq!(std::fs::read_to_string(dir.file()).unwrap(), original);
}

#[test]
fn rehome_paths_do_not_conflict_with_logical_identity_or_duplicate_pending_input() {
    use crate::agentctl::journal::attachments::{
        AttachedSet, AttachmentRef, LandedFile, sha256_hex,
    };
    let receiver = receiver("current");
    let ledger = InboxLedger::new(None);
    let reference = AttachmentRef {
        sha256: sha256_hex(b"bytes"),
        name: "sample.txt".into(),
        mime_type: "text/plain".into(),
        size: 5,
    };
    let mut original = entry("file", InboxKind::Prompt);
    original.attachments = Some(AttachedSet {
        images: Vec::new(),
        files: vec![LandedFile {
            file: reference,
            path: "/issued/first".into(),
            landed_at: 1.0,
        }],
    });
    assert_eq!(
        ledger
            .keep(&receiver, &[original.clone()])
            .unwrap()
            .persistence,
        Persistence::Memory
    );
    let mut replay = original.clone();
    let attachments = replay.attachments.as_mut().unwrap();
    attachments.files[0].path = "/issued/retry".into();
    attachments.files[0].landed_at = 2.0;
    assert!(
        ledger
            .known(&receiver, &[replay.clone()])
            .unwrap()
            .contains_key(&replay.entry.key())
    );
    ledger.keep(&receiver, &[replay.clone()]).unwrap();
    ledger
        .materialized(
            &receiver,
            &replay.entry.key(),
            replay.attachments.as_ref().unwrap(),
        )
        .unwrap();
    assert_eq!(ledger.pending(&receiver).unwrap().1, [replay.clone()]);
    replay.attachments.as_mut().unwrap().files[0].file.name = "changed-name.txt".into();
    assert!(ledger.keep(&receiver, &[replay]).is_err());
    assert_eq!(ledger.pending(&receiver).unwrap().1.len(), 1);
}

#[test]
fn incoming_blob_refs_survive_first_output_and_terminal_identity_survives_normal_expiry() {
    use crate::agentctl::journal::attachments::{
        AttachedSet, AttachmentRef, AttachmentStore, LandedFile, UPLOAD_TTL_MS,
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    let now = Arc::new(AtomicU64::new(1));
    let read = now.clone();
    let clock: crate::agentctl::journal::Clock =
        Arc::new(move || read.load(Ordering::SeqCst) as f64);
    let store = AttachmentStore::with_clock(None, clock.clone());
    let bytes = Arc::new(b"tool must still read this file".to_vec());
    let sha = store.put_now(&bytes).unwrap();
    let mut input = entry("file-lifetime", InboxKind::Prompt);
    input.attachments = Some(AttachedSet {
        images: Vec::new(),
        files: vec![LandedFile {
            file: AttachmentRef {
                sha256: sha.clone(),
                name: "sample.txt".into(),
                mime_type: "text/plain".into(),
                size: bytes.len() as u64,
            },
            path: "/issued/path".into(),
            landed_at: 1.0,
        }],
    });
    let receiver = receiver("current");
    let ledger = InboxLedger::with_clock(None, clock);
    ledger.keep(&receiver, &[input.clone()]).unwrap();
    ledger
        .reconcile(&receiver, &receipt(&receiver, &[input.clone()]))
        .unwrap();
    now.store(2 * 60 * 60 * 1000, Ordering::SeqCst);
    assert_eq!(store.sweep(&ledger.attachment_shas().unwrap()), 0);
    assert_eq!(store.get_now(&sha).unwrap().as_slice(), bytes.as_slice());
    now.store(UPLOAD_TTL_MS as u64 + 2, Ordering::SeqCst);
    assert_eq!(store.sweep(&ledger.attachment_shas().unwrap()), 1);
    assert!(store.get_now(&sha).is_none());
    assert_eq!(
        ledger.known(&receiver, &[input.clone()]).unwrap()[&input.entry.key()],
        super::Ownership::ContextObserved
    );
    assert!(ledger.pending(&receiver).unwrap().1.is_empty());
}

#[test]
fn shared_attachment_pins_cover_import_windows_and_release_only_their_own_reference() {
    use crate::agentctl::journal::attachments::AttachmentStore;
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    let now = Arc::new(AtomicU64::new(1));
    let read = now.clone();
    let store = Arc::new(AttachmentStore::with_clock(
        None,
        Arc::new(move || read.load(Ordering::SeqCst) as f64),
    ));
    let sha = store
        .put_now(&Arc::new(b"shared import bytes".to_vec()))
        .unwrap();
    let first = store.pin([sha.as_str()]).unwrap();
    let second = store.pin([sha.as_str()]).unwrap();
    now.store(2 * 60 * 60 * 1000, Ordering::SeqCst);
    assert_eq!(store.sweep(&HashSet::new()), 0);
    drop(first);
    assert_eq!(store.sweep(&HashSet::new()), 0);
    assert!(store.get_now(&sha).is_some());
    drop(second);
    assert_eq!(store.sweep(&HashSet::new()), 1);
    assert!(store.get_now(&sha).is_none());
}
