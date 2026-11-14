use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ompdesk-rea-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TestDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

fn config(dir: &Path) -> ReaConfig {
    ReaConfig {
        command: "bun".into(),
        args: vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mcp_hub/fixtures/rea-server.mjs").to_string_lossy().into_owned()],
        env: std::env::vars().collect(),
        cache_dir: Some(dir.to_owned()),
        version: "test".into(),
        curated_tools: vec!["open_binary".into()],
    }
}
fn session(config: ReaConfig, cache: Arc<Cache>) -> (Arc<Rea>, UnboundedReceiver<Value>, UnboundedReceiver<()>) {
    let (events, rx) = mpsc::unbounded_channel();
    let (closed, ended) = mpsc::unbounded_channel();
    (Rea::new(config, None, cache, events, closed), rx, ended)
}
fn handshake() -> Value { json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}) }
async fn call(rea: &Rea, id: Value, method: &str, params: Value) -> Value {
    let receiver = rea.receive(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).unwrap();
    tokio::time::timeout(Duration::from_secs(10), receiver).await.unwrap().unwrap()
}
fn notify(rea: &Rea, method: &str, params: Value) {
    assert!(rea.receive(json!({"jsonrpc":"2.0","method":method,"params":params})).is_none());
}
async fn next_event(events: &mut UnboundedReceiver<Value>, method: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["method"] == method { return event; }
        }
    }).await.unwrap()
}
async fn initialize(rea: &Rea) -> Value {
    let result = call(rea, json!(1), "initialize", handshake()).await;
    notify(rea, "notifications/initialized", json!({}));
    result
}
async fn seed(dir: &Path) -> (ReaConfig, Arc<Cache>) {
    let config = config(dir);
    let cache = Arc::new(Cache::new(&config));
    let (rea, _, _) = session(config.clone(), cache.clone());
    assert_eq!(initialize(&rea).await["result"]["instructions"], "Keep upstream instructions.");
    let listed = call(&rea, json!(2), "tools/list", json!({})).await;
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 3);
    assert!(dir.join("rea-test.json").exists());
    rea.close().await;
    (config, cache)
}
async fn file_exists(path: &Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
}

#[tokio::test]
async fn cache_preserves_instructions_complete_descriptors_and_lazy_start() {
    let dir = TestDir::new();
    let (config, _) = seed(&dir.0).await;
    let cache = Arc::new(Cache::new(&config));
    let (rea, _, _) = session(config, cache);
    assert_eq!(initialize(&rea).await["result"]["instructions"], "Keep upstream instructions.");
    assert!(!rea.running());
    let listed = call(&rea, Value::Null, "tools/list", json!({})).await;
    assert_eq!(listed["id"], Value::Null);
    assert_eq!(listed["result"]["tools"][0]["_meta"]["provenance"]["untrusted_content"], true);
    assert_eq!(call(&rea, json!("prompts"), "prompts/list", json!({})).await["result"]["prompts"][0]["name"], "investigate");
    let result = call(&rea, json!(3), "tools/call", json!({"name":"rea_catalog","arguments":{"name":"open_binary"}})).await;
    let text = result["result"]["content"][0]["text"].as_str().unwrap();
    let descriptor: Value = serde_json::from_str(text).unwrap();
    assert_eq!(descriptor["tools"][0]["outputSchema"]["type"], "object");
    assert!(!rea.running());
    let invoked = call(&rea, json!(4), "tools/call", json!({"name":"rea_call","arguments":{"name":"other","arguments":{"marker":"ok"}}})).await;
    assert_eq!(invoked["result"], json!({"name":"other","arguments":{"marker":"ok"}}));
    assert!(rea.running());
    rea.close().await;
    assert!(!rea.running());
}

#[tokio::test]
async fn cancelled_call_during_handshake_never_reaches_child_and_notifications_wait() {
    let dir = TestDir::new();
    let (mut config, cache) = seed(&dir.0).await;
    let barrier = dir.0.join("barrier");
    let log = dir.0.join("child.log");
    config.env.insert("REA_BARRIER".into(), barrier.to_string_lossy().into_owned());
    config.env.insert("REA_LOG".into(), log.to_string_lossy().into_owned());
    let (rea, mut events, _) = session(config, cache);
    initialize(&rea).await;
    let answer = rea.receive(json!({"jsonrpc":"2.0","id":null,"method":"tools/call","params":{"name":"rea_call","arguments":{"name":"other","arguments":{"marker":"cancel"}}}})).unwrap();
    file_exists(&dir.0.join("barrier.started")).await;
    notify(&rea, "notifications/roots/list_changed", json!({}));
    notify(&rea, "notifications/cancelled", json!({"requestId":null}));
    std::fs::write(dir.0.join("barrier.release"), "ok").unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(10), answer).await.unwrap().unwrap();
    assert_eq!(answer["id"], Value::Null);
    assert_eq!(answer["error"]["code"], -32800);
    let message = next_event(&mut events, "notifications/message").await;
    assert_eq!(message["params"]["initialized"], true);
    let next = call(&rea, json!("next"), "tools/call", json!({"name":"rea_call","arguments":{"name":"other","arguments":{"marker":"next"}}})).await;
    assert_eq!(next["result"]["arguments"]["marker"], "next");
    rea.close().await;
    let lines = std::fs::read_to_string(log).unwrap();
    assert!(!lines.contains("\"marker\":\"cancel\""));
    assert!(lines.contains("\"marker\":\"next\""));
    let notices: Vec<Value> = lines.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let init = notices.iter().position(|item| item["method"] == "initialize").unwrap();
    let changed = notices.iter().position(|item| item["method"] == "notifications/roots/list_changed").unwrap();
    assert!(init < changed);
}

#[tokio::test]
async fn server_requests_refresh_and_original_errors_cross_the_session() {
    let dir = TestDir::new();
    let config = config(&dir.0);
    let (rea, mut events, _) = session(config.clone(), Arc::new(Cache::new(&config)));
    initialize(&rea).await;
    call(&rea, json!(2), "tools/list", json!({})).await;
    let error = call(&rea, json!(3), "tools/call", json!({"name":"rea_call","arguments":{"name":"other","arguments":{"marker":"fail"}}})).await;
    assert_eq!(error["error"], json!({"code":-32001,"message":"original","data":{"source":"fixture"}}));
    call(&rea, json!(4), "fixture/ask", json!({})).await;
    let asked = next_event(&mut events, "roots/list").await;
    assert_ne!(asked["id"], json!(41));
    assert!(rea.receive(json!({"jsonrpc":"2.0","id":asked["id"],"result":{"roots":[]}})).is_none());
    loop {
        let event = next_event(&mut events, "notifications/message").await;
        if event["params"]["answered"] == 41 { assert_eq!(event["params"]["result"], json!({"roots":[]})); break; }
    }
    call(&rea, json!(5), "fixture/change", json!({})).await;
    next_event(&mut events, "notifications/tools/list_changed").await;
    let listed = call(&rea, json!(6), "tools/list", json!({})).await;
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 2);
    rea.close().await;
}

#[tokio::test]
async fn failed_cached_handshake_answers_before_closing_and_invalidates_cache() {
    let dir = TestDir::new();
    let (mut config, cache) = seed(&dir.0).await;
    config.env.insert("REA_FAIL_INITIALIZE".into(), "1".into());
    let (rea, _, mut ended) = session(config, cache.clone());
    initialize(&rea).await;
    let error = call(&rea, json!("failed"), "tools/call", json!({"name":"rea_call","arguments":{"name":"other","arguments":{}}})).await;
    assert_eq!(error["error"]["message"], "refused");
    tokio::time::timeout(Duration::from_secs(10), ended.recv()).await.unwrap().unwrap();
    assert!(cache.get().is_none());
    assert!(!dir.0.join("rea-test.json").exists());
    rea.close().await;
}
