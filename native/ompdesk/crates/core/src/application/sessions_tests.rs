use super::*;
use crate::server::Events;
use crate::stock::native::{Config, LaunchCommand, Launcher, WorkerKind};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

struct FixtureLauncher {
    entered: Notify,
    release: Notify,
    attempts: AtomicUsize,
}

impl Launcher for FixtureLauncher {
    fn launch(
        &self,
        _: WorkerKind,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchCommand, Fault>> + Send + '_>> {
        Box::pin(async move {
            let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            self.release.notified().await;
            if attempt == 0 {
                return Err(Fault::new("fixture", "first launch failed"));
            }
            Ok(LaunchCommand {
                bin: "/bin/sh".into(),
                args: vec!["-c".into(), r#"while IFS= read -r line; do case "$line" in *'"id":'*) id=${line#*'"id":'}; id=${id%%,*}; printf '{"id":%s,"result":[]}\n' "$id";; esac; done"#.into()],
                env: BTreeMap::new(),
                stamp_file: None,
            })
        })
    }
}

fn index() -> (Arc<SessionIndex>, Arc<FixtureLauncher>) {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    let launcher = Arc::new(FixtureLauncher {
        entered: Notify::new(),
        release: Notify::new(),
        attempts: AtomicUsize::new(0),
    });
    let (events, _, _) = Events::capture();
    let stock = Arc::new(Stock::new(
        Config {
            host: format!("index-test-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
            events,
        },
        launcher.clone(),
    ));
    let index = SessionIndex::new(
        stock,
        PathBuf::from("/synthetic/sessions"),
        PathBuf::from("/project/a"),
        Arc::new(SessionAuthority::open(None)),
        PathBuf::from("/synthetic/no-kinds.json"),
    );
    {
        let mut state = lock(&index.state);
        state.started = true;
        state.watching = true;
    }
    (index, launcher)
}

fn row(path: &str, cwd: &str) -> Row {
    Row::parse(json!({"path":path,"id":path,"cwd":cwd,"modified":"2026-01-01T00:00:00Z"})).unwrap()
}

#[tokio::test]
async fn local_windows_use_their_own_project_and_shared_tombstones() {
    let (index, _) = index();
    index.publish(
        vec![
            row("/synthetic/sessions/a.jsonl", "/project/a"),
            row("/synthetic/sessions/b.jsonl", "/project/b"),
        ],
        Some(0),
    );
    assert_eq!(
        index
            .list(true, Some(Path::new("/project/b")))
            .await
            .unwrap()[0]
            .path(),
        "/synthetic/sessions/b.jsonl"
    );
    index
        .tombstones
        .begin_delete(Path::new("/synthetic/sessions/b.jsonl"), None)
        .commit(1.0);
    assert!(
        index
            .list(true, Some(Path::new("/project/b")))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(index.list(false, None).await.unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn failed_read_does_not_poison_the_next_read() {
    let (index, launcher) = index();
    let reader = tokio::spawn({
        let index = index.clone();
        async move { index.current().await }
    });
    launcher.entered.notified().await;
    let other = tokio::spawn({
        let index = index.clone();
        async move { index.current().await }
    });
    tokio::task::yield_now().await;
    launcher.release.notify_one();
    assert!(reader.await.unwrap().is_err());
    assert!(other.await.unwrap().is_err());
    assert_eq!(launcher.attempts.load(Ordering::SeqCst), 1);
    let reader = tokio::spawn({
        let index = index.clone();
        async move { index.current().await }
    });
    launcher.entered.notified().await;
    launcher.release.notify_one();
    assert!(reader.await.unwrap().unwrap().sessions.is_empty());
    index.stock.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn invalidation_during_a_shared_read_is_not_marked_fresh() {
    let (index, launcher) = index();
    launcher.attempts.store(1, Ordering::SeqCst);
    let first = tokio::spawn({
        let index = index.clone();
        async move { index.current().await }
    });
    launcher.entered.notified().await;
    let same_generation = tokio::spawn({
        let index = index.clone();
        async move { index.current().await }
    });
    tokio::task::yield_now().await;
    index.stale();
    let after_change = tokio::spawn({
        let index = index.clone();
        async move { index.current().await }
    });
    tokio::task::yield_now().await;
    launcher.release.notify_one();
    let first = first.await.unwrap().unwrap();
    let same_generation = same_generation.await.unwrap().unwrap();
    let after_change = after_change.await.unwrap().unwrap();
    assert_eq!(first.version, same_generation.version);
    assert_eq!(first.version, after_change.version);
    assert_eq!(lock(&index.state).copy_generation, Some(1));
    assert_eq!(launcher.attempts.load(Ordering::SeqCst), 2);
    index.stock.close().await.unwrap();
}

#[tokio::test]
async fn setting_a_copy_does_not_clear_staleness() {
    let (index, _) = index();
    index.publish(
        vec![row("/synthetic/sessions/a.jsonl", "/project/a")],
        Some(0),
    );
    index.stale();
    index.set(Vec::new());
    let state = lock(&index.state);
    assert_eq!(state.generation, 1);
    assert_eq!(state.copy_generation, Some(0));
    assert!(state.copy.as_ref().unwrap().sessions.is_empty());
}

#[tokio::test(start_paused = true)]
async fn warmup_invalidates_only_a_live_watch() {
    let (index, _) = index();
    index.publish(Vec::new(), Some(0));
    let lifecycle = lock(&index.state).lifecycle;
    index.watch_report(lifecycle, NativeReport::Watching { missed: false });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert_eq!(lock(&index.state).generation, 1);
    index.watch_report(lifecycle, NativeReport::Watching { missed: false });
    index.stop();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert_eq!(lock(&index.state).generation, 1);
}

#[test]
fn target_validation_preserves_existing_confinement() {
    let (index, _) = index();
    assert_eq!(
        index
            .validate_target(Path::new("/synthetic/sessions/folder/../a.jsonl"))
            .unwrap(),
        PathBuf::from("/synthetic/sessions/a.jsonl")
    );
    for path in [
        "/synthetic/sessions",
        "/synthetic/sessions/../other/a.jsonl",
        "/synthetic/sessions/a.txt",
    ] {
        assert_eq!(
            index.validate_target(Path::new(path)).unwrap_err().code,
            "invalid_session_path"
        );
    }
}

#[tokio::test]
async fn invalidation_and_notification_are_separate() {
    let (index, _) = index();
    let mut paths = index.subscribe_paths();
    let mut changes = index.subscribe();
    index.invalidate_paths(&[PathBuf::from("/synthetic/sessions/a.jsonl")]);
    assert!(matches!(
        paths.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    index.notify_mutation();
    assert_eq!(paths.try_recv().unwrap(), None);
    assert!(changes.try_recv().unwrap().is_none());
    assert!(matches!(
        paths.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

struct JoinedIndexLauncher(std::net::SocketAddr);

impl Launcher for JoinedIndexLauncher {
    fn launch(
        &self,
        _: WorkerKind,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchCommand, Fault>> + Send + '_>> {
        Box::pin(async move {
            Ok(LaunchCommand {
                bin: std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                args: vec![
                    "--exact".into(),
                    "stock::native::tests::joined_worker_fixture".into(),
                    "--nocapture".into(),
                ],
                env: BTreeMap::from([("OMPDESK_JOINED_WORKER".into(), self.0.to_string())]),
                stamp_file: None,
            })
        })
    }
}

#[cfg(unix)]
#[tokio::test]
async fn stored_delete_retains_scope_after_cancellation_and_drop() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (events, _, _) = Events::capture();
    let stock = Arc::new(Stock::new(
        Config {
            host: format!("index-joined-{}", listener.local_addr().unwrap()),
            events,
        },
        Arc::new(JoinedIndexLauncher(listener.local_addr().unwrap())),
    ));
    let index = SessionIndex::new(
        stock.clone(),
        "/synthetic/sessions".into(),
        "/project".into(),
        Arc::new(SessionAuthority::open(None)),
        "/synthetic/no-kinds.json".into(),
    );
    let mut paths = index.subscribe_paths();
    for cancel in [true, false] {
        let (scope, gone) = Scope::watched();
        let task = tokio::spawn({
            let index = index.clone();
            let scope = scope.clone();
            async move {
                index
                    .delete_stored(Path::new("/synthetic/sessions/a.jsonl"), scope)
                    .await
            }
        });
        let (mut control, _) = listener.accept().await.unwrap();
        let mut started = [0; 7];
        control.read_exact(&mut started).await.unwrap();
        assert_eq!(&started, b"started");
        if cancel {
            scope.cancel();
        } else {
            task.abort();
        }
        drop(scope);
        let mut withdrawn = [0; 6];
        control.read_exact(&mut withdrawn).await.unwrap();
        assert_eq!(&withdrawn, b"cancel");
        let mut gone = Box::pin(gone.wait());
        let pending =
            std::future::poll_fn(|cx| std::task::Poll::Ready(gone.as_mut().poll(cx).is_pending()))
                .await;
        assert!(pending);
        control.write_all(b"r").await.unwrap();
        if cancel {
            assert_eq!(task.await.unwrap().unwrap_err().code, "cancelled");
        } else {
            assert!(task.await.unwrap_err().is_cancelled());
        }
        gone.await;
        assert!(matches!(
            paths.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        stock.stop().await.unwrap();
    }
    stock.close().await.unwrap();
}
