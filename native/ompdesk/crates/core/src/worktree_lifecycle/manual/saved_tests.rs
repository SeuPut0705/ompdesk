use super::*;

fn record() -> Record {
    Record { id: "one".into(), path: "/work".into(), repo: "/repo".into(), branch: Some("feature".into()), head: "abc".into(), saved_branch: Some("saved".into()), staged: None, removed_at: 10.0, archived_files: 2, archived_bytes: 12 }
}

#[test]
fn record_uses_saved_json_names_and_preserves_optional_staged() {
    let mut value = serde_json::to_value(record()).unwrap();
    assert_eq!(value["savedBranch"], "saved");
    assert_eq!(value["archivedFiles"], 2);
    assert!(value.get("staged").is_none());
    value["staged"] = json!("staged-sha");
    let loaded: Record = serde_json::from_value(value).unwrap();
    assert_eq!(loaded.staged.as_deref(), Some("staged-sha"));
}

#[test]
fn unreadable_or_invalid_saved_json_is_empty() {
    let root = std::env::temp_dir().join(format!("ompdesk-manual-saved-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("saved.json");
    std::fs::write(&file, b"not json").unwrap();
    let store = SavedStore::new(root.clone());
    assert!(store.list().is_empty());
    std::fs::write(&file, b"{}").unwrap();
    assert!(store.list().is_empty());
    std::fs::write(&file, serde_json::to_vec(&vec![record()]).unwrap()).unwrap();
    assert_eq!(store.list(), vec![record()]);
    std::fs::remove_dir_all(root).unwrap();
}


#[tokio::test]
async fn updates_are_serialized_and_cancelled_updates_do_not_write() {
    let root = std::env::temp_dir().join(format!("ompdesk-manual-saved-update-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store = SavedStore::new(root.clone());
    let first = record();
    store.update(Scope::detached(), move |records| records.push(first)).await.unwrap();
    let stopped = Scope::detached();
    stopped.cancel();
    assert!(store.update(stopped, |records| records.clear()).await.is_err());
    assert_eq!(store.list(), vec![record()]);
    let bytes = std::fs::read(root.join("saved.json")).unwrap();
    assert_eq!(serde_json::from_slice::<Vec<Record>>(&bytes).unwrap(), vec![record()]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(root.join("saved.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn listing_filters_repository_and_sorts_newest_first() {
    let root = std::env::temp_dir().join(format!("ompdesk-manual-saved-list-{}", std::process::id()));
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    crate::git::session_lifecycle::test_support::repo_at(&repo);
    let store = SavedStore::new(root.clone());
    let mut old = record();
    old.repo = repo.to_string_lossy().into_owned();
    let mut new = old.clone();
    new.id = "new".into();
    new.removed_at = 20.0;
    let other = record();
    store.update(Scope::detached(), move |records| records.extend([old, other, new])).await.unwrap();
    let result = list_for_repo(&store, crate::git::run::tests::runner(), Scope::detached(), &repo.to_string_lossy()).await.unwrap();
    assert_eq!(result["worktrees"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), ["new", "one"]);
    let config = prepare::Config { env: Default::default(), supervisor: String::new() };
    let error = restore(&store, crate::git::run::tests::runner(), &config, Scope::detached(), &repo.to_string_lossy(), "missing").await.unwrap_err();
    assert_eq!(error, CommandError::local("not_saved", "No saved worktree missing in this repository."));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn partial_removal_keeps_archive_and_record_but_intact_tree_discards_archive() {
    let root = std::env::temp_dir().join(format!("ompdesk-manual-saved-settle-{}", std::process::id()));
    let worktree = root.join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join(".env"), b"private").unwrap();
    let store = SavedStore::new(root.join("store"));
    let mut saved_record = record();
    saved_record.path = worktree.to_string_lossy().into_owned();
    let archive = store.archive_dir(&saved_record.id);
    let scope = Scope::detached();
    saved::write_archive(&saved_record.path, &[".env".to_owned()], &archive, &[], &scope).unwrap();
    settle(&store, scope.clone(), saved_record.clone(), false).await.unwrap();
    assert!(!Path::new(&archive).exists());
    assert!(store.list().is_empty());
    saved::write_archive(&saved_record.path, &[".env".to_owned()], &archive, &[], &scope).unwrap();
    std::fs::remove_file(worktree.join(".env")).unwrap();
    settle(&store, scope, saved_record.clone(), false).await.unwrap();
    assert!(Path::new(&archive).exists());
    assert_eq!(store.list(), vec![saved_record]);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn restore_recreates_the_checkout_and_private_files_then_forgets_completed_record() {
    use super::super::test_support::{repo, runner, sh};
    let root = repo("restore-private");
    let worktree = root.join("linked");
    let store = SavedStore::new(root.join("private-store"));
    let path = worktree.to_str().unwrap();
    sh(&root, &["worktree", "add", "-b", "restore-private", path]);
    std::fs::write(worktree.join(".env"), "kept-private\n").unwrap();
    let mut entry = record();
    entry.path = path.to_owned();
    entry.repo = root.to_string_lossy().into_owned();
    entry.branch = Some("restore-private".into());
    entry.head = sh(&root, &["rev-parse", "HEAD"]);
    entry.saved_branch = None;
    entry.archived_files = 1;
    saved::write_archive(path, &[".env".into()], &store.archive_dir(&entry.id), &[], &Scope::detached()).unwrap();
    sh(&root, &["worktree", "remove", "--force", path]);
    let stored = entry.clone();
    store.update(Scope::detached(), move |records| records.push(stored)).await.unwrap();
    let config = prepare::Config { env: Default::default(), supervisor: String::new() };
    let result = restore(&store, runner(), &config, Scope::detached(), root.to_str().unwrap(), &entry.id).await.unwrap();
    assert_eq!(result["branch"], "restore-private");
    assert_eq!(result["archive"], json!({"restored":1,"skipped":0}));
    assert_eq!(std::fs::read_to_string(worktree.join(".env")).unwrap(), "kept-private\n");
    assert!(store.list().is_empty());
    assert!(!Path::new(&store.archive_dir(&entry.id)).exists());
    sh(&root, &["worktree", "remove", "--force", path]);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn restore_keeps_the_archive_when_a_checkout_directory_prevents_a_file_restore() {
    use super::super::test_support::{repo, runner, sh};
    let root = repo("restore-skipped");
    std::fs::create_dir(root.join("vault")).unwrap();
    std::fs::write(root.join("vault/README"), "tracked\n").unwrap();
    sh(&root, &["add", "vault"]);
    sh(&root, &["commit", "-qm", "directory at archived path"]);
    let archive_source = root.join("archive-source");
    std::fs::create_dir(&archive_source).unwrap();
    std::fs::write(archive_source.join("vault"), "private-file\n").unwrap();
    let store = SavedStore::new(root.join("private-store"));
    let mut entry = record();
    entry.path = root.join("restored").to_string_lossy().into_owned();
    entry.repo = root.to_string_lossy().into_owned();
    entry.branch = None;
    entry.head = sh(&root, &["rev-parse", "HEAD"]);
    entry.saved_branch = None;
    entry.archived_files = 1;
    saved::write_archive(archive_source.to_str().unwrap(), &["vault".into()], &store.archive_dir(&entry.id), &[], &Scope::detached()).unwrap();
    let stored = entry.clone();
    store.update(Scope::detached(), move |records| records.push(stored)).await.unwrap();
    let config = prepare::Config { env: Default::default(), supervisor: String::new() };
    let result = restore(&store, runner(), &config, Scope::detached(), root.to_str().unwrap(), &entry.id).await.unwrap();
    assert_eq!(result["archive"], json!({"restored":0,"skipped":1}));
    assert_eq!(store.list(), vec![entry.clone()]);
    assert!(Path::new(&store.archive_dir(&entry.id)).exists());
    assert_eq!(std::fs::read_to_string(Path::new(&entry.path).join("vault/README")).unwrap(), "tracked\n");
    sh(&root, &["worktree", "remove", "--force", &entry.path]);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn cancelled_newer_quota_update_preserves_the_prior_record_without_holding_its_request() {
    let root = crate::fs::disk::make_temp_dir("ompdesk-manual-quota-").unwrap();
    let store = SavedStore::new(root.clone());
    let file = root.join("saved.json");
    let quota = saves::test_support::Quota::new(&file);
    let first = record();
    let (scope, exited) = Scope::watched();
    assert!(store.update(scope, move |records| records.push(first)).await.is_err());
    exited.wait().await;
    let newer = Scope::detached();
    assert!(store.update(newer.clone(), |records| records.clear()).await.is_err());
    newer.cancel();
    assert_eq!(store.list(), vec![record()]);
    quota.recover();
    assert_eq!(serde_json::from_slice::<Vec<Record>>(&std::fs::read(&file).unwrap()).unwrap(), vec![record()]);
    drop(quota);
    std::fs::remove_dir_all(root).unwrap();
}