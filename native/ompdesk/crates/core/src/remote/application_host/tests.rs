//! Isolated policy tests over real encrypted links. The Host effect double does not prove the native pool adapter.
use super::*;
use crate::remote::quota::{Limits, QuotaRecord, QuotaStore};
use crate::remote::requests::tests::pair;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;

type Listener = Arc<dyn Fn(String, Value) + Send + Sync>;
struct Target {
    state: Mutex<Snapshot>,
    listeners: Mutex<Vec<Listener>>,
    answers: Mutex<HashSet<String>>,
}
#[derive(Clone)]
struct Caller(String);
struct Effects {
    targets: Mutex<HashMap<String, Arc<Target>>>,
    calls: AtomicUsize,
    opens: AtomicUsize,
    closed: AtomicUsize,
    fail: AtomicBool,
    block: AtomicBool,
    acquired: Semaphore,
    release: Semaphore,
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
        })
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
        Ok(lock(&target.state).clone())
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
fn service() -> (Arc<HostServices<Effects>>, Arc<Effects>, Arc<PeerQuota>) {
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
