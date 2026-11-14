use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::agentctl::inbox::{
    InboxAddress, InboxContent, InboxIntent, InboxLogicalMessage, InboxLogicalPayload,
    InboxPayload, InboxReceiver, InboxSender, NativeInboxEntry, NativeInboxTransferEntry,
    NativeInboxUpload,
};
use crate::agentctl::journal::attachments::{AttachedSet, LandedFile};
use crate::agentctl::journal::inbox_ledger::InboxLedger;
use crate::web::uploads::{Limits, open};

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        Self(crate::fs::disk::make_temp_dir("ompdesk-inbox-attachment-").unwrap())
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn clock() -> (Clock, Arc<AtomicU64>) {
    let now = Arc::new(AtomicU64::new(1));
    let read = now.clone();
    (Arc::new(move || read.load(Ordering::SeqCst) as f64), now)
}
fn transfer(path: String, bytes: &[u8]) -> NativeInboxTransfer {
    let sha = sha256_hex(bytes);
    let file = AttachmentRef {
        sha256: sha.clone(),
        name: "sample.txt".into(),
        mime_type: "text/plain".into(),
        size: bytes.len() as u64,
    };
    NativeInboxTransfer {
        receiver: InboxReceiver {
            session_path: "/isolated/receiver.jsonl".into(),
            device: None,
            instance: "before".into(),
        },
        entries: vec![NativeInboxTransferEntry {
            entry: NativeInboxEntry {
                delivery_id: "stable-one".into(),
                sender: InboxSender {
                    session: "native-sender".into(),
                    device: None,
                },
                intent: InboxIntent::Immediate,
                trigger_turn: true,
                legacy: false,
                payload: InboxPayload::Prompt {
                    content: InboxContent::Text("read the attached sample".into()),
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
                payload: InboxLogicalPayload::Prompt {
                    text: "read the attached sample".into(),
                },
            },
            dispatch: None,
            attachments: Some(AttachedSet {
                images: Vec::new(),
                files: vec![LandedFile {
                    file,
                    path: path.clone(),
                    landed_at: 1.0,
                }],
            }),
        }],
        uploads: vec![NativeInboxUpload { sha256: sha, path }],
    }
}
async fn upload(uploads: &UploadStore, bytes: &[u8]) -> String {
    match uploads
        .store(
            1,
            Limits::default(),
            "authenticated-peer",
            "sample.txt",
            bytes.to_vec(),
        )
        .await
    {
        Ok(upload) => upload.path,
        Err(failure) => panic!("{}", failure.message),
    }
}

#[tokio::test]
async fn destination_keeps_bytes_after_source_gc_upload_expiry_restart_and_lost_ack_replay() {
    let dir = Dir::new();
    let (now, advance) = clock();
    let bytes = b"the receiver owns these exact file bytes";
    let source = AttachmentStore::with_clock(Some(dir.0.join("source")), now.clone());
    let sha = source.put_now(&Arc::new(bytes.to_vec())).unwrap();
    let uploads = open(&dir.0.join("host"));
    let path = upload(&uploads, bytes).await;
    let original = transfer(path.clone(), bytes);
    let destination_dir = dir.0.join("destination");
    let destination = Arc::new(AttachmentStore::with_clock(
        Some(destination_dir.clone()),
        now.clone(),
    ));
    let ledger_file = dir.0.join("ledger.json");
    let ledger = InboxLedger::with_clock(Some(ledger_file.clone()), now.clone());
    let imported = import(
        original.clone(),
        &HashMap::new(),
        &destination,
        &uploads,
        "authenticated-peer",
        &now,
        &|| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(imported.persistence, Some(Persistence::Disk));
    assert_eq!(
        ledger
            .keep(&original.receiver, &imported.transfer.entries)
            .unwrap()
            .persistence,
        Persistence::Disk
    );
    drop(imported.pin);
    advance.store(1_000_000_000_000_000, Ordering::SeqCst);
    assert_eq!(source.sweep(&HashSet::new()), 1);
    assert!(source.get_now(&sha).is_none());
    assert_eq!(uploads.sweep(1_000_000_000_000_000, 1).await, 1);
    assert!(!PathBuf::from(&path).exists());
    assert_eq!(destination.sweep(&ledger.attachment_shas().unwrap()), 0);
    drop(ledger);
    drop(destination);
    let reopened = InboxLedger::with_clock(Some(ledger_file), now.clone());
    let destination = Arc::new(AttachmentStore::with_clock(
        Some(destination_dir),
        now.clone(),
    ));
    let mut replay = original.clone();
    replay.receiver.instance = "after".into();
    replay.uploads.clear();
    let known = reopened.known(&replay.receiver, &replay.entries).unwrap();
    let replayed = import(
        replay,
        &known,
        &destination,
        &uploads,
        "authenticated-peer",
        &now,
        &|| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(destination.get_now(&sha).unwrap().as_slice(), bytes);
    assert_eq!(
        replayed.transfer.entries[0]
            .attachments
            .as_ref()
            .unwrap()
            .files[0]
            .landed_at,
        1.0
    );
    assert_eq!(
        reopened
            .keep(&replayed.transfer.receiver, &replayed.transfer.entries)
            .unwrap()
            .persistence,
        Persistence::Disk
    );
    assert_eq!(
        reopened
            .pending(&replayed.transfer.receiver)
            .unwrap()
            .1
            .len(),
        1
    );
}

#[tokio::test]
async fn unowned_delivery_cannot_reuse_a_global_blob_to_bypass_upload_ownership() {
    let dir = Dir::new();
    let (now, _) = clock();
    let uploads = open(&dir.0.join("host"));
    let bytes = b"device-owned bytes";
    let path = upload(&uploads, bytes).await;
    let destination = Arc::new(AttachmentStore::new(Some(dir.0.join("destination"))));
    let sha = destination.put_now(&Arc::new(bytes.to_vec())).unwrap();
    let result = import(
        transfer(path.clone(), bytes),
        &HashMap::new(),
        &destination,
        &uploads,
        "different-peer",
        &now,
        &|| Ok(()),
    )
    .await;
    assert!(result.is_err());
    assert!(PathBuf::from(path).exists());
    assert_eq!(destination.get_now(&sha).unwrap().as_slice(), bytes);
}

#[tokio::test]
async fn outside_landing_is_refused_and_no_destination_blob_or_receipt_is_created() {
    let dir = Dir::new();
    let (now, _) = clock();
    let uploads = open(&dir.0.join("host"));
    let bytes = b"not an authorized upload";
    let external = dir.0.join("outside.txt");
    std::fs::write(&external, bytes).unwrap();
    let destination = Arc::new(AttachmentStore::new(Some(dir.0.join("destination"))));
    let result = import(
        transfer(external.to_string_lossy().into_owned(), bytes),
        &HashMap::new(),
        &destination,
        &uploads,
        "authenticated-peer",
        &now,
        &|| Ok(()),
    )
    .await;
    assert!(result.is_err());
    assert!(destination.get_now(&sha256_hex(bytes)).is_none());
    assert_eq!(std::fs::read(external).unwrap(), bytes);
}

#[tokio::test]
async fn failed_blob_write_retains_the_upload_and_cannot_return_an_import_acceptance() {
    let dir = Dir::new();
    let (now, _) = clock();
    let uploads = open(&dir.0.join("host"));
    let bytes = b"retry after storage failure";
    let path = upload(&uploads, bytes).await;
    let destination_dir = dir.0.join("destination");
    std::fs::write(&destination_dir, b"not a directory").unwrap();
    let destination = Arc::new(AttachmentStore::new(Some(destination_dir.clone())));
    assert!(
        import(
            transfer(path.clone(), bytes),
            &HashMap::new(),
            &destination,
            &uploads,
            "authenticated-peer",
            &now,
            &|| Ok(())
        )
        .await
        .is_err()
    );
    assert!(PathBuf::from(&path).exists());
    std::fs::remove_file(destination_dir).unwrap();
    let accepted = import(
        transfer(path, bytes),
        &HashMap::new(),
        &destination,
        &uploads,
        "authenticated-peer",
        &now,
        &|| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(accepted.persistence, Some(Persistence::Disk));
    assert_eq!(
        destination.get_now(&sha256_hex(bytes)).unwrap().as_slice(),
        bytes
    );
}

#[tokio::test]
async fn receiver_fence_change_after_read_prevents_blob_acceptance() {
    let dir = Dir::new();
    let (now, _) = clock();
    let uploads = open(&dir.0.join("host"));
    let bytes = b"do not accept after receiver changed";
    let path = upload(&uploads, bytes).await;
    let destination = Arc::new(AttachmentStore::new(Some(dir.0.join("destination"))));
    let calls = AtomicU64::new(0);
    let fence = || {
        if calls.fetch_add(1, Ordering::SeqCst) < 2 {
            Ok(())
        } else {
            Err("receiver changed".into())
        }
    };
    assert!(
        import(
            transfer(path.clone(), bytes),
            &HashMap::new(),
            &destination,
            &uploads,
            "authenticated-peer",
            &now,
            &fence
        )
        .await
        .is_err()
    );
    assert!(destination.get_now(&sha256_hex(bytes)).is_none());
    assert!(PathBuf::from(path).exists());
}

#[tokio::test]
async fn lost_ack_replay_with_a_new_upload_path_keeps_one_logical_delivery() {
    let dir = Dir::new();
    let (now, _) = clock();
    let uploads = open(&dir.0.join("host"));
    let bytes = b"same source file after lost ACK";
    let first_path = upload(&uploads, bytes).await;
    let second_path = upload(&uploads, bytes).await;
    assert_ne!(first_path, second_path);
    let first = transfer(first_path, bytes);
    let second = transfer(second_path, bytes);
    let store = Arc::new(AttachmentStore::new(Some(dir.0.join("destination"))));
    let ledger = InboxLedger::new(Some(dir.0.join("ledger.json")));
    let accepted = import(
        first.clone(),
        &HashMap::new(),
        &store,
        &uploads,
        "authenticated-peer",
        &now,
        &|| Ok(()),
    )
    .await
    .unwrap();
    ledger
        .keep(&first.receiver, &accepted.transfer.entries)
        .unwrap();
    let known = ledger.known(&second.receiver, &second.entries).unwrap();
    let replay = import(
        second,
        &known,
        &store,
        &uploads,
        "authenticated-peer",
        &now,
        &|| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(
        ledger
            .keep(&replay.transfer.receiver, &replay.transfer.entries)
            .unwrap()
            .persistence,
        Persistence::Disk
    );
    assert_eq!(ledger.pending(&first.receiver).unwrap().1.len(), 1);
    assert_eq!(store.get_now(&sha256_hex(bytes)).unwrap().as_slice(), bytes);
}

#[tokio::test]
async fn failed_ledger_write_never_returns_disk_acceptance_and_pins_imported_bytes_until_recovery()
{
    let dir = Dir::new();
    let (now, advance) = clock();
    let uploads = open(&dir.0.join("host"));
    let bytes = b"blob durable but ledger not yet accepted";
    let incoming = transfer(upload(&uploads, bytes).await, bytes);
    let store = Arc::new(AttachmentStore::with_clock(None, now.clone()));
    let file = dir.0.join("ledger.json");
    let ledger = InboxLedger::new(Some(file.clone()));
    std::fs::create_dir(&file).unwrap();
    let imported = import(
        incoming.clone(),
        &HashMap::new(),
        &store,
        &uploads,
        "authenticated-peer",
        &now,
        &|| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(imported.persistence, Some(Persistence::Memory));
    assert!(
        ledger
            .keep(&incoming.receiver, &imported.transfer.entries)
            .is_err()
    );
    advance.store(2 * 60 * 60 * 1000, Ordering::SeqCst);
    assert_eq!(store.sweep(&HashSet::new()), 0);
    assert!(ledger.pending(&incoming.receiver).is_err());
    std::fs::remove_dir(&file).unwrap();
    assert_eq!(
        ledger
            .keep(&incoming.receiver, &imported.transfer.entries)
            .unwrap()
            .persistence,
        Persistence::Disk
    );
    // Outer acceptance must still be memory: the blob store has no durable folder.
    assert_ne!(imported.persistence, Some(Persistence::Disk));
    assert_eq!(ledger.pending(&incoming.receiver).unwrap().1.len(), 1);
}
