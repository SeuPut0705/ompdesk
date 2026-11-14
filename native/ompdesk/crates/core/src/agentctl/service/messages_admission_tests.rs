use serde_json::{Value, json};

use super::super::Files;
use super::super::host::Caps;
use super::super::tuning::Tuning;
use crate::agentctl::inbox::{InboxIntent, InboxReceiver};
use crate::agentctl::runtime::tests::native_rig;

fn snapshot(child: bool, card: bool) -> Value {
    let mut target = json!({
        "tabId": "target", "title": "target", "cwd": "/w", "status": "ready",
        "busy": true, "asks": [], "hidden": false,
        "sessionPath": "/s/target_2.jsonl", "runtimeInstance": "runtime-target"
    });
    if card {
        target["asks"] = json!([{ "id": "approval", "request": {
            "id": "approval", "method": "confirm", "title": "Continue?"
        } }]);
    }
    json!({
        "deviceId": "test-host", "enabled": true, "approveEnabled": true,
        "tabs": [{
            "tabId": "sender", "title": "sender", "cwd": "/w", "status": "ready",
            "busy": true, "asks": [], "hidden": false,
            "sessionPath": "/s/sender_1.jsonl", "runtimeInstance": "runtime-sender"
        }, target],
        "windowOf": { "sender": "w", "target": "w" },
        "parents": if child { json!({ "target": { "callerTabId": "sender" } }) } else { json!({}) }
    })
}

fn replies(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "command" => Ok(json!({ "success": true, "data": {} })),
        "mail" => Ok(Value::Null),
        other => Err(format!("unexpected admission fixture call: {other}")),
    }
}

async fn check_follow_up(id: u64, child: bool, card: bool) {
    let (control, asked, mut deliveries, _fixture) = native_rig(
        id,
        snapshot(child, card),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        replies,
    );
    let args = json!({ "session": "target", "message": "keep this request", "request_id": "first-intent", "delivery": "follow_up" });
    let result = control
        .run("sender", "ompdesk_session_send", args.clone(), None)
        .await;
    assert!(!result.is_error, "{}", result.text);
    let delivery = tokio::time::timeout(std::time::Duration::from_secs(5), deliveries.recv())
        .await
        .expect("native delivery timed out")
        .expect("delivery channel closed");
    let receiver: InboxReceiver =
        serde_json::from_value(delivery["request"]["receiver"].clone()).unwrap();
    let ledger = &control.receiving_inbox.as_ref().unwrap().ledger;
    let first = ledger.pending(&receiver).unwrap().1;
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].logical.intent,
        if child {
            InboxIntent::FollowUp
        } else {
            InboxIntent::Immediate
        }
    );
    assert_eq!(
        first[0].entry.intent,
        if child || card {
            InboxIntent::FollowUp
        } else {
            InboxIntent::Immediate
        }
    );
    assert_eq!(first[0].dispatch, child.then_some(1));
    if card {
        assert!(result.text.contains("which stays open"), "{}", result.text);
    }
    crate::ports::apply_state(control.host.port(), 1, &snapshot(child, false).to_string()).unwrap();
    let retry = control
        .run("sender", "ompdesk_session_send", args, None)
        .await;
    assert!(!retry.is_error, "{}", retry.text);
    assert_eq!(ledger.pending(&receiver).unwrap().1, first);
    let attempts = asked.lock().unwrap();
    for (method, args) in &*attempts {
        if method == "inbox" {
            for entry in args["transfer"]["entries"].as_array().unwrap() {
                assert_eq!(
                    entry["logical"],
                    serde_json::to_value(&first[0].logical).unwrap()
                );
                assert_eq!(entry["entry"]["deliveryId"], first[0].entry.delivery_id);
            }
        }
    }
    control.host.port().close();
}

#[tokio::test]
async fn foreign_follow_up_is_normalized_before_logical_admission() {
    check_follow_up(9_331, false, false).await;
}

#[tokio::test]
async fn foreign_follow_up_card_deferral_survives_card_close_and_retry() {
    check_follow_up(9_332, false, true).await;
}

#[tokio::test]
async fn owned_child_follow_up_is_never_promoted_on_retry() {
    check_follow_up(9_333, true, false).await;
}

#[tokio::test]
async fn owned_child_follow_up_survives_card_close_and_retry() {
    check_follow_up(9_334, true, true).await;
}

fn outside_snapshot(known: bool) -> Value {
    let mut state = snapshot(false, false);
    state["parents"] = json!({ "sender": { "callerTabId": "outside:cli#1" } });
    if known {
        state["outsideCallers"] = json!({ "outside:cli#1": {
            "tabId": "outside:cli#1", "title": "cli", "cwd": "/w", "status": "ready",
            "busy": false, "asks": [], "hidden": false
        } });
        state["outsideWindow"] = json!("w");
    }
    state
}

async fn check_outside(id: u64, known: bool, sink_fails: bool) {
    let (control, asked, mut deliveries, _fixture) = native_rig(
        id,
        outside_snapshot(known),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        move |method, args| {
            if method == "mail" && sink_fails {
                Err("outside event sink failed".into())
            } else {
                replies(method, args)
            }
        },
    );
    let result = control
        .run(
            "sender",
            "ompdesk_report",
            json!({ "kind": "done", "text": "All green", "id": "outside-report" }),
            None,
        )
        .await;
    assert_eq!(result.is_error, !known || sink_fails, "{}", result.text);
    let asked = asked.lock().unwrap();
    let mail: Vec<_> = asked
        .iter()
        .filter(|(method, _)| method == "mail")
        .collect();
    assert_eq!(mail.len(), usize::from(known));
    if known {
        assert_eq!(mail[0].1["tabId"], "outside:cli#1");
        assert!(mail[0].1["content"].as_str().unwrap().contains("All green"));
    }
    if sink_fails && known {
        assert!(
            result.text.contains("outside event sink failed"),
            "{}",
            result.text
        );
    }
    assert!(asked.iter().all(|(method, _)| method != "inbox"
        && method != "inboxStatus"
        && method != "deliverInbox"));
    assert!(control.host.outbox().unwrap().pending().is_empty());
    assert!(control.send_outbox.as_ref().unwrap().pending().is_empty());
    assert!(matches!(
        deliveries.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    control.host.port().close();
}

#[tokio::test]
async fn known_outside_parent_reports_use_only_the_existing_event_sink() {
    check_outside(9_335, true, false).await;
}

#[tokio::test]
async fn unknown_outside_parent_is_rejected_without_event_or_inbox_delivery() {
    check_outside(9_336, false, false).await;
}

#[tokio::test]
async fn outside_parent_event_sink_errors_are_returned_to_the_reporter() {
    check_outside(9_337, true, true).await;
}

async fn parent_change_while_reading_journal(id: u64, remove_parent: bool) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use super::super::AgentControl;

    let holder = Arc::new(Mutex::new(None::<AgentControl>));
    let journal_entered = Arc::new(AtomicBool::new(false));
    let callback_control = holder.clone();
    let callback_entered = journal_entered.clone();
    let (control, asked, mut deliveries, _fixture) = native_rig(
        id,
        snapshot(true, false),
        Caps::default(),
        &Files::default(),
        Tuning::default(),
        move |method, args| {
            if method == "command"
                && args["tabId"] == "target"
                && args["command"]["type"] == "get_transcript_page"
            {
                let held = callback_control.lock().unwrap();
                let control = held.as_ref().unwrap();
                let mut changed = snapshot(false, false);
                if !remove_parent {
                    changed["parents"] = json!({ "target": { "callerTabId": "another-opener" } });
                }
                crate::ports::apply_state(control.host.port(), 1, &changed.to_string()).unwrap();
                callback_entered.store(true, Ordering::SeqCst);
            }
            replies(method, args)
        },
    );
    *holder.lock().unwrap() = Some(control.clone());
    let initial = control.host.state();
    assert!(
        control
            .opened_by(&initial, "sender", &initial.tabs("sender").unwrap())
            .iter()
            .any(|tab| tab == "target")
    );
    let result = control
        .run(
            "sender",
            "ompdesk_session_send",
            json!({ "session": "target", "message": "do not admit after reparent", "request_id": "parent-boundary", "delivery": "follow_up" }),
            None,
        )
        .await;
    assert!(journal_entered.load(Ordering::SeqCst));
    let current = control.host.state();
    assert_ne!(current.parent_of("target"), initial.parent_of("target"));
    assert!(
        control
            .opened_by(&current, "sender", &current.tabs("sender").unwrap())
            .iter()
            .any(|tab| tab == "target")
    );
    assert!(result.is_error, "{}", result.text);
    assert!(control.send_outbox.as_ref().unwrap().pending().is_empty());
    assert!(control.host.outbox().unwrap().pending().is_empty());
    assert!(asked.lock().unwrap().iter().all(|(method, _)| {
        method != "inbox" && method != "inboxStatus" && method != "deliverInbox"
    }));
    assert!(matches!(
        deliveries.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    holder.lock().unwrap().take();
    control.host.port().close();
}

#[tokio::test]
async fn reparent_during_journal_read_refuses_even_when_opened_by_remembers_the_tab() {
    parent_change_while_reading_journal(9_338, false).await;
}

#[tokio::test]
async fn parent_removal_during_journal_read_refuses_even_when_opened_by_remembers_the_tab() {
    parent_change_while_reading_journal(9_339, true).await;
}
