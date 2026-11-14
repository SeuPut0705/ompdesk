//! Isolated policy tests over real encrypted links. The Host effect double does not prove the native pool adapter.
use super::*;
use crate::remote::quota::{Limits, QuotaRecord, QuotaStore};
use crate::remote::requests::tests::pair;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;

type Listener = Arc<dyn Fn(String, Value) + Send + Sync>;
pub(crate) struct Target {
    pub(crate) state: Mutex<Snapshot>,
    listeners: Mutex<Vec<Listener>>,
    answers: Mutex<HashSet<String>>,
}
#[derive(Clone)]
pub(crate) struct Caller(pub(crate) String);
pub(crate) struct Effects {
    pub(crate) targets: Mutex<HashMap<String, Arc<Target>>>,
    calls: AtomicUsize,
    opens: AtomicUsize,
    closed: AtomicUsize,
    fail: AtomicBool,
    block: AtomicBool,
    acquired: Semaphore,
    release: Semaphore,
    block_close: AtomicBool,
    close_started: Semaphore,
    close_release: Semaphore,
    closed_targets: Mutex<Vec<Arc<Target>>>,
    block_runtime: AtomicBool,
    runtime_started: Semaphore,
    runtime_release: Semaphore,
    fail_after_close: AtomicBool,
    session_effects: Mutex<Vec<(Arc<Target>, Value)>>,
    fail_session_effect: AtomicBool,
    capture_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    pub(crate) snapshot_failure: Mutex<Option<Fault>>,
    capture_started: Semaphore,
}
impl Effects {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            targets: Mutex::default(),
            calls: AtomicUsize::new(0),
            opens: AtomicUsize::new(0),
            closed: AtomicUsize::new(0),
            fail: AtomicBool::new(false),
            block: AtomicBool::new(false),
            acquired: Semaphore::new(0),
            release: Semaphore::new(0),
            block_close: AtomicBool::new(false),
            close_started: Semaphore::new(0),
            close_release: Semaphore::new(0),
            closed_targets: Mutex::default(),
            block_runtime: AtomicBool::new(false),
            runtime_started: Semaphore::new(0),
            runtime_release: Semaphore::new(0),
            fail_after_close: AtomicBool::new(false),
            session_effects: Mutex::default(),
            fail_session_effect: AtomicBool::new(false),
            capture_gate: Mutex::default(),
            snapshot_failure: Mutex::default(),
            capture_started: Semaphore::new(0),
        })
    }

    fn record_session_effect(&self, target: &Arc<Target>, command: Value) -> Result<(), Fault> {
        lock(&self.session_effects).push((Arc::clone(target), command));
        if self.fail_session_effect.load(Ordering::SeqCst) {
            return Err(Fault::new(
                "session_effect_failed",
                "The native session effect failed",
            ));
        }
        Ok(())
    }
}
impl Host for Effects {
    type Owner = Caller;
    type Target = Arc<Target>;
    fn peer(&self, owner: &Caller) -> Peer {
        Peer {
            device_id: owner.0.clone(),
            name: owner.0.clone(),
        }
    }
    async fn acquire(&self, _: &Caller, options: Open) -> Result<Arc<Target>, Fault> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        if self.block.load(Ordering::SeqCst) {
            self.acquired.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        let file = options
            .session_path
            .unwrap_or_else(|| "/session/new.jsonl".into());
        let mut targets = lock(&self.targets);
        Ok(targets
            .entry(file.clone())
            .or_insert_with(|| {
                Arc::new(Target {
                    state: Mutex::new(Snapshot {
                        cwd: "/workspace".into(),
                        kind: "agent".into(),
                        status: "asleep".into(),
                        status_detail: json!({}),
                        process_alive: false,
                        omp: "process-one".into(),
                        session_path: Some(file),
                        viewing: false,
                        busy: false,
                        awaiting_connection: false,
                        scheduled_retry: Value::Null,
                        views: 0,
                        run: json!({"running":false}),
                        asks: vec![json!({"id":"ask","method":"input","title":"question"})],
                        sign_ins: vec![],
                        pending_plan: None,
                        kept: None,
                    }),
                    listeners: Mutex::default(),
                    answers: Mutex::default(),
                })
            })
            .clone())
    }
    fn snapshot(&self, target: &Arc<Target>) -> Result<Snapshot, Fault> {
        if let Some(failure) = lock(&self.snapshot_failure).as_ref() {
            return Err(failure.clone());
        }
        Ok(lock(&target.state).clone())
    }
    async fn capture_session_target(
        &self,
        target: &Arc<Target>,
        expected_path: &str,
    ) -> Result<Arc<Target>, Fault> {
        let gate = lock(&self.capture_gate).take();
        self.capture_started.add_permits(1);
        if let Some(gate) = gate {
            gate.await
                .map_err(|_| Fault::new("capture_lost", "Capture gate dropped"))?;
        }
        if lock(&target.state).session_path.as_deref() != Some(expected_path) {
            return Err(Fault::new(
                "session_changed",
                "The hosted session path changed",
            ));
        }
        Ok(Arc::clone(target))
    }
    async fn stop_session(&self, target: &Arc<Target>) -> Result<(), Fault> {
        self.record_session_effect(target, json!({"type":"stop"}))
    }
    async fn command_session(&self, target: &Arc<Target>, command: Value) -> Result<Value, Fault> {
        self.record_session_effect(target, command)?;
        Ok(json!({
            "type":"response",
            "command":"set_session_name",
            "success":false,
            "error":"Stock rejected the name",
            "data":{"preserved":true}
        }))
    }
    async fn note_session_name(&self, target: &Arc<Target>, name: &str) -> Result<(), Fault> {
        self.record_session_effect(target, json!({"type":"note_session_name","name":name}))
    }
    async fn session_runtime(&self, target: &Arc<Target>) -> Result<SessionRuntime, Fault> {
        self.runtime_started.add_permits(1);
        if self.block_runtime.load(Ordering::SeqCst) {
            self.runtime_release.acquire().await.unwrap().forget();
        }
        use crate::session_ops::{Activity, RuntimeState};
        let snapshot = lock(&target.state);
        Ok(SessionRuntime {
            activity: if snapshot.run["compacting"] == true {
                Activity::Compacting
            } else if snapshot.run["running"] == true {
                Activity::Running
            } else {
                Activity::Idle
            },
            state: match snapshot.status.as_str() {
                "ready" => RuntimeState::Ready,
                "asleep" => RuntimeState::Dormant,
                _ => RuntimeState::Starting,
            },
        })
    }
    async fn close_session(&self, target: Arc<Target>) -> Result<SessionRelease, Fault> {
        if self.session_runtime(&target).await?.activity != crate::session_ops::Activity::Idle {
            return Ok(SessionRelease::Busy);
        }
        self.close_started.add_permits(1);
        if self.block_close.load(Ordering::SeqCst) {
            self.close_release.acquire().await.unwrap().forget();
        }
        lock(&self.closed_targets).push(target);
        self.closed.fetch_add(1, Ordering::SeqCst);
        Ok(SessionRelease::Released(
            if self.fail_after_close.load(Ordering::SeqCst) {
                Err(Fault::new("after_close", "A post-release observer failed"))
            } else {
                Ok(())
            },
        ))
    }
    fn listen(&self, target: &Arc<Target>, event: Listener) -> Result<(), Fault> {
        lock(&target.listeners).push(event);
        Ok(())
    }
    fn start(&self, target: &Arc<Target>) -> Result<(), Fault> {
        {
            let mut state = lock(&target.state);
            state.status = "ready".into();
            state.process_alive = true;
        }
        let listeners = lock(&target.listeners).clone();
        for listener in listeners {
            listener("status".into(), json!({"status":"ready"}));
        }
        Ok(())
    }
    fn restart(
        &self,
        target: &Arc<Target>,
        _: Option<String>,
        _: Option<String>,
    ) -> Result<(), Fault> {
        self.start(target)
    }
    fn adopt_cwd(&self, target: &Arc<Target>, cwd: String) -> Result<bool, Fault> {
        lock(&target.state).cwd = cwd;
        Ok(true)
    }
    async fn command(
        &self,
        _: &Caller,
        target: &Arc<Target>,
        _: Value,
        _: Option<Duration>,
    ) -> ResultValue {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"success":!self.fail.load(Ordering::SeqCst),"data":lock(&target.state).session_path}),
        )
    }
    async fn side_channel(
        &self,
        _: &Caller,
        target: &Arc<Target>,
        frame: Value,
    ) -> Result<(), Fault> {
        if frame["type"] == "extension_ui_response"
            && let Some(id) = frame["id"].as_str()
            && !lock(&target.answers).insert(id.to_owned())
        {
            return Err(Fault::new("already_answered", "Already answered"));
        }
        Ok(())
    }
    async fn close(&self, _: Arc<Target>) -> Result<(), Fault> {
        self.closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn cancel_wait(&self, _: &Arc<Target>) -> Result<(), Fault> {
        Ok(())
    }
    fn sync_image_generation(&self, _: &Arc<Target>) -> Result<(), Fault> {
        Ok(())
    }
    async fn upload(&self, _: &Caller, upload: super::super::uploads::Upload) -> ResultValue {
        Ok(json!({"path":upload.name,"size":upload.bytes.len()}))
    }
    fn prepare_request(
        &self,
        _: &Caller,
        request: HostRequest,
    ) -> Result<impl Future<Output = ResultValue> + Send, Fault> {
        Err::<std::future::Ready<ResultValue>, _>(Fault::new("invalid_params", request.method))
    }
    fn disconnected(&self, _: &Caller) {}
    fn publish(&self, _: &str, _: &Value) {}
}
#[derive(Default)]
struct Records(Mutex<HashMap<String, QuotaRecord>>);
impl QuotaStore for Records {
    fn update(
        &self,
        id: &str,
        change: &mut dyn FnMut(&mut QuotaRecord) -> bool,
    ) -> Result<bool, Fault> {
        let mut records = lock(&self.0);
        let Some(record) = records.get_mut(id) else {
            return Ok(false);
        };
        change(record);
        Ok(true)
    }
}
pub(crate) fn service() -> (Arc<HostServices<Effects>>, Arc<Effects>, Arc<PeerQuota>) {
    let effects = Effects::new();
    let records = Arc::new(Records::default());
    lock(&records.0).insert("peer".into(), QuotaRecord::default());
    let quota = Arc::new(PeerQuota::new(records));
    quota
        .set_limits(
            "peer",
            Limits {
                requests_per_day: Some(10.0),
                tokens_per_day: None,
            },
        )
        .unwrap();
    (
        HostServices::new(
            Arc::clone(&effects),
            Arc::clone(&quota),
            DeliveryLedger::default(),
            Config {
                max_former_tab_ids: 8,
            },
        ),
        effects,
        quota,
    )
}
fn open(rtab: &str) -> Value {
    json!({"rtab":rtab,"cwd":"/workspace","kind":"agent","sessionPath":"/session/one.jsonl"})
}

#[tokio::test]
async fn concurrent_open_and_relaunched_peer_adoption_keep_one_target_and_route_new_rtab_events() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (device, host, _keep) = pair().await;
    let (first, second) = tokio::join!(
        service.call(&owner, "tab.open", open("one"), &host),
        service.call(&owner, "tab.open", open("one"), &host)
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(effects.opens.load(Ordering::SeqCst), 1);
    service
        .call(&owner, "tab.start", json!({"rtab":"one"}), &host)
        .await
        .unwrap();
    service.disconnected(&owner, &host);
    let (new_device, new_host, _new_keep) = pair().await;
    let mut events = new_device.events();
    let adopted = service
        .call(&owner, "tab.open", open("new-id"), &new_host)
        .await
        .unwrap();
    assert_eq!(adopted["attached"], true);
    assert_eq!(effects.opens.load(Ordering::SeqCst), 1);
    service
        .call(&owner, "tab.start", json!({"rtab":"new-id"}), &new_host)
        .await
        .unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event.data["rtab"], "new-id");
    let duplicate = service
        .call(&owner, "tab.open", open("duplicate"), &new_host)
        .await
        .unwrap_err();
    assert_eq!(duplicate.fault.code, "session_open_in_tab");
    assert_eq!(duplicate.holder.unwrap()["rtab"], "new-id");
    service.drop_peer("peer").await.unwrap();
    device.disconnect_for_test();
    host.disconnect_for_test();
    new_device.disconnect_for_test();
    new_host.disconnect_for_test();
}

#[tokio::test]
async fn a_close_during_acquire_cannot_leave_an_orphan_target() {
    let (service, effects, _) = service();
    effects.block.store(true, Ordering::SeqCst);
    let (device, host, _keep) = pair().await;
    let owner = Caller("peer".into());
    let opening = service.call(&owner, "tab.open", open("one"), &host);
    let close = async {
        effects.acquired.acquire().await.unwrap().forget();
        service
            .call(&owner, "tab.close", json!({"rtab":"one"}), &host)
            .await
            .unwrap();
        effects.release.add_permits(1);
    };
    let (result, ()) = tokio::join!(opening, close);
    assert_eq!(result.unwrap_err().fault.code, "unknown_tab");
    assert_eq!(effects.closed.load(Ordering::SeqCst), 1);
    assert!(lock(&service.state).tabs.is_empty());
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn retried_delivery_reserves_quota_once_and_failed_commands_refund() {
    let (service, effects, quota) = service();
    let owner = Caller("peer".into());
    let (device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let params =
        json!({"rtab":"one","command":{"type":"prompt","message":"hello","deliveryId":"delivery"}});
    let (first, second) = tokio::join!(
        service.call(&owner, "tab.command", params.clone(), &host),
        service.call(&owner, "tab.command", params, &host)
    );
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(effects.calls.load(Ordering::SeqCst), 1);
    assert_eq!(quota.usage("peer").unwrap().requests, 1.0);
    effects.fail.store(true, Ordering::SeqCst);
    service
        .call(
            &owner,
            "tab.command",
            json!({"rtab":"one","command":{"type":"prompt"}}),
            &host,
        )
        .await
        .unwrap();
    assert_eq!(quota.usage("peer").unwrap().requests, 1.0);
    let response =
        json!({"rtab":"one","frame":{"type":"extension_ui_response","id":"ask","value":"first"}});
    service
        .call(&owner, "tab.sideChannel", response.clone(), &host)
        .await
        .unwrap();
    assert_eq!(
        service
            .call(&owner, "tab.sideChannel", response, &host)
            .await
            .unwrap_err()
            .fault
            .code,
        "already_answered"
    );
    service.drop_peer("peer").await.unwrap();
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn admission_before_poll_cannot_rebind_a_command_or_revive_a_closed_open() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let command = service.call(
        &owner,
        "tab.command",
        json!({"rtab":"one","command":{"type":"get_state"}}),
        &host,
    );
    let close = service.call(&owner, "tab.close", json!({"rtab":"one"}), &host);
    let mut replacement = open("one");
    replacement["sessionPath"] = "/session/replacement.jsonl".into();
    service
        .call(&owner, "tab.open", replacement, &host)
        .await
        .unwrap();
    assert_eq!(command.await.unwrap()["data"], "/session/one.jsonl");
    close.await.unwrap();
    assert_eq!(effects.closed.load(Ordering::SeqCst), 1);
    let unopened = service.call(&owner, "tab.open", open("pending"), &host);
    service
        .call(&owner, "tab.close", json!({"rtab":"pending"}), &host)
        .await
        .unwrap();
    assert_eq!(unopened.await.unwrap_err().fault.code, "unknown_tab");
    assert_eq!(effects.opens.load(Ordering::SeqCst), 2);
    service.drop_peer("peer").await.unwrap();
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn a_restored_peer_marker_is_not_started_twice_when_its_device_returns() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let marker = Resume {
        tab: "peer:peer:old-id".into(),
        cwd: "/workspace".into(),
        kind: "agent".into(),
        session_path: Some("/session/one.jsonl".into()),
    };
    assert_eq!(
        service
            .revive(&owner, marker.clone())
            .await
            .unwrap()
            .as_deref(),
        Some("peer:peer:old-id")
    );
    assert_eq!(
        service.revive(&owner, marker).await.unwrap().as_deref(),
        Some("peer:peer:old-id")
    );
    assert_eq!(effects.opens.load(Ordering::SeqCst), 1);
    let (device, host, _keep) = pair().await;
    let opened = service
        .call(&owner, "tab.open", open("new-id"), &host)
        .await
        .unwrap();
    assert_eq!(opened["attached"], false);
    assert_eq!(effects.opens.load(Ordering::SeqCst), 1);
    assert_eq!(
        lock(&service.state).tabs[&("peer".into(), "new-id".into())].former,
        vec!["old-id"]
    );
    service
        .call(&owner, "tab.start", json!({"rtab":"new-id"}), &host)
        .await
        .unwrap();
    assert!(
        lock(&effects.targets)
            .get("/session/one.jsonl")
            .unwrap()
            .state
            .lock()
            .unwrap()
            .process_alive
    );
    service.drop_peer("peer").await.unwrap();
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn native_validation_errors_precede_quota_admission() {
    let (service, _, quota) = service();
    quota
        .set_limits(
            "peer",
            Limits {
                requests_per_day: Some(0.0),
                tokens_per_day: None,
            },
        )
        .unwrap();
    let (device, host, _keep) = pair().await;
    let error = service
        .call(
            &Caller("peer".into()),
            "host.bench.run",
            json!({"options":{"models":[],"runs":1}}),
            &host,
        )
        .await
        .unwrap_err();
    assert_eq!(error.fault.code, "invalid_params");
    assert_eq!(quota.usage("peer").unwrap().requests, 0.0);
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn sign_in_callback_is_bound_to_live_target_state_and_consumed_before_polling() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (service, effects, quota) = service();
    let owner = Caller("peer".into());
    let (device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let target = lock(&effects.targets)
        .get("/session/one.jsonl")
        .unwrap()
        .clone();
    lock(&target.state).sign_ins.push("provider".into());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let authorization = format!(
        "https://provider.invalid/?redirect_uri=http%3A%2F%2F127.0.0.1%3A{}%2Fcallback&state=expected",
        listener.local_addr().unwrap().port()
    );
    let advertise = || {
        for listener in lock(&target.listeners).clone() {
            listener(
                "extensionUi".into(),
                json!({"method":"open_url","url":authorization,"launchUrl":authorization}),
            );
        }
    };
    advertise();
    let params = json!({"rtab":"one","path":"/callback","query":"state=expected&code=opaque"});
    for invalid in [
        json!({"rtab":"one","path":"/wrong","query":"state=expected"}),
        json!({"rtab":"one","path":"/callback","query":"state=wrong&state=expected"}),
    ] {
        assert_eq!(
            service
                .call(&owner, "host.signIn.callback", invalid, &host)
                .await
                .unwrap_err()
                .fault
                .code,
            "sign_in_unavailable"
        );
    }
    let mut extra = params.clone();
    extra["url"] = json!("http://127.0.0.1:1/forbidden");
    assert_eq!(
        service
            .call(&owner, "host.signIn.callback", extra, &host)
            .await
            .unwrap_err()
            .fault
            .code,
        "invalid_params"
    );
    let first = service.call(&owner, "host.signIn.callback", params.clone(), &host);
    assert_eq!(
        service
            .call(&owner, "host.signIn.callback", params.clone(), &host)
            .await
            .unwrap_err()
            .fault
            .code,
        "sign_in_unavailable"
    );
    let respond = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
        }
        assert!(
            String::from_utf8(request)
                .unwrap()
                .starts_with("GET /callback?state=expected&code=opaque HTTP/1.1\r\n")
        );
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndone").await.unwrap();
    };
    let (page, ()) = tokio::join!(first, respond);
    assert_eq!(
        page.unwrap(),
        json!({"status":200,"contentType":"text/plain","body":"done"})
    );
    advertise();
    drop(listener);
    assert_eq!(
        service
            .call(&owner, "host.signIn.callback", params.clone(), &host)
            .await
            .unwrap_err()
            .fault
            .code,
        "sign_in_unavailable"
    );
    assert!(
        lock(&service.state)
            .tabs
            .values()
            .all(|tab| tab.callback.is_none())
    );
    advertise();
    lock(&target.state).sign_ins.clear();
    for listener in lock(&target.listeners).clone() {
        listener("signIn".into(), json!({"active":[]}));
    }
    assert_eq!(
        service
            .call(&owner, "host.signIn.callback", params, &host)
            .await
            .unwrap_err()
            .fault
            .code,
        "sign_in_unavailable"
    );
    assert_eq!(quota.usage("peer").unwrap().requests, 0.0);
    service.drop_peer("peer").await.unwrap();
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn captured_session_follows_rekey_but_never_closes_a_replacement() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("old"), &host)
        .await
        .unwrap();
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    let original = captured.holders[0].runtime.target().clone();
    service.disconnected(&owner, &host);
    let (_new_device, new_host, _new_keep) = pair().await;
    service
        .call(&owner, "tab.open", open("new"), &new_host)
        .await
        .unwrap();
    service
        .close_session_ticket(&captured.holders[0].runtime)
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&lock(&effects.closed_targets)[0], &original));
    assert!(service.target("peer", "new").is_err());

    lock(&effects.targets).remove("/session/one.jsonl");
    service
        .call(&owner, "tab.open", open("new"), &new_host)
        .await
        .unwrap();
    let replacement = service.target("peer", "new").unwrap();
    assert!(!Arc::ptr_eq(&original, &replacement));
    assert_eq!(
        service
            .close_session_ticket(&captured.holders[0].runtime)
            .await
            .unwrap_err()
            .code,
        "session_changed"
    );
    assert!(Arc::ptr_eq(
        &service.target("peer", "new").unwrap(),
        &replacement
    ));
    assert_eq!(lock(&effects.closed_targets).len(), 1);
}

#[tokio::test]
async fn captured_activity_reports_compaction_and_starting_without_closing() {
    use crate::session_ops::{Activity, RuntimeState};
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let target = service.target("peer", "one").unwrap();
    {
        let mut snapshot = lock(&target.state);
        snapshot.run = json!({"running":false,"compacting":true});
        snapshot.status = "starting".into();
    }
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    assert_eq!(captured.holders[0].activity, Activity::Compacting);
    assert_eq!(captured.holders[0].state, RuntimeState::Starting);
    assert_eq!(
        service
            .close_session_ticket(&captured.holders[0].runtime)
            .await
            .unwrap_err()
            .code,
        "session_running"
    );
    assert_eq!(effects.closed.load(Ordering::SeqCst), 0);
    assert!(service.target("peer", "one").is_ok());
}

#[tokio::test]
async fn failed_status_notification_does_not_skip_joining_the_captured_close() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    effects.block_close.store(true, Ordering::SeqCst);
    host.disconnect_for_test();
    let closing = {
        let service = Arc::clone(&service);
        tokio::spawn(async move {
            service
                .close_session_ticket(&captured.holders[0].runtime)
                .await
        })
    };
    effects.close_started.acquire().await.unwrap().forget();
    assert!(!closing.is_finished());
    effects.close_release.add_permits(1);
    assert!(closing.await.unwrap().is_err());
    assert_eq!(effects.closed.load(Ordering::SeqCst), 1);
    assert!(service.target("peer", "one").is_err());
}

#[tokio::test]
async fn a_committed_close_error_still_forgets_the_exact_hosted_ticket() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    effects.fail_after_close.store(true, Ordering::SeqCst);
    let error = service
        .close_session_ticket(&captured.holders[0].runtime)
        .await
        .unwrap_err();
    assert_eq!(error.code, "after_close");
    assert_eq!(effects.closed.load(Ordering::SeqCst), 1);
    assert!(service.target("peer", "one").is_err());
}

#[tokio::test]
async fn failed_captured_notice_still_notifies_current_connections() {
    let (service, _, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    service
        .close_session_ticket(&captured.holders[0].runtime)
        .await
        .unwrap();
    host.disconnect_for_test();
    let (other_device, other_host, _other_keep) = pair().await;
    let mut events = other_device.events();
    lock(&service.state)
        .connections
        .insert("other".into(), (other_host, json!({})));
    assert!(
        service
            .notify_session_deleted("/session/one.jsonl", captured.notices)
            .is_err()
    );
    let event = events.recv().await.unwrap();
    assert_eq!(event.event, "host.sessionsDeleted");
    assert_eq!(event.data, json!({"paths":["/session/one.jsonl"]}));
}

#[tokio::test]
async fn runtime_await_keeps_the_previously_captured_target_across_rekey() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("old"), &host)
        .await
        .unwrap();
    let original = service.target("peer", "old").unwrap();
    effects.block_runtime.store(true, Ordering::SeqCst);
    let capture = {
        let service = Arc::clone(&service);
        tokio::spawn(async move { service.capture_session("/session/one.jsonl").await })
    };
    effects.runtime_started.acquire().await.unwrap().forget();
    service.disconnected(&owner, &host);
    let (_device, new_host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("new"), &new_host)
        .await
        .unwrap();
    effects.runtime_release.add_permits(1);
    let captured = capture.await.unwrap().unwrap();
    assert!(Arc::ptr_eq(captured.holders[0].runtime.target(), &original));
    assert!(Arc::ptr_eq(
        &service.target("peer", "new").unwrap(),
        &original
    ));
}

#[tokio::test]
async fn captured_session_effects_keep_the_original_target_and_full_reply_after_rekey() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("old"), &host)
        .await
        .unwrap();
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    let ticket = &captured.holders[0].runtime;
    let original = ticket.target();
    service.disconnected(&owner, &host);
    let (_new_device, new_host, _new_keep) = pair().await;
    service
        .call(&owner, "tab.open", open("new"), &new_host)
        .await
        .unwrap();

    service.stop_session_ticket(ticket).await.unwrap();
    let command = json!({"type":"set_session_name","name":"sample"});
    let reply = service
        .command_session_ticket(ticket, command.clone())
        .await
        .unwrap();
    assert_eq!(
        reply,
        json!({
            "type":"response",
            "command":"set_session_name",
            "success":false,
            "error":"Stock rejected the name",
            "data":{"preserved":true}
        })
    );
    service
        .note_session_name_ticket(ticket, "sample")
        .await
        .unwrap();
    {
        let effects = lock(&effects.session_effects);
        assert_eq!(effects.len(), 3);
        assert!(
            effects
                .iter()
                .all(|(target, _)| Arc::ptr_eq(target, original))
        );
        assert_eq!(effects[0].1, json!({"type":"stop"}));
        assert_eq!(effects[1].1, command);
        assert_eq!(
            effects[2].1,
            json!({"type":"note_session_name","name":"sample"})
        );
    }
    assert!(Arc::ptr_eq(
        &service.target("peer", "new").unwrap(),
        original
    ));
    service.drop_peer("peer").await.unwrap();
}

#[tokio::test]
async fn replaced_hosted_ticket_refuses_all_session_effects_before_dispatch() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("same"), &host)
        .await
        .unwrap();
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    let ticket = &captured.holders[0].runtime;
    service.close_session_ticket(ticket).await.unwrap();
    lock(&effects.targets).remove("/session/one.jsonl");
    service
        .call(&owner, "tab.open", open("same"), &host)
        .await
        .unwrap();
    let replacement = service.target("peer", "same").unwrap();
    assert!(!Arc::ptr_eq(ticket.target(), &replacement));
    assert_eq!(
        service.stop_session_ticket(ticket).await.unwrap_err().code,
        "session_changed"
    );
    assert_eq!(
        service
            .command_session_ticket(ticket, json!({"type":"get_state"}))
            .await
            .unwrap_err()
            .code,
        "session_changed"
    );
    assert_eq!(
        service
            .note_session_name_ticket(ticket, "obsolete")
            .await
            .unwrap_err()
            .code,
        "session_changed"
    );
    assert!(lock(&effects.session_effects).is_empty());
    assert!(Arc::ptr_eq(
        &service.target("peer", "same").unwrap(),
        &replacement
    ));
    service.drop_peer("peer").await.unwrap();
}

#[tokio::test]
async fn captured_session_effect_failures_are_not_reported_as_success() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("one"), &host)
        .await
        .unwrap();
    let captured = service.capture_session("/session/one.jsonl").await.unwrap();
    let ticket = &captured.holders[0].runtime;
    effects.fail_session_effect.store(true, Ordering::SeqCst);
    let expected = Fault::new("session_effect_failed", "The native session effect failed");
    assert_eq!(
        service.stop_session_ticket(ticket).await,
        Err(expected.clone())
    );
    assert_eq!(
        service
            .command_session_ticket(ticket, json!({"type":"get_state"}))
            .await,
        Err(expected.clone())
    );
    assert_eq!(
        service.note_session_name_ticket(ticket, "sample").await,
        Err(expected)
    );
    assert_eq!(lock(&effects.session_effects).len(), 3);
    service.drop_peer("peer").await.unwrap();
}

#[tokio::test]
async fn a_path_changed_while_freezing_never_becomes_a_session_holder() {
    let (service, effects, _) = service();
    let owner = Caller("peer".into());
    let (_device, host, _keep) = pair().await;
    service
        .call(&owner, "tab.open", open("freezing"), &host)
        .await
        .unwrap();
    let original = service.target("peer", "freezing").unwrap();
    let (release, released) = tokio::sync::oneshot::channel();
    *lock(&effects.capture_gate) = Some(released);
    let capture = {
        let service = Arc::clone(&service);
        tokio::spawn(async move { service.capture_session("/session/one.jsonl").await })
    };
    effects.capture_started.acquire().await.unwrap().forget();
    lock(&original.state).session_path = Some("/session/replacement.jsonl".into());
    release.send(()).unwrap();
    let error = capture
        .await
        .unwrap()
        .err()
        .expect("changed target must be refused");
    assert_eq!(error.code, "session_changed");
    assert!(lock(&effects.session_effects).is_empty());
    assert_eq!(effects.closed.load(Ordering::SeqCst), 0);
}
