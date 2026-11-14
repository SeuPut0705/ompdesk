use super::*;
use serde_json::json;

fn query(attachments: Option<InboxLogicalAttachments>) -> NativeInboxLookupEntry {
    let logical = InboxLogicalMessage {
        producer: InboxAddress {
            device_id: "source".into(),
            session_path: "/source.jsonl".into(),
        },
        target: InboxAddress {
            device_id: "receiver".into(),
            session_path: "/receiver.jsonl".into(),
        },
        request_id: Some("stable".into()),
        intent: InboxIntent::FollowUp,
        trigger_turn: false,
        payload: InboxLogicalPayload::Prompt {
            text: "Read the retained file".into(),
        },
    };
    NativeInboxLookupEntry {
        key: NativeInboxKey {
            kind: InboxKind::Prompt,
            delivery_id: logical.delivery_id().unwrap(),
        },
        logical,
        attachments,
    }
}

fn file() -> AttachmentRef {
    AttachmentRef {
        sha256: "a".repeat(64),
        name: "report.txt".into(),
        mime_type: "text/plain".into(),
        size: 7,
    }
}

#[test]
fn lookup_uses_the_original_logical_attachment_bytes_without_landing_or_presentation() {
    let lookup = query(Some(InboxLogicalAttachments {
        images: Vec::new(),
        files: vec![file()],
    }));
    let wire = serde_json::to_value(&lookup).unwrap();
    assert_eq!(wire["attachments"]["files"], json!([file().to_json()]));
    assert!(wire.get("entry").is_none());
    assert!(wire.get("dispatch").is_none());
    let decoded: NativeInboxLookupEntry = serde_json::from_value(wire).unwrap();
    decoded
        .logical
        .validate_identity(decoded.key.kind, &decoded.key.delivery_id)
        .unwrap();
    let original = NativeInboxTransferEntry {
        entry: NativeInboxEntry {
            delivery_id: lookup.key.delivery_id.clone(),
            sender: InboxSender {
                session: "display title".into(),
                device: None,
            },
            intent: InboxIntent::FollowUp,
            trigger_turn: false,
            legacy: false,
            payload: InboxPayload::Prompt {
                content: InboxContent::Text("first derived display".into()),
            },
        },
        logical: lookup.logical.clone(),
        dispatch: Some(1),
        attachments: Some(AttachedSet {
            images: Vec::new(),
            files: vec![super::super::journal::attachments::LandedFile {
                file: file(),
                path: "/first/landing".into(),
                landed_at: 1.0,
            }],
        }),
    };
    let expected = json!({
        "producer": {"deviceId":"source","sessionPath":"/source.jsonl"},
        "target": {"deviceId":"receiver","sessionPath":"/receiver.jsonl"},
        "requestId":"stable","intent":"follow_up","triggerTurn":false,
        "payload":{"kind":"prompt","text":"Read the retained file"},
        "attachments":{"images":[],"files":[file().to_json()]},
    });
    assert_eq!(original.logical_payload().unwrap(), expected);
    assert_eq!(decoded.logical_payload().unwrap(), expected);
    let mut rehomed = original;
    let landed = &mut rehomed.attachments.as_mut().unwrap().files[0];
    landed.path = "/different/retry/landing".into();
    landed.landed_at = 99.0;
    rehomed.dispatch = Some(8);
    assert_eq!(rehomed.logical_payload().unwrap(), expected);
    let mut conflict = decoded;
    conflict.attachments.as_mut().unwrap().files[0].name = "different-visible-name.txt".into();
    assert_ne!(conflict.logical_payload().unwrap(), expected);
}

#[test]
fn lookup_preserves_absent_versus_present_empty_logical_attachments() {
    let absent = query(None);
    let empty = query(Some(InboxLogicalAttachments {
        images: Vec::new(),
        files: Vec::new(),
    }));
    let decoded: NativeInboxLookupEntry =
        serde_json::from_value(serde_json::to_value(&empty).unwrap()).unwrap();
    assert!(decoded.attachments.is_some());
    assert_ne!(
        absent.logical_payload().unwrap(),
        decoded.logical_payload().unwrap()
    );
}

#[test]
fn lookup_rejects_invalid_refs_and_a_key_for_a_different_logical_request() {
    let original = query(Some(InboxLogicalAttachments {
        images: Vec::new(),
        files: vec![file()],
    }));
    let mut malformed = serde_json::to_value(&original).unwrap();
    malformed["attachments"]["files"][0]["sha256"] = json!("not-a-content-hash");
    assert!(serde_json::from_value::<NativeInboxLookupEntry>(malformed).is_err());
    let mut wrong = original;
    wrong.key.delivery_id = "another-request".into();
    assert!(
        wrong
            .logical
            .validate_identity(wrong.key.kind, &wrong.key.delivery_id)
            .is_err()
    );
}
