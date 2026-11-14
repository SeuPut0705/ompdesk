use super::run;
use crate::git::run::Git;
use crate::git::scm::tests::repo;
use crate::git::session_lifecycle::test_support::runner;
use crate::server::Scope;
use tokio::sync::oneshot;

#[tokio::test]
async fn dropped_owner_holds_gate_until_git_effect_and_cleanup_finish() {
    let repo = repo("native-repo-gate");
    let primary = repo.to_string_lossy().into_owned();
    let first_primary = primary.clone();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let first = tokio::spawn(async move {
        let cwd = first_primary.clone();
        run(&first_primary, Scope::detached(), move |scope| async move {
            let git = Git::new(runner(), scope.clone());
            git.text(&cwd, &["status", "--porcelain"]).await?;
            let _ = entered_tx.send(());
            scope.on_cancel().await;
            let _ = release_rx.await;
            Err::<(), _>(crate::server::Fault::cancelled())
        })
        .await
    });
    entered_rx.await.unwrap();
    first.abort();
    let (next_tx, mut next_rx) = oneshot::channel();
    let second_primary = primary.clone();
    let second = tokio::spawn(async move {
        run(&second_primary, Scope::detached(), move |_| async move {
            let _ = next_tx.send(());
            Ok(())
        })
        .await
    });
    assert!(matches!(
        next_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    release_tx.send(()).unwrap();
    next_rx.await.unwrap();
    second.await.unwrap().unwrap();
    std::fs::remove_dir_all(repo).unwrap();
}

#[tokio::test]
async fn cancelled_queued_operation_never_runs() {
    let repo = repo("native-repo-queued");
    let primary = repo.to_string_lossy().into_owned();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let first_primary = primary.clone();
    let first = tokio::spawn(async move {
        run(&first_primary, Scope::detached(), move |_| async move {
            let _ = entered_tx.send(());
            let _ = release_rx.await;
            Ok(())
        })
        .await
    });
    entered_rx.await.unwrap();
    let scope = Scope::detached();
    let cancelled = scope.clone();
    let (ran_tx, ran_rx) = oneshot::channel();
    let queued_primary = primary.clone();
    let queued = tokio::spawn(async move {
        run(&queued_primary, scope, move |_| async move {
            let _ = ran_tx.send(());
            Ok(())
        })
        .await
    });
    cancelled.cancel();
    assert!(queued.await.unwrap().is_err());
    release_tx.send(()).unwrap();
    first.await.unwrap().unwrap();
    assert!(ran_rx.await.is_err());
    std::fs::remove_dir_all(repo).unwrap();
}
