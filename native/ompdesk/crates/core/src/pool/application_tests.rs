use super::*;

fn update(text: &str) -> Value {
    json!({"type": "message_update", "message": {"role": "assistant", "timestamp": 1, "content": [{"type": "text", "text": text}]}, "assistantMessageEvent": {"type": "text_delta", "delta": text}})
}

fn batches(deliveries: &[Delivery], window: i64) -> Vec<Value> {
    deliveries
        .iter()
        .filter(|delivery| delivery.windows.contains(&window))
        .map(|delivery| serde_json::to_value(&delivery.data).unwrap())
        .collect()
}

#[test]
fn reconnecting_receiver_gets_a_whole_snapshot_without_resetting_other_viewers() {
    let mut full = FullChannel::new("tab");
    full.attach(1);
    let mut sent = Vec::new();
    full.events(Arc::from([update("first")]), &mut |delivery| {
        sent.push(delivery)
    });
    full.attach(-2);
    full.events(Arc::from([update("second")]), &mut |delivery| {
        sent.push(delivery)
    });
    assert!(
        batches(&sent, 1)[1]["payload"][0]["message"]
            .get("content")
            .is_none()
    );
    assert_eq!(
        batches(&sent, -2)[0]["payload"][0]["message"]["content"][0]["text"],
        "second"
    );
    full.resnapshot(1);
    full.events(Arc::from([update("third")]), &mut |delivery| {
        sent.push(delivery)
    });
    assert_eq!(
        batches(&sent, 1)[2]["payload"][0]["message"]["content"][0]["text"],
        "third"
    );
    assert!(
        batches(&sent, -2)[1]["payload"][0]["message"]
            .get("content")
            .is_none()
    );
}

#[test]
fn detaching_a_viewer_flushes_received_frames_then_only_removes_that_receiver() {
    let mut full = FullChannel::new("tab");
    full.attach(1);
    full.attach(-2);
    assert!(full.subagent(json!({"type": "subagent_progress", "payload": {"id": "child"}})));
    assert!(!full.subagent(
        json!({"type": "subagent_progress", "payload": {"id": "child", "text": "last"}})
    ));
    let mut sent = Vec::new();
    full.detach(-2, &mut |delivery| sent.push(delivery));
    full.events(Arc::from([update("owner continues")]), &mut |delivery| {
        sent.push(delivery)
    });
    assert_eq!(
        sent[0].windows,
        [1, -2]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    );
    assert_eq!(sent[0].channel, "SUBAGENT_FRAMES");
    assert_eq!(sent[1].windows, [1]);
    assert_eq!(batches(&sent, -2).len(), 1);
    assert_eq!(
        batches(&sent, 1)[1]["payload"][0]["message"]["content"][0]["text"],
        "owner continues"
    );
}

#[test]
fn frames_flush_before_agent_events_and_before_a_transcript_answer() {
    let mut full = FullChannel::new("tab");
    full.attach(1);
    full.subagent(json!({"type": "subagent_progress", "payload": {"id": "child"}}));
    let mut order = Vec::new();
    full.events(Arc::from([json!({"type": "agent_end"})]), &mut |delivery| {
        order.push(delivery.channel)
    });
    full.subagent(
        json!({"type": "subagent_progress", "payload": {"id": "child", "text": "completed"}}),
    );
    full.flush(&mut |delivery| order.push(delivery.channel));
    order.push("TRANSCRIPT_ANSWER");
    full.flush(&mut |delivery| order.push(delivery.channel));
    assert_eq!(
        order,
        [
            "SUBAGENT_FRAMES",
            "EVENTS_BATCH",
            "SUBAGENT_FRAMES",
            "TRANSCRIPT_ANSWER"
        ]
    );
}

#[test]
fn receivers_at_the_same_message_share_one_slimmed_push() {
    let mut full = FullChannel::new("tab");
    full.attach(1);
    full.attach(-2);
    full.events(Arc::from([update("first")]), &mut |_| {});
    let mut sent = Vec::new();
    full.events(Arc::from([update("second")]), &mut |delivery| {
        sent.push(delivery)
    });
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].windows, [-2, 1]);
    assert!(
        batches(&sent, 1)[0]["payload"][0]["message"]
            .get("content")
            .is_none()
    );
}

#[test]
fn restart_decisions_do_not_interrupt_turns_or_start_sleeping_tabs() {
    for status in ["starting", "ready", "error", "stopped"] {
        assert_eq!(restart_decision(Some(status), true, false), Decision::Wait);
        assert_eq!(
            restart_decision(Some(status), false, false),
            Decision::Restart
        );
    }
    for busy in [false, true] {
        assert_eq!(
            restart_decision(Some("asleep"), busy, false),
            Decision::Skip
        );
        assert_eq!(restart_decision(Some("asleep"), busy, true), Decision::Skip);
        assert_eq!(restart_decision(None, busy, false), Decision::Skip);
    }
    assert_eq!(restart_decision(Some("ready"), true, true), Decision::Wait);
    assert_eq!(restart_decision(Some("ready"), false, true), Decision::Now);
    assert_eq!(
        restart_decision(Some("starting"), true, true),
        Decision::Skip
    );
    assert_eq!(restart_decision(Some("error"), true, true), Decision::Skip);
}

#[test]
fn pending_extension_changes_keep_all_reconnects_and_an_all_mcp_reload_dominates() {
    let a = json!({"reload": true, "restart": false, "reconnect": ["a", "b"], "mcp": {"names": ["x", "y"]}});
    let b = json!({"reload": false, "restart": true, "reconnect": ["b", "c"], "mcp": {"names": ["y", "z"]}});
    assert_eq!(
        merge_plans(&a, &b),
        json!({"reload": true, "restart": true, "reconnect": ["a", "b", "c"], "mcp": {"names": ["x", "y", "z"]}})
    );
    assert_eq!(
        merge_plans(
            &a,
            &json!({"reload": false, "restart": false, "reconnect": [], "mcp": {"all": true, "names": []}})
        )["mcp"],
        json!({"names": [], "all": true})
    );
}
