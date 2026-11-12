//! Every call the TypeScript tests made on the encoding (`captured/*.json.gz`, see `link-events-capture.ts`) replayed
//! on the Rust: the same output text, the same tab events from a sender.

use std::borrow::Cow;
use std::io::Read;
use std::time::Instant;

use flate2::read::GzDecoder;
use serde::Deserialize;
use serde_json::{Value, json};

use super::encoder::{Options, Sender};
use super::js;
use super::slim::{SharedBatch, Slimmer};
use super::{Op, Stream};

#[derive(Deserialize)]
struct Captured {
    rows: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    kind: String,
    test: String,
    options: Option<Value>,
    epoch: Option<String>,
    ops: Vec<CapturedOp>,
}

#[derive(Deserialize)]
struct CapturedOp {
    #[serde(flatten)]
    op: Op,
    /// `None` for `undefined` (and for a sender's calls, which give nothing).
    #[serde(default)]
    out: Option<String>,
    #[serde(default)]
    sends: Vec<CapturedSend>,
}

#[derive(Deserialize)]
struct CapturedSend {
    name: String,
    arg: String,
    ok: bool,
}

fn load(gz: &[u8]) -> Captured {
    let mut text = String::new();
    GzDecoder::new(gz).read_to_string(&mut text).expect("gzip");
    serde_json::from_str(&text).expect("captured rows")
}

/// Replays every row; answers how many calls matched, and the first differences.
fn replay(name: &str, gz: &[u8]) {
    let captured = load(gz);
    let mut calls = 0;
    let mut differences = Vec::new();
    for row in &captured.rows {
        let mut stream =
            Stream::open(&row.kind, row.options.as_ref(), row.epoch.as_deref()).expect("stream");
        for (index, captured) in row.ops.iter().enumerate() {
            let op = Op {
                op: captured.op.op.clone(),
                input: captured.op.input.clone(),
                fresh: captured.op.fresh,
                oks: captured.sends.iter().map(|send| send.ok).collect(),
            };
            let outcome = stream.call(&op).expect("call");
            calls += 1;
            let sends: Vec<(String, String)> = captured
                .sends
                .iter()
                .map(|send| (send.name.clone(), send.arg.clone()))
                .collect();
            let out_differs = captured.out != outcome.out;
            if (out_differs || sends != outcome.sends) && differences.len() < 5 {
                differences.push(format!(
                    "{} [{}] op {index} {}:\n  ts:   {:.600}\n  rust: {:.600}\n  ts sends:   {:.600}\n  rust sends: {:.600}",
                    row.test,
                    row.kind,
                    captured.op.op,
                    format!("{:?}", captured.out),
                    format!("{:?}", outcome.out),
                    format!("{sends:?}"),
                    format!("{:?}", outcome.sends),
                ));
            }
        }
    }
    assert!(calls > 0, "{name}: no calls captured");
    assert!(differences.is_empty(), "{name}: {}", differences.join("\n"));
}

#[test]
fn every_call_of_link_events_test() {
    replay(
        "link-events",
        include_bytes!("captured/link-events.json.gz"),
    );
}

#[test]
fn every_call_of_message_update_slim_test() {
    replay(
        "message-update-slim",
        include_bytes!("captured/message-update-slim.json.gz"),
    );
}

#[test]
fn every_call_of_subagent_frames_and_frame_bookkeeping_tests() {
    replay(
        "subagent-frames",
        include_bytes!("captured/subagent-frames.json.gz"),
    );
    replay(
        "frame-bookkeeping",
        include_bytes!("captured/frame-bookkeeping.json.gz"),
    );
}

#[test]
fn every_call_of_a_run_of_the_installed_omp() {
    replay(
        "link-events-stock",
        include_bytes!("captured/link-events-stock.json.gz"),
    );
}

#[test]
fn every_call_of_the_link_traffic_rig() {
    replay(
        "link-traffic-report",
        include_bytes!("captured/link-traffic-report.json.gz"),
    );
}

fn update(timestamp: u64, text: &str) -> Value {
    json!({
        "type": "message_update",
        "message": {"role": "assistant", "timestamp": timestamp, "content": [{"type": "text", "text": text}]},
        "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "x",
            "partial": {"role": "assistant", "content": [{"type": "text", "text": text}]}},
    })
}

#[test]
fn slimmers_that_stand_at_the_same_message_share_one_batch() {
    let batch = vec![update(1, "a"), update(1, "ab")];
    let mut shared = SharedBatch::default();
    let (mut first, mut second) = (Slimmer::new(), Slimmer::new());
    let one = first.slim_shared(&batch, &mut shared).expect("slimmed");
    let two = second.slim_shared(&batch, &mut shared).expect("slimmed");
    assert!(std::sync::Arc::ptr_eq(&one, &two));
    // One that stands elsewhere slims on its own.
    let mut joined = Slimmer::new();
    joined.slim(&[update(1, "")]);
    let own = joined.slim_shared(&batch, &mut shared).expect("slimmed");
    assert!(!std::sync::Arc::ptr_eq(&one, &own));
    assert_eq!(own.len(), 2);
    assert!(own[0]["message"].get("content").is_none());
    // A batch with nothing to slim goes as it is.
    let mut fresh = Slimmer::new();
    assert!(matches!(fresh.slim(&batch[..1]), Cow::Borrowed(_)));
    // A reset slimmer sends the snapshot again.
    first.reset();
    assert!(matches!(first.slim(&batch[1..]), Cow::Borrowed(_)));
}

/// The cost per event of the host's encoding on the traffic rig's streamed replies (450, 900 and 1 800 tokens), for
/// the ledger: `cargo test --release -p ompdesk-core remote::events::tests::cost -- --ignored --nocapture`. The same
/// sends as `link-events-core.test.ts`'s TypeScript measure: the sender's work, then that and each tab event's JSON
/// text.
#[test]
#[ignore]
fn cost() {
    let captured = load(include_bytes!("captured/link-traffic-report.json.gz"));
    let rounds: usize = std::env::var("OMPDESK_EVENTS_COST_ROUNDS")
        .ok()
        .and_then(|rounds| rounds.parse().ok())
        .unwrap_or(20);
    for tokens in [
        "150 thinking + 300",
        "300 thinking + 600",
        "600 thinking + 1200",
    ] {
        let Some(row) = captured
            .rows
            .iter()
            .find(|row| row.kind == "sender" && row.test.contains(tokens))
        else {
            continue;
        };
        let options = Options::from_value(row.options.as_ref().unwrap_or(&Value::Null));
        let events: usize = row
            .ops
            .iter()
            .map(|op| match (&op.op.op[..], &op.op.input) {
                ("events", Some(Value::Array(batch))) => batch.len(),
                ("subagentFrame", Some(_)) => 1,
                _ => 0,
            })
            .sum();
        let run = |send: &mut dyn FnMut(&'static str, Value) -> bool| {
            let started = Instant::now();
            for _ in 0..rounds {
                let mut sender = Sender::new(options);
                for op in &row.ops {
                    match (&op.op.op[..], &op.op.input) {
                        ("events", Some(Value::Array(batch))) => sender.events(batch, send),
                        ("subagentFrame", Some(frame)) => {
                            sender.subagent_frame(frame.clone(), send);
                        }
                        ("flush" | "timer", _) => sender.flush(send),
                        _ => sender.dispose(),
                    }
                }
            }
            started.elapsed().as_secs_f64() * 1e6 / (rounds * events) as f64
        };
        let encoding = run(&mut |_, _| true);
        let with_text = run(&mut |_, arg| !js::stringify(&arg).is_empty());
        println!(
            "{tokens} text tokens: {events} events, {encoding:.2} µs an event encoding, {with_text:.2} µs with JSON text"
        );
    }
}
