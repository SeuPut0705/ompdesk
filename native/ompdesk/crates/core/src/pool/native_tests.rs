use super::*;
use crate::pool::application::{Released, Spawn, asks::Collaborators};

#[derive(Default)]
struct TestHost {
    listening: Mutex<Vec<i64>>,
    announcements: Mutex<Vec<(Value, Value, Option<u64>)>>,
    running_changes: std::sync::atomic::AtomicUsize,
    releases: Mutex<Vec<Released<crate::sidecar::native::Service>>>,
    fail_running: std::sync::atomic::AtomicBool,
    fail_window_tabs: std::sync::atomic::AtomicBool,
    receipt_gate: Mutex<Option<oneshot::Receiver<Result<(), Fault>>>>,
    receipt_entered: Mutex<Option<oneshot::Sender<()>>>,
    on_gone: Mutex<
        Option<(
            Weak<Application<TestHost>>,
            Arc<crate::sidecar::native::Service>,
        )>,
    >,
}

impl super::super::Host for TestHost {
    type Sidecar = crate::sidecar::native::Service;
    fn window(&self, _: i64) -> (bool, bool) {
        (false, false)
    }
    fn unknown_window(&self) -> Fault {
        Fault::new("window_unknown", "closed")
    }
    fn canonical_cwd(&self, _: &str) -> String {
        unreachable!()
    }
    fn create(&self, _: &Spawn, _: bool) -> Result<Arc<Self::Sidecar>, Fault> {
        unreachable!()
    }
    fn prepare_gate(&self, _: &Spawn, _: &Arc<Self::Sidecar>) {
        unreachable!()
    }
    fn wire_light(&self, _: &str, _: &Arc<Self::Sidecar>) {
        unreachable!()
    }
    fn track_summary(&self, _: &Arc<Self::Sidecar>) {
        unreachable!()
    }
    fn released(&self, release: Released<Self::Sidecar>) {
        locked(&self.releases).push(release);
    }
}

impl Collaborators for TestHost {
    fn error(&self, message: String) -> Fault {
        Fault::new("main_error", message)
    }
    fn spawn_owner(&self, _: &str) -> Result<Owner, Fault> {
        unreachable!()
    }
    fn blocked(&self, _: Option<&str>, _: Option<&str>, _: &str, _: bool) -> bool {
        unreachable!()
    }
    fn acquired(&self, _: &str, _: Arc<Self::Sidecar>) {
        unreachable!()
    }
    fn end_views(&self, _: &str, _: &[i64]) {
        unreachable!()
    }
    fn deleted_add(&self, _: &str, _: Option<&str>) {
        unreachable!()
    }
    fn self_device(&self) -> Option<String> {
        unreachable!()
    }
    fn snowflake(&self) -> String {
        unreachable!()
    }
    fn running_changed(&self) -> Result<(), Fault> {
        self.running_changes.fetch_add(1, Ordering::SeqCst);
        if self.fail_running.load(Ordering::SeqCst) {
            return Err(Fault::new("observer_failed", "Running observer failed"));
        }
        Ok(())
    }
    fn session_files_changed(&self) {}
    fn window_tabs_changed(&self, _: i64, _: Value) -> Result<(), Fault> {
        if self.fail_window_tabs.load(Ordering::SeqCst) {
            return Err(Fault::new(
                "window_observer_failed",
                "Window observer failed",
            ));
        }
        Ok(())
    }
    fn exiting(&self, _: String) -> EffectFuture<'_, Result<(), Fault>> {
        unreachable!()
    }
    fn command(
        &self,
        _: Arc<Self::Sidecar>,
        _: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        unreachable!()
    }
    fn command_for_generation(
        &self,
        sidecar: Arc<Self::Sidecar>,
        generation: u64,
        command: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        crate::pool::application::Sidecar::stock_for_generation(
            sidecar.as_ref(),
            generation,
            command,
        )
    }
}

impl effects::Host for TestHost {
    fn notify(&self, notification: effects::Notification) {
        match notification {
            effects::Notification::ListenClosed { window } => locked(&self.listening).push(window),
            effects::Notification::Gone { tab } => {
                if let Some((app, replacement)) = locked(&self.on_gone).take()
                    && let Some(app) = app.upgrade()
                {
                    app.handles().insert(
                        super::super::HandleKey::Tab(tab),
                        super::super::Handle {
                            sidecar: replacement,
                            device: None,
                        },
                    );
                }
            }
            effects::Notification::Send { .. }
            | effects::Notification::SettleWatch { .. }
            | effects::Notification::ModelWaitForget { .. }
            | effects::Notification::SessionFile { .. } => {}
            _ => unreachable!(),
        }
    }
}

impl Host for TestHost {
    type Reservation = ();
    fn window_for(&self, _: &Owner) -> Result<i64, Fault> {
        unreachable!()
    }
    fn reserve_owner(&self, _: &Owner, _: &str) -> Result<(), Fault> {
        unreachable!()
    }
    fn finish_reservation(&self, _: Self::Reservation, _: bool) {
        unreachable!()
    }
    fn authorize_tab(&self, _: &Owner, _: &str) -> Result<(), Fault> {
        Ok(())
    }
    fn when_released(
        &self,
        _: String,
        source: Arc<Self::Sidecar>,
    ) -> EffectFuture<'static, Result<(), Fault>> {
        let release = locked(&self.releases).pop();
        let gate = locked(&self.receipt_gate).take();
        let entered = locked(&self.receipt_entered).take();
        Box::pin(async move {
            let release =
                release.ok_or_else(|| Fault::new("missing_receipt", "No release receipt"))?;
            if !Arc::ptr_eq(&source, &release.source) {
                return Err(Fault::new(
                    "wrong_receipt",
                    "Release receipt names another sidecar",
                ));
            }
            release.exited.await?;
            if let Some(entered) = entered {
                let _ = entered.send(());
            }
            if let Some(gate) = gate {
                gate.await
                    .map_err(|_| Fault::new("receipt_lost", "Receipt gate dropped"))??;
            }
            Ok(())
        })
    }
    fn announce(&self, activity: Value, tabs: Value, outcome_id: Option<u64>) {
        locked(&self.announcements).push((activity, tabs, outcome_id));
    }
}

#[tokio::test]
async fn native_pool_finishes_effects_before_answer_and_keeps_seeded_host_identity() {
    let host = Arc::new(TestHost::default());
    let service = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7001,
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
        },
        Arc::new(Application::new(Arc::clone(&host))),
    )
    .await
    .unwrap();
    service.call("seed", json!({"tabs": [
        {"tab": "local", "win": 17, "sessionFile": "/local/session.jsonl", "status": "asleep"},
        {"tab": "remote", "win": 17, "device": "peer", "sessionFile": "/host/session.jsonl", "status": "ready"}
    ]}), false).await.unwrap();
    assert_eq!(*locked(&host.listening), [17]);
    let rows = service.snapshot().await.unwrap();
    assert_eq!(rows[0]["tab"], "local");
    assert_eq!(rows[0]["device"], Value::Null);
    assert_eq!(rows[0]["sessionFile"], "/local/session.jsonl");
    assert_eq!(rows[1]["device"], "peer");
    assert_eq!(rows[1]["sessionFile"], "/host/session.jsonl");
    assert_eq!(rows[0]["facts"]["busy"], false);
    assert!(rows[0]["pendingPlan"].is_null());
    assert!(
        service
            .session_owner("/local/session.jsonl", None)
            .await
            .unwrap()["tabId"]
            == "local"
    );
    assert!(
        !service
            .session_running("/local/session.jsonl", None)
            .await
            .unwrap()
    );
    service.guard_plan("local", false).await.unwrap();
    assert!(
        !service
            .note_draft("local", 17, "set_next_prompt_draft", false)
            .await
            .unwrap()
    );
    assert!(
        !service
            .note_draft("local", 18, "set_next_prompt_draft", true)
            .await
            .unwrap()
    );
    assert!(
        service
            .note_draft("local", 17, "set_next_prompt_draft", true)
            .await
            .unwrap()
    );
    service
        .feed("local", "events", json!([{"type": "agent_start"}]), false)
        .await
        .unwrap();
    service.feed("local", "events", json!([{"type": "agent_end", "messages": [
        {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "done"}]}
    ]}]), false).await.unwrap();
    service
        .execute(false, |ctx, _| {
            Outcome::Later(Box::pin(async move {
                ctx.announce_run("local").await?;
                Ok(Value::Null)
            }))
        })
        .await
        .unwrap();
    service
        .feed("local", "events", json!([{"type": "agent_start"}]), false)
        .await
        .unwrap();
    service.feed("local", "events", json!([{"type": "agent_end", "messages": [
        {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "done"}]}
    ]}]), false).await.unwrap();
    {
        let announcements = locked(&host.announcements);
        assert_eq!(announcements[0].0["type"], "busy");
        assert_eq!(announcements[0].1[0]["facts"]["busy"], true);
        assert_eq!(announcements[0].1[0]["sessionFile"], "/local/session.jsonl");
        assert_eq!(announcements[1].0["type"], "idle");
        assert_eq!(announcements[1].1[0]["facts"]["busy"], false);
        assert_eq!(announcements[1].0["outcome"]["reply"], "done");
        assert_eq!(announcements[0].2, None);
        assert!(announcements[1].2.is_some());
        assert_eq!(announcements[1].2, announcements[2].2);
        assert_ne!(announcements[1].2, announcements[4].2);
        assert_eq!(host.running_changes.load(Ordering::SeqCst), 4);
    }
    let out = service.out;
    drop(service);
    let (send, recv) = oneshot::channel();
    hub::post(move || {
        let _ = send.send(out.open());
    });
    assert!(!recv.await.unwrap());
}

#[cfg(unix)]
struct SidecarSink;

#[cfg(unix)]
impl crate::sidecar::native::Sink for SidecarSink {
    fn event(&self, _: crate::sidecar::LaneEvent) {}
    fn before_response(&self) {}
    fn remove_listeners(&self) {}
    fn sync_settings(&self) -> EffectFuture<'_, ()> {
        Box::pin(async {})
    }
}

#[cfg(unix)]
#[tokio::test]
async fn binding_checks_the_actual_source_before_mutating_the_pool_entry() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::default());
    let app = Arc::new(Application::new(host));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7002,
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "binding", "win": 17, "status": "asleep", "sessionFile": "/session.jsonl"}]}), false).await.unwrap();
    let (events_a, _output_a, _frames_a) = crate::server::Events::capture();
    let (events_b, _output_b, _frames_b) = crate::server::Events::capture();
    let config = |tab: &str| SidecarConfig {
        tab: tab.into(),
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
    };
    let (old, old_held) = SidecarService::new(
        config("bind-old"),
        events_a,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    let (current, current_held) = SidecarService::new(
        config("bind-current"),
        events_b,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("binding".into()),
        super::super::Handle {
            sidecar: Arc::clone(&current),
            device: None,
        },
    );
    let owner = ompdesk_app_contract::OwnerIssuer::new(1)
        .admit_authenticated()
        .unwrap();
    let target = pool
        .session_target(&owner, "/session.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(target.tab, "binding");
    assert!(Arc::ptr_eq(&target.sidecar, &current));
    let mut stale_generation = target.clone();
    stale_generation.generation = stale_generation.generation.wrapping_add(1);
    assert!(
        pool.note_name_for_session(&owner, &stale_generation, "not current")
            .await
            .is_err()
    );
    let mut stale_incarnation = target.clone();
    stale_incarnation.incarnation = stale_incarnation.incarnation.wrapping_add(1);
    assert!(
        pool.note_name_for_session(&owner, &stale_incarnation, "not current")
            .await
            .is_err()
    );
    pool.note_name_for_session(&owner, &target, "captured title")
        .await
        .unwrap();
    assert_eq!(
        pool.facts("binding").await.unwrap()["title"],
        "captured title"
    );
    app.handles().insert(
        super::super::HandleKey::Tab("binding".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    assert!(
        pool.command_for_session(&owner, &target, json!({"type": "abort"}))
            .await
            .is_err()
    );
    assert!(pool.stop_session(&owner, &target).await.is_err());
    assert!(pool.close_session_tab(&owner, &target).await.is_err());
    assert!(
        pool.note_name_for_session(&owner, &target, "wrong source")
            .await
            .is_err()
    );
    assert!(
        pool.bridge_if_live(
            &owner,
            "binding",
            Arc::clone(&current),
            0,
            "worktree.create".into(),
            None,
            None
        )
        .await
        .is_err()
    );
    app.handles().insert(
        super::super::HandleKey::Tab("binding".into()),
        super::super::Handle {
            sidecar: Arc::clone(&current),
            device: None,
        },
    );
    assert!(
        pool.stock_if_live(
            &owner,
            "binding",
            Arc::clone(&current),
            u64::MAX,
            json!({"type": "get_state"})
        )
        .await
        .is_err()
    );
    assert!(
        !pool
            .bind_if_live(
                &owner,
                "binding",
                Arc::clone(&old),
                json!({"branch": "old"})
            )
            .await
            .unwrap()
    );
    let unchanged = pool
        .execute(false, |ctx, _| {
            Outcome::Now(Ok(ctx.with(|state| {
                state
                    .entry("binding")
                    .and_then(|entry| entry.worktree.clone())
                    .unwrap_or(Value::Null)
            })))
        })
        .await
        .unwrap();
    assert_eq!(unchanged, Value::Null);
    assert!(
        pool.bind_if_live(
            &owner,
            "binding",
            Arc::clone(&current),
            json!({"branch": "new"})
        )
        .await
        .unwrap()
    );
    let value = pool
        .execute(false, |ctx, _| {
            Outcome::Now(Ok(ctx.with(|state| {
                state
                    .entry("binding")
                    .and_then(|entry| entry.worktree.clone())
                    .unwrap_or(Value::Null)
            })))
        })
        .await
        .unwrap();
    assert_eq!(value, json!({"branch": "new"}));
    old.dispose(std::time::Duration::ZERO);
    current.dispose(std::time::Duration::ZERO);
    old_held.await.unwrap();
    current_held.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn detached_release_disposes_the_captured_lane_not_its_replacement() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let config = |tab: &str| SidecarConfig {
        tab: tab.into(),
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
    };
    let (events_a, _output_a, _frames_a) = crate::server::Events::capture();
    let (events_b, _output_b, _frames_b) = crate::server::Events::capture();
    let (old, old_held) = SidecarService::new(
        config("release-old"),
        events_a,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    let (replacement, replacement_held) = SidecarService::new(
        config("release-new"),
        events_b,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("shared".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    assert!(
        app.effect(&json!({"k": "gone", "tab": "shared", "incarnation": 17}))
            .is_none()
    );
    app.handles().insert(
        super::super::HandleKey::Tab("shared".into()),
        super::super::Handle {
            sidecar: Arc::clone(&replacement),
            device: None,
        },
    );
    app.ask("dispose", &json!({"tab": "shared", "incarnation": 17}))
        .await
        .unwrap();
    let release = locked(&host.releases).pop().unwrap();
    assert!(Arc::ptr_eq(&release.source, &old));
    release.exited.await.unwrap();
    old_held.await.unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("already-closed".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    assert!(
        app.effect(&json!({"k": "gone", "tab": "already-closed", "incarnation": 18}))
            .is_none()
    );
    app.ask(
        "dispose",
        &json!({"tab": "already-closed", "incarnation": 18}),
    )
    .await
    .unwrap();
    let failed = locked(&host.releases).pop().unwrap();
    assert!(failed.exited.await.is_err());
    assert!(Arc::ptr_eq(&app.sidecar("shared").unwrap(), &replacement));
    replacement.barrier().await.unwrap();
    replacement.dispose(std::time::Duration::ZERO);
    replacement_held.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn session_close_keeps_the_detached_source_when_the_tab_is_replaced() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7003,
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "closing", "win": 17, "status": "asleep", "sessionFile": "/closing.jsonl"}]}), false).await.unwrap();
    let config = |tab: &str| SidecarConfig {
        tab: tab.into(),
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
    };
    let (events_a, _output_a, _frames_a) = crate::server::Events::capture();
    let (events_b, _output_b, _frames_b) = crate::server::Events::capture();
    let (old, old_held) = SidecarService::new(
        config("close-engine-old"),
        events_a,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    let (replacement, replacement_held) = SidecarService::new(
        config("close-engine-new"),
        events_b,
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("closing".into()),
        super::super::Handle {
            sidecar: Arc::clone(&old),
            device: None,
        },
    );
    *locked(&host.on_gone) = Some((Arc::downgrade(&app), Arc::clone(&replacement)));
    let owner = ompdesk_app_contract::OwnerIssuer::new(1)
        .admit_authenticated()
        .unwrap();
    let target = pool
        .session_target(&owner, "/closing.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        pool.close_session_tab(&owner, &target).await.unwrap(),
        SessionRelease::Released(Ok(()))
    ));
    old_held.await.unwrap();
    assert!(Arc::ptr_eq(&app.sidecar("closing").unwrap(), &replacement));
    replacement.barrier().await.unwrap();
    replacement.dispose(std::time::Duration::ZERO);
    replacement_held.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn observer_failure_still_disposes_and_waits_for_the_exact_receipt() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7004,
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: false,
            now_ms: || 1234,
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "fault-close", "win": 17, "status": "asleep", "sessionFile": "/fault.jsonl"}]}), false).await.unwrap();
    let (events, _output, _frames) = crate::server::Events::capture();
    let (source, held) = SidecarService::new(
        SidecarConfig {
            tab: "fault-close-lane".into(),
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
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("fault-close".into()),
        super::super::Handle {
            sidecar: Arc::clone(&source),
            device: None,
        },
    );
    let (gate, gated) = oneshot::channel();
    let (entered, seen) = oneshot::channel();
    *locked(&host.receipt_gate) = Some(gated);
    *locked(&host.receipt_entered) = Some(entered);
    host.fail_running.store(true, Ordering::SeqCst);
    let owner = ompdesk_app_contract::OwnerIssuer::new(1)
        .admit_authenticated()
        .unwrap();
    let target = pool
        .session_target(&owner, "/fault.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    let closing = tokio::spawn(pool.close_session_tab(&owner, &target));
    seen.await.unwrap();
    assert!(!closing.is_finished());
    gate.send(Err(Fault::new("exit_failed", "Exit proof failed")))
        .unwrap();
    let SessionRelease::Released(Err(error)) = closing.await.unwrap().unwrap() else {
        panic!("the committed release must retain its observer failure");
    };
    assert_eq!(error.code, "observer_failed");
    held.await.unwrap();
    assert!(app.sidecar("fault-close").is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn window_observer_failure_after_disposal_still_waits_for_exit_result() {
    use crate::sidecar::native::{Config as SidecarConfig, DirectSpawn, Service as SidecarService};
    let host = Arc::new(TestHost::default());
    let app = Arc::new(Application::new(Arc::clone(&host)));
    let pool = Service::new(
        Config {
            id: 0x706f_6f6c_6170_7005,
            layout_version: 1,
            max_former_tab_ids: 8,
            stop_session_wait_ms: 60_000,
            window_tabs_hook: true,
            now_ms: || 1234,
        },
        Arc::clone(&app),
    )
    .await
    .unwrap();
    pool.call("seed", json!({"tabs": [{"tab": "window-fault", "win": 17, "status": "asleep", "sessionFile": "/window-fault.jsonl"}]}), false).await.unwrap();
    let (events, _output, _frames) = crate::server::Events::capture();
    let (source, held) = SidecarService::new(
        SidecarConfig {
            tab: "window-fault-lane".into(),
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
        Arc::new(SidecarSink),
        Arc::new(DirectSpawn),
    )
    .unwrap();
    app.handles().insert(
        super::super::HandleKey::Tab("window-fault".into()),
        super::super::Handle {
            sidecar: source,
            device: None,
        },
    );
    let (gate, gated) = oneshot::channel();
    let (entered, seen) = oneshot::channel();
    *locked(&host.receipt_gate) = Some(gated);
    *locked(&host.receipt_entered) = Some(entered);
    host.fail_window_tabs.store(true, Ordering::SeqCst);
    let owner = ompdesk_app_contract::OwnerIssuer::new(1)
        .admit_authenticated()
        .unwrap();
    let target = pool
        .session_target(&owner, "/window-fault.jsonl", None)
        .await
        .unwrap()
        .unwrap();
    let closing = tokio::spawn(pool.close_session_tab(&owner, &target));
    seen.await.unwrap();
    assert!(!closing.is_finished());
    gate.send(Err(Fault::new("exit_failed", "Exit proof failed")))
        .unwrap();
    let SessionRelease::Released(Err(error)) = closing.await.unwrap().unwrap() else {
        panic!("the committed release must retain its window observer failure");
    };
    assert_eq!(error.code, "window_observer_failed");
    held.await.unwrap();
}
