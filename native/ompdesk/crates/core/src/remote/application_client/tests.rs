use super::*;
use crate::remote::requests::tests::pair;
use crate::remotebytes::native::tests::Dir;

fn options() -> TabOptions {
    TabOptions {
        rtab: "tab".into(),
        cwd: "/workspace".into(),
        kind: "agent".into(),
        fresh: false,
        session_path: Some("/sessions/one.jsonl".into()),
        offline_message: "offline".into(),
        unanswered_message: "waiting".into(),
        execution_host: "host-one".into(),
        sign_in_failure: Words {
            title: "Sign-in failed".into(),
            message: "Paste the callback address".into(),
        },
    }
}

async fn event(events: &mut mpsc::UnboundedReceiver<TabEvent>, name: &str) -> TabEvent {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.name == name {
                return event;
            }
        }
    })
    .await
    .unwrap()
}

fn status(host: &RemoteRequests, omp: &str) {
    host.emit("tab.event", &json!({"rtab":"tab","name":"status","arg":{
        "status":"ready","statusPayload":{},"processAlive":true,"cwd":"/workspace","kind":"agent","omp":omp
    }})).unwrap();
}

async fn attach(
    host: &RemoteRequests,
    incoming: &mut mpsc::UnboundedReceiver<super::super::requests::IncomingRequest>,
    omp: &str,
) {
    let open = incoming.recv().await.unwrap();
    assert_eq!(open.method, "tab.open");
    host.emit(
        "tab.event",
        &json!({"rtab":"tab","name":"run","arg":{"running":true}}),
    )
    .unwrap();
    status(host, omp);
    host.answer(
        open.id,
        Ok(json!({"cwd":"/workspace","kind":"agent","attached":true})),
    )
    .unwrap();
}

#[tokio::test]
async fn streamed_events_precede_open_completion_and_reattach_does_not_start_another_omp() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, mut events) = RemoteTab::new(
        options(),
        device.clone(),
        Arc::default(),
        Arc::new(ContentCache::new(folder.path().to_owned())),
    );
    tab.start();
    attach(&host, &mut incoming, "omp-one").await;
    let ready = event(&mut events, "status").await;
    if ready.arg["status"] != "ready" {
        assert_eq!(event(&mut events, "status").await.arg["status"], "ready");
    }
    assert!(tab.snapshot().process_alive);
    let read = tab.command(json!({"type":"get_state"}), Duration::from_secs(2));
    let serve = async {
        let request = incoming.recv().await.unwrap();
        assert_eq!(request.method, "tab.command");
        host.answer(request.id, Ok(json!({"success":true,"data":{"model":"m"}})))
            .unwrap();
    };
    let (result, ()) = tokio::join!(read, serve);
    assert_eq!(result.unwrap()["data"]["model"], "m");
    tab.dispose(true);
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn offline_user_answer_is_refused_and_host_reply_replays_only_to_its_omp() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, mut events) = RemoteTab::new(
        options(),
        device.clone(),
        Arc::default(),
        Arc::new(ContentCache::new(folder.path().to_owned())),
    );
    tab.start();
    attach(&host, &mut incoming, "omp-one").await;
    while event(&mut events, "status").await.arg["status"] != "ready" {}
    device.disconnect_for_test();
    while event(&mut events, "status").await.arg["reconnecting"] != true {}
    assert_eq!(
        tab.side_channel(json!({"type":"extension_ui_response","id":"ask"}))
            .await
            .unwrap_err()
            .fault
            .code,
        "remote_offline"
    );
    tab.side_channel(json!({"type":"host_tool_result","id":"tool","result":"done"}))
        .await
        .unwrap();
    let (next_device, next_host, _next_keep) = pair().await;
    let mut next = next_host.take_requests().unwrap();
    tab.relink(next_device.clone());
    attach(&next_host, &mut next, "omp-one").await;
    let replay = next.recv().await.unwrap();
    assert_eq!(replay.method, "tab.sideChannel");
    assert_eq!(replay.params["frame"]["id"], "tool");
    next_host.answer(replay.id, Ok(Value::Null)).unwrap();
    assert_eq!(event(&mut events, "hostReplyDelivered").await.arg, "tool");
    next_device.disconnect_for_test();
    while event(&mut events, "status").await.arg["reconnecting"] != true {}
    tab.side_channel(json!({"type":"host_tool_result","id":"old-tool"}))
        .await
        .unwrap();
    let (last_device, last_host, _last_keep) = pair().await;
    let mut last = last_host.take_requests().unwrap();
    tab.relink(last_device.clone());
    attach(&last_host, &mut last, "omp-two").await;
    let command = tab.command(json!({"type":"get_state"}), Duration::from_secs(2));
    let serve = async {
        let request = last.recv().await.unwrap();
        // The new omp never receives the old omp's tool reply.
        assert_eq!(request.method, "tab.command");
        last_host
            .answer(request.id, Ok(json!({"success":true,"data":{}})))
            .unwrap();
    };
    let (result, ()) = tokio::join!(command, serve);
    result.unwrap();
    tab.dispose(true);
    host.disconnect_for_test();
    next_host.disconnect_for_test();
    last_device.disconnect_for_test();
    last_host.disconnect_for_test();
}

#[tokio::test]
async fn missing_delta_base_requests_fresh_and_close_cancellation_does_not_remove_a_new_close() {
    let folder = Dir::new();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let closes = Arc::new(PendingTabCloses::default());
    let (tab, _events) = RemoteTab::new(
        options(),
        device.clone(),
        Arc::clone(&closes),
        Arc::new(ContentCache::new(folder.path().to_owned())),
    );
    tab.start();
    attach(&host, &mut incoming, "omp-one").await;
    let read = tab.command(json!({"type":"get_autopilot"}), Duration::from_secs(2));
    let serve = async {
        let request = incoming.recv().await.unwrap();
        host.answer(request.id, Ok(json!({"success":true,"data":{"~read":"epoch.2","base":"epoch.1","delta":{"~delta":"x","set":{"phase":"running"},"unset":[]}}}))).unwrap();
        let fresh = incoming.recv().await.unwrap();
        assert_eq!(fresh.params["fresh"], true);
        host.answer(
            fresh.id,
            Ok(json!({"success":true,"data":{"~read":"epoch.3","status":{"phase":"running"}}})),
        )
        .unwrap();
    };
    let (result, ()) = tokio::join!(read, serve);
    assert_eq!(result.unwrap()["data"]["phase"], "running");
    closes.defer("closed".into());
    let flush = closes.flush(&device);
    let reopen = async {
        let close = incoming.recv().await.unwrap();
        assert_eq!(close.method, "tab.close");
        closes.cancel("closed");
        closes.defer("closed".into());
        host.answer(close.id, Ok(Value::Null)).unwrap();
    };
    tokio::join!(flush, reopen);
    assert!(closes.0.lock().unwrap().tabs.contains_key("closed"));
    tab.dispose(true);
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn tail_pages_and_content_addressed_images_survive_a_native_tab_restart() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let folder = Dir::new();
    let hash: String = Sha256::digest(b"picture")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let reference = format!("blob:sha256:{hash}");
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"picture");
    let cache = Arc::new(ContentCache::new(folder.path().to_owned()));
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, _events) = RemoteTab::new(
        options(),
        device.clone(),
        Arc::default(),
        Arc::clone(&cache),
    );
    tab.start();
    attach(&host, &mut incoming, "omp-one").await;
    let command = json!({"type":"get_transcript_page","fromEnd":true,"limit":20});
    let read = tab.command(command.clone(), Duration::from_secs(2));
    let serve = async {
        let page = incoming.recv().await.unwrap();
        assert_eq!(page.params["command"]["imageRefs"], true);
        host.answer(page.id,Ok(json!({"success":true,"data":{"version":"v1","messages":[{"content":[{"type":"image","data":reference}]}]}}))).unwrap();
        let image = incoming.recv().await.unwrap();
        assert_eq!(image.params["command"]["type"], "read_image_blob");
        assert_eq!(image.params["command"]["ref"], reference);
        host.answer(
            image.id,
            Ok(json!({"success":true,"data":{"data":encoded}})),
        )
        .unwrap();
    };
    let (first, ()) = tokio::join!(read, serve);
    assert_eq!(
        first.unwrap()["data"]["messages"][0]["content"][0]["data"],
        encoded
    );
    tab.dispose(true);
    device.disconnect_for_test();
    host.disconnect_for_test();
    let cache = Arc::new(ContentCache::new(folder.path().to_owned()));
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, _events) = RemoteTab::new(options(), device.clone(), Arc::default(), cache);
    tab.start();
    attach(&host, &mut incoming, "omp-one").await;
    let read = tab.command(command, Duration::from_secs(2));
    let serve = async {
        let page = incoming.recv().await.unwrap();
        assert_eq!(page.params["command"]["ifVersion"], "v1");
        host.answer(
            page.id,
            Ok(json!({"success":true,"data":{"unchanged":true,"version":"v1"}})),
        )
        .unwrap();
    };
    let (second, ()) = tokio::join!(read, serve);
    assert_eq!(
        second.unwrap()["data"]["messages"][0]["content"][0]["data"],
        encoded
    );
    tab.dispose(true);
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn a_busy_callback_port_is_reported_instead_of_a_stale_listener_completion() {
    let folder = Dir::new();
    let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = socket.local_addr().unwrap().port();
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let (tab, mut events) = RemoteTab::new(
        options(),
        device.clone(),
        Arc::default(),
        Arc::new(ContentCache::new(folder.path().to_owned())),
    );
    tab.start();
    attach(&host, &mut incoming, "omp-one").await;
    host.emit(
        "tab.event",
        &json!({"rtab":"tab","name":"signIn","arg":{"active":["provider"]}}),
    )
    .unwrap();
    let url = format!(
        "https://provider.example/?redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fcallback&state=flow"
    );
    host.emit("tab.event",&json!({"rtab":"tab","name":"extensionUi","arg":{"method":"open_url","url":url,"launchUrl":"https://provider.example/"}})).unwrap();
    assert_eq!(
        event(&mut events, "signInRelay").await.arg,
        json!({"listening":false,"port":port})
    );
    host.emit(
        "tab.event",
        &json!({"rtab":"tab","name":"signIn","arg":{"active":[]}}),
    )
    .unwrap();
    assert_eq!(event(&mut events, "signInRelay").await.arg, Value::Null);
    tab.dispose(true);
    device.disconnect_for_test();
    host.disconnect_for_test();
}

#[tokio::test]
async fn reopening_a_later_snapshot_row_cancels_its_unsent_close() {
    let (device, host, _keep) = pair().await;
    let mut incoming = host.take_requests().unwrap();
    let closes = PendingTabCloses::default();
    closes.defer("one".into());
    closes.defer("two".into());
    let flush = closes.flush(&device);
    tokio::pin!(flush);
    let first = tokio::select! {
        first = incoming.recv() => first.unwrap(),
        () = &mut flush => panic!("No close was sent"),
    };
    let reopened = if first.params["rtab"] == "one" {
        "two"
    } else {
        "one"
    };
    closes.cancel(reopened);
    host.answer(first.id, Ok(Value::Null)).unwrap();
    let stale = tokio::select! {
        () = &mut flush => None,
        next = incoming.recv() => next,
    };
    if let Some(stale) = &stale {
        host.answer(stale.id, Ok(Value::Null)).unwrap();
        flush.await;
    }
    assert!(stale.is_none(), "A reopened snapshot row was closed");
    device.disconnect_for_test();
    host.disconnect_for_test();
}
