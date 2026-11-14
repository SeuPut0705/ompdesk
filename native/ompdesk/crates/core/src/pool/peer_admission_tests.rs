use super::*;
use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
use tokio::sync::mpsc;

struct Recorded(mpsc::UnboundedSender<crate::sidecar::LaneEvent>);
impl crate::sidecar::native::Sink for Recorded {
    fn event(&self, event: crate::sidecar::LaneEvent) {
        let _ = self.0.send(event);
    }
    fn before_response(&self) {}
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        Box::pin(async {})
    }
}

fn lane_config(tab: String) -> SidecarConfig {
    SidecarConfig {
        tab,
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
    }
}

#[tokio::test]
async fn a_rejoined_peer_keeps_its_execution_but_each_admission_captures_the_current_run() {
    let callers = Arc::new(Callers::new(64));
    let host = test_host(Arc::clone(&callers));
    let app = Arc::new(Application::new(host));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_7065_6572,
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
            callers: Arc::clone(&callers),
            removal_claims: RemovalClaims::new(),
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call(
        "seed",
        json!({"tabs":[
            {"tab":"peer:original:rtab","win":0,"status":"asleep"},
            {"tab":"peer:original:dormant","win":0,"status":"asleep"}
        ]}),
        false,
    )
    .await
    .unwrap();
    let (events, _keep_output, _frames) = crate::server::Events::capture();
    let (record, mut recorded) = mpsc::unbounded_channel();
    let (source, held) = SidecarService::new(
        lane_config(format!("native-peer-capture-{}", std::process::id())),
        events,
        Arc::new(Recorded(record)),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::super::HandleKey::Tab("peer:original:rtab".into()),
        super::super::super::Handle {
            sidecar: Arc::clone(&source),
            device: None,
        },
    );
    let (dormant_events, _keep_dormant, _dormant_frames) = crate::server::Events::capture();
    let (dormant, dormant_held) = SidecarService::new(
        lane_config(format!("native-peer-dormant-{}", std::process::id())),
        dormant_events,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::super::HandleKey::Tab("peer:original:dormant".into()),
        super::super::super::Handle {
            sidecar: Arc::clone(&dormant),
            device: None,
        },
    );
    let (first, first_remote, _keep_first) = crate::remote::requests::tests::pair().await;
    let (next, next_remote, _keep_next) = crate::remote::requests::tests::pair().await;
    let admitted = callers
        .admit_peer("peer".into(), first.link_id().unwrap())
        .unwrap();
    callers
        .bind_peer_connection(&admitted.owner, first.clone())
        .unwrap();
    let reservation = callers
        .reserve_execution(&admitted.owner, "peer:original:rtab", 0)
        .unwrap();
    let execution = callers.execution_owner("peer:original:rtab").unwrap();
    callers.finish_execution_reservation(reservation, true);
    let dormant_reservation = callers
        .reserve_execution(&admitted.owner, "peer:original:dormant", 0)
        .unwrap();
    callers.finish_execution_reservation(dormant_reservation, true);
    let run_source = Arc::clone(&source);
    let run_first = first.clone();
    let run_next = next.clone();
    let scenario = tokio::spawn(async move {
        run_source.start();
        crate::sidecar::native::tests::ready(&run_source, &mut recorded).await;
        let target = pool
            .peer_execution_target(&admitted.owner, &run_first, "peer:original:rtab")
            .await
            .unwrap();
        assert_eq!(target.owner(), &execution);
        assert!(Arc::ptr_eq(target.source(), &run_source));
        let old = pool
            .peer_execution_selected(&admitted.owner, &run_first, &target)
            .await
            .unwrap();
        assert_eq!(
            old.session_file, None,
            "an unwritten hosted execution is still selectable"
        );
        let before = pool
            .peer_execution_command(
                &admitted.owner,
                &run_first,
                &target,
                ExecutionCommand::Stock(json!({"type":"get_state"})),
            )
            .await
            .unwrap();
        assert_eq!(before["success"], true);
        let restarted = run_source.restart_for_generation(old.generation);
        crate::sidecar::native::tests::ready(&run_source, &mut recorded).await;
        restarted.await.unwrap();
        assert!(
            run_source
                .stock_for_generation(old.generation, json!({"type":"get_state"}), None)
                .await
                .is_err()
        );
        let current = pool
            .peer_execution_selected(&admitted.owner, &run_first, &target)
            .await
            .unwrap();
        assert_ne!(current.generation, old.generation);
        assert_eq!(current.cwd, old.cwd);
        let rejoined = callers
            .admit_peer("peer".into(), run_next.link_id().unwrap())
            .unwrap();
        callers
            .bind_peer_connection(&rejoined.owner, run_next.clone())
            .unwrap();
        assert!(
            pool.peer_execution_selected(&admitted.owner, &run_first, &target)
                .await
                .is_err()
        );
        let answer = pool
            .peer_execution_command(
                &rejoined.owner,
                &run_next,
                &target,
                ExecutionCommand::Stock(json!({"type":"get_state"})),
            )
            .await
            .unwrap();
        assert_eq!(answer["success"], true);
        assert_eq!(
            callers.execution_owner("peer:original:rtab").unwrap(),
            execution
        );
        let cleanup = pool.execution_selected(&target).await.unwrap();
        assert_eq!(cleanup.generation, current.generation);
        assert!(Arc::ptr_eq(&cleanup.sidecar, &run_source));
        let dormant_target = pool
            .peer_execution_target(&rejoined.owner, &run_next, "peer:original:dormant")
            .await
            .unwrap();
        let incarnation = dormant_target.incarnation();
        pool.execute(false, move |ctx, _| {
            ctx.with(|pool| pool.entry_mut("peer:original:dormant").unwrap().seq = incarnation + 1);
            Outcome::Now(Ok(Value::Null))
        })
        .await
        .unwrap();
        assert!(pool.release_peer_execution(&dormant_target).await.is_err());
        pool.execute(false, move |ctx, _| {
            ctx.with(|pool| pool.entry_mut("peer:original:dormant").unwrap().seq = incarnation);
            Outcome::Now(Ok(Value::Null))
        })
        .await
        .unwrap();
        pool.release_peer_execution(&dormant_target).await.unwrap();
        assert!(pool.execution_selected(&dormant_target).await.is_err());
        assert_eq!(run_source.facts()["processAlive"], true);
        assert!(callers.retire_execution(&execution));
        assert!(
            pool.peer_execution_command(
                &rejoined.owner,
                &run_next,
                &target,
                ExecutionCommand::Stock(json!({"type":"get_state"}))
            )
            .await
            .is_err()
        );
        assert!(pool.execution_selected(&target).await.is_err());
    })
    .await;
    source.dispose(std::time::Duration::ZERO);
    held.await.unwrap();
    dormant.dispose(std::time::Duration::ZERO);
    dormant_held.await.unwrap();
    for connection in [&first, &first_remote, &next, &next_remote] {
        let mut changes = connection.changes();
        connection.disconnect_for_test();
        changes.wait_for(|online| !*online).await.unwrap();
    }
    scenario.unwrap();
}
