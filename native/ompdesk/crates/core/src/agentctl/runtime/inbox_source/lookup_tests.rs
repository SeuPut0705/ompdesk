use super::*;
use crate::agentctl::inbox::{InboxContextReceipt, InboxEvidence, InboxKind, InboxReceiver};

fn query() -> NativeInboxLookup {
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
        trigger_turn: true,
        payload: InboxLogicalPayload::Prompt {
            text: "one logical effect".into(),
        },
    };
    NativeInboxLookup {
        receiver: InboxReceiver {
            session_path: "/receiver.jsonl".into(),
            device: None,
            instance: "current".into(),
        },
        entries: vec![NativeInboxLookupEntry {
            key: NativeInboxKey {
                kind: InboxKind::Prompt,
                delivery_id: logical.delivery_id().unwrap(),
            },
            logical,
            attachments: None,
        }],
    }
}

fn observed(query: &NativeInboxLookup) -> NativeInboxLookupReply {
    NativeInboxLookupReply {
        receiver: query.receiver.clone(),
        entries: vec![NativeInboxLookupResult::ExistingContextObserved {
            key: query.entries[0].key.clone(),
            dispatch: Some(1),
            context_receipt: InboxContextReceipt {
                request_id: "actual-old-request".into(),
                session_path: query.receiver.session_path.clone(),
                instance: "old-provider-incarnation".into(),
                ids: vec![query.entries[0].key.provider_id()],
                evidence: InboxEvidence::ContextIdAndProviderOutput,
            },
        }],
    }
}

#[test]
fn lookup_reply_requires_the_exact_authenticated_receiver_and_key_set() {
    let query = query();
    let good = observed(&query);
    validate_lookup_reply(&query, &good).unwrap();
    let mut other_receiver = good.clone();
    other_receiver.receiver.instance = "rebound".into();
    assert!(validate_lookup_reply(&query, &other_receiver).is_err());
    let mut missing = good.clone();
    missing.entries.clear();
    assert!(validate_lookup_reply(&query, &missing).is_err());
    let mut duplicated = good.clone();
    duplicated.entries.push(good.entries[0].clone());
    assert!(validate_lookup_reply(&query, &duplicated).is_err());
    let mut wrong_key = good;
    wrong_key.entries[0] = NativeInboxLookupResult::Missing {
        key: NativeInboxKey {
            kind: InboxKind::Report,
            delivery_id: "another-key".into(),
        },
    };
    assert!(validate_lookup_reply(&query, &wrong_key).is_err());
}

#[test]
fn historical_consumed_proof_requires_its_own_exact_key_path_and_actual_request() {
    let query = query();
    for field in ["ids", "path", "request", "instance"] {
        let mut wrong = observed(&query);
        let NativeInboxLookupResult::ExistingContextObserved {
            context_receipt, ..
        } = &mut wrong.entries[0]
        else {
            unreachable!()
        };
        match field {
            "ids" => {
                context_receipt.ids = vec![
                    NativeInboxKey {
                        kind: InboxKind::Prompt,
                        delivery_id: "another-message".into(),
                    }
                    .provider_id(),
                ]
            }
            "path" => context_receipt.session_path = "/another.jsonl".into(),
            "request" => context_receipt.request_id.clear(),
            "instance" => context_receipt.instance.clear(),
            _ => unreachable!(),
        }
        assert!(validate_lookup_reply(&query, &wrong).is_err(), "{field}");
    }
    validate_lookup_reply(&query, &observed(&query)).unwrap();
}
