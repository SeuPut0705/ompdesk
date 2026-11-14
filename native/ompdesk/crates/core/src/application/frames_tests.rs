use super::*;
use serde_json::json;

#[derive(Default)]
struct Recorder(Mutex<Vec<(Vec<i64>, &'static str, Value)>>);
impl DeliverySink for Recorder {
    fn deliver(&self, delivery: Delivery) {
        lock(&self.0).push((
            delivery.windows,
            delivery.channel,
            serde_json::to_value(delivery.data).unwrap(),
        ));
    }
}

fn service() -> (Frames, Arc<Recorder>) {
    let sink = Arc::new(Recorder::default());
    (Frames::new(Handle::current(), sink.clone()), sink)
}

fn frame(name: &str) -> Value {
    json!({"type":"subagent_progress","payload":{"id":name}})
}

fn update(text: &str) -> Value {
    json!({"type":"message_update","message":{"role":"assistant","timestamp":1,"content":[{"type":"text","text":text}]},"assistantMessageEvent":{"type":"text_delta","delta":text}})
}

#[tokio::test]
async fn subagent_frames_precede_agent_events_and_reply() {
    let (frames, sink) = service();
    frames.attach("tab", 1);
    frames.subagent("tab", frame("first"));
    frames.events("tab", Arc::from([json!({"type":"agent_end"})]));
    frames.subagent("tab", frame("second"));
    frames.flush("tab");
    let mut seen = lock(&sink.0);
    seen.push((vec![1], "REPLY", Value::Null));
    assert_eq!(
        seen.iter().map(|item| item.1).collect::<Vec<_>>(),
        [
            "SUBAGENT_FRAMES",
            "EVENTS_BATCH",
            "SUBAGENT_FRAMES",
            "REPLY"
        ]
    );
}

#[tokio::test]
async fn detach_flushes_to_departing_window() {
    let (frames, sink) = service();
    frames.attach("tab", 1);
    frames.attach("tab", 2);
    frames.subagent("tab", frame("first"));
    frames.detach("tab", 2);
    frames.forward("tab", "STATUS", json!("ready"));
    let seen = lock(&sink.0);
    assert_eq!(seen[0].0, [1, 2]);
    assert_eq!(seen[0].2["payload"][0]["payload"]["id"], "first");
    assert_eq!(seen[1].0, [1]);
}

#[tokio::test]
async fn stale_timer_cannot_flush_recreated_tab_or_push_after_close() {
    let (frames, sink) = service();
    frames.attach("tab", 1);
    frames.subagent("tab", frame("old"));
    let old = lock(&frames.inner.state).tabs["tab"].timer.unwrap();
    frames.release("tab");
    frames.attach("tab", 2);
    frames.subagent("tab", frame("new"));
    timer_fired(&Arc::downgrade(&frames.inner), "tab", old);
    assert_eq!(lock(&sink.0).len(), 1);
    frames.flush("tab");
    assert_eq!(lock(&sink.0)[1].0, [2]);
    frames.subagent("tab", frame("closed"));
    let current = lock(&frames.inner.state).tabs["tab"].timer.unwrap();
    frames.close();
    timer_fired(&Arc::downgrade(&frames.inner), "tab", current);
    frames.forward("tab", "STATUS", json!("late"));
    assert_eq!(lock(&sink.0).len(), 2);
}

#[tokio::test]
async fn receiver_slimmer_survives_batches_and_resnapshot_resets_it() {
    let (frames, sink) = service();
    frames.attach("tab", 1);
    frames.events("tab", Arc::from([update("first")]));
    frames.events("tab", Arc::from([update("second")]));
    frames.resnapshot("tab", 1);
    frames.events("tab", Arc::from([update("third")]));
    let seen = lock(&sink.0);
    assert_eq!(
        seen[0].2["payload"][0]["message"]["content"][0]["text"],
        "first"
    );
    assert!(seen[1].2["payload"][0]["message"].get("content").is_none());
    assert_eq!(
        seen[2].2["payload"][0]["message"]["content"][0]["text"],
        "third"
    );
}

#[tokio::test(start_paused = true)]
async fn presentation_deadline_delivers_the_waiting_subagent_batch() {
    let (frames, sink) = service();
    frames.attach("tab", 1);
    frames.subagent("tab", frame("timed"));
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(31)).await;
    assert!(lock(&sink.0).is_empty());
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(lock(&sink.0)[0].2["payload"][0]["payload"]["id"], "timed");
}
