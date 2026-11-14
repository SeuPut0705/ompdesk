use super::*;

fn page(callers: &Callers, win_id: u64) -> super::super::Admitted {
    callers
        .admit_page(NativeCaller::Desktop {
            win_id,
            wc_id: win_id + 100,
        })
        .unwrap()
}

#[test]
fn refused_overlapping_acquisitions_release_only_their_provisional_identity() {
    let callers = Callers::new(1);
    let creator = page(&callers, 1);
    let viewer = page(&callers, 2);
    let first = callers.reserve_execution(&creator.owner, "tab", 1).unwrap();
    let original = callers.execution_owner("tab").unwrap();
    let second = callers.reserve_execution(&viewer.owner, "tab", 2).unwrap();
    callers.finish_execution_reservation(first, false);
    assert_eq!(callers.execution_owner("tab").unwrap(), original);
    callers.finish_execution_reservation(second, false);
    assert!(callers.execution_owner("tab").is_err());
    assert!(callers.execution_facts(&original).is_none());
    let replacement = callers.reserve_execution(&creator.owner, "tab", 1).unwrap();
    assert_ne!(callers.execution_owner("tab").unwrap(), original);
    callers.finish_execution_reservation(replacement, false);
}

#[test]
fn one_success_keeps_the_original_creator_not_the_latest_viewer() {
    let callers = Callers::new(1);
    let creator = page(&callers, 1);
    let viewer = page(&callers, 2);
    let first = callers.reserve_execution(&creator.owner, "tab", 1).unwrap();
    let original = callers.execution_owner("tab").unwrap();
    let second = callers.reserve_execution(&viewer.owner, "tab", 2).unwrap();
    callers.finish_execution_reservation(first, false);
    callers.finish_execution_reservation(second, true);
    let facts = callers.execution_facts(&original).unwrap();
    assert_eq!(facts.window, 1);
    assert_eq!(facts.creator, creator.principal);
    assert!(!callers.finish_execution_retirement(&original));
    callers.close_page(&NativeCaller::Desktop {
        win_id: 1,
        wc_id: 101,
    });
    assert_eq!(callers.execution_owner("tab").unwrap(), original);
    assert!(callers.principal(&creator.owner).is_err());
    assert!(
        callers.principal(&original).is_err(),
        "execution identity is not a page grant"
    );
    assert!(callers.retire_execution(&original));
    assert!(callers.execution_owner("tab").is_err());
    assert!(callers.execution_facts(&original).is_some());
    assert!(callers.finish_execution_retirement(&original));
    assert!(callers.execution_facts(&original).is_none());
}

#[test]
fn cancellation_after_factory_success_retains_the_exact_handle_until_exit() {
    let callers = Callers::new(1);
    let creator = page(&callers, 1);
    let reservation = callers.reserve_execution(&creator.owner, "tab", 1).unwrap();
    let original = callers.execution_owner("tab").unwrap();
    callers.keep_execution(&original).unwrap();
    callers.revoke(&creator.owner);
    callers.finish_execution_reservation(reservation, false);
    assert_eq!(callers.execution_owner("tab").unwrap(), original);
    callers.retire_execution(&original);
    assert!(callers.keep_execution(&original).is_err());
    assert!(callers.execution_facts(&original).is_some());
    callers.finish_execution_retirement(&original);
    assert!(callers.execution_facts(&original).is_none());
}

#[test]
fn an_old_receipt_or_reservation_cannot_erase_a_replacement_execution() {
    let callers = Callers::new(1);
    let creator = page(&callers, 1);
    let stale = callers.reserve_execution(&creator.owner, "tab", 1).unwrap();
    let old = callers.execution_owner("tab").unwrap();
    callers.keep_execution(&old).unwrap();
    callers.retire_execution(&old);
    let next = callers.reserve_execution(&creator.owner, "tab", 1).unwrap();
    let replacement = callers.execution_owner("tab").unwrap();
    assert_ne!(old, replacement);
    callers.keep_execution(&replacement).unwrap();
    callers.finish_execution_reservation(next, true);
    callers.finish_execution_reservation(stale, false);
    assert!(callers.finish_execution_retirement(&old));
    assert!(!callers.finish_execution_retirement(&old));
    assert_eq!(callers.execution_owner("tab").unwrap(), replacement);
    assert!(callers.execution_facts(&replacement).is_some());
}

#[test]
fn revoked_or_foreign_window_callers_never_mint_an_execution() {
    let callers = Callers::new(1);
    let creator = page(&callers, 1);
    assert!(callers.reserve_execution(&creator.owner, "tab", 2).is_err());
    assert!(callers.execution_owner("tab").is_err());
    callers.revoke(&creator.owner);
    assert!(callers.reserve_execution(&creator.owner, "tab", 1).is_err());
    assert!(callers.execution_owner("tab").is_err());
}

#[test]
fn shutdown_refuses_new_work_but_keeps_retirement_metadata_until_reaped() {
    let callers = Callers::new(1);
    let creator = page(&callers, 1);
    let reservation = callers.reserve_execution(&creator.owner, "tab", 1).unwrap();
    let owner = callers.execution_owner("tab").unwrap();
    callers.keep_execution(&owner).unwrap();
    callers.finish_execution_reservation(reservation, true);
    callers.stop();
    assert!(
        callers
            .reserve_execution(&creator.owner, "other", 1)
            .is_err()
    );
    assert!(callers.keep_execution(&owner).is_err());
    assert!(callers.execution_owner("tab").is_err());
    assert_eq!(callers.execution_facts(&owner).unwrap().tab, "tab");
    callers.retire_execution(&owner);
    assert!(callers.finish_execution_retirement(&owner));
    assert!(callers.execution_facts(&owner).is_none());
}
