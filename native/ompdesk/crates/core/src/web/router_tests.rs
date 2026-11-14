use super::*;

const BATCH: &str = "rpc:events";

#[derive(Deserialize)]
struct Item {
    ch: String,
    d: Option<String>,
}

#[derive(Deserialize)]
struct Row {
    pushed: Vec<Item>,
    out: Vec<Item>,
}

fn pushed(item: &Item) -> Arc<Pushed> {
    let data = item
        .d
        .clone()
        .map(|text| RawValue::from_string(text).expect("captured JSON"));
    Pushed::new(item.ch.clone(), data)
}

/// 300 queues captured from `coalesceEvents` (ws-router.ts before 8c): every frame's channel and data text.
#[test]
fn joins_and_merges_as_the_typescript_router_did() {
    let rows: Vec<Row> =
        serde_json::from_str(include_str!("router-captured.json")).expect("captured rows");
    assert_eq!(rows.len(), 300);
    for (index, row) in rows.iter().enumerate() {
        let queue: Vec<Arc<Pushed>> = row.pushed.iter().map(pushed).collect();
        let out = coalesce(&queue, BATCH);
        let got: Vec<(String, Option<String>)> = out
            .iter()
            .map(|item| {
                (
                    item.ch().to_owned(),
                    item.data_text(BATCH).map(|t| t.to_string()),
                )
            })
            .collect();
        let want: Vec<(String, Option<String>)> = row
            .out
            .iter()
            .map(|item| (item.ch.clone(), item.d.clone()))
            .collect();
        assert_eq!(got, want, "row {index}");
    }
}

#[test]
fn makes_a_joined_text_once_for_the_same_pushes() {
    let a = Pushed::new(
        BATCH.into(),
        Some(RawValue::from_string(r#"{"tabId":"a","payload":[{"type":"x"}]}"#.into()).unwrap()),
    );
    let b = Pushed::new(
        BATCH.into(),
        Some(RawValue::from_string(r#"{"tabId":"a","payload":[{"type":"y"}]}"#.into()).unwrap()),
    );
    let queue = vec![Arc::clone(&a), Arc::clone(&b)];
    let first = coalesce(&queue, BATCH)[0].data_text(BATCH).unwrap();
    let second = coalesce(&queue, BATCH)[0].data_text(BATCH).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(
        &*first,
        r#"{"tabId":"a","payload":[{"type":"x"},{"type":"y"}]}"#
    );
}

#[test]
fn preserves_view_identity_when_coalescing_same_view_batches() {
    let queue: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|kind| {
            Pushed::new(
                BATCH.into(),
                Some(
                    RawValue::from_string(
                        json!({"tabId":"retained","viewId":"view-B","payload":[{"type":kind}]})
                            .to_string(),
                    )
                    .unwrap(),
                ),
            )
        })
        .collect();
    let output = coalesce(&queue, BATCH);
    assert_eq!(output.len(), 1);
    let value: Value = serde_json::from_str(&output[0].data_text(BATCH).unwrap()).unwrap();
    assert_eq!(value["viewId"], "view-B");
    assert_eq!(
        value["payload"],
        json!([{"type":"first"},{"type":"second"}])
    );
}

#[test]
fn separates_reopened_views_of_the_same_execution() {
    let queue: Vec<_> = ["view-A", "view-B"]
        .into_iter()
        .map(|view| {
            Pushed::new(
                BATCH.into(),
                Some(
                    RawValue::from_string(
                        json!({"tabId":"retained","viewId":view,"payload":[{"type":view}]})
                            .to_string(),
                    )
                    .unwrap(),
                ),
            )
        })
        .collect();
    let output: Vec<Value> = coalesce(&queue, BATCH)
        .iter()
        .map(|item| serde_json::from_str(&item.data_text(BATCH).unwrap()).unwrap())
        .collect();
    assert_eq!(
        output,
        vec![
            json!({"tabId":"retained","viewId":"view-A","payload":[{"type":"view-A"}]}),
            json!({"tabId":"retained","viewId":"view-B","payload":[{"type":"view-B"}]}),
        ]
    );
}

#[test]
fn reads_frames_as_the_schema_did() {
    let call = Frame::parse(r#"{"t":"inv","id":7,"ch":"c","a":[1,{"x":"\ud83d"}],"extra":1}"#);
    assert!(matches!(call, Some(Frame::Call { id: Some(7), .. })));
    assert!(matches!(
        Frame::parse(r#"{"t":"snd","ch":"c","a":[]}"#),
        Some(Frame::Call { id: None, .. })
    ));
    assert!(matches!(
        Frame::parse(r#"{"t":"ack","seq":3}"#),
        Some(Frame::Ack(3))
    ));
    assert!(matches!(
        Frame::parse(r#"{"t":"inv","id":2.0,"ch":"c","a":[]}"#),
        Some(Frame::Call { id: Some(2), .. })
    ));
    for junk in [
        "not json",
        r#"{"t":"nope"}"#,
        r#"{"t":"inv","id":"x","ch":"c","a":[]}"#,
        r#"{"t":"inv","id":-1,"ch":"c","a":[]}"#,
        r#"{"t":"inv","id":1.5,"ch":"c","a":[]}"#,
        r#"{"t":"inv","id":1,"ch":"","a":[]}"#,
        r#"{"t":"snd","ch":"c","a":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}"#,
        r#"{"t":"presence","visible":1}"#,
        r#"{"t":"ack"}"#,
        "[]",
    ] {
        assert!(Frame::parse(junk).is_none(), "{junk}");
    }
    let long = format!(r#"{{"t":"snd","ch":"{}","a":[]}}"#, "x".repeat(129));
    assert!(Frame::parse(&long).is_none());
}

#[test]
fn reads_a_repeated_key_as_json_parse_does_and_a_wide_frame_in_linear_time() {
    // The last value wins, at the place the key first had.
    assert!(matches!(
        Frame::parse(r#"{"t":"nope","ch":"c","a":[],"t":"snd"}"#),
        Some(Frame::Call { id: None, .. })
    ));
    let members: Members = serde_json::from_str(r#"{"a":1,"b":2,"a":3}"#).unwrap();
    let order: Vec<(&str, &str)> = members
        .members
        .iter()
        .map(|(key, value)| (key.as_str(), value.get()))
        .collect();
    assert_eq!(order, [("a", "3"), ("b", "2")]);
    // A page's frame holds up to 1 MB: one of short distinct keys (about 110 000 here) is read at once, where a
    // search of the keys before each key took about 6e9 comparisons.
    let mut wide = String::from(r#"{"t":"snd","ch":"c","a":[]"#);
    let mut n = 0;
    while wide.len() < 1_000_000 {
        wide.push_str(&format!(r#","k{n}":0"#));
        n += 1;
    }
    wide.push('}');
    let started = std::time::Instant::now();
    assert!(matches!(Frame::parse(&wide), Some(Frame::Call { .. })));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn keeps_mobile_web_preferences_on_the_computer() {
    let args = |text: &str| RawValue::from_string(text.to_owned()).unwrap();
    assert!(writes_mobile_web(&args(
        r#"[{"key":"mobileWeb.enabled","value":true}]"#
    )));
    assert!(writes_mobile_web(&args(r#"[{"key":"MOBILEWEB.x"}]"#)));
    assert!(!writes_mobile_web(&args(r#"[{"key":"theme"}]"#)));
    assert!(!writes_mobile_web(&args(r#"[]"#)));
}

/// `TokenBucket` (rate-limit.ts before 8c): a burst, then the sustained rate, refilling with time up to the burst.
#[test]
fn lets_a_burst_through_then_the_sustained_rate() {
    let mut bucket = Bucket::new(0);
    let drain = |bucket: &mut Bucket, now: i64| (0..).take_while(|_| bucket.take(now)).count();
    assert_eq!(drain(&mut bucket, 0), 400);
    assert_eq!(drain(&mut bucket, 100), 20);
    assert_eq!(drain(&mut bucket, 60_100), 400);
}
