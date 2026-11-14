use super::*;
use super::super::{checkout::tests::session, test_support::{repo, runner, sh}};

#[tokio::test]
async fn listing_excludes_open_descendants_and_reports_dirty_gui_worktrees() {
    let repo = repo("orphan-open");
    let managed = repo.join("managed");
    std::fs::create_dir(&managed).unwrap();
    let target = managed.join("gui-topic-123abcd");
    sh(&repo, &["worktree", "add", "-b", "topic", target.to_str().unwrap()]);
    let session = session(&managed, &repo);
    let primary = repo.to_str().unwrap();
    let initial = listing(&session, runner(), Scope::detached(), primary, Vec::new(), None).await.unwrap();
    assert_eq!(initial.worktrees.len(), 1);
    assert!(matches!(initial.worktrees[0].state, orphans::State::Untouched));
    let open = Folder::resolve(target.join("src").to_string_lossy().into_owned()).await.unwrap();
    let in_use = listing(&session, runner(), Scope::detached(), primary, vec![open], None).await.unwrap();
    assert!(in_use.worktrees.is_empty());
    assert_eq!(in_use.in_use, vec![disk::spelled(&std::fs::canonicalize(&target).unwrap())]);
    std::fs::write(target.join("README.md"), "modified\n").unwrap();
    let dirty = listing(&session, runner(), Scope::detached(), primary, Vec::new(), None).await.unwrap();
    assert!(matches!(dirty.worktrees[0].state, orphans::State::Dirty));
    assert_eq!(dirty.worktrees[0].dirty_files, 1);
    sh(&repo, &["worktree", "remove", "--force", target.to_str().unwrap()]);
    std::fs::remove_dir_all(repo).unwrap();
}

#[tokio::test]
async fn listing_never_offers_an_arbitrary_linked_checkout_or_the_primary_clone() {
    let repo = repo("orphan-root");
    let managed = repo.join("managed");
    std::fs::create_dir(&managed).unwrap();
    let not_gui = managed.join("user-worktree");
    let outside = repo.join("gui-outside-123abcd");
    sh(&repo, &["worktree", "add", "-b", "user", not_gui.to_str().unwrap()]);
    sh(&repo, &["worktree", "add", "-b", "outside", outside.to_str().unwrap()]);
    let session = session(&managed, &repo);
    let found = listing(&session, runner(), Scope::detached(), repo.to_str().unwrap(), Vec::new(), None).await.unwrap();
    assert!(found.worktrees.is_empty());
    sh(&repo, &["worktree", "remove", not_gui.to_str().unwrap()]);
    sh(&repo, &["worktree", "remove", outside.to_str().unwrap()]);
    std::fs::remove_dir_all(repo).unwrap();
}
