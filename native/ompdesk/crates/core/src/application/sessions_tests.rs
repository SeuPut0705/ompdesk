use super::*;
use crate::server::Events;
use crate::stock::native::{Config, LaunchCommand, Launcher, WorkerKind};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

#[test]
fn tombstones_prune_the_oldest_and_keep_device_keys_separate() {
    let tombstones = Tombstones::open(None);
    for n in 0..2001 {
        tombstones
            .add(&format!("/sessions/{n}.jsonl"), None, n as f64)
            .unwrap();
    }
    assert!(!tombstones.has(Path::new("/sessions/0.jsonl"), None));
    assert!(tombstones.has(Path::new("/sessions/1.jsonl"), None));
    tombstones
        .add("/sessions/2.jsonl", Some("other-device"), 2002.0)
        .unwrap();
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
    let absolute_first = absolute(Path::new(first)).to_string_lossy().into_owned();
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

    let tombstones = Tombstones::open(Some(file.clone()));
    let loaded = tombstones.list();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded[0].path, replacement);
    assert_eq!(loaded[0].at, 3.0);
    assert_eq!(loaded[1].path, "second-session.jsonl");
    assert_eq!(loaded[2].path, first);
    assert!(tombstones.has(Path::new(&absolute_first), None));
    assert!(tombstones.has(Path::new(first), Some("remote")));
    assert!(!tombstones.has(Path::new(&absolute_first), Some("remote")));

    tombstones.add(first, None, 5.0).unwrap();
    let updated = tombstones.list();
    assert_eq!(updated[0].path, "second-session.jsonl");
    assert_eq!(updated[1].device.as_deref(), Some("remote"));
    assert_eq!(updated[2].path, absolute_first);
    assert_eq!(updated[2].at, 5.0);
    std::fs::remove_file(file).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

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
        Arc::new(Tombstones::open(None)),
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
        .add("/synthetic/sessions/b.jsonl", None, 1.0)
        .unwrap();
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
    index.stock.close().await;
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
    index.stock.close().await;
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
