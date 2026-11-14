use super::*;

#[test]
fn navigation_revokes_the_previous_owner_and_cancels_only_its_requests() {
    let callers = Callers::new(7);
    let page = NativeCaller::Desktop {
        win_id: 1,
        wc_id: 2,
    };
    let first = callers.admit_page(page.clone()).unwrap();
    let other = callers
        .admit_page(NativeCaller::Desktop {
            win_id: 1,
            wc_id: 3,
        })
        .unwrap();
    let id = RequestId {
        generation: 7,
        id: 10,
    };
    let (previous, _) = callers.begin(&first.owner, id).unwrap();
    let (unrelated, _) = callers
        .begin(
            &other.owner,
            RequestId {
                generation: 7,
                id: 11,
            },
        )
        .unwrap();
    let replacement = callers.admit_page(page.clone()).unwrap();
    assert_ne!(first.owner, replacement.owner);
    assert!(previous.cancelled());
    assert!(!unrelated.cancelled());
    assert!(callers.principal(&first.owner).is_err());
    assert!(
        callers
            .begin(
                &first.owner,
                RequestId {
                    generation: 7,
                    id: 12
                }
            )
            .is_err()
    );
    assert_eq!(callers.page(&page).unwrap().owner, replacement.owner);
    assert!(callers.finish(&first.owner, id));
}

#[test]
fn request_generation_owner_and_duplicate_identity_are_not_page_controlled() {
    let callers = Callers::new(8);
    let first = callers.admit_peer("peer".into(), 1).unwrap();
    let other = callers.admit_peer("other".into(), 2).unwrap();
    let id = RequestId {
        generation: 8,
        id: 1,
    };
    let (scope, _) = callers.begin(&first.owner, id).unwrap();
    assert!(callers.begin(&first.owner, id).is_err());
    assert!(!callers.cancel(&other.owner, id));
    assert!(!callers.finish(&other.owner, id));
    assert!(!scope.cancelled());
    assert!(
        callers
            .begin(
                &first.owner,
                RequestId {
                    generation: 7,
                    id: 2
                }
            )
            .is_err()
    );
    assert!(callers.cancel(&first.owner, id));
    assert!(scope.cancelled());
    assert!(callers.finish(&first.owner, id));
    assert!(!callers.finish(&first.owner, id));
}

#[test]
fn shutdown_is_terminal_and_peers_are_not_forged_web_pages() {
    let callers = Callers::new(9);
    let peer = callers.admit_peer("peer".into(), 42).unwrap();
    assert_eq!(
        peer.principal,
        Principal::Peer {
            device: "peer".into(),
            connection: 42
        }
    );
    let id = RequestId {
        generation: 9,
        id: 1,
    };
    let (work, _) = callers.begin(&peer.owner, id).unwrap();
    assert_eq!(callers.stop().len(), 1);
    assert!(work.cancelled());
    assert!(callers.principal(&peer.owner).is_err());
    assert!(callers.admit_peer("peer".into(), 43).is_err());
    assert!(
        callers
            .admit_page(NativeCaller::Desktop {
                win_id: 1,
                wc_id: 1
            })
            .is_err()
    );
    assert!(callers.finish(&peer.owner, id));
}
