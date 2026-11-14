use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(unix)]
struct ShellLauncher {
    launches: AtomicUsize,
}

#[cfg(unix)]
impl Launcher for ShellLauncher {
    fn launch(
        &self,
        _kind: WorkerKind,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchCommand, Fault>> + Send + '_>> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(LaunchCommand {
                bin: "/bin/sh".into(),
                args: vec!["-c".into(), r#"n=0; while IFS= read -r line; do case "$line" in *'"id":'*) id=${line#*'"id":'}; id=${id%%,*}; n=$((n+1)); printf '{"id":%s,"result":%s}\n' "$id" "$n";; esac; done"#.into()],
                env: BTreeMap::new(),
                stamp_file: None,
            })
        })
    }
}

#[cfg(unix)]
struct GatedLauncher {
    entered: tokio::sync::Notify,
    completed: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[cfg(unix)]
impl Launcher for GatedLauncher {
    fn launch(
        &self,
        _kind: WorkerKind,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchCommand, Fault>> + Send + '_>> {
        Box::pin(async {
            self.entered.notify_one();
            self.release.notified().await;
            self.completed.notify_one();
            Ok(LaunchCommand {
                bin: "/bin/sh".into(),
                args: vec!["-c".into(), r#"n=0; while IFS= read -r line; do case "$line" in *'"id":'*) id=${line#*'"id":'}; id=${id%%,*}; n=$((n+1)); printf '{"id":%s,"result":%s}\n' "$id" "$n";; esac; done"#.into()],
                env: BTreeMap::new(),
                stamp_file: None,
            })
        })
    }
}

#[cfg(unix)]
#[tokio::test]
async fn dropped_and_cancelled_requests_do_not_reach_a_worker_waiting_to_start() {
    let (events, _frames, _output) = Events::capture();
    let launcher = Arc::new(GatedLauncher {
        entered: tokio::sync::Notify::new(),
        completed: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let service = Service::new(
        Config {
            host: format!("native-test-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
            events,
        },
        launcher.clone(),
    );
    drop(service.request(
        "sessions.dropped",
        &json!({}),
        Duration::from_secs(5),
        Scope::detached(),
    ));
    let scope = Scope::detached();
    let cancelled = service.request(
        "sessions.cancelled",
        &json!({}),
        Duration::from_secs(5),
        scope.clone(),
    );
    scope.cancel();
    assert_eq!(cancelled.await.unwrap_err().code, "cancelled");
    let live = service.request(
        "sessions.live",
        &json!({}),
        Duration::from_secs(5),
        Scope::detached(),
    );
    launcher.release.notify_one();
    assert_eq!(live.await.unwrap(), json!(1));
    service.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_launch_answer_after_stop_cannot_start_the_next_generation() {
    let (events, _frames, _output) = Events::capture();
    let host = format!("native-test-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let gate = Arc::new(GatedLauncher {
        entered: tokio::sync::Notify::new(),
        completed: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let old = Service::new(
        Config {
            host: host.clone(),
            events: events.clone(),
        },
        gate.clone(),
    );
    let pending = old.request(
        "sessions.old",
        &json!({}),
        Duration::from_secs(5),
        Scope::detached(),
    );
    gate.entered.notified().await;
    old.stop().await;
    assert_eq!(pending.await.unwrap_err().code, "stock_stopped");
    let next = Service::new(
        Config { host, events },
        Arc::new(ShellLauncher {
            launches: AtomicUsize::new(0),
        }),
    );
    gate.release.notify_one();
    gate.completed.notified().await;
    assert_eq!(
        next.request(
            "sessions.new",
            &json!({}),
            Duration::from_secs(5),
            Scope::detached()
        )
        .await
        .unwrap(),
        json!(1)
    );
    next.close().await;
    old.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_requests_are_admitted_in_call_order_and_reuse_the_worker() {
    let (events, _frames, mut output) = Events::capture();
    let launcher = Arc::new(ShellLauncher {
        launches: AtomicUsize::new(0),
    });
    let service = Service::new(
        Config {
            host: format!("native-test-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
            events,
        },
        launcher.clone(),
    );
    let first = service.request(
        "sessions.first",
        &json!({}),
        Duration::from_secs(5),
        Scope::detached(),
    );
    let second = service.request(
        "sessions.second",
        &json!({}),
        Duration::from_secs(5),
        Scope::detached(),
    );
    assert_eq!(second.await.unwrap(), json!(2));
    assert_eq!(first.await.unwrap(), json!(1));
    assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    assert!(output.try_recv().is_err());
    service.close().await;
    assert_eq!(
        service
            .request(
                "sessions.third",
                &json!({}),
                Duration::from_secs(5),
                Scope::detached()
            )
            .await
            .unwrap_err()
            .code,
        "stock_stopped"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn conflicting_launchers_cannot_share_a_host_even_across_worker_kinds() {
    let (events, _frames, _output) = Events::capture();
    let host = format!("native-test-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let launcher = Arc::new(ShellLauncher {
        launches: AtomicUsize::new(0),
    });
    let first = Service::new(
        Config {
            host: host.clone(),
            events: events.clone(),
        },
        launcher.clone(),
    );
    let second = Service::new(
        Config {
            host: host.clone(),
            events: events.clone(),
        },
        launcher,
    );
    assert_eq!(
        first
            .request(
                "sessions.list",
                &json!({}),
                Duration::from_secs(5),
                Scope::detached()
            )
            .await
            .unwrap(),
        json!(1)
    );
    assert_eq!(
        second
            .request(
                "terminal.list",
                &json!({}),
                Duration::from_secs(5),
                Scope::detached()
            )
            .await
            .unwrap_err()
            .code,
        "stock_host_conflict"
    );
    assert_eq!(
        super::super::request_in_process(
            &events,
            &host,
            "terminal.list",
            &json!({}),
            Duration::from_secs(5)
        )
        .await
        .unwrap_err()
        .code,
        "stock_host_conflict"
    );
    first.stop().await;
    assert_eq!(
        second
            .request(
                "sessions.list",
                &json!({}),
                Duration::from_secs(5),
                Scope::detached()
            )
            .await
            .unwrap(),
        json!(1)
    );
    second.close().await;
    first.close().await;
}
