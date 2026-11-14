use super::*;
use serde_json::json;
use std::sync::mpsc;
use std::thread;

#[test]
fn overlapping_guards_release_only_their_own_deletion() {
    let authority = Arc::new(SessionAuthority::open(None));
    let path = Path::new("/sessions/a.jsonl");
    let first = authority.begin_delete(path, None);
    let second = authority.begin_delete(path, None);
    drop(first);
    assert!(authority.in_progress(path, None));
    assert!(authority.any_in_progress());
    assert_eq!(
        authority.admit(path, None, || ()),
        Err(AdmissionRefusal::Deleting)
    );
    assert!(matches!(second.commit(42.0), Persistence::MemoryOnly));
    drop(second);
    assert!(!authority.any_in_progress());
    assert_eq!(authority.at("/sessions/a.jsonl", None), Some(42.0));
    assert_eq!(
        authority.admit(path, None, || ()),
        Err(AdmissionRefusal::Deleted)
    );
}

#[test]
fn admission_registration_and_delete_start_are_serialized() {
    let authority = Arc::new(SessionAuthority::open(None));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let admitted = Arc::clone(&authority);
    let registration = thread::spawn(move || {
        admitted.admit(Path::new("/sessions/a.jsonl"), None, || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            7
        })
    });
    entered_rx.recv().unwrap();
    let deleting = Arc::clone(&authority);
    let (started_tx, started_rx) = mpsc::channel();
    let deletion = thread::spawn(move || {
        let guard = deleting.begin_delete(Path::new("/sessions/a.jsonl"), None);
        started_tx.send(()).unwrap();
        guard
    });
    assert!(started_rx.try_recv().is_err());
    release_tx.send(()).unwrap();
    assert_eq!(registration.join().unwrap(), Ok(7));
    started_rx.recv().unwrap();
    let guard = deletion.join().unwrap();
    assert_eq!(
        authority.admit(Path::new("/sessions/a.jsonl"), None, || ()),
        Err(AdmissionRefusal::Deleting)
    );
    drop(guard);
    assert_eq!(
        authority.admit(Path::new("/sessions/a.jsonl"), None, || 9),
        Ok(9)
    );
}
#[test]
fn tombstones_prune_the_oldest_and_keep_device_keys_separate() {
    let tombstones = Arc::new(SessionAuthority::open(None));
    for n in 0..2001 {
        tombstones
            .begin_delete(Path::new(&format!("/sessions/{n}.jsonl")), None)
            .commit(n as f64);
    }
    assert!(!tombstones.has(Path::new("/sessions/0.jsonl"), None));
    assert!(tombstones.has(Path::new("/sessions/1.jsonl"), None));
    tombstones
        .begin_delete(Path::new("/sessions/2.jsonl"), Some("other-device"))
        .commit(2002.0);
    assert!(tombstones.has(Path::new("/sessions/2.jsonl"), None));
    assert!(tombstones.has(Path::new("/sessions/2.jsonl"), Some("other-device")));
    assert_eq!(tombstones.list().len(), 2000);
}

#[test]
fn tombstones_keep_loaded_spelling_and_duplicate_order() {
    let dir =
        std::env::temp_dir().join(format!("ompdesk-session-tombstones-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("deleted-sessions.json");
    let first = "relative-session.jsonl";
    let absolute_first = node_resolve(first);
    let replacement = "./relative-session.jsonl";
    std::fs::write(
        &file,
        serde_json::to_vec(&json!([
            {"path": first, "at": 1},
            {"path": "second-session.jsonl", "at": 2},
            {"path": replacement, "at": 3},
            {"path": first, "device": "remote", "at": 4}
        ]))
        .unwrap(),
    )
    .unwrap();

    let tombstones = Arc::new(SessionAuthority::open(Some(file.clone())));
    let loaded = tombstones.list();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded[0].path, replacement);
    assert_eq!(loaded[0].at, 3.0);
    assert_eq!(loaded[1].path, "second-session.jsonl");
    assert_eq!(loaded[2].path, first);
    assert!(tombstones.has(Path::new(&absolute_first), None));
    assert!(tombstones.has(Path::new(first), Some("remote")));
    assert!(!tombstones.has(Path::new(&absolute_first), Some("remote")));

    tombstones.begin_delete(Path::new(first), None).commit(5.0);
    let updated = tombstones.list();
    assert_eq!(updated[0].path, "second-session.jsonl");
    assert_eq!(updated[1].device.as_deref(), Some("remote"));
    assert_eq!(updated[2].path, absolute_first);
    assert_eq!(updated[2].at, 5.0);
    let saved = std::fs::read_to_string(&file).unwrap();
    assert_eq!(
        saved,
        format!(
            "[{{\"path\":\"second-session.jsonl\",\"at\":2.0}},{{\"path\":\"relative-session.jsonl\",\"device\":\"remote\",\"at\":4.0}},{{\"path\":{},\"at\":5.0}}]",
            serde_json::to_string(&absolute_first).unwrap()
        )
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    std::fs::remove_file(file).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

#[test]
fn failed_persistence_keeps_the_committed_tombstone_and_releases_only_the_guard() {
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-session-save-failure-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let parent = dir.join("not-a-directory");
    std::fs::write(&parent, b"existing bytes").unwrap();
    let authority = Arc::new(SessionAuthority::open(Some(
        parent.join("deleted-sessions.json"),
    )));
    let path = Path::new("/sessions/deleted.jsonl");
    let guard = authority.begin_delete(path, None);
    assert!(matches!(guard.commit(23.0), Persistence::Failed(_)));
    assert!(authority.in_progress(path, None));
    assert_eq!(authority.read(path, None).unwrap().at, 23.0);
    drop(guard);
    assert!(!authority.in_progress(path, None));
    assert_eq!(
        authority.admit(path, None, || ()),
        Err(AdmissionRefusal::Deleted)
    );
    assert_eq!(std::fs::read(&parent).unwrap(), b"existing bytes");
    std::fs::remove_file(parent).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
