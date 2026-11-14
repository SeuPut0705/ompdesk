use std::sync::{Arc, Barrier};

use super::InboxLedger;
use super::tests::{Dir, entry, receipt, receiver};
use crate::agentctl::inbox::{
    InboxContent, InboxIntent, InboxKind, InboxLogicalPayload, InboxPayload,
    NativeInboxTransferEntry,
};
use crate::agentctl::journal::Persistence;

fn request() -> NativeInboxTransferEntry {
    let mut request = entry("temporary", InboxKind::Prompt);
    request.logical.request_id = Some("same-request".into());
    request.entry.delivery_id = request.logical.delivery_id().unwrap();
    request.entry.payload = InboxPayload::Prompt {
        content: InboxContent::Text("first display name; d1".into()),
    };
    request
}

#[test]
fn retry_after_source_removal_and_receiver_restart_returns_first_dispatch_without_requeue() {
    let dir = Dir::new();
    let before = receiver("before");
    let ledger = InboxLedger::new(Some(dir.file()));
    let original = request();
    let first = ledger
        .keep(&before, std::slice::from_ref(&original))
        .unwrap();
    assert_eq!(first.persistence, Persistence::Disk);
    assert_eq!(first.deliveries[0].dispatch, Some(1));
    assert!(!first.deliveries[0].existing);
    let mut retry = original.clone();
    retry.dispatch = Some(2);
    retry.entry.sender.session = "changed display sender".into();
    retry.entry.payload = InboxPayload::Prompt {
        content: InboxContent::Text("changed display name; d2".into()),
    };
    let duplicate = ledger.keep(&before, &[retry.clone()]).unwrap();
    assert_eq!(duplicate.persistence, Persistence::Disk);
    assert_eq!(duplicate.deliveries[0].key, first.deliveries[0].key);
    assert_eq!(
        duplicate.deliveries[0].dispatch,
        first.deliveries[0].dispatch
    );
    assert!(duplicate.deliveries[0].existing);
    assert_eq!(
        ledger.pending(&before).unwrap().1.as_slice(),
        std::slice::from_ref(&original)
    );
    ledger
        .reconcile(&before, &receipt(&before, &[original]))
        .unwrap();
    drop(ledger);
    // No producer-side terminal journal or retained sender outbox is needed for the receiver's answer.
    let reopened = InboxLedger::new(Some(dir.file()));
    let after = receiver("after");
    let accepted = reopened.keep(&after, &[retry]).unwrap();
    assert_eq!(accepted.persistence, Persistence::Disk);
    assert_eq!(accepted.deliveries[0].key, first.deliveries[0].key);
    assert_eq!(
        accepted.deliveries[0].dispatch,
        first.deliveries[0].dispatch
    );
    assert!(accepted.deliveries[0].existing);
    assert!(reopened.pending(&after).unwrap().1.is_empty());
}

#[test]
fn concurrent_retries_keep_one_first_presentation_and_return_its_dispatch_to_every_caller() {
    let dir = Dir::new();
    let ledger = Arc::new(InboxLedger::new(Some(dir.file())));
    let gate = Arc::new(Barrier::new(3));
    let threads: Vec<_> = (1..=2)
        .map(|dispatch| {
            let ledger = ledger.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                let mut request = request();
                request.dispatch = Some(dispatch);
                request.entry.payload = InboxPayload::Prompt {
                    content: InboxContent::Text(format!("presentation d{dispatch}")),
                };
                gate.wait();
                ledger.keep(&receiver("current"), &[request]).unwrap()
            })
        })
        .collect();
    gate.wait();
    let accepted: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(accepted[0].persistence, Persistence::Disk);
    assert_eq!(accepted[1].persistence, Persistence::Disk);
    assert_eq!(accepted[0].deliveries[0].key, accepted[1].deliveries[0].key);
    assert_eq!(
        accepted[0].deliveries[0].dispatch,
        accepted[1].deliveries[0].dispatch
    );
    assert_ne!(
        accepted[0].deliveries[0].existing,
        accepted[1].deliveries[0].existing
    );
    let pending = ledger.pending(&receiver("current")).unwrap().1;
    let dispatch = accepted[0].deliveries[0].dispatch.unwrap();
    assert_eq!(
        pending,
        [{
            let mut expected = request();
            expected.dispatch = Some(dispatch);
            expected.entry.payload = InboxPayload::Prompt {
                content: InboxContent::Text(format!("presentation d{dispatch}")),
            };
            expected
        }]
    );
}

#[test]
fn changed_logical_body_or_explicit_follow_up_conflicts_before_new_batch_members_are_accepted() {
    let ledger = InboxLedger::new(None);
    let receiver = receiver("current");
    let original = request();
    ledger
        .keep(&receiver, std::slice::from_ref(&original))
        .unwrap();
    let mut changed = original.clone();
    if let InboxLogicalPayload::Prompt { text } = &mut changed.logical.payload {
        *text = "different actual instructions".into();
    }
    assert!(
        ledger
            .keep(&receiver, &[entry("new", InboxKind::Prompt), changed])
            .is_err()
    );
    let mut follow_up = original.clone();
    follow_up.logical.intent = InboxIntent::FollowUp;
    follow_up.entry.intent = InboxIntent::FollowUp;
    assert!(ledger.keep(&receiver, &[follow_up]).is_err());
    assert_eq!(ledger.pending(&receiver).unwrap().1, [original]);
}

#[test]
fn explicit_follow_up_and_original_question_contract_survive_replay_and_restart() {
    let dir = Dir::new();
    let receiver = receiver("current");
    let mut original = entry("question", InboxKind::Report);
    original.logical.intent = InboxIntent::FollowUp;
    original.entry.intent = InboxIntent::FollowUp;
    if let InboxLogicalPayload::Report {
        instruction, card, ..
    } = &mut original.logical.payload
    {
        *instruction = Some("Never guess approval".into());
        *card = Some("approval-card-id".into());
    }
    InboxLedger::new(Some(dir.file()))
        .keep(&receiver, &[original.clone()])
        .unwrap();
    let reopened = InboxLedger::new(Some(dir.file()));
    reopened.keep(&receiver, &[original.clone()]).unwrap();
    assert_eq!(reopened.pending(&receiver).unwrap().1, [original.clone()]);
    if let InboxLogicalPayload::Report { card, .. } = &mut original.logical.payload {
        *card = Some("different-card".into());
    }
    assert!(reopened.keep(&receiver, &[original]).is_err());
}

#[test]
fn identical_request_ids_from_different_authenticated_producers_are_not_the_same_work() {
    let first = request();
    let mut second = first.clone();
    second.logical.producer.device_id = "other-source-host".into();
    second.entry.delivery_id = second.logical.delivery_id().unwrap();
    let ledger = InboxLedger::new(None);
    let receiver = receiver("current");
    ledger
        .keep(&receiver, &[first.clone(), second.clone()])
        .unwrap();
    assert_eq!(ledger.pending(&receiver).unwrap().1, [first, second]);
}
