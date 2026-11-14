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
    service.close().await.unwrap();
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
    old.stop().await.unwrap();
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
    next.close().await.unwrap();
    old.close().await.unwrap();
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
    service.close().await.unwrap();
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
    first.stop().await.unwrap();
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
    second.close().await.unwrap();
    first.close().await.unwrap();
}

struct JoinedLauncher {
    address: std::net::SocketAddr,
}

impl Launcher for JoinedLauncher {
    fn launch(
        &self,
        _kind: WorkerKind,
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
                env: BTreeMap::from([("OMPDESK_JOINED_WORKER".into(), self.address.to_string())]),
                stamp_file: None,
            })
        })
    }
}

#[test]
fn joined_worker_fixture() {
    use std::io::{BufRead, Read, Write};
    let Ok(address) = std::env::var("OMPDESK_JOINED_WORKER") else {
        return;
    };
    let mut control = std::net::TcpStream::connect(address).unwrap();
    let mut notifications = control.try_clone().unwrap();
    let (send, receive) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let notification = if request.get("cancel").is_some() {
                Some(&b"cancel"[..])
            } else if request["method"] == "sessions.queued" {
                Some(&b"queued"[..])
            } else {
                None
            };
            if send.send(request).is_err() {
                break;
            }
            if let Some(notification) = notification {
                notifications.write_all(notification).unwrap();
            }
        }
        let _ = notifications.write_all(b"closed");
    });
    println!();
    let mut queue = std::collections::VecDeque::new();
    let mut cancelled = std::collections::HashSet::new();
    loop {
        if queue.is_empty() {
            let Ok(request) = receive.recv() else { break };
            queue.push_back(request);
        }
        queue.extend(receive.try_iter());
        while let Some(request) = queue.pop_front() {
            if let Some(id) = request.get("cancel") {
                cancelled.insert(id.as_u64().unwrap());
                continue;
            }
            let id = request["id"].as_u64().unwrap();
            for next in receive.try_iter() {
                if let Some(id) = next.get("cancel") {
                    cancelled.insert(id.as_u64().unwrap());
                } else {
                    queue.push_back(next);
                }
            }
            if cancelled.remove(&id) {
                println!("{}", json!({"id": id, "error": "withdrawn"}));
                continue;
            }
            control.write_all(b"started").unwrap();
            let mut release = [0];
            control.read_exact(&mut release).unwrap();
            println!("{}", json!({"id": id, "result": "mutated"}));
        }
    }
}

#[tokio::test]
async fn joined_cancel_withdraws_a_request_queued_in_the_worker() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (service, listener) = joined_fixture().await;
    let active = service.request_joined(
        "sessions.active",
        &json!({}),
        Duration::from_secs(60),
        Scope::detached(),
    );
    let mut control = worker_started(listener).await;
    let (scope, gone) = Scope::watched();
    let mut queued = Box::pin(service.request_joined(
        "sessions.queued",
        &json!({}),
        Duration::from_secs(60),
        scope.clone(),
    ));
    let mut notice = [0; 6];
    control.read_exact(&mut notice).await.unwrap();
    assert_eq!(&notice, b"queued");
    scope.cancel();
    drop(scope);
    control.read_exact(&mut notice).await.unwrap();
    assert_eq!(&notice, b"cancel");
    assert_pending(queued.as_mut()).await;
    let mut gone = Box::pin(gone.wait());
    assert_pending(gone.as_mut()).await;
    control.write_all(b"r").await.unwrap();
    assert_eq!(active.await.unwrap(), json!("mutated"));
    assert_eq!(queued.await.unwrap_err().code, "cancelled");
    gone.await;
    service.close().await.unwrap();
}

async fn joined_fixture() -> (Service, tokio::net::TcpListener) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (events, _frames, _output) = Events::capture();
    let service = Service::new(
        Config {
            host: format!("native-joined-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
            events,
        },
        Arc::new(JoinedLauncher {
            address: listener.local_addr().unwrap(),
        }),
    );
    (service, listener)
}

async fn worker_started(listener: tokio::net::TcpListener) -> tokio::net::TcpStream {
    use tokio::io::AsyncReadExt;
    let (mut control, _) = listener.accept().await.unwrap();
    let mut started = [0; 7];
    control.read_exact(&mut started).await.unwrap();
    assert_eq!(&started, b"started");
    control
}

async fn assert_pending<T>(mut future: Pin<&mut impl Future<Output = T>>) {
    let pending =
        std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx).is_pending()))
            .await;
    assert!(pending, "future completed before the worker");
}

fn inject_wait_error(service: &Service, worker: WorkerKind) {
    let inbox = locked(&LANES)
        .get(&(service.config.host.clone(), worker))
        .unwrap()
        .inbox
        .clone();
    assert!(
        inbox
            .send(super::super::Msg::WaitFailed { generation: 1 })
            .is_ok()
    );
}

#[tokio::test]
async fn wait_error_retains_scope_until_late_worker_answer() {
    use tokio::io::AsyncWriteExt;
    let (service, listener) = joined_fixture().await;
    let (scope, gone) = Scope::watched();
    let result = service.request_joined(
        "sessions.mutate",
        &json!({}),
        Duration::from_secs(60),
        scope,
    );
    let mut control = worker_started(listener).await;
    inject_wait_error(&service, WorkerKind::Stock);
    assert_eq!(result.await.unwrap_err().code, "stock_exit_unconfirmed");
    let mut gone = Box::pin(gone.wait());
    assert_pending(gone.as_mut()).await;
    control.write_all(b"r").await.unwrap();
    gone.await;
    service.close().await.unwrap();
}

#[tokio::test]
async fn terminal_wait_error_reports_unconfirmed_without_releasing_the_active_request() {
    use tokio::io::AsyncWriteExt;
    let (service, listener) = joined_fixture().await;
    let (scope, gone) = Scope::watched();
    let result = service.request_joined(
        "terminal.mutate",
        &json!({}),
        Duration::from_secs(60),
        scope,
    );
    let mut control = worker_started(listener).await;
    inject_wait_error(&service, WorkerKind::Terminals);
    assert_eq!(result.await.unwrap_err().code, "stock_exit_unconfirmed");
    let mut gone = Box::pin(gone.wait());
    assert_pending(gone.as_mut()).await;
    control.write_all(b"r").await.unwrap();
    gone.await;
    service.close().await.unwrap();
}

#[tokio::test]
async fn joined_cancel_waits_for_active_worker_answer() {
    use tokio::io::AsyncWriteExt;
    let (service, listener) = joined_fixture().await;
    let (scope, gone) = Scope::watched();
    let mut result = Box::pin(service.request_joined(
        "sessions.mutate",
        &json!({}),
        Duration::from_secs(60),
        scope.clone(),
    ));
    let mut control = worker_started(listener).await;
    scope.cancel();
    drop(scope);
    tokio::task::yield_now().await;
    assert_pending(result.as_mut()).await;
    let mut gone = Box::pin(gone.wait());
    assert_pending(gone.as_mut()).await;
    control.write_all(b"r").await.unwrap();
    assert_eq!(result.await.unwrap_err().code, "cancelled");
    gone.await;
    service.close().await.unwrap();
}

#[tokio::test]
async fn joined_timeout_waits_for_active_worker_answer() {
    use tokio::io::AsyncWriteExt;
    let (service, listener) = joined_fixture().await;
    let (scope, gone) = Scope::watched();
    let mut result = Box::pin(service.request_joined(
        "sessions.mutate",
        &json!({}),
        Duration::from_secs(60),
        scope,
    ));
    let mut control = worker_started(listener).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_pending(result.as_mut()).await;
    let mut gone = Box::pin(gone.wait());
    assert_pending(gone.as_mut()).await;
    tokio::time::resume();
    control.write_all(b"r").await.unwrap();
    assert_eq!(result.await.unwrap_err().code, "stock_timeout");
    gone.await;
    service.close().await.unwrap();
}

#[tokio::test]
async fn joined_stop_waits_for_process_exit_not_lane_stop() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (service, listener) = joined_fixture().await;
    let (scope, gone) = Scope::watched();
    let mut result = Box::pin(service.request_joined(
        "sessions.mutate",
        &json!({}),
        Duration::from_secs(60),
        scope,
    ));
    let mut control = worker_started(listener).await;
    tokio::time::pause();
    let mut stop = Box::pin(service.stop());
    assert_pending(stop.as_mut()).await;
    tokio::time::advance(STOP_WAIT).await;
    assert_eq!(stop.await.unwrap_err().code, "stock_exit_unconfirmed");
    tokio::time::resume();
    let mut closed = [0; 6];
    control.read_exact(&mut closed).await.unwrap();
    assert_eq!(
        service
            .request(
                "sessions.replacement",
                &json!({}),
                Duration::from_secs(60),
                Scope::detached()
            )
            .await
            .unwrap_err()
            .code,
        "stock_exit_unconfirmed"
    );
    assert_eq!(&closed, b"closed");
    assert_pending(result.as_mut()).await;
    let mut gone = Box::pin(gone.wait());
    assert_pending(gone.as_mut()).await;
    control.write_all(b"r").await.unwrap();
    assert_eq!(result.await.unwrap_err().code, "stock_stopped");
    gone.await;
    service.close().await.unwrap();
}

#[tokio::test]
async fn dropped_joined_future_retains_scope_until_active_worker_answers() {
    use tokio::io::AsyncWriteExt;
    let (service, listener) = joined_fixture().await;
    let (scope, gone) = Scope::watched();
    let result = service.request_joined(
        "sessions.mutate",
        &json!({}),
        Duration::from_secs(60),
        scope,
    );
    let mut control = worker_started(listener).await;
    drop(result);
    let mut gone = Box::pin(gone.wait());
    assert_pending(gone.as_mut()).await;
    control.write_all(b"r").await.unwrap();
    gone.await;
    service.close().await.unwrap();
}

#[tokio::test]
async fn joined_cancel_before_worker_start_withdraws_the_request() {
    let (events, _frames, _output) = Events::capture();
    let launcher = Arc::new(GatedLauncher {
        entered: tokio::sync::Notify::new(),
        completed: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let service = Service::new(
        Config {
            host: format!("native-joined-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
            events,
        },
        launcher.clone(),
    );
    let scope = Scope::detached();
    let cancelled = service.request_joined(
        "sessions.mutate",
        &json!({}),
        Duration::from_secs(60),
        scope.clone(),
    );
    launcher.entered.notified().await;
    scope.cancel();
    assert_eq!(cancelled.await.unwrap_err().code, "cancelled");
    let live = service.request_joined(
        "sessions.live",
        &json!({}),
        Duration::from_secs(60),
        Scope::detached(),
    );
    launcher.release.notify_one();
    assert_eq!(live.await.unwrap(), json!(1));
    service.close().await.unwrap();
}

async fn quarantines_lost_stop_receipt(worker_wait_error: bool) {
    let (events, _frames, _output) = Events::capture();
    let host = format!(
        "native-quarantine-{}",
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let service = Service::new(
        Config {
            host: host.clone(),
            events: events.clone(),
        },
        Arc::new(ShellLauncher {
            launches: AtomicUsize::new(0),
        }),
    );
    let (inbox, mut messages) = tokio::sync::mpsc::unbounded_channel();
    locked(&LANES).insert(
        (host.clone(), WorkerKind::Stock),
        super::super::Entry {
            inbox,
            events: events.clone(),
            source: service.source.clone(),
        },
    );
    if worker_wait_error {
        tokio::spawn(async move {
            if let Some(super::super::Msg::Stop(reply)) = messages.recv().await {
                let (exit, exited) = tokio::sync::watch::channel(false);
                drop(exit);
                let _ = reply.send(vec![exited]);
            }
        });
    } else {
        drop(messages);
    }
    assert_eq!(
        service.stop().await.unwrap_err().code,
        "stock_exit_unconfirmed"
    );
    assert_eq!(
        service
            .request(
                "sessions.next",
                &json!({}),
                Duration::from_secs(60),
                Scope::detached()
            )
            .await
            .unwrap_err()
            .code,
        "stock_exit_unconfirmed"
    );
    let other = Service::new(
        Config { host, events },
        Arc::new(ShellLauncher {
            launches: AtomicUsize::new(0),
        }),
    );
    assert_eq!(
        other
            .request(
                "sessions.next",
                &json!({}),
                Duration::from_secs(60),
                Scope::detached()
            )
            .await
            .unwrap_err()
            .code,
        "stock_host_conflict"
    );
    assert_eq!(
        service.close().await.unwrap_err().code,
        "stock_exit_unconfirmed"
    );
    locked(&super::super::STOPPING).retain(|_, (_, owner, _)| !owner.same_owner(&service.source));
    other.close().await.unwrap();
}

#[tokio::test]
async fn lost_stop_reply_keeps_source_quarantined() {
    quarantines_lost_stop_receipt(false).await;
}

#[tokio::test]
async fn unconfirmed_worker_exit_keeps_source_quarantined() {
    quarantines_lost_stop_receipt(true).await;
}
