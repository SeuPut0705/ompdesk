use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::oneshot;

use super::*;
use crate::agentctl::inbox::InboxRoute;
use crate::agentctl::journal::system_clock;
use crate::agentctl::runtime::{RuntimeConfig, start};
use crate::agentctl::service::AgentControl;
use crate::agentctl::service::host::{Caps, HostState};
use crate::agentctl::service::tuning::Tuning;
use crate::ports::Port;

#[derive(Clone, Copy)]
enum Revocation {
    DuringStatus,
    DuringStatusReplacement,
    AfterDisk,
}

fn route(incarnation: &str) -> InboxRoute {
    InboxRoute {
        peer_device_id: "source-host".into(),
        connection_incarnation: incarnation.into(),
        rtab: "original-peer-view".into(),
        tab_id: "local-window".into(),
        session_path: receiver().session_path,
        runtime_instance: "actual-rpc-client".into(),
    }
}

fn window_snapshot(current_route: Option<&InboxRoute>) -> Value {
    let mut state = snapshot(false);
    state["tabs"] = state["mailTargets"].clone();
    state["tabs"][0]["tabId"] = "local-window".into();
    state["mailTargets"] = json!([]);
    state["windowOf"] = json!({"local-window":"actual-local-window"});
    state["devices"] = json!([{"id":"source-host","name":"Source host","state":"online"}]);
    state["inboxRoutes"] = match current_route {
        Some(route) => json!([route]),
        None => json!([]),
    };
    state
}

fn captured_params(
    port: u64,
    transfer: NativeInboxTransfer,
    captured: &InboxRoute,
) -> AcceptParams {
    // The private receiving route supplies the original connection capture, not the transferred message body.
    serde_json::from_value(json!({
        "port":port,
        "tabId":captured.tab_id,
        "transfer":transfer,
        "uploadDeviceId":captured.peer_device_id,
        "expectedProducerDeviceId":captured.peer_device_id,
        "expectedRuntimeInstance":captured.runtime_instance,
        "expectedRoute":captured,
    }))
    .unwrap()
}

async fn exercise(revocation: Revocation, id: u64) {
    let dir = Dir::new();
    let ledger_file = dir.0.join("inbox.json");
    let original_route = route("first-authenticated-connection");
    let before = window_snapshot(Some(&original_route));
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _writer_task) = crate::wire::spawn_writer(writer);
    let events = crate::server::test_events(&tx);
    let port =
        Port::<HostState>::open(&events, id, serde_json::from_value(before).unwrap()).unwrap();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let bridge_calls = Arc::new(AtomicUsize::new(0));
    let calls = bridge_calls.clone();
    let answer_port = port.clone();
    let host_task = tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        let mut entered = Some(entered_tx);
        let mut release = Some(release_rx);
        while let Ok(Some(line)) = lines.next_line().await {
            let event: Value = serde_json::from_str(&line).unwrap();
            let data = &event["data"];
            let Some(ask) = data["ask"].as_u64() else {
                continue;
            };
            let reply = match data["method"].as_str().unwrap() {
                "state" => Value::Null,
                "inboxStatus" => {
                    if let Some(entered) = entered.take() {
                        entered.send(()).unwrap();
                        release.take().unwrap().await.unwrap();
                    }
                    serde_json::to_value(NativeInboxReply {
                        receiver: receiver(),
                        entries: vec![],
                        receipts: vec![],
                    })
                    .unwrap()
                }
                "deliverInbox" => {
                    calls.fetch_add(1, Ordering::SeqCst);
                    serde_json::to_value(NativeInboxReply {
                        receiver: receiver(),
                        entries: vec![],
                        receipts: vec![],
                    })
                    .unwrap()
                }
                method => panic!("Unexpected native Host ask: {method}"),
            };
            crate::ports::apply_answer(&answer_port, ask, Ok(&reply.to_string()));
        }
    });
    let control = AgentControl::new(
        port.clone(),
        Caps::default(),
        &Files {
            inbox: Some(InboxFiles {
                ledger: ledger_file.clone(),
                upload_user_data: dir.0.join("user-data"),
            }),
            attachments: Some(dir.0.join("blobs")),
            ..Files::default()
        },
        Tuning::default(),
        system_clock(),
    );
    let runtime = start(
        control.clone(),
        id,
        RuntimeConfig {
            sweep_ms: 0,
            ..RuntimeConfig::default()
        },
    );
    let inbox = control.receiving_inbox.as_ref().unwrap();
    let bytes = b"attachment owned only after valid native acceptance";
    let upload = inbox
        .uploads
        .store(
            1,
            Limits::default(),
            "source-host",
            "sample.txt",
            bytes.to_vec(),
        )
        .await
        .unwrap_or_else(|failure| panic!("Upload fixture failed: {}", failure.message));
    let original = transfer(upload.path.clone(), bytes);
    let request = captured_params(id, original.clone(), &original_route);
    let accepting_runtime = runtime.clone();
    let mut accepting = tokio::spawn(async move { accepting_runtime.accept_inbox(request).await });
    tokio::select! {
        reached = entered_rx => reached.unwrap(),
        early = &mut accepting => panic!("Native acceptance ended before the status barrier: {early:?}"),
    }
    match revocation {
        Revocation::DuringStatus => {
            crate::ports::apply_state(&port, 1, &window_snapshot(None).to_string()).unwrap();
        }
        Revocation::DuringStatusReplacement => {
            let replacement = route("replacement-authenticated-connection");
            crate::ports::apply_state(&port, 1, &window_snapshot(Some(&replacement)).to_string())
                .unwrap();
        }
        Revocation::AfterDisk => {}
    }
    release_tx.send(()).unwrap();
    let outcome = accepting.await.unwrap();
    match revocation {
        Revocation::DuringStatus | Revocation::DuringStatusReplacement => {
            // A real native replay would also find the still-valid local window if the invalid keep happened.
            runtime.deliver_pending_inbox().await;
            let state = port.state();
            let target = state
                .tabs
                .iter()
                .find(|tab| tab.tab_id == "local-window")
                .unwrap();
            assert_eq!(
                target.session_path.as_deref(),
                Some(original_route.session_path.as_str())
            );
            assert_eq!(
                target.runtime_instance.as_deref(),
                Some("actual-rpc-client")
            );
            assert!(target.device.is_none());
            assert_eq!(
                state.device("source-host").unwrap().state,
                crate::agentctl::service::types::DeviceState::Online
            );
            let held = inbox.ledger.pending(&receiver()).unwrap().1;
            let dispatched = bridge_calls.load(Ordering::SeqCst);
            let blob = inbox.store.get_now(&sha256_hex(bytes)).is_some();
            let disk_ack = outcome
                .as_ref()
                .is_ok_and(|accepted| accepted.persistence == Persistence::Disk);
            let no_keep = held.is_empty();
            control.host.port().close();
            host_task.abort();
            let _ = host_task.await;
            drop(tx);
            assert!(
                outcome.is_err() && no_keep && !blob && dispatched == 0 && !disk_ack,
                "Original route was withdrawn/replaced at the held native status await, but local runtime survived: outcome={outcome:?}, held={}, ledgerExists={}, blob={blob}, bridgeDispatches={dispatched}, diskAck={disk_ack}",
                held.len(),
                ledger_file.exists()
            );
            assert_unowned_after_restart(&ledger_file, &original.entries);
            assert_eq!(std::fs::read(upload.path).unwrap(), bytes);
        }
        Revocation::AfterDisk => {
            let first = outcome.unwrap();
            assert_eq!(first.persistence, Persistence::Disk);
            assert_eq!(first.deliveries[0].dispatch, Some(1));
            runtime.deliver_pending_inbox().await;
            let before_withdrawal = bridge_calls.load(Ordering::SeqCst);
            crate::ports::apply_state(&port, 1, &window_snapshot(None).to_string()).unwrap();
            runtime.deliver_pending_inbox().await;
            assert!(bridge_calls.load(Ordering::SeqCst) > before_withdrawal);
            assert_eq!(inbox.ledger.pending(&receiver()).unwrap().1.len(), 1);
            let replacement = route("replacement-authenticated-connection");
            crate::ports::apply_state(&port, 2, &window_snapshot(Some(&replacement)).to_string())
                .unwrap();
            let mut retry = original;
            retry.uploads.clear();
            retry.entries[0].dispatch = Some(2);
            retry.entries[0].entry.sender.session = "changed presentation title".into();
            retry.entries[0].entry.payload = InboxPayload::Prompt {
                content: InboxContent::Text("changed display: d2".into()),
            };
            let replay = runtime
                .accept_inbox(captured_params(id, retry, &replacement))
                .await
                .unwrap();
            assert_eq!(replay.persistence, Persistence::Disk);
            assert_eq!(replay.receiver, first.receiver);
            assert_eq!(replay.deliveries[0].key, first.deliveries[0].key);
            assert_eq!(replay.deliveries[0].dispatch, first.deliveries[0].dispatch);
            assert!(!first.deliveries[0].existing);
            assert!(replay.deliveries[0].existing);
            let held = inbox.ledger.pending(&receiver()).unwrap().1;
            assert_eq!(held.len(), 1);
            assert_eq!(held[0].dispatch, Some(1));
            assert_eq!(
                held[0].entry.payload,
                InboxPayload::Prompt {
                    content: InboxContent::Text("first d1 presentation".into())
                }
            );
            assert_eq!(
                inbox.store.get_now(&sha256_hex(bytes)).unwrap().as_slice(),
                bytes
            );
            control.host.port().close();
            host_task.abort();
            let _ = host_task.await;
            drop(tx);
        }
    }
}

#[tokio::test]
async fn withdrawn_original_peer_route_during_status_cannot_keep_or_queue_into_a_surviving_local_window()
 {
    exercise(Revocation::DuringStatus, 24_000_001).await;
}

#[tokio::test]
async fn replacement_connection_cannot_authorize_an_old_captured_route_at_the_native_status_barrier()
 {
    exercise(Revocation::DuringStatusReplacement, 24_000_003).await;
}

#[tokio::test]
async fn sender_route_loss_after_disk_does_not_erase_responsibility_and_new_connection_retry_keeps_first_dispatch()
 {
    exercise(Revocation::AfterDisk, 24_000_002).await;
}
