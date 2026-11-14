#![cfg(unix)]

use super::*;
use std::sync::atomic::AtomicUsize;
use tokio::sync::mpsc;

struct Recorder {
    events: mpsc::UnboundedSender<LaneEvent>,
    flushes: AtomicUsize,
}

impl Sink for Recorder {
    fn event(&self, event: LaneEvent) {
        let _ = self.events.send(event);
    }
    fn before_response(&self) {
        self.flushes.fetch_add(1, Ordering::SeqCst);
    }
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        Box::pin(async {})
    }
}

#[tokio::test]
async fn native_commands_flush_before_reply_and_close_waits_for_the_real_child() {
    let (events, _keep_output, _frames) = Events::capture();
    let (record, mut recorded) = mpsc::unbounded_channel();
    let sink = Arc::new(Recorder {
        events: record,
        flushes: AtomicUsize::new(0),
    });
    let config = Config {
        tab: format!("native-lane-test-{}", std::process::id()),
        seq: 0,
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        fresh: true,
        event_filter: Vec::new(),
        bridge: false,
        ledger_file: None,
        start_slow_ms: None,
        entry_id_timeout_ms: None,
        tuning: None,
        session_path: None,
        is_new: Some(true),
    };
    let (service, held) =
        Service::new(config, events, sink.clone(), Arc::new(DirectSpawn)).unwrap();
    service.start();
    loop {
        let event = recorded.recv().await.expect("the lane's events stay open");
        let ask = Ask {
            ask: event.data["ask"].as_u64().unwrap_or(0),
            cmd: event.data["cmd"].as_u64().unwrap(),
        };
        match event.name.as_str() {
            "sidecar.resolve" => service.answer(
                ask,
                Answer::Resolved {
                    outcome: "ok",
                    message: None,
                },
            ),
            "sidecar.launch" => {
                let mut env: std::collections::BTreeMap<String, String> =
                    std::env::vars().collect();
                env.insert("OMPDESK_FAKE_OMP".into(), "normal".into());
                service.answer(
                    ask,
                    Answer::Launched {
                        command: LaunchCommand {
                            bin: std::env::current_exe().unwrap(),
                            args: [
                                "--nocapture",
                                "--exact",
                                "sidecar::tests::fake_omp_stand_in",
                                "--",
                            ]
                            .map(String::from)
                            .to_vec(),
                            env,
                            cwd: std::env::current_dir()
                                .unwrap()
                                .to_string_lossy()
                                .into_owned(),
                        },
                        host_tools: json!([]),
                    },
                );
            }
            "sidecar.status" if event.data["payload"]["status"] == "ready" => break,
            _ => {}
        }
    }
    assert_eq!(service.facts()["status"], "ready");
    assert_eq!(service.facts()["processAlive"], true);
    assert!(crate::pool::application::Sidecar::generation(service.as_ref()) > 0);
    let before = sink.flushes.load(Ordering::SeqCst);
    let answer = service
        .stock(json!({"type": "get_state"}), Some(Duration::from_secs(2)))
        .await
        .unwrap();
    assert_eq!(answer["success"], true);
    assert!(
        sink.flushes.load(Ordering::SeqCst) > before,
        "the ordered stream flush happens before the stock answer becomes visible"
    );
    service.barrier().await.unwrap();
    let exited = service.when_exited();
    service.dispose(Duration::ZERO);
    exited.await.unwrap();
    held.await.unwrap();
    assert!(
        service.when_exited().await.is_err(),
        "a closed lane cannot produce a child-exit receipt"
    );
    assert!(!service.current(Ask {
        ask: 99,
        cmd: u64::MAX
    }));
}

#[tokio::test]
async fn abandoning_a_native_handle_releases_its_lane_without_an_explicit_dispose() {
    let (events, _keep_output, _frames) = Events::capture();
    let (record, mut recorded) = mpsc::unbounded_channel();
    let sink = Arc::new(Recorder {
        events: record,
        flushes: AtomicUsize::new(0),
    });
    let (service, held) = Service::new(
        Config {
            tab: format!("native-abandoned-test-{}", std::process::id()),
            seq: 0,
            cwd: ".".into(),
            fresh: true,
            event_filter: Vec::new(),
            bridge: false,
            ledger_file: None,
            start_slow_ms: None,
            entry_id_timeout_ms: None,
            tuning: None,
            session_path: None,
            is_new: Some(true),
        },
        events,
        sink,
        Arc::new(DirectSpawn),
    )
    .unwrap();
    let weak = Arc::downgrade(&service);
    drop(service);
    assert!(
        weak.upgrade().is_none(),
        "the event pump must not retain the native handle"
    );
    held.await.unwrap();
    loop {
        let event = recorded
            .recv()
            .await
            .expect("disposal is delivered before the stream closes");
        if event.name == "sidecar.disposed" {
            break;
        }
    }
}
