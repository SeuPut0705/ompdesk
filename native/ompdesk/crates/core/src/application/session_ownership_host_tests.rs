use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::application::runtime_log::RuntimeLogContext;
use crate::remote::application_host::tests::{Caller, service};
use crate::remote::requests::tests::pair;
use crate::server::Fault;
use crate::session_ownership::Host as _;

struct LogFile {
    folder: PathBuf,
    writer: Arc<Writer>,
}

impl LogFile {
    fn new() -> Self {
        let folder = crate::fs::disk::make_temp_dir("ompdesk-ownership-host-").unwrap();
        let writer = Arc::new(Writer::new(
            folder.join("runtime.jsonl"),
            RuntimeLogContext {
                app_version: "ownership-fixture".into(),
                platform: std::env::consts::OS.into(),
                pid: std::process::id(),
                window_id: Some(17.0),
                cwd: None,
            },
        ));
        Self { folder, writer }
    }

    fn records(&self) -> Vec<Value> {
        std::fs::read_to_string(self.writer.path()).unwrap().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }
}

impl Drop for LogFile {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.folder); }
}

#[tokio::test]
async fn held_facts_keep_only_exact_nonview_sessions_through_real_disconnect_grace() {
    let log = LogFile::new();
    let (hosted, effects, _) = service();
    let adapter = SessionOwnershipHost::new(Arc::clone(&hosted), Arc::clone(&log.writer));
    let owner = Caller("peer".into());
    let (device, connection, _keep_link) = pair().await;
    hosted.serve(owner.clone(), connection.clone(), json!({})).unwrap();
    let run_hosted = Arc::clone(&hosted);
    let run_effects = Arc::clone(&effects);
    let run_device = device.clone();
    let run_connection = connection.clone();
    let outcome = tokio::spawn(async move {
        let runner = "/isolated/ownership-runner.jsonl";
        let view = "/isolated/ownership-view.jsonl";
        run_device.request("tab.open", json!({"rtab":"runner","cwd":"/workspace","sessionPath":runner}), Duration::from_secs(30)).await.unwrap();
        run_device.request("tab.open", json!({"rtab":"view","cwd":"/workspace","sessionPath":view}), Duration::from_secs(30)).await.unwrap();
        let view_target = run_effects.targets.lock().unwrap().get(view).unwrap().clone();
        view_target.state.lock().unwrap().viewing = true;
        assert!(adapter.hosted_held(runner));
        assert!(!adapter.hosted_held(view), "a view holds no execution tag");
        assert!(!adapter.hosted_held("/isolated/ownership-runner.jsonl/other"));
        assert!(!adapter.hosted_held("/isolated/ownership-missing.jsonl"));
        adapter.log("Ownership sweep retained a hosted execution", json!({"sessionPath":runner,"held":true}));
        run_hosted.disconnected(&owner, &run_connection);
        for link in [&run_device, &run_connection] {
            let mut changed = link.changes();
            link.disconnect_for_test();
            changed.wait_for(|online| !*online).await.unwrap();
        }
        assert!(adapter.hosted_held(runner), "disconnected grace must not abandon a runner's process tag");
        assert!(!adapter.hosted_held(view));
        run_hosted.drop_peer("peer").await.unwrap();
        assert!(!adapter.hosted_held(runner));
    }).await;
    *effects.snapshot_failure.lock().unwrap() = None;
    let dropped = hosted.drop_peer("peer").await;
    for link in [&device, &connection] {
        let mut changed = link.changes();
        link.disconnect_for_test();
        changed.wait_for(|online| !*online).await.unwrap();
    }
    dropped.unwrap();
    outcome.unwrap();
    let records = log.records();
    assert_eq!(records[0]["source"], "session-processes");
    assert_eq!(records[0]["appVersion"], "ownership-fixture");
    assert_eq!(records[0]["windowId"], 17.0);
    assert_eq!(records[0]["details"]["sessionPath"], "/isolated/ownership-runner.jsonl");
    assert_eq!(records[0]["details"]["held"], true);
}

#[tokio::test]
async fn a_snapshot_fault_retains_unknown_processes_and_writes_the_original_fault_to_the_real_log() {
    let log = LogFile::new();
    let (hosted, effects, _) = service();
    let adapter = SessionOwnershipHost::new(Arc::clone(&hosted), Arc::clone(&log.writer));
    let (device, connection, _keep_link) = pair().await;
    hosted.serve(Caller("peer".into()), connection.clone(), json!({})).unwrap();
    let run_device = device.clone();
    let run_effects = Arc::clone(&effects);
    let outcome = tokio::spawn(async move {
        run_device.request("tab.open", json!({"rtab":"runner","cwd":"/workspace","sessionPath":"/isolated/ownership-running.jsonl"}), Duration::from_secs(30)).await.unwrap();
        let uncertain = "/isolated/ownership-uncertain.jsonl";
        assert!(!adapter.hosted_held(uncertain));
        *run_effects.snapshot_failure.lock().unwrap() = Some(Fault::new("snapshot_unavailable", "Original hosted snapshot failure"));
        assert!(adapter.hosted_held(uncertain), "an unreadable hosted snapshot must not authorize process termination");
        *run_effects.snapshot_failure.lock().unwrap() = None;
        assert!(!adapter.hosted_held(uncertain));
    }).await;
    *effects.snapshot_failure.lock().unwrap() = None;
    let dropped = hosted.drop_peer("peer").await;
    for link in [&device, &connection] {
        let mut changed = link.changes();
        link.disconnect_for_test();
        changed.wait_for(|online| !*online).await.unwrap();
    }
    dropped.unwrap();
    outcome.unwrap();
    let records = log.records();
    assert_eq!(records[0]["source"], "session-processes");
    assert_eq!(records[0]["details"]["sessionPath"], "/isolated/ownership-uncertain.jsonl");
    assert_eq!(records[0]["details"]["code"], "snapshot_unavailable");
    assert_eq!(records[0]["details"]["error"], "Original hosted snapshot failure");
}
