use super::*;
use http_body_util::Full;
use tokio::net::TcpStream;

struct Fixture { dir: PathBuf }
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("mcp-hub-native-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }
    fn config(&self) -> Config {
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        env.insert("OMP_GUI_MCP_HUB_SECRET".into(), "must-not-reach-child".into());
        env.insert("FIXTURE_MARKER".into(), "isolated".into());
        Config {
            port: 0,
            memory_state_file: Some(self.dir.join("recall.json")),
            rea: ReaConfig {
                command: "bun".into(),
                args: vec![format!("{}/src/mcp_hub/fixtures/hub-rea.ts", env!("CARGO_MANIFEST_DIR"))],
                env,
                cache_dir: Some(self.dir.join("cache")),
                version: "fixture".into(),
                curated_tools: vec!["inspect".into()],
            },
        }
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); } }

async fn request(hub: &McpHub, method: Method, path: &str, message: Option<Value>, session: Option<&str>, auth: Option<&str>) -> Response<Incoming> {
    let socket = TcpStream::connect(("127.0.0.1", hub.port())).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(socket)).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    let body = Full::new(Bytes::from(message.map_or(String::new(), |message| message.to_string())));
    let mut builder = Request::builder().method(method).uri(path).header("host", "127.0.0.1");
    if let Some(auth) = auth { builder = builder.header("authorization", auth); }
    if let Some(session) = session { builder = builder.header(SESSION_HEADER, session); }
    sender.send_request(builder.body(body).unwrap()).await.unwrap()
}
async fn post(hub: &McpHub, message: Value, session: Option<&str>) -> (String, Value) {
    let response = request(hub, Method::POST, "/rea", Some(message), session, Some(&hub.inner.auth)).await;
    assert_eq!(response.status(), 200);
    let session = response.headers().get(SESSION_HEADER).unwrap().to_str().unwrap().to_owned();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (session, serde_json::from_slice(&body).unwrap())
}
async fn initialize(hub: &McpHub) -> (String, Value) { post(hub, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}), None).await }

#[tokio::test]
async fn loopback_requires_launch_auth_and_keeps_port_and_credentials_on_restart() {
    let fixture = Fixture::new();
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let env = hub.omp_env("/a b/한글?x=1&y=%2F");
    assert_eq!(env["OMP_GUI_MCP_CWD"], "%2Fa%20b%2F%ED%95%9C%EA%B8%80%3Fx%3D1%26y%3D%252F");
    for auth in [None, Some("Bearer wrong"), Some("")] {
        assert_eq!(request(&hub, Method::POST, "/memory", Some(json!({"id":1,"method":"ping"})), None, auth).await.status(), 401);
    }
    let port = hub.port();
    assert_eq!(hub.restart().await.unwrap(), port);
    assert_eq!(hub.omp_env("/a b/한글?x=1&y=%2F"), env);
    let response = request(&hub, Method::POST, "/memory", Some(json!({"jsonrpc":"2.0","id":1,"method":"ping"})), None, Some(&hub.inner.auth)).await;
    let answer: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(answer["error"]["message"], "upstream MCP request failed: memory is not running");
    hub.shutdown().await.unwrap();
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    assert!(hub.omp_env("/").is_empty());
    let second = McpHub::start(fixture.config()).await.unwrap();
    assert_ne!(second.inner.auth, env["OMP_GUI_MCP_AUTH"]);
    second.shutdown().await.unwrap();
}

#[tokio::test]
async fn session_http_preserves_descriptors_ids_cwd_env_and_stream_events() {
    let fixture = Fixture::new();
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let cwd = fixture.dir.join("space 한글");
    std::fs::create_dir(&cwd).unwrap();
    let path = format!("/rea?cwd={}", encode_cwd(&cwd.to_string_lossy()));
    let init = request(&hub, Method::POST, &path, Some(json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{}})), None, Some(&hub.inner.auth)).await;
    let session = init.headers()[SESSION_HEADER].to_str().unwrap().to_owned();
    let answer: Value = serde_json::from_slice(&init.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(answer["result"]["instructions"], "Keep upstream trust instructions.\n\n");
    let notice = request(&hub, Method::POST, "/rea", Some(json!({"jsonrpc":"2.0","method":"notifications/initialized"})), Some(&session), Some(&hub.inner.auth)).await;
    assert_eq!(notice.status(), 202);
    let (_, list) = post(&hub, json!({"jsonrpc":"2.0","id":"7","method":"tools/list"}), Some(&session)).await;
    assert_eq!(list["id"], "7");
    assert_eq!(list["result"]["tools"][0]["_meta"], json!({"intact":true}));
    let mut stream = request(&hub, Method::GET, "/rea", None, Some(&session), Some(&hub.inner.auth)).await.into_body();
    assert_eq!(stream.frame().await.unwrap().unwrap().into_data().unwrap(), Bytes::from_static(b": open\n\n"));
    let (_, call) = post(&hub, json!({"jsonrpc":"2.0","id":null,"method":"tools/call","params":{"name":"inspect","arguments":{"notify":"proof"}}}), Some(&session)).await;
    assert_eq!(call["id"], Value::Null);
    let facts: Value = serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(std::fs::canonicalize(facts["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(&cwd).unwrap());
    assert_eq!(facts["secret"], Value::Null);
    assert_eq!(facts["marker"], "isolated");
    let event = stream.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(String::from_utf8_lossy(&event).contains("\"marker\":\"proof\""));
    let pid = facts["pid"].as_u64().unwrap() as u32;
    drop(stream);
    hub.shutdown().await.unwrap();
    #[cfg(unix)]
    assert!(!crate::sys::alive(pid));
}

#[tokio::test]
async fn eof_joins_listener_and_child_and_unknown_sessions_are_not_reused() {
    let fixture = Fixture::new();
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let (session, _) = initialize(&hub).await;
    let (_, call) = post(&hub, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"inspect","arguments":{}}}), Some(&session)).await;
    let facts: Value = serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let pid = facts["pid"].as_u64().unwrap() as u32;
    let response = request(&hub, Method::POST, "/rea", Some(json!({"id":2,"method":"ping"})), Some("gone"), Some(&hub.inner.auth)).await;
    assert_eq!(response.status(), 404);
    let (owner, pipe) = tokio::io::duplex(8);
    drop(owner);
    let port = hub.port();
    hub.own_until(pipe).await.unwrap();
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    #[cfg(unix)]
    assert!(!crate::sys::alive(pid));
}

#[tokio::test]
async fn memory_reads_current_token_and_preserves_upstream_instructions_and_sse() {
    let fixture = Fixture::new();
    let data_dir = fixture.dir.join("data");
    std::fs::create_dir_all(data_dir.join("auth-tokens")).unwrap();
    std::fs::write(data_dir.join("auth-tokens/default"), "fixture-token-one\n").unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    std::fs::write(fixture.dir.join("recall.json"), json!({"url":url,"dataDir":data_dir}).to_string()).unwrap();
    let (seen, mut received) = mpsc::unbounded_channel();
    let upstream = tokio::spawn(async move {
        let mut clients = JoinSet::new();
        for _ in 0..2 {
            let (socket, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            clients.spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let seen = seen.clone();
                    async move {
                        assert_eq!(request.uri().path(), "/mcp");
                        seen.send(request.headers()["authorization"].to_str().unwrap().to_owned()).unwrap();
                        let message: Value = serde_json::from_slice(&request.into_body().collect().await.unwrap().to_bytes()).unwrap();
                        let answer = json!({"jsonrpc":"2.0","id":message["id"],"result":{"instructions":"upstream trust text\n\n","content":[]}});
                        let mut response = response(200, Out::bytes(Bytes::from(format!("data: {answer}\n\n"))));
                        response.headers_mut().insert("content-type", hyper::header::HeaderValue::from_static("text/event-stream"));
                        Ok::<_, Infallible>(response)
                    }
                });
                let _ = http1::Builder::new().serve_connection(TokioIo::new(socket), service).await;
            });
        }
        while clients.join_next().await.is_some() {}
    });
    let hub = McpHub::start(fixture.config()).await.unwrap();
    for (index, token) in ["fixture-token-one", "fixture-token-two"].iter().enumerate() {
        std::fs::write(data_dir.join("auth-tokens/default"), token).unwrap();
        let response = request(&hub, Method::POST, "/memory", Some(json!({"jsonrpc":"2.0","id":index,"method":"initialize"})), None, Some(&hub.inner.auth)).await;
        let answer: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(answer["result"]["instructions"], "upstream trust text\n\n");
        assert_eq!(received.recv().await.unwrap(), format!("Bearer {token}"));
    }
    hub.shutdown().await.unwrap();
    upstream.await.unwrap();
}
