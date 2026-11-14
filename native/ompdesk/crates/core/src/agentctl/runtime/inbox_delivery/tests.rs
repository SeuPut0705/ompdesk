use std::path::PathBuf;

use serde_json::{Value, json};

use super::*;
use crate::agentctl::inbox::{
    InboxAddress, InboxFiles, InboxIntent, InboxLogicalMessage, InboxLogicalPayload, InboxSender,
    NativeInboxEntry, NativeInboxReply, NativeInboxTransferEntry, NativeInboxUpload,
};
use crate::agentctl::journal::attachments::{AttachedSet, AttachmentRef, LandedFile, sha256_hex};
use crate::agentctl::runtime::tests::{rig, told_of};
use crate::agentctl::service::Files;
use crate::web::uploads::Limits;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        Self(crate::fs::disk::make_temp_dir("ompdesk-inbox-fence-").unwrap())
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn receiver() -> InboxReceiver {
    InboxReceiver {
        session_path: "/sample/receiver.jsonl".into(),
        device: None,
        instance: "bridge-context".into(),
    }
}

fn hosted_route() -> InboxRoute {
    InboxRoute {
        peer_device_id: "source-host".into(),
        connection_incarnation: "authenticated-source-connection".into(),
        rtab: "source-peer-view".into(),
        tab_id: "hosted-only".into(),
        session_path: receiver().session_path,
        runtime_instance: "actual-rpc-client".into(),
    }
}

fn snapshot(blocked: bool) -> Value {
    json!({"deviceId":"receiver-host", "enabled":true, "tabs":[], "mailTargets":[{
        "tabId":"hosted-only", "runtimeInstance":"actual-rpc-client", "title":"hosted", "cwd":"/sample", "status":"ready",
        "busy":true, "asks":[], "hidden":false, "sessionPath":receiver().session_path
    }], "inboxRoutes":[hosted_route()], "mailBlocked":if blocked { vec!["hosted-only"] } else { vec![] }})
}

fn transfer(path: String, bytes: &[u8]) -> NativeInboxTransfer {
    let logical = InboxLogicalMessage {
        producer: InboxAddress {
            device_id: "source-host".into(),
            session_path: "/sample/source.jsonl".into(),
        },
        target: InboxAddress {
            device_id: "receiver-host".into(),
            session_path: receiver().session_path,
        },
        request_id: Some("same-native-request".into()),
        intent: InboxIntent::Immediate,
        trigger_turn: true,
        payload: InboxLogicalPayload::Prompt {
            text: "read the original attachment".into(),
        },
    };
    let sha = sha256_hex(bytes);
    NativeInboxTransfer {
        receiver: receiver(),
        entries: vec![NativeInboxTransferEntry {
            entry: NativeInboxEntry {
                delivery_id: logical.delivery_id().unwrap(),
                sender: InboxSender {
                    session: "source-display".into(),
                    device: None,
                },
                intent: InboxIntent::Immediate,
                trigger_turn: true,
                legacy: false,
                payload: InboxPayload::Prompt {
                    content: InboxContent::Text("first d1 presentation".into()),
                },
            },
            logical,
            dispatch: Some(1),
            attachments: Some(AttachedSet {
                images: vec![],
                files: vec![LandedFile {
                    file: AttachmentRef {
                        sha256: sha.clone(),
                        name: "sample.txt".into(),
                        mime_type: "text/plain".into(),
                        size: bytes.len() as u64,
                    },
                    path: path.clone(),
                    landed_at: 1.0,
                }],
            }),
        }],
        uploads: vec![NativeInboxUpload { sha256: sha, path }],
    }
}

fn params(port: u64, transfer: NativeInboxTransfer) -> AcceptParams {
    AcceptParams {
        port,
        tab_id: "hosted-only".into(),
        transfer,
        upload_device_id: "source-host".into(),
        expected_producer_device_id: "source-host".into(),
        expected_runtime_instance: "actual-rpc-client".into(),
        expected_route: Some(hosted_route()),
    }
}

#[tokio::test]
async fn blocked_hosted_snapshot_refuses_before_import_or_keep_then_recovers_the_same_native_id() {
    let dir = Dir::new();
    let ledger = dir.0.join("inbox.json");
    let (control, runtime, told) = rig(
        7_491,
        snapshot(true),
        Files {
            inbox: Some(InboxFiles {
                ledger: ledger.clone(),
                upload_user_data: dir.0.join("user-data"),
            }),
            attachments: Some(dir.0.join("blobs")),
            ..Files::default()
        },
        |method, _| match method {
            "state" => Ok(Value::Null),
            "inboxStatus" => Ok(serde_json::to_value(NativeInboxReply {
                receiver: receiver(),
                entries: vec![],
                receipts: vec![],
            })
            .unwrap()),
            "deliverInbox" => Err("__hold__".into()),
            other => Err(format!("unexpected {other}")),
        },
    );
    let inbox = control.receiving_inbox.as_ref().unwrap();
    let bytes = b"receiver-native attachment";
    let upload = inbox
        .uploads
        .store(
            1,
            Limits::default(),
            "source-host",
            "sample.txt",
            bytes.to_vec(),
        )
        .await
        .unwrap_or_else(|failure| panic!("Upload fixture failed: {}", failure.message));
    let original = transfer(upload.path.clone(), bytes);
    let blocked = runtime
        .accept_inbox(params(7_491, original.clone()))
        .await
        .unwrap_err();
    assert!(blocked.message.contains("being deleted"));
    assert!(told_of(&told, "inboxStatus").is_empty());
    assert!(told_of(&told, "deliverInbox").is_empty());
    assert!(!ledger.exists());
    assert!(inbox.ledger.pending(&receiver()).unwrap().1.is_empty());
    assert!(inbox.store.get_now(&sha256_hex(bytes)).is_none());
    assert_eq!(std::fs::read(&upload.path).unwrap(), bytes);
    crate::ports::apply_state(control.host.port(), 1, &snapshot(false).to_string()).unwrap();
    let accepted = runtime
        .accept_inbox(params(7_491, original.clone()))
        .await
        .unwrap();
    assert_eq!(accepted.persistence, Persistence::Disk);
    assert_eq!(accepted.deliveries[0].key, original.entries[0].entry.key());
    assert_eq!(accepted.deliveries[0].dispatch, Some(1));
    assert_eq!(
        inbox.store.get_now(&sha256_hex(bytes)).unwrap().as_slice(),
        bytes
    );
    let replay = runtime.accept_inbox(params(7_491, original)).await.unwrap();
    assert_eq!(replay, accepted);
    assert_eq!(inbox.ledger.pending(&receiver()).unwrap().1.len(), 1);
    control.host.port().close();
}

#[test]
fn materialization_only_rewrites_renderer_owned_report_attachment_slots() {
    let mut transfer = transfer("/old/authorized/upload".into(), b"bytes");
    let NativeInboxTransferEntry {
        entry, attachments, ..
    } = &mut transfer.entries[0];
    let mut details = serde_json::Map::new();
    details.insert(
        "attachments".into(),
        json!([{"kind":"file","name":"sample.txt","path":"/old/authorized/upload"}]),
    );
    details.insert("originalUserText".into(), "/old/authorized/upload".into());
    details.insert("nested".into(), json!({"path":"/old/authorized/upload"}));
    entry.payload = InboxPayload::Report {
        content: InboxContent::Text("/old/authorized/upload stays literal".into()),
        details,
    };
    let set = attachments.as_mut().unwrap();
    set.files[0].path = "/receiver/content-addressed-file".into();
    materialize_report_details(entry, set).unwrap();
    let InboxPayload::Report { content, details } = &entry.payload else {
        unreachable!()
    };
    assert_eq!(
        details["attachments"][0]["path"],
        "/receiver/content-addressed-file"
    );
    assert_eq!(details["originalUserText"], "/old/authorized/upload");
    assert_eq!(details["nested"]["path"], "/old/authorized/upload");
    assert_eq!(
        content,
        &InboxContent::Text("/old/authorized/upload stays literal".into())
    );
}

mod peer_route;

#[tokio::test]
async fn missing_peer_capture_cannot_keep_and_local_admission_requires_the_local_upload_namespace()
{
    let dir = Dir::new();
    let ledger_file = dir.0.join("inbox.json");
    let (control, runtime, told) = rig(
        7_492,
        snapshot(false),
        Files {
            inbox: Some(InboxFiles {
                ledger: ledger_file.clone(),
                upload_user_data: dir.0.join("user-data"),
            }),
            attachments: Some(dir.0.join("blobs")),
            ..Files::default()
        },
        |method, _| match method {
            "state" => Ok(Value::Null),
            "inboxStatus" => Ok(serde_json::to_value(NativeInboxReply {
                receiver: receiver(),
                entries: vec![],
                receipts: vec![],
            })
            .unwrap()),
            "deliverInbox" => Err("__hold__".into()),
            other => Err(format!("unexpected {other}")),
        },
    );
    let inbox = control.receiving_inbox.as_ref().unwrap();
    let mut input = transfer(String::new(), b"");
    input.entries[0].attachments = None;
    input.uploads.clear();
    let mut missing_capture = params(7_492, input.clone());
    missing_capture.expected_route = None;
    assert!(runtime.accept_inbox(missing_capture).await.is_err());
    assert!(!ledger_file.exists());
    assert!(inbox.ledger.pending(&receiver()).unwrap().1.is_empty());
    assert!(told_of(&told, "deliverInbox").is_empty());

    input.entries[0].logical.producer.device_id = "receiver-host".into();
    input.entries[0].entry.delivery_id = input.entries[0].logical.delivery_id().unwrap();
    let mut local = params(7_492, input);
    local.expected_route = None;
    local.expected_producer_device_id = "receiver-host".into();
    // A local producer identity does not turn a peer-owned upload namespace into a local admission.
    assert!(
        runtime
            .accept_inbox(AcceptParams {
                port: local.port,
                tab_id: local.tab_id.clone(),
                transfer: local.transfer.clone(),
                upload_device_id: local.upload_device_id.clone(),
                expected_producer_device_id: local.expected_producer_device_id.clone(),
                expected_runtime_instance: local.expected_runtime_instance.clone(),
                expected_route: None,
            })
            .await
            .is_err()
    );
    assert!(!ledger_file.exists());
    local.upload_device_id = crate::web::uploads::LOCAL_DEVICE.into();
    let accepted = runtime.accept_inbox(local).await.unwrap();
    assert_eq!(accepted.persistence, Persistence::Disk);
    assert_eq!(inbox.ledger.pending(&receiver()).unwrap().1.len(), 1);
    control.host.port().close();
}
