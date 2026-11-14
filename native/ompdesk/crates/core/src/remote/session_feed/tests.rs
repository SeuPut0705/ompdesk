//! Captured from the real TS HostSessionList with capture-host-feed.ts before native cutover. Native requests
//! use real encrypted TCP links; the host replies here isolate the receiver from the separate stock session index.
use super::*;
use crate::remote::requests::{IncomingRequest, tests::pair};
use tokio::sync::mpsc;
fn row(path: &str, modified: &str) -> Value {
    json!({"path":path,"modified":modified,"label":path})
}
async fn read(
    feed: &Arc<HostSessionList>,
    host: &RemoteRequests,
    incoming: &mut mpsc::UnboundedReceiver<IncomingRequest>,
    reply: Value,
    asked: &Mutex<Vec<Value>>,
) -> Value {
    let a = feed.current();
    let b = feed.current();
    let serve = async {
        let request = incoming.recv().await.unwrap();
        assert_eq!(request.method, "sessions.list");
        lock(asked).push(request.params);
        host.answer(request.id, Ok(reply)).unwrap();
    };
    let (a, b, ()) = tokio::join!(a, b, serve);
    let a = a.unwrap();
    assert!(Arc::ptr_eq(&a, &b.unwrap()));
    json!({"version":a.version.split('.').nth(1).unwrap().parse::<u64>().unwrap(),"sessions":a.sessions})
}
#[tokio::test]
async fn captured_deltas_missing_versions_and_old_snapshots_match_typescript() {
    let captured: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let changed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let output = Arc::clone(&changed);
    let feed = HostSessionList::new(
        "host".into(),
        Arc::new(move |change| {
            lock(&output).push(if change.get("list").is_some() {json!({"device":change["device"],"set":change["list"]["set"],"remove":change["list"]["remove"]})} else {change});
        }),
    );
    feed.relink(Some(device.clone()));
    lock(&changed).clear();
    let asked = Mutex::new(Vec::new());
    let mut shown = Vec::new();
    let a = row("/a", "2026-11-14T00:00:00Z");
    let b = row("/b", "2026-11-13T23:00:00Z");
    let c = row("/c", "2026-11-14T01:00:00Z");
    shown.push(
        read(
            &feed,
            &host,
            &mut incoming,
            json!({"version":"host.1","sessions":[b,a]}),
            &asked,
        )
        .await,
    );
    feed.host_changed(json!({"base":"host.1","version":"host.2","set":[c],"remove":["/a"]}));
    let current = feed.current().await.unwrap();
    shown.push(json!({"version":current.version.split('.').nth(1).unwrap().parse::<u64>().unwrap(),"sessions":current.sessions}));
    feed.stale();
    shown.push(
        read(
            &feed,
            &host,
            &mut incoming,
            json!({"version":"host.1","sessions":[a,b]}),
            &asked,
        )
        .await,
    );
    feed.host_changed(json!({"base":"missing.0","version":"host.4","set":[],"remove":["/c"]}));
    shown.push(
        read(
            &feed,
            &host,
            &mut incoming,
            json!({"version":"host.4","sessions":[b]}),
            &asked,
        )
        .await,
    );
    assert_eq!(
        json!({"asked":*lock(&asked),"changes":*lock(&changed),"shown":shown}),
        captured
    );
    device.disconnect_for_test();
    host.disconnect_for_test();
}
#[tokio::test]
async fn a_change_delivered_before_an_old_read_continuation_cannot_revive_a_removed_row() {
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let feed = HostSessionList::new("host".into(), Arc::new(|_| {}));
    feed.relink(Some(device.clone()));
    let asked = Mutex::new(Vec::new());
    let a = row("/a", "2026-11-14T00:00:00Z");
    read(
        &feed,
        &host,
        &mut incoming,
        json!({"version":"host.1","sessions":[a]}),
        &asked,
    )
    .await;
    feed.stale();
    let current = feed.current();
    let deliver = async {
        let request = incoming.recv().await.unwrap();
        feed.host_changed(json!({"base":"host.1","version":"host.2","set":[],"remove":["/a"]}));
        host.answer(request.id, Ok(json!({"version":"host.1","sessions":[a]})))
            .unwrap();
    };
    let (answer, ()) = tokio::join!(current, deliver);
    assert!(answer.unwrap().sessions.is_empty());
    device.disconnect_for_test();
    host.disconnect_for_test();
}
#[tokio::test]
async fn a_newer_announced_version_requires_one_more_read_and_disconnect_fences_old_answers() {
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let feed = HostSessionList::new("host".into(), Arc::new(|_| {}));
    feed.relink(Some(device.clone()));
    let current = feed.current();
    let announce = async {
        let request = incoming.recv().await.unwrap();
        feed.host_changed(json!({"base":"missing","version":"host.2","set":[],"remove":[]}));
        host.answer(request.id, Ok(json!({"version":"host.1","sessions":[]})))
            .unwrap();
    };
    let (first, ()) = tokio::join!(current, announce);
    first.unwrap();
    let current = feed.current();
    let disconnect = async {
        let request = incoming.recv().await.unwrap();
        feed.relink(None);
        host.answer(request.id,Ok(json!({"version":"host.2","sessions":[row("/must-not-return","2026-11-14T00:00:00Z")]}))).unwrap();
    };
    let (answer, ()) = tokio::join!(current, disconnect);
    assert_eq!(answer.unwrap_err().fault.code, "remote_offline");
    assert_eq!(
        feed.current().await.unwrap_err().fault.code,
        "remote_offline"
    );
    device.disconnect_for_test();
    host.disconnect_for_test();
}
