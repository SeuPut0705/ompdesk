use super::*;
use http_body_util::Full;
use tokio::net::TcpStream;

static FIXTURE_PORTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    dir: PathBuf,
    _port_owner: tokio::sync::MutexGuard<'static, ()>,
}
impl Fixture {
    async fn new() -> Self {
        let port_owner = FIXTURE_PORTS.lock().await;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!(
            "mcp-hub-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            dir,
            _port_owner: port_owner,
        }
    }
    fn config(&self) -> Config {
        let mut env = fixture_environment(&self.dir);
        env.insert(
            "OMP_GUI_MCP_HUB_SECRET".into(),
            "must-not-reach-child".into(),
        );
        for key in [
            "OMP_GUI_MCP_AUTH",
            "OMP_GUI_MCP_HUB",
            "OMP_GUI_MCP_CWD",
            "OMP_GUI_BRIDGE",
            "OMPDESK_SOCKET",
            "OMP_GUI_SESSION_TAG",
            "OMP_GUI_REA_ROOT",
        ] {
            env.insert(key.into(), "Bearer sample-fake-bearer".into());
        }
        env.insert("FIXTURE_MARKER".into(), "isolated".into());
        Config {
            port: 0,
            memory_state_file: Some(self.dir.join("recall.json")),
            rea: ReaConfig {
                command: "bun".into(),
                args: vec![format!(
                    "{}/src/mcp_hub/fixtures/hub-rea.ts",
                    env!("CARGO_MANIFEST_DIR")
                )],
                env,
                cache_dir: Some(self.dir.join("cache")),
                version: "fixture".into(),
                curated_tools: vec!["inspect".into()],
            },
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn request(
    hub: &McpHub,
    method: Method,
    path: &str,
    message: Option<Value>,
    session: Option<&str>,
    auth: Option<&str>,
) -> Response<Incoming> {
    let socket = TcpStream::connect(("127.0.0.1", hub.port())).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let body = Full::new(Bytes::from(
        message.map_or(String::new(), |message| message.to_string()),
    ));
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1");
    if let Some(auth) = auth {
        builder = builder.header("authorization", auth);
    }
    if let Some(session) = session {
        builder = builder.header(SESSION_HEADER, session);
    }
    sender
        .send_request(builder.body(body).unwrap())
        .await
        .unwrap()
}
async fn post(hub: &McpHub, message: Value, session: Option<&str>) -> (String, Value) {
    let response = request(
        hub,
        Method::POST,
        "/rea",
        Some(message),
        session,
        Some(&hub.inner.auth),
    )
    .await;
    assert_eq!(response.status(), 200);
    let session = response
        .headers()
        .get(SESSION_HEADER)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (session, serde_json::from_slice(&body).unwrap())
}
async fn initialize(hub: &McpHub) -> (String, Value) {
    post(hub, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}), None).await
}

#[tokio::test]
async fn loopback_requires_launch_auth_and_keeps_port_and_credentials_on_restart() {
    let fixture = Fixture::new().await;
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let env = hub.omp_env("/a b/한글?x=1&y=%2F");
    assert_eq!(
        env["OMP_GUI_MCP_CWD"],
        "%2Fa%20b%2F%ED%95%9C%EA%B8%80%3Fx%3D1%26y%3D%252F"
    );
    for auth in [None, Some("Bearer wrong"), Some("")] {
        assert_eq!(
            request(
                &hub,
                Method::POST,
                "/memory",
                Some(json!({"id":1,"method":"ping"})),
                None,
                auth
            )
            .await
            .status(),
            401
        );
    }
    let port = hub.port();
    assert_eq!(hub.restart().await.unwrap(), port);
    assert_eq!(hub.omp_env("/a b/한글?x=1&y=%2F"), env);
    let response = request(
        &hub,
        Method::POST,
        "/memory",
        Some(json!({"jsonrpc":"2.0","id":1,"method":"ping"})),
        None,
        Some(&hub.inner.auth),
    )
    .await;
    let answer: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        answer["error"]["message"],
        "upstream MCP request failed: memory is not running"
    );
    let mut held = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    hub.shutdown().await.unwrap();
    let mut byte = [0];
    let closed = tokio::time::timeout(Duration::from_secs(10), held.read(&mut byte))
        .await
        .unwrap();
    assert!(closed.is_err() || closed.unwrap() == 0);
    assert_listener_closed(&hub).await;
    assert!(hub.omp_env("/").is_empty());
    let second = McpHub::start(fixture.config()).await.unwrap();
    assert_ne!(second.inner.auth, env["OMP_GUI_MCP_AUTH"]);
    second.shutdown().await.unwrap();
}

#[tokio::test]
async fn session_http_preserves_descriptors_ids_cwd_env_and_stream_events() {
    let fixture = Fixture::new().await;
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let cwd = fixture.dir.join("space 한글");
    std::fs::create_dir(&cwd).unwrap();
    let path = format!("/rea?cwd={}", encode_cwd(&cwd.to_string_lossy()));
    let init = request(
        &hub,
        Method::POST,
        &path,
        Some(json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{}})),
        None,
        Some(&hub.inner.auth),
    )
    .await;
    let session = init.headers()[SESSION_HEADER].to_str().unwrap().to_owned();
    let answer: Value =
        serde_json::from_slice(&init.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        answer["result"]["instructions"],
        "Keep upstream trust instructions.\n\n"
    );
    let notice = request(
        &hub,
        Method::POST,
        "/rea",
        Some(json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
        Some(&session),
        Some(&hub.inner.auth),
    )
    .await;
    assert_eq!(notice.status(), 202);
    let (_, list) = post(
        &hub,
        json!({"jsonrpc":"2.0","id":"7","method":"tools/list"}),
        Some(&session),
    )
    .await;
    assert_eq!(list["id"], "7");
    assert_eq!(list["result"]["tools"][0]["_meta"], json!({"intact":true}));
    let mut stream = request(
        &hub,
        Method::GET,
        "/rea",
        None,
        Some(&session),
        Some(&hub.inner.auth),
    )
    .await
    .into_body();
    assert_eq!(
        stream.frame().await.unwrap().unwrap().into_data().unwrap(),
        Bytes::from_static(b": open\n\n")
    );
    let (_, call) = post(&hub, json!({"jsonrpc":"2.0","id":null,"method":"tools/call","params":{"name":"inspect","arguments":{"notify":"proof"}}}), Some(&session)).await;
    assert_eq!(call["id"], Value::Null);
    let facts: Value =
        serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        std::fs::canonicalize(facts["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(&cwd).unwrap()
    );
    assert_eq!(facts["secret"], Value::Null);
    assert!(
        facts["plumbing"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_null)
    );
    assert_eq!(facts["marker"], "isolated");
    let event = stream.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(String::from_utf8_lossy(&event).contains("\"marker\":\"proof\""));
    assert!(facts["pid"].is_u64());
    drop(stream);
    hub.shutdown().await.unwrap();
    #[cfg(unix)]
    {
        let pid = facts["pid"].as_u64().unwrap() as u32;
        assert!(!crate::sys::alive(pid));
    }
}

#[tokio::test]
async fn eof_joins_listener_and_child_and_unknown_sessions_are_not_reused() {
    let fixture = Fixture::new().await;
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let (session, _) = initialize(&hub).await;
    let (_, call) = post(&hub, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"inspect","arguments":{}}}), Some(&session)).await;
    let facts: Value =
        serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(facts["pid"].is_u64());
    let response = request(
        &hub,
        Method::POST,
        "/rea",
        Some(json!({"id":2,"method":"ping"})),
        Some("gone"),
        Some(&hub.inner.auth),
    )
    .await;
    assert_eq!(response.status(), 404);
    let (owner, pipe) = tokio::io::duplex(8);
    drop(owner);
    let mut held = TcpStream::connect(("127.0.0.1", hub.port())).await.unwrap();
    hub.own_until(pipe).await.unwrap();
    let mut byte = [0];
    let closed = tokio::time::timeout(Duration::from_secs(10), held.read(&mut byte))
        .await
        .unwrap();
    assert!(closed.is_err() || closed.unwrap() == 0);
    assert_listener_closed(&hub).await;
    #[cfg(unix)]
    {
        let pid = facts["pid"].as_u64().unwrap() as u32;
        assert!(!crate::sys::alive(pid));
    }
}

#[tokio::test]
async fn memory_reads_current_token_and_preserves_upstream_instructions_and_sse() {
    let fixture = Fixture::new().await;
    let data_dir = fixture.dir.join("data");
    std::fs::create_dir_all(data_dir.join("auth-tokens")).unwrap();
    std::fs::write(data_dir.join("auth-tokens/default"), "fixture-token-one\n").unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    std::fs::write(
        fixture.dir.join("recall.json"),
        json!({"url":url,"dataDir":data_dir}).to_string(),
    )
    .unwrap();
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
                        let raw = message["id"] == 0;
                        let text = if raw { format!("  {answer}\r\n ") } else { format!("data: {answer}\n\n") };
                        let mut response = response(200, Out::bytes(Bytes::from(text)));
                        response.headers_mut().insert("content-type", hyper::header::HeaderValue::from_static(if raw { "application/json" } else { "text/event-stream" }));
                        Ok::<_, Infallible>(response)
                    }
                });
                let _ = http1::Builder::new().serve_connection(TokioIo::new(socket), service).await;
            });
        }
        while clients.join_next().await.is_some() {}
    });
    let hub = McpHub::start(fixture.config()).await.unwrap();
    for (index, token) in ["fixture-token-one", "fixture-token-two"]
        .iter()
        .enumerate()
    {
        std::fs::write(data_dir.join("auth-tokens/default"), token).unwrap();
        let response = request(
            &hub,
            Method::POST,
            "/memory",
            Some(json!({"jsonrpc":"2.0","id":index,"method":"initialize"})),
            None,
            Some(&hub.inner.auth),
        )
        .await;
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        if index == 0 {
            assert!(bytes.starts_with(b"  {") && bytes.ends_with(b"\r\n "));
        }
        let answer: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(answer["result"]["instructions"], "upstream trust text\n\n");
        assert_eq!(received.recv().await.unwrap(), format!("Bearer {token}"));
    }
    hub.shutdown().await.unwrap();
    upstream.await.unwrap();
}

#[tokio::test]
async fn completed_session_tasks_are_reaped_but_shutdown_still_joins_active_cleanup() {
    let fixture = Fixture::new().await;
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let (release, wait) = oneshot::channel();
    let (closed, mut was_closed) = oneshot::channel();
    hub.inner.track(tokio::spawn(async move {
        let _ = wait.await;
        let _ = closed.send(());
    }));
    for _ in 0..100 {
        let mut finished = tokio::spawn(async {});
        (&mut finished).await.unwrap();
        hub.inner.track(finished);
    }
    // Completed work is gone; the active close still belongs to shutdown.
    assert_eq!(hub.inner.tasks.lock().unwrap().len(), 1);
    let mut stopping = std::pin::pin!(hub.shutdown());
    std::future::poll_fn(|cx| {
        assert!(stopping.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(matches!(
        was_closed.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    stopping.await.unwrap();
    was_closed.await.unwrap();
}

#[tokio::test]
async fn replacing_a_stream_keeps_the_same_rea_while_a_dropped_live_stream_closes_it() {
    let fixture = Fixture::new().await;
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let (session, _) = initialize(&hub).await;
    let (_, first) = post(&hub, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"inspect","arguments":{}}}), Some(&session)).await;
    let facts: Value =
        serde_json::from_str(first["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(facts["pid"].is_u64());
    let mut old = request(
        &hub,
        Method::GET,
        "/rea",
        None,
        Some(&session),
        Some(&hub.inner.auth),
    )
    .await
    .into_body();
    old.frame().await.unwrap().unwrap();
    let mut replacement = request(
        &hub,
        Method::GET,
        "/rea",
        None,
        Some(&session),
        Some(&hub.inner.auth),
    )
    .await
    .into_body();
    replacement.frame().await.unwrap().unwrap();
    drop(old);
    let (_, call) = post(&hub, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"inspect","arguments":{"notify":"replacement"}}}), Some(&session)).await;
    let after: Value =
        serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(after["pid"], facts["pid"]);
    assert!(
        String::from_utf8_lossy(
            &replacement
                .frame()
                .await
                .unwrap()
                .unwrap()
                .into_data()
                .unwrap()
        )
        .contains("replacement")
    );
    let mut ended = hub
        .inner
        .sessions
        .lock()
        .unwrap()
        .get(&session)
        .unwrap()
        .end
        .subscribe();
    drop(replacement);
    tokio::time::timeout(Duration::from_secs(10), ended.changed())
        .await
        .unwrap()
        .unwrap();
    #[cfg(unix)]
    {
        let pid = facts["pid"].as_u64().unwrap() as u32;
        assert!(!crate::sys::alive(pid));
    }
    hub.shutdown().await.unwrap();
}

#[tokio::test]
async fn requested_port_conflict_falls_back_and_bundled_config_reads_the_shipped_pin() {
    let fixture = Fixture::new().await;
    let occupied = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let taken = occupied.local_addr().unwrap().port();
    let mut config = fixture.config();
    config.port = taken;
    let hub = McpHub::start(config).await.unwrap();
    assert_ne!(hub.port(), taken);
    hub.shutdown().await.unwrap();
    let builtin = fixture.dir.join("builtin");
    std::fs::create_dir_all(builtin.join("rea")).unwrap();
    std::fs::write(
        builtin.join("rea/rea-config.json"),
        br#"{"version":"123.4.5","curatedTools":["original"]}"#,
    )
    .unwrap();
    let config = Config::bundled(&builtin, &fixture.dir, BTreeMap::new(), false).unwrap();
    assert_eq!(config.rea.args, ["-y", "rea-agents@123.4.5", "mcp"]);
    assert_eq!(config.rea.curated_tools, ["original"]);
}

#[tokio::test]
async fn stream_end_waits_for_the_outstanding_post_body_to_be_consumed_or_cancelled() {
    let fixture = Fixture::new().await;
    let hub = McpHub::start(fixture.config()).await.unwrap();
    let (_id, session) = hub.inner.open(None).unwrap();
    let (tx, mut stream) = mpsc::unbounded_channel();
    session.events.lock().unwrap().stream = Some((1, tx));
    let mut post = rpc_response(
        200,
        json!({"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"REA child exited"}}),
    );
    post.body_mut()._reply = ReplyLease::acquire(&session);
    let mut finish = std::pin::pin!(session.finish());
    std::future::poll_fn(|cx| {
        assert!(finish.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(matches!(
        stream.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    let bytes = post
        .body_mut()
        .frame()
        .await
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("REA child exited"));
    drop(post);
    finish.await;
    assert!(stream.recv().await.is_none());
    hub.shutdown().await.unwrap();
}

async fn assert_listener_closed(hub: &McpHub) {
    let connected = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect(("127.0.0.1", hub.port())),
    )
    .await
    .expect("fresh connect timed out; listener ownership is unknown");
    let socket = match connected {
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => return,
        Err(error) => panic!("fresh connect failed without proving refusal: {error}"),
        Ok(socket) => socket,
    };
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
        .await
        .expect("fresh peer is not identified as an MCP HTTP server");
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    let probe = Request::builder()
        .method(Method::POST)
        .uri("/memory")
        .header("host", "127.0.0.1")
        .header("authorization", &hub.inner.auth)
        .body(Full::new(Bytes::from_static(
            br#"{"jsonrpc":"2.0","id":"closed-owner","method":"ping"}"#,
        )))
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), sender.send_request(probe)).await;
    driver.abort();
    let _ = driver.await;
    match result {
        Ok(Ok(reply)) if reply.status() == 200 => {
            panic!("the closed hub still accepts its old launch bearer")
        }
        Ok(Ok(reply)) => panic!(
            "fresh peer at the closed port is unknown; old-bearer probe returned {}",
            reply.status()
        ),
        Ok(Err(error)) => panic!("fresh peer identity could not be established: {error}"),
        Err(_) => panic!("fresh peer timed out; listener closure is not proved"),
    }
}
