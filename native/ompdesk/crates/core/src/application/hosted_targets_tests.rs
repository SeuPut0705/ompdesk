#![cfg(unix)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tokio::sync::mpsc;

use super::*;
use crate::application::callers::Callers;
use crate::pool::application::Application;
use crate::pool::application::native::Config as PoolConfig;
use crate::pool::application::native::tests::{TestHost, set_test_source, test_host};
use crate::remote::requests::tests::pair;
use crate::sidecar::LaneEvent;
use crate::sidecar::application::EffectFuture;
use crate::sidecar::native::{Config as SourceConfig, DirectSpawn, Held, Service as Source, Sink};
use crate::worktree_lifecycle::RemovalClaims;

struct Recorded(mpsc::UnboundedSender<LaneEvent>);
impl Sink for Recorded {
    fn event(&self, event: LaneEvent) { let _ = self.0.send(event); }
    fn before_response(&self) {}
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> { Box::pin(async {}) }
}

fn source(tab: String) -> (Arc<Source>, Held, mpsc::UnboundedReceiver<LaneEvent>) {
    let (events, _output, _frames) = crate::server::Events::capture();
    let (record, incoming) = mpsc::unbounded_channel();
    let (source, held) = Source::new(
        SourceConfig {
            tab, seq: 0,
            cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(),
            fresh: true, event_filter: Vec::new(), bridge: false, ledger_file: None,
            start_slow_ms: None, entry_id_timeout_ms: None, tuning: None,
            session_path: None, is_new: Some(true),
        },
        events, Arc::new(Recorded(record)), Arc::new(DirectSpawn),
    ).unwrap();
    (source, held, incoming)
}

async fn all_frozen_effects_refuse(adapter: &HostedTargets<TestHost>, target: &Target<Source>, reason: &str) {
    assert!(adapter.runtime(target).await.is_err(), "runtime accepted {reason}");
    assert!(adapter.stop(target).await.is_err(), "stop accepted {reason}");
    assert!(adapter.command(target, json!({"type":"get_state"})).await.is_err(), "command accepted {reason}");
    assert!(adapter.name(target, "must not apply").await.is_err(), "name accepted {reason}");
    assert!(adapter.close_session(target).await.is_err(), "session close accepted {reason}");
    assert!(adapter.close(target).await.is_err(), "general close refreshed {reason}");
}

#[tokio::test]
async fn frozen_effects_preserve_original_path_run_source_and_execution_owner() {
    static NEXT: AtomicU64 = AtomicU64::new(0x6672_6f7a_656e_0000);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let tab = format!("peer:frozen:{id}");
    let path_a = "/isolated/frozen-session-a.jsonl";
    let path_b = "/isolated/frozen-session-b.jsonl";
    let callers = Arc::new(Callers::new(id));
    let app = Arc::new(Application::new(test_host(Arc::clone(&callers))));
    let pool = NativePool::new(
        PoolConfig {
            id, layout_version: 1, max_former_tab_ids: 8, stop_session_wait_ms: 60_000,
            window_tabs_hook: false, now_ms: || 1234,
            callers: Arc::clone(&callers), removal_claims: RemovalClaims::new(),
        },
        Arc::clone(&app),
    ).await.unwrap();
    pool.call("seed", json!({"tabs":[{"tab":tab,"win":0,"status":"ready","sessionFile":path_a}]}), false).await.unwrap();
    let (original, original_held, mut original_events) = source(format!("frozen-original-{id}"));
    let (replacement, replacement_held, mut replacement_events) = source(format!("frozen-replacement-{id}"));
    set_test_source(&app, &tab, Arc::clone(&original));
    let (connection, remote, _keep_link) = pair().await;
    let admitted = callers.admit_peer("frozen-peer".into(), connection.link_id().unwrap()).unwrap();
    callers.bind_peer_connection(&admitted.owner, connection.clone()).unwrap();
    let reservation = callers.reserve_execution(&admitted.owner, &tab, 0).unwrap();
    callers.finish_execution_reservation(reservation, true);
    let run_original = Arc::clone(&original);
    let run_replacement = Arc::clone(&replacement);
    let run_pool = Arc::clone(&pool);
    let run_connection = connection.clone();
    let original_exit_result = Arc::new(Mutex::new(None::<Result<(), Fault>>));
    let observed_original_exit = Arc::clone(&original_exit_result);
    // The outer owner retains both real lanes and links even when an assertion in this scenario panics.
    let outcome = tokio::spawn(async move {
        run_original.start();
        run_replacement.start();
        crate::sidecar::native::tests::ready(&run_original, &mut original_events).await;
        crate::sidecar::native::tests::ready(&run_replacement, &mut replacement_events).await;
        let execution = run_pool.peer_execution_target(&admitted.owner, &run_connection, &tab).await.unwrap();
        let execution_owner = execution.owner().clone();
        let adapter = HostedTargets::new(Arc::clone(&run_pool));
        let live = Target::live(execution);
        assert!(adapter.runtime(&live).await.is_err(), "live presentation must not act as a saved-session capture");
        assert!(adapter.capture_session_target(&live, path_b).await.is_err());
        let frozen_a = adapter.capture_session_target(&live, path_a).await.unwrap();
        assert!(matches!(adapter.runtime(&frozen_a).await.unwrap().state, crate::session_ops::RuntimeState::Ready));
        let response = adapter.command(&frozen_a, json!({"type":"get_state"})).await.unwrap();
        assert_eq!(response["type"], "response");
        assert_eq!(response["command"], "get_state");
        assert_eq!(response["success"], true);
        adapter.name(&frozen_a, "frozen original").await.unwrap();
        assert_eq!(run_pool.facts(&tab).await.unwrap()["title"], "frozen original");

        run_pool.call("noteSessionFile", json!({"tab":tab,"file":path_b}), false).await.unwrap();
        all_frozen_effects_refuse(&adapter, &frozen_a, "changed saved path").await;
        assert!(adapter.capture_session_target(&frozen_a, path_a).await.is_err());
        assert!(adapter.capture_session_target(&frozen_a, path_b).await.is_err());
        assert!(adapter.capture_session_target(&live, path_a).await.is_err());
        let frozen_b = adapter.capture_session_target(&live, path_b).await.unwrap();
        let old_generation = run_original.generation();
        let restarted = run_original.restart_for_generation(old_generation);
        crate::sidecar::native::tests::ready(&run_original, &mut original_events).await;
        restarted.await.unwrap();
        assert_ne!(run_original.generation(), old_generation);
        all_frozen_effects_refuse(&adapter, &frozen_b, "changed run generation").await;
        assert!(adapter.capture_session_target(&frozen_b, path_b).await.is_err(), "frozen recapture must not refresh its generation");
        let current = adapter.capture_session_target(&live, path_b).await.unwrap();
        assert_eq!(adapter.command(&current, json!({"type":"get_state"})).await.unwrap()["success"], true);

        let replacement_pid = run_replacement.facts()["pid"].as_u64().unwrap();
        set_test_source(&app, &tab, Arc::clone(&run_replacement));
        all_frozen_effects_refuse(&adapter, &current, "replaced source").await;
        assert!(adapter.capture_session_target(&live, path_b).await.is_err());
        assert_eq!(run_replacement.stock(json!({"type":"get_state"}), None).await.unwrap()["success"], true);
        assert_eq!(run_replacement.facts()["pid"].as_u64(), Some(replacement_pid));
        set_test_source(&app, &tab, Arc::clone(&run_original));
        assert_eq!(adapter.command(&current, json!({"type":"get_state"})).await.unwrap()["success"], true);
        let exact_exit = run_original.when_exited();
        match adapter.close_session(&current).await.unwrap() {
            SessionRelease::Released(result) => result.unwrap(),
            SessionRelease::Busy => panic!("idle frozen execution was refused as busy"),
        }
        let exited = exact_exit.await;
        *observed_original_exit.lock().unwrap() = Some(exited.clone());
        exited.unwrap();
        assert!(callers.retire_execution(&execution_owner));
        let reopened_reservation = callers.reserve_execution(&admitted.owner, &tab, 0).unwrap();
        callers.finish_execution_reservation(reopened_reservation, true);
        run_pool.call("seed", json!({"tabs":[{"tab":tab,"win":0,"status":"ready","sessionFile":path_b}]}), false).await.unwrap();
        set_test_source(&app, &tab, Arc::clone(&run_replacement));
        let reopened_execution = run_pool.peer_execution_target(&admitted.owner, &run_connection, &tab).await.unwrap();
        assert_ne!(reopened_execution.incarnation(), live.execution().incarnation());
        let reopened_owner = reopened_execution.owner().clone();
        let reopened_live = Target::live(reopened_execution);
        let reopened = adapter.capture_session_target(&reopened_live, path_b).await.unwrap();
        all_frozen_effects_refuse(&adapter, &current, "reopened tab incarnation").await;
        assert!(adapter.capture_session_target(&live, path_b).await.is_err());
        assert!(adapter.close(&live).await.is_err());
        assert_eq!(adapter.command(&reopened, json!({"type":"get_state"})).await.unwrap()["success"], true);
        assert_eq!(run_replacement.facts()["pid"].as_u64(), Some(replacement_pid));
        assert!(callers.retire_execution(&reopened_owner));
        all_frozen_effects_refuse(&adapter, &reopened, "retired execution owner").await;
        assert!(adapter.capture_session_target(&reopened_live, path_b).await.is_err());
        assert!(adapter.close(&reopened_live).await.is_err());
        assert_eq!(run_replacement.facts()["pid"].as_u64(), Some(replacement_pid));
    }).await;
    let original_exit: Held = match original_exit_result.lock().unwrap().take() {
        Some(result) => Box::pin(async move { result }),
        None => original.when_exited(),
    };
    let replacement_exit = replacement.when_exited();
    original.dispose(Duration::ZERO);
    replacement.dispose(Duration::ZERO);
    let (original_exit, replacement_exit, original_held, replacement_held) = tokio::join!(
        original_exit, replacement_exit, original_held, replacement_held,
    );
    for link in [&connection, &remote] {
        let mut changes = link.changes();
        link.disconnect_for_test();
        changes.wait_for(|online| !*online).await.unwrap();
    }
    original_exit.unwrap();
    replacement_exit.unwrap();
    original_held.unwrap();
    replacement_held.unwrap();
    outcome.unwrap();
}
