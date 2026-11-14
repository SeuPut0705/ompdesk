use super::{Service, Worktree, test_support};
use crate::server::Scope;

#[tokio::test]
async fn snapshot_tracks_dirty_files_and_missing_checkout() {
    let repo = crate::git::scm::tests::repo("session-lifecycle-snapshot");
    let root = repo.join("trees");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("session");
    let base = test_support::sh(&repo, &["rev-parse", "HEAD"]);
    test_support::sh(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "session-test",
            path.to_str().unwrap(),
            "HEAD",
        ],
    );
    let worktree = Worktree {
        path: path.to_string_lossy().into_owned(),
        branch: "session-test".into(),
        source_cwd: repo.to_string_lossy().into_owned(),
        base_commit: base,
        root: root.to_string_lossy().into_owned(),
    };
    let service = Service::new(test_support::runner(), Scope::detached());
    let clean = service.inspect(&worktree).await.unwrap();
    assert!(clean.present);
    assert!(!clean.state.dirty && !clean.state.moved && !clean.state.off_branch);
    std::fs::write(path.join("new-file"), "change").unwrap();
    let dirty = service.inspect(&worktree).await.unwrap();
    assert!(dirty.state.dirty);
    assert_ne!(clean.fingerprint, dirty.fingerprint);
    test_support::sh(
        &repo,
        &["worktree", "remove", "--force", path.to_str().unwrap()],
    );
    let missing = service.inspect(&worktree).await.unwrap();
    assert!(!missing.present);
    std::fs::remove_dir_all(repo).unwrap();
}

#[tokio::test]
async fn removes_linked_worktree_and_refuses_outside_root() {
    let repo = crate::git::scm::tests::repo("session-lifecycle-remove");
    let root = repo.join("trees");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("session");
    let base = test_support::sh(&repo, &["rev-parse", "HEAD"]);
    test_support::sh(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "session-remove",
            path.to_str().unwrap(),
            "HEAD",
        ],
    );
    let mut worktree = Worktree {
        path: path.to_string_lossy().into_owned(),
        branch: "session-remove".into(),
        source_cwd: repo.to_string_lossy().into_owned(),
        base_commit: base,
        root: repo.join("wrong-root").to_string_lossy().into_owned(),
    };
    let service = Service::new(test_support::runner(), Scope::detached());
    assert_eq!(
        service.remove(&worktree, false).await.unwrap_err().code,
        "worktree_outside_root"
    );
    assert!(path.exists());
    worktree.root = root.to_string_lossy().into_owned();
    let mut main_checkout = worktree.clone();
    main_checkout.path = repo.to_string_lossy().into_owned();
    main_checkout.root = repo.parent().unwrap().to_string_lossy().into_owned();
    assert!(service.remove(&main_checkout, false).await.is_err());
    assert!(repo.join("README.md").exists());
    service.remove(&worktree, false).await.unwrap();
    assert!(!path.exists());
    assert!(test_support::sh(&repo, &["branch", "--list", "session-remove"]).is_empty());
    std::fs::remove_dir_all(repo).unwrap();
}
