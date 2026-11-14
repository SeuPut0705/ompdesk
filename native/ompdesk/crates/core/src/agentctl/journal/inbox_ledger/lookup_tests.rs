use super::InboxLedger;
use super::tests::{Dir, entry, receipt, receiver};
use crate::agentctl::inbox::{
    InboxIntent, InboxKind, InboxLogicalAttachments, InboxLogicalPayload, InboxReceiver,
    NativeInboxLookupEntry, NativeInboxLookupResult, NativeInboxTransferEntry,
};
use crate::agentctl::journal::Persistence;

fn lookup(
    ledger: &InboxLedger,
    receiver: &InboxReceiver,
    entry: &NativeInboxTransferEntry,
) -> Result<Vec<NativeInboxLookupResult>, String> {
    let query = NativeInboxLookupEntry {
        key: entry.entry.key(),
        logical: entry.logical.clone(),
        attachments: entry
            .attachments
            .as_ref()
            .map(|set| InboxLogicalAttachments {
                images: set.images.clone(),
                files: set.files.iter().map(|landed| landed.file.clone()).collect(),
            }),
    };
    ledger.lookup(receiver, &[query])
}

#[test]
fn lookup_does_not_admit_and_returns_only_the_first_disk_owned_transport() {
    let dir = Dir::new();
    let target = receiver("current");
    let ledger = InboxLedger::new(Some(dir.file()));
    let mut original = entry("stable", InboxKind::Prompt);
    original.entry.intent = InboxIntent::FollowUp;
    original.dispatch = Some(1);
    let key = original.entry.key();
    assert_eq!(
        lookup(&ledger, &target, &original).unwrap(),
        [NativeInboxLookupResult::Missing { key: key.clone() }]
    );
    let accepted = ledger
        .keep(&target, std::slice::from_ref(&original))
        .unwrap();
    assert_eq!(accepted.persistence, Persistence::Disk);
    assert!(!accepted.deliveries[0].existing);
    let mut retry = original.clone();
    retry.entry.intent = InboxIntent::Immediate;
    retry.dispatch = Some(9);
    assert_eq!(
        lookup(&ledger, &target, &retry).unwrap(),
        [NativeInboxLookupResult::ExistingPending {
            key,
            dispatch: Some(1),
            intent: InboxIntent::FollowUp,
        }]
    );
    assert_eq!(
        ledger.pending(&target).unwrap().1.as_slice(),
        std::slice::from_ref(&original)
    );
    let mut conflict = original.clone();
    if let InboxLogicalPayload::Prompt { text } = &mut conflict.logical.payload {
        *text = "changed instructions".into();
    }
    assert!(lookup(&ledger, &target, &conflict).is_err());
    assert_eq!(ledger.pending(&target).unwrap().1, [original]);
}

#[test]
fn memory_or_failed_save_never_becomes_existing_disk_ownership_through_lookup() {
    let target = receiver("current");
    let original = entry("stable", InboxKind::Report);
    let memory = InboxLedger::new(None);
    assert_eq!(
        memory
            .keep(&target, std::slice::from_ref(&original))
            .unwrap()
            .persistence,
        Persistence::Memory
    );
    assert!(lookup(&memory, &target, &original).is_err());
    assert_eq!(
        memory.pending(&target).unwrap().1.as_slice(),
        std::slice::from_ref(&original)
    );
    let dir = Dir::new();
    let file = dir.file();
    let ledger = InboxLedger::new(Some(file.clone()));
    std::fs::create_dir(&file).unwrap();
    assert!(
        ledger
            .keep(&target, std::slice::from_ref(&original))
            .is_err()
    );
    assert!(lookup(&ledger, &target, &original).is_err());
    std::fs::remove_dir(&file).unwrap();
    assert_eq!(ledger.pending(&target).unwrap().0, Persistence::Disk);
    assert!(matches!(
        lookup(&ledger, &target, &original).unwrap().as_slice(),
        [NativeInboxLookupResult::ExistingPending { .. }]
    ));
}

#[test]
fn old_consumed_rows_return_their_actual_proof_without_inventing_an_intent_or_requeueing() {
    let dir = Dir::new();
    let old = receiver("old-provider-context");
    let original = entry("stable", InboxKind::Report);
    let ledger = InboxLedger::new(Some(dir.file()));
    ledger.keep(&old, std::slice::from_ref(&original)).unwrap();
    let proof = receipt(&old, std::slice::from_ref(&original));
    ledger.reconcile(&old, &proof).unwrap();
    drop(ledger);
    let bytes = std::fs::read(dir.file()).unwrap();
    let reopened = InboxLedger::new(Some(dir.file()));
    let current = receiver("new-provider-context");
    assert_eq!(
        lookup(&reopened, &current, &original).unwrap(),
        [NativeInboxLookupResult::ExistingContextObserved {
            key: original.entry.key(),
            dispatch: original.dispatch,
            context_receipt: proof.receipts[0].clone(),
        }]
    );
    assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
    assert!(reopened.pending(&current).unwrap().1.is_empty());
    let mut conflicting = original;
    if let InboxLogicalPayload::Report { text, .. } = &mut conflicting.logical.payload {
        *text = "different logical report".into();
    }
    assert!(lookup(&reopened, &current, &conflicting).is_err());
}

#[test]
fn an_unreadable_current_disk_file_is_not_replaced_by_a_cached_successful_lookup() {
    let dir = Dir::new();
    let target = receiver("current");
    let original = entry("stable", InboxKind::Report);
    let ledger = InboxLedger::new(Some(dir.file()));
    ledger
        .keep(&target, std::slice::from_ref(&original))
        .unwrap();
    let damaged = b"not a ledger";
    std::fs::write(dir.file(), damaged).unwrap();
    assert!(lookup(&ledger, &target, &original).is_err());
    assert_eq!(std::fs::read(dir.file()).unwrap(), damaged);
}

#[test]
fn existing_empty_attachment_identity_survives_restart_without_becoming_absent() {
    let dir = Dir::new();
    let target = receiver("current");
    let mut original = entry("stable-empty", InboxKind::Report);
    original.attachments = Some(crate::agentctl::journal::attachments::AttachedSet {
        images: Vec::new(),
        files: Vec::new(),
    });
    let ledger = InboxLedger::new(Some(dir.file()));
    ledger
        .keep(&target, std::slice::from_ref(&original))
        .unwrap();
    drop(ledger);
    let before = std::fs::read(dir.file()).unwrap();
    let reopened = InboxLedger::new(Some(dir.file()));
    assert!(matches!(
        lookup(&reopened, &target, &original).unwrap().as_slice(),
        [NativeInboxLookupResult::ExistingPending { .. }]
    ));
    let mut absent = original.clone();
    absent.attachments = None;
    assert!(lookup(&reopened, &target, &absent).is_err());
    assert_eq!(std::fs::read(dir.file()).unwrap(), before);
    assert_eq!(reopened.pending(&target).unwrap().1, [original]);
}
