use std::path::PathBuf;

use serde_json::{Map, json};

use super::Persistence;
use super::attachments::AttachedSet;
use super::mail_outbox::{MailOutbox, OutboxMail};
use super::send_outbox::{OutboxSend, SendOutbox, StreamingBehavior};
use crate::agentctl::inbox::{
    InboxAddress, InboxIntent, InboxLogicalMessage, InboxLogicalPayload, InboxLogicalSource,
};
use crate::agentctl::rules::mail::MailDelivery;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        Self(crate::fs::disk::make_temp_dir("ompdesk-inbox-source-").unwrap())
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn logical(payload: InboxLogicalPayload) -> InboxLogicalMessage {
    InboxLogicalMessage {
        producer: InboxAddress {
            device_id: "source-host".into(),
            session_path: "/sample/source.jsonl".into(),
        },
        target: InboxAddress {
            device_id: "target-host".into(),
            session_path: "/sample/target.jsonl".into(),
        },
        request_id: Some("request-one".into()),
        intent: InboxIntent::Immediate,
        trigger_turn: true,
        payload,
    }
}

fn prompt() -> OutboxSend {
    let source = logical(InboxLogicalPayload::Prompt {
        text: "original instruction".into(),
    });
    let mut entry = OutboxSend::new(
        "presentation-mark".into(),
        Some(1),
        source.target.session_path.clone(),
        None,
        source.producer.session_path.clone(),
        "original instruction".into(),
        "first title: d1".into(),
        StreamingBehavior::Steer,
        1.0,
    );
    entry.delivery_id = Some(source.delivery_id().unwrap());
    entry.logical_message = Some(entry.message.clone());
    entry.native_source = InboxLogicalSource::Bound(source);
    entry
}

fn report() -> OutboxMail {
    let source = logical(InboxLogicalPayload::Report {
        text: "original report".into(),
        details: Map::new(),
        instruction: None,
        card: None,
    });
    OutboxMail {
        id: "display-report-id".into(),
        session_path: source.target.session_path.clone(),
        device: None,
        from: Some(source.producer.session_path.clone()),
        from_device: None,
        content: "first report presentation".into(),
        details: json!({"id":"display-report-id","original":{"keep":"unchanged"}}),
        delivery_id: Some(source.delivery_id().unwrap()),
        logical_content: Some("first report presentation".into()),
        native_source: InboxLogicalSource::Bound(source),
        delivery: MailDelivery {
            trigger_turn: true,
            aside: true,
        },
        attachments: None,
        attachments_corrupt: false,
        at: 1.0,
    }
}

#[test]
fn producer_retry_and_restart_preserve_first_prompt_dispatch_and_reject_changed_instructions() {
    let dir = Dir::new();
    let file = dir.0.join("send.json");
    let original = prompt();
    let outbox = SendOutbox::new(Some(file.clone()));
    assert_eq!(outbox.keep(original.clone()).unwrap(), Persistence::Disk);
    let mut retry = original.clone();
    retry.dispatch = Some(2);
    retry.message = "new title: d2".into();
    retry.logical_message = Some(retry.message.clone());
    assert_eq!(outbox.keep(retry.clone()).unwrap(), Persistence::Disk);
    assert_eq!(outbox.pending().as_slice(), std::slice::from_ref(&original));
    drop(outbox);
    let reopened = SendOutbox::new(Some(file));
    let InboxLogicalSource::Bound(source) = &mut retry.native_source else {
        unreachable!()
    };
    source.payload = InboxLogicalPayload::Prompt {
        text: "changed instruction".into(),
    };
    assert!(reopened.keep(retry).is_err());
    assert_eq!(reopened.pending(), [original]);
}

#[test]
fn legacy_report_settlement_and_relanding_cannot_remove_or_mutate_native_source() {
    let outbox = MailOutbox::new(None);
    let original = report();
    assert_eq!(outbox.keep(original.clone()).unwrap(), Persistence::Memory);
    outbox.settle(&original.id);
    outbox.relanded(
        &original.id,
        "wrong legacy body",
        &json!({}),
        &AttachedSet {
            images: Vec::new(),
            files: Vec::new(),
        },
    );
    assert_eq!(outbox.pending().as_slice(), std::slice::from_ref(&original));
    outbox.settle_native(&original);
    assert!(outbox.pending().is_empty());
}

#[test]
fn producer_report_retry_keeps_original_details_and_conflict_does_not_purge_pending() {
    let dir = Dir::new();
    let file = dir.0.join("mail.json");
    let original = report();
    MailOutbox::new(Some(file.clone()))
        .keep(original.clone())
        .unwrap();
    let reopened = MailOutbox::new(Some(file));
    let mut retry = original.clone();
    retry.content = "new display title".into();
    retry.logical_content = Some(retry.content.clone());
    assert_eq!(reopened.keep(retry.clone()).unwrap(), Persistence::Disk);
    let InboxLogicalSource::Bound(source) = &mut retry.native_source else {
        unreachable!()
    };
    if let InboxLogicalPayload::Report { details, .. } = &mut source.payload {
        details.insert("instruction".into(), "changed meaning".into());
    }
    assert!(reopened.keep(retry).is_err());
    assert_eq!(reopened.pending(), [original]);
}

#[test]
fn source_write_failure_is_not_disk_acceptance_and_restart_recovers_the_original_after_retry() {
    let dir = Dir::new();
    let file = dir.0.join("send.json");
    let outbox = SendOutbox::new(Some(file.clone()));
    std::fs::create_dir(&file).unwrap();
    let original = prompt();
    assert!(outbox.keep(original.clone()).is_err());
    assert_eq!(outbox.pending().as_slice(), std::slice::from_ref(&original));
    std::fs::remove_dir(&file).unwrap();
    assert_eq!(outbox.persist_pending().unwrap(), Persistence::Disk);
    assert_eq!(SendOutbox::new(Some(file)).pending(), [original]);
}
