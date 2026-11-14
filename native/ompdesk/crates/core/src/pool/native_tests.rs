use super::*;
use crate::pool::application::{Released, Spawn, asks::Collaborators};

#[derive(Default)]
struct TestHost {
    listening: Mutex<Vec<i64>>,
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
    fn released(&self, _: Released) {
        unreachable!()
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
    fn activity(&self, _: Value) {
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
    fn running_changed(&self) {
        unreachable!()
    }
    fn session_files_changed(&self) {
        unreachable!()
    }
    fn window_tabs_changed(&self, _: i64, _: Value) {
        unreachable!()
    }
    fn exiting(&self, _: String) -> EffectFuture<'_, ()> {
        unreachable!()
    }
    fn command(
        &self,
        _: Arc<Self::Sidecar>,
        _: Value,
    ) -> EffectFuture<'static, Result<Value, Fault>> {
        unreachable!()
    }
}

impl effects::Host for TestHost {
    fn notify(&self, notification: effects::Notification) {
        match notification {
            effects::Notification::ListenClosed { window } => locked(&self.listening).push(window),
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
        unreachable!()
    }
    fn when_released(&self, _: String) -> EffectFuture<'static, ()> {
        unreachable!()
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
    let out = service.out;
    drop(service);
    let (send, recv) = oneshot::channel();
    hub::post(move || {
        let _ = send.send(out.open());
    });
    assert!(!recv.await.unwrap());
}
