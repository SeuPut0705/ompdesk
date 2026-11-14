use super::*;

fn execution(callers: &Callers, caller: &NativeCaller) -> ompdesk_app_contract::Owner {
    let admitted = callers.admit_page(caller.clone()).unwrap();
    let reservation = callers
        .reserve_execution(&admitted.owner, "tab", 1)
        .unwrap();
    let execution = callers.execution_owner("tab").unwrap();
    callers.finish_execution_reservation(reservation, true);
    execution
}

#[test]
fn a_reopened_window_cannot_admit_creation_from_the_original_gate() {
    let callers = Callers::new(1);
    let caller = NativeCaller::Desktop {
        win_id: 1,
        wc_id: 2,
    };
    let owner = execution(&callers, &caller);
    let window = callers.window(&caller).unwrap();
    callers.close_page(&caller).unwrap();
    callers.admit_page(caller.clone()).unwrap();
    let replacement = callers.window(&caller).unwrap();
    assert_ne!(window, replacement);
    assert_eq!(callers.execution_window(&owner).unwrap(), Some(window));
    let creates = std::cell::Cell::new(0);
    let failure = callers
        .admit_execution(&owner, "tab", Some(window), || {
            creates.set(creates.get() + 1);
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, "window_closed");
    assert_eq!(creates.get(), 0);
    assert!(callers.with_window(window, |_| ()).is_none());
    assert_eq!(callers.execution_owner("tab").unwrap(), owner);
    callers
        .admit_execution(&owner, "tab", None, || Ok(()))
        .unwrap();
    callers.retire_execution(&owner);
    assert!(
        callers
            .admit_execution(&owner, "tab", None, || Ok(()))
            .is_err()
    );
}

#[test]
fn a_new_window_cannot_replace_the_execution_creators_window_at_late_gate_admission() {
    let callers = Callers::new(1);
    let caller = NativeCaller::Desktop {
        win_id: 1,
        wc_id: 1,
    };
    let owner = execution(&callers, &caller);
    callers.close_page(&caller).unwrap();
    callers.admit_page(caller.clone()).unwrap();
    let replacement = callers.window(&caller).unwrap();
    let starts = std::cell::Cell::new(0);
    let admitted = callers.admit_execution(&owner, "tab", Some(replacement), || {
        starts.set(starts.get() + 1);
        Ok(())
    });
    assert!(
        admitted.is_err(),
        "a later page granted creation to the old execution"
    );
    assert_eq!(starts.get(), 0);
}

#[test]
fn shutdown_denies_new_creation_without_losing_existing_cleanup_admission() {
    let callers = Callers::new(1);
    let caller = NativeCaller::Desktop {
        win_id: 1,
        wc_id: 2,
    };
    let owner = execution(&callers, &caller);
    let window = callers.window(&caller).unwrap();
    callers.stop();
    assert!(
        callers
            .admit_execution(&owner, "tab", Some(window), || Ok(()))
            .is_err()
    );
    callers
        .admit_execution(&owner, "tab", None, || Ok(()))
        .unwrap();
    callers.retire_execution(&owner);
    assert!(
        callers
            .admit_execution(&owner, "tab", None, || Ok(()))
            .is_err()
    );
}

#[test]
fn revocation_cannot_split_effect_admission_from_synchronous_enqueue() {
    let callers = std::sync::Arc::new(Callers::new(1));
    let caller = NativeCaller::Desktop {
        win_id: 1,
        wc_id: 2,
    };
    let owner = execution(&callers, &caller);
    let window = callers.window(&caller).unwrap();
    let ordered = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (entered, inside) = std::sync::mpsc::channel();
    let (proceed, wait) = std::sync::mpsc::channel();
    let effect = {
        let callers = std::sync::Arc::clone(&callers);
        let ordered = std::sync::Arc::clone(&ordered);
        std::thread::spawn(move || {
            callers.admit_execution(&owner, "tab", Some(window), || {
                entered.send(()).unwrap();
                wait.recv().unwrap();
                ordered.lock().unwrap().push("enqueued");
                Ok(())
            })
        })
    };
    inside.recv().unwrap();
    let (started, attempting) = std::sync::mpsc::channel();
    let closed = {
        let callers = std::sync::Arc::clone(&callers);
        let ordered = std::sync::Arc::clone(&ordered);
        std::thread::spawn(move || {
            started.send(()).unwrap();
            callers.close_page(&caller).unwrap();
            ordered.lock().unwrap().push("revoked");
        })
    };
    attempting.recv().unwrap();
    proceed.send(()).unwrap();
    effect.join().unwrap().unwrap();
    closed.join().unwrap();
    assert_eq!(*ordered.lock().unwrap(), ["enqueued", "revoked"]);
}
