//! Session conclusions that arrive from another of the person's computers.
//!
//! `POST /admin/write-conclusions` stores them in their own table, `memory_query
//! {conclusions:true}` answers them beside the local `Stop` conclusions, and
//! `GET /admin/conclusions` lists both streams so a paired computer can pull
//! them. Everything here goes through the real routes and the real MCP tool.

use ai_memory_core::{
    AgentKind, NewObservation, NewPage, NewSession, ObservationKind, PagePath, ProjectId,
    Sanitized, Sanitizer, SessionId, Tier, WorkspaceId,
};
use ai_memory_mcp::{AdminState, AiMemoryServer, admin_router};
use ai_memory_store::{DecayParams, Store, lookup_existing_scope};
use ai_memory_wiki::Wiki;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const WS: &str = "default";
const PROJ: &str = "scratch";
const OTHER: &str = "other";
const DEVICE: &str = "mac-1";

struct Harness {
    _tmp: TempDir,
    store: Store,
    admin: Router,
    mcp: Router,
    ws: WorkspaceId,
    proj: ProjectId,
    other: ProjectId,
}

async fn harness() -> Harness {
    let tmp = TempDir::new().expect("tempdir");
    let store = Store::open(tmp.path()).expect("store");
    let ws = store.writer.get_or_create_workspace(WS).await.expect("ws");
    let proj = store
        .writer
        .get_or_create_project(ws, PROJ, None)
        .await
        .expect("proj");
    let other = store
        .writer
        .get_or_create_project(ws, OTHER, None)
        .await
        .expect("other");
    let wiki = Wiki::new(tmp.path(), store.writer.clone())
        .expect("wiki")
        .with_store_reader(store.reader.clone());
    let admin = admin_router(AdminState {
        ingest_metrics: std::sync::Arc::new(ai_memory_core::IngestMetrics::default()),
        mcp_metrics: std::sync::Arc::new(ai_memory_mcp::McpMetrics::default()),
        writer: store.writer.clone(),
        reader: store.reader.clone(),
        wiki,
        llm: None,
        auto_improve_require_approval: false,
        auto_improve_review_config: Default::default(),
        embedder: None,
        provider_health: ai_memory_llm::ProviderHealth::default(),
        decay_params: DecayParams::default(),
        contradiction_band_min: ai_memory_consolidate::DEFAULT_CONTRADICTION_SIM_LOW,
        contradiction_band_max: ai_memory_consolidate::DEFAULT_CONTRADICTION_SIM_HIGH,
        data_dir: tmp.path().to_path_buf(),
        db_path: store.db_path().to_path_buf(),
        bind: "127.0.0.1:0".to_string(),
        home_dir: None,
        bootstrap_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        token_pepper: None,
        active_project: ai_memory_core::ActiveProject::new(),
        scope_invalidator: None,
        trusted_proxy_identity: false,
    });
    let server = AiMemoryServer::new(store.reader.clone(), store.writer.clone(), ws, proj);
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_stateful_mode(false)
            .with_json_response(true),
    );
    Harness {
        _tmp: tmp,
        store,
        admin,
        mcp: Router::new().nest_service("/mcp", service),
        ws,
        proj,
        other,
    }
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let resp = router.clone().oneshot(request).await.expect("oneshot");
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn post(router: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    send(
        router,
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("post"),
    )
    .await
}

async fn get(router: &Router, uri: &str) -> (StatusCode, Value) {
    send(
        router,
        Request::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .expect("get"),
    )
    .await
}

async fn query(router: &Router, arguments: Value) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "memory_query", "arguments": arguments },
    });
    let req = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(Body::from(body.to_string()))
        .expect("mcp req");
    let (_, v) = send(router, req).await;
    assert!(v.get("error").is_none(), "JSON-RPC error: {v}");
    let text = v
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing tool text: {v}"));
    serde_json::from_str(text).expect("tool payload")
}

fn args(query: &str) -> Value {
    json!({ "query": query, "workspace": WS, "project": PROJ, "conclusions": true })
}

/// The response omits `conclusion_hits` when no conclusion matched.
fn no_conclusions(payload: &Value) -> bool {
    payload["conclusion_hits"]
        .as_array()
        .is_none_or(|hits| hits.is_empty())
}

fn item(id: &str, session: SessionId, title: &str, body: &str, at: &str) -> Value {
    json!({
        "id": id,
        "session_id": session.to_string(),
        "title": title,
        "body": body,
        "created_at": at,
    })
}

fn write_request(project: &str, items: Vec<Value>) -> Value {
    json!({
        "workspace": WS,
        "project": project,
        "origin_device": DEVICE,
        "conclusions": items,
    })
}

async fn write(h: &Harness, project: &str, items: Vec<Value>) -> (StatusCode, Value) {
    post(
        &h.admin,
        "/admin/write-conclusions",
        write_request(project, items),
    )
    .await
}

fn statuses(reply: &Value) -> Vec<String> {
    reply["results"]
        .as_array()
        .unwrap_or_else(|| panic!("no results: {reply}"))
        .iter()
        .map(|r| r["status"].as_str().unwrap().to_string())
        .collect()
}

async fn native_session(h: &Harness, project: ProjectId) -> SessionId {
    let id = SessionId::new();
    h.store
        .writer
        .begin_session(NewSession {
            occurred_at: None,
            id,
            workspace_id: h.ws,
            project_id: project,
            agent_kind: AgentKind::ClaudeCode,
            cwd: Some("/repo".into()),
            actor_user: None,
        })
        .await
        .expect("session");
    id
}

async fn observe(
    h: &Harness,
    project: ProjectId,
    session_id: SessionId,
    kind: ObservationKind,
    title: &str,
    body: &str,
) {
    h.store
        .writer
        .insert_observation(Sanitized::new(
            NewObservation {
                occurred_at: None,
                session_id,
                workspace_id: h.ws,
                project_id: project,
                kind,
                extension: None,
                source_event: None,
                title: title.into(),
                body: body.into(),
                importance: 5,
            },
            &Sanitizer::builtin(),
        ))
        .await
        .expect("observation");
}

async fn synced_rows(h: &Harness) -> Vec<Value> {
    let (status, reply) = get(&h.admin, "/admin/conclusions?source=synced").await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    reply["conclusions"].as_array().expect("rows").clone()
}

#[tokio::test]
async fn a_written_conclusion_is_answered_by_memory_query_with_its_title_and_excerpt() {
    let h = harness().await;
    let session = SessionId::new();
    let (status, reply) = write(
        &h,
        PROJ,
        vec![item(
            "obs-1",
            session,
            "Deploy decision",
            "We decided the quokka cache must be warmed before every deploy.",
            "2026-10-19T10:00:00Z",
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(
        reply["results"],
        json!([{ "id": "obs-1", "status": "written" }])
    );

    let payload = query(&h.mcp, args("quokka")).await;
    let rows = payload["conclusion_hits"].as_array().expect("hits");
    assert_eq!(rows.len(), 1, "{payload}");
    assert_eq!(rows[0]["session_id"], session.to_string().as_str());
    assert_eq!(rows[0]["title"], "Deploy decision");
    assert!(
        rows[0]["excerpt"]
            .as_str()
            .unwrap()
            .contains("<mark>quokka</mark>"),
        "{payload}"
    );
    assert_eq!(rows[0]["created_at"], "2026-10-19T10:00:00Z");
    assert!(rows[0]["rank"].as_f64().is_some(), "{payload}");
}

#[tokio::test]
async fn native_and_synced_conclusions_of_different_sessions_both_appear_ordered_by_rank() {
    let h = harness().await;
    let native = native_session(&h, h.proj).await;
    observe(
        &h,
        h.proj,
        native,
        ObservationKind::Stop,
        "stop",
        "quokka quokka quokka: the local run pinned the flaky test to the quokka pool.",
    )
    .await;
    let synced = SessionId::new();
    let (status, reply) = write(
        &h,
        PROJ,
        vec![item(
            "obs-2",
            synced,
            "From the other computer",
            "The remote run also blamed the quokka pool, after a long walk through many other steps.",
            "2026-10-19T11:00:00Z",
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");

    let payload = query(&h.mcp, args("quokka")).await;
    let rows = payload["conclusion_hits"].as_array().expect("hits");
    let mut found: Vec<&str> = rows
        .iter()
        .map(|r| r["session_id"].as_str().unwrap())
        .collect();
    found.sort_unstable();
    let mut expected = [native.to_string(), synced.to_string()];
    expected.sort_unstable();
    assert_eq!(found, expected, "both streams answer: {payload}");
    let ranks: Vec<f64> = rows.iter().map(|r| r["rank"].as_f64().unwrap()).collect();
    assert!(
        ranks.windows(2).all(|w| w[0] <= w[1]),
        "best rank first: {ranks:?}"
    );

    let mut capped = args("quokka");
    capped["limit"] = json!(1);
    let payload = query(&h.mcp, capped).await;
    assert_eq!(
        payload["conclusion_hits"].as_array().unwrap().len(),
        1,
        "{payload}"
    );
}

#[tokio::test]
async fn one_hit_per_session_keeps_the_best_ranked_conclusion() {
    let h = harness().await;
    let session = SessionId::new();
    let (status, reply) = write(
        &h,
        PROJ,
        vec![
            item(
                "obs-a",
                session,
                "Weak",
                "A passing mention of the quokka among a very long list of unrelated words that dilute it.",
                "2026-10-19T10:00:00Z",
            ),
            item(
                "obs-b",
                session,
                "Strong",
                "quokka quokka quokka",
                "2026-10-19T10:05:00Z",
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(statuses(&reply), ["written", "written"]);

    let payload = query(&h.mcp, args("quokka")).await;
    let rows = payload["conclusion_hits"].as_array().expect("hits");
    assert_eq!(rows.len(), 1, "{payload}");
    assert_eq!(rows[0]["title"], "Strong", "{payload}");
}

#[tokio::test]
async fn the_same_request_twice_answers_same_and_keeps_one_row() {
    let h = harness().await;
    let items = vec![
        item(
            "obs-1",
            SessionId::new(),
            "One",
            "first quokka conclusion",
            "2026-10-19T10:00:00Z",
        ),
        item(
            "obs-2",
            SessionId::new(),
            "Two",
            "second quokka conclusion",
            "2026-10-19T10:01:00Z",
        ),
    ];
    let (_, first) = write(&h, PROJ, items.clone()).await;
    assert_eq!(statuses(&first), ["written", "written"], "{first}");
    let (status, second) = write(&h, PROJ, items.clone()).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(statuses(&second), ["same", "same"], "{second}");
    assert_eq!(second["results"][0]["id"], "obs-1");
    assert_eq!(synced_rows(&h).await.len(), 2);

    // Immutable: a later copy of the same origin id with other text changes nothing.
    let mut edited = items[0].clone();
    edited["body"] = json!("rewritten walrus text");
    edited["title"] = json!("Rewritten");
    let (_, third) = write(&h, PROJ, vec![edited]).await;
    assert_eq!(statuses(&third), ["same"], "{third}");
    let rows = synced_rows(&h).await;
    assert_eq!(rows.len(), 2);
    let stored = rows.iter().find(|r| r["id"] == "obs-1").unwrap();
    assert_eq!(stored["body"], "first quokka conclusion");
    assert_eq!(stored["title"], "One");
    let payload = query(&h.mcp, args("walrus")).await;
    assert!(no_conclusions(&payload), "{payload}");
}

#[tokio::test]
async fn an_invalid_item_refuses_the_whole_request_and_writes_nothing() {
    let h = harness().await;
    let ok = || {
        item(
            "ok",
            SessionId::new(),
            "Fine",
            "a quokka line",
            "2026-10-19T10:00:00Z",
        )
    };
    let broken = |field: &str, value: Value| {
        let mut bad = ok();
        bad["id"] = json!("bad");
        bad[field] = value;
        bad
    };
    let too_many: Vec<Value> = (0..501)
        .map(|n| {
            item(
                &format!("n{n}"),
                SessionId::new(),
                "t",
                "b",
                "2026-10-19T10:00:00Z",
            )
        })
        .collect();
    let mut blank_device = write_request("ghost", vec![ok()]);
    blank_device["origin_device"] = json!("  ");
    let mut long_device = write_request("ghost", vec![ok()]);
    long_device["origin_device"] = json!("d".repeat(129));

    let bodies = vec![
        write_request(
            "ghost",
            vec![ok(), broken("session_id", json!("not-a-session"))],
        ),
        write_request("ghost", vec![ok(), broken("id", json!("has space"))]),
        write_request("ghost", vec![ok(), broken("id", json!(""))]),
        write_request("ghost", vec![ok(), broken("id", json!("i".repeat(129)))]),
        write_request(
            "ghost",
            vec![ok(), broken("created_at", json!("yesterday"))],
        ),
        write_request("ghost", Vec::new()),
        write_request("ghost", too_many),
        blank_device,
        long_device,
    ];
    for body in bodies {
        let (status, reply) = post(&h.admin, "/admin/write-conclusions", body.clone()).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{reply} for {}",
            body.to_string().chars().take(200).collect::<String>()
        );
    }
    assert!(synced_rows(&h).await.is_empty(), "nothing was written");
    assert!(
        lookup_existing_scope(&h.store.reader, WS, "ghost")
            .await
            .is_err(),
        "a refused request creates no project"
    );
}

#[tokio::test]
async fn secret_shaped_text_is_stored_scrubbed_and_the_body_is_capped() {
    let h = harness().await;
    let github = format!(
        "ghp_{}",
        "A1b2C3d4".repeat(5).chars().take(36).collect::<String>()
    );
    let api_key = format!("sk-{}", "x9Y8z7W6".repeat(5));
    let (status, reply) = write(
        &h,
        PROJ,
        vec![
            item(
                "secret",
                SessionId::new(),
                &format!("Deploy with {github}"),
                &format!("quokka credentials: {github} and {api_key} were pasted."),
                "2026-10-19T10:00:00Z",
            ),
            item(
                "long",
                SessionId::new(),
                &"t".repeat(900),
                &format!("quokka {}", "é".repeat(3000)),
                "2026-10-19T10:01:00Z",
            ),
            item(
                "empty",
                SessionId::new(),
                "Nothing",
                "  \n ",
                "2026-10-19T10:02:00Z",
            ),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(statuses(&reply), ["written", "written", "skipped"]);

    let rows = synced_rows(&h).await;
    assert_eq!(rows.len(), 2, "the empty body was skipped: {rows:?}");
    let secret = rows.iter().find(|r| r["id"] == "secret").unwrap();
    for field in ["title", "body"] {
        let text = secret[field].as_str().unwrap();
        assert!(!text.contains(&github), "{field} leaked: {text}");
        assert!(!text.contains(&api_key), "{field} leaked: {text}");
        assert!(text.contains("[REDACTED:"), "{field}: {text}");
    }
    let long = rows.iter().find(|r| r["id"] == "long").unwrap();
    let body = long["body"].as_str().unwrap();
    assert!(body.len() <= 2000, "{} bytes", body.len());
    assert!(body.starts_with("quokka "));
    assert_eq!(long["title"].as_str().unwrap().chars().count(), 500);

    let payload = query(&h.mcp, args("credentials")).await;
    let excerpt = payload["conclusion_hits"][0]["excerpt"].as_str().unwrap();
    assert!(
        !excerpt.contains(&github) && !excerpt.contains(&api_key),
        "{excerpt}"
    );
}

#[tokio::test]
async fn native_listing_has_stops_with_a_body_only_and_pages_by_after_and_limit() {
    let h = harness().await;
    let titled = native_session(&h, h.proj).await;
    observe(
        &h,
        h.proj,
        titled,
        ObservationKind::UserPrompt,
        "why is deploy slow",
        "why is deploy slow",
    )
    .await;
    observe(
        &h,
        h.proj,
        titled,
        ObservationKind::Stop,
        "stop",
        "cold cache one",
    )
    .await;
    let paged = native_session(&h, h.proj).await;
    observe(
        &h,
        h.proj,
        paged,
        ObservationKind::Stop,
        "stop",
        "cold cache two",
    )
    .await;
    h.store
        .writer
        .upsert_page(NewPage {
            workspace_id: h.ws,
            project_id: h.proj,
            path: PagePath::new(format!("sessions/{paged}.md")).unwrap(),
            title: "Session: CI fixes".into(),
            body: "notes".into(),
            tier: Tier::Semantic,
            frontmatter_json: json!({}),
            pinned: false,
            links: Vec::new(),
            author_id: None,
            expires_at: None,
            entities: Vec::new(),
            evidence: Vec::new(),
        })
        .await
        .expect("page");
    let bare = native_session(&h, h.other).await;
    observe(
        &h,
        h.other,
        bare,
        ObservationKind::Stop,
        "stop",
        "cold cache three",
    )
    .await;
    // Never listed: an empty Stop, a blank Stop and a prompt with text.
    let silent = native_session(&h, h.proj).await;
    observe(&h, h.proj, silent, ObservationKind::Stop, "stop", "").await;
    observe(&h, h.proj, silent, ObservationKind::Stop, "stop", "   ").await;
    observe(
        &h,
        h.proj,
        silent,
        ObservationKind::UserPrompt,
        "prompt",
        "cold cache prompt",
    )
    .await;
    // A synced row never shows in the native stream.
    let (status, reply) = write(
        &h,
        PROJ,
        vec![item(
            "s1",
            SessionId::new(),
            "Remote",
            "cold cache remote",
            "2026-10-19T10:00:00Z",
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");

    let (status, all) = get(&h.admin, "/admin/conclusions?source=native").await;
    assert_eq!(status, StatusCode::OK, "{all}");
    let rows = all["conclusions"].as_array().unwrap();
    let bodies: Vec<&str> = rows.iter().map(|r| r["body"].as_str().unwrap()).collect();
    assert_eq!(
        bodies,
        ["cold cache one", "cold cache two", "cold cache three"]
    );
    assert_eq!(all["more"], false);
    let seqs: Vec<i64> = rows.iter().map(|r| r["seq"].as_i64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "{seqs:?}");
    assert_eq!(all["next"], seqs[2]);
    assert_eq!(rows[0]["workspace"], WS);
    assert_eq!(rows[0]["project"], PROJ);
    assert_eq!(rows[2]["project"], OTHER);
    assert_eq!(rows[0]["session_id"], titled.to_string().as_str());
    assert!(rows[0].get("origin_device").is_none(), "{}", rows[0]);
    assert!(!rows[0]["id"].as_str().unwrap().is_empty());
    assert!(rows[0]["created_at"].as_str().unwrap().ends_with('Z'));
    // The title rule is the one memory_query's conclusions use.
    assert_eq!(rows[0]["title"], "why is deploy slow");
    assert_eq!(rows[1]["title"], "Session: CI fixes");
    assert_eq!(rows[2]["title"], bare.to_string().as_str());

    let (_, first) = get(&h.admin, "/admin/conclusions?source=native&limit=2").await;
    assert_eq!(first["conclusions"].as_array().unwrap().len(), 2, "{first}");
    assert_eq!(first["more"], true);
    assert_eq!(first["next"], seqs[1]);
    let (_, rest) = get(
        &h.admin,
        &format!(
            "/admin/conclusions?source=native&limit=2&after={}",
            first["next"]
        ),
    )
    .await;
    let rest_rows = rest["conclusions"].as_array().unwrap();
    assert_eq!(rest_rows.len(), 1, "{rest}");
    assert_eq!(rest_rows[0]["body"], "cold cache three");
    assert_eq!(rest["more"], false);
    assert_eq!(rest["next"], seqs[2]);

    let (_, none) = get(
        &h.admin,
        &format!("/admin/conclusions?source=native&after={}", seqs[2]),
    )
    .await;
    assert_eq!(none["conclusions"], json!([]));
    assert_eq!(none["next"], seqs[2], "no rows: next echoes after");
    assert_eq!(none["more"], false);
}

#[tokio::test]
async fn synced_listing_carries_origin_device_pages_and_covers_every_project() {
    let h = harness().await;
    let a = SessionId::new();
    let b = SessionId::new();
    let c = SessionId::new();
    for (project, id, session, at) in [
        (PROJ, "o1", a, "2026-10-19T10:00:00Z"),
        (OTHER, "o2", b, "2026-10-19T10:01:00Z"),
        (PROJ, "o3", c, "2026-10-19T10:02:00Z"),
    ] {
        let (status, reply) =
            write(&h, project, vec![item(id, session, "T", "quokka body", at)]).await;
        assert_eq!(status, StatusCode::OK, "{reply}");
    }
    let (status, all) = get(&h.admin, "/admin/conclusions?source=synced&limit=2").await;
    assert_eq!(status, StatusCode::OK, "{all}");
    let rows = all["conclusions"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(all["more"], true);
    assert_eq!(rows[0]["id"], "o1");
    assert_eq!(rows[0]["origin_device"], DEVICE);
    assert_eq!(rows[0]["workspace"], WS);
    assert_eq!(rows[0]["project"], PROJ);
    assert_eq!(rows[0]["session_id"], a.to_string().as_str());
    assert_eq!(rows[0]["created_at"], "2026-10-19T10:00:00Z");
    assert_eq!(rows[1]["project"], OTHER);
    assert_eq!(all["next"], rows[1]["seq"]);

    let (_, rest) = get(
        &h.admin,
        &format!("/admin/conclusions?source=synced&after={}", all["next"]),
    )
    .await;
    assert_eq!(rest["conclusions"].as_array().unwrap().len(), 1, "{rest}");
    assert_eq!(rest["conclusions"][0]["id"], "o3");
    assert_eq!(rest["more"], false);

    // Native and synced seq spaces are independent streams.
    let (_, native) = get(&h.admin, "/admin/conclusions?source=native").await;
    assert_eq!(native["conclusions"], json!([]), "{native}");
}

#[tokio::test]
async fn a_conclusion_of_another_project_never_answers_this_one() {
    let h = harness().await;
    let (status, reply) = write(
        &h,
        OTHER,
        vec![item(
            "elsewhere",
            SessionId::new(),
            "Other project",
            "quokka in the other project",
            "2026-10-19T10:00:00Z",
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");

    let payload = query(&h.mcp, args("quokka")).await;
    assert!(no_conclusions(&payload), "{payload}");
    let mut other = args("quokka");
    other["project"] = json!(OTHER);
    let payload = query(&h.mcp, other).await;
    assert_eq!(
        payload["conclusion_hits"].as_array().unwrap().len(),
        1,
        "{payload}"
    );
}

#[tokio::test]
async fn a_saved_native_cursor_still_sees_conclusions_captured_after_the_newest_session_is_purged()
{
    let h = harness().await;
    let keep = native_session(&h, h.proj).await;
    observe(
        &h,
        h.proj,
        keep,
        ObservationKind::Stop,
        "stop",
        "kept conclusion",
    )
    .await;
    let newest = native_session(&h, h.proj).await;
    observe(
        &h,
        h.proj,
        newest,
        ObservationKind::Stop,
        "stop",
        "newest conclusion",
    )
    .await;

    let (_, first) = get(&h.admin, "/admin/conclusions?source=native").await;
    assert_eq!(first["conclusions"].as_array().unwrap().len(), 2, "{first}");
    let saved = first["next"].as_i64().unwrap();
    assert_eq!(first["last"], saved);

    // The newest session holds the highest observation rowid; once it is
    // gone SQLite would hand that rowid out again.
    h.store
        .writer
        .purge_session(
            h.ws,
            h.proj,
            newest,
            None,
            ai_memory_store::Compaction::Skip,
            ai_memory_store::PurgeMode::Commit,
        )
        .await
        .expect("purge");
    let (_, after_purge) = get(&h.admin, "/admin/conclusions?source=native").await;
    let bodies: Vec<&str> = after_purge["conclusions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["body"].as_str().unwrap())
        .collect();
    assert_eq!(
        bodies,
        ["kept conclusion"],
        "the purged turn left the stream"
    );

    let fresh = native_session(&h, h.proj).await;
    observe(
        &h,
        h.proj,
        fresh,
        ObservationKind::Stop,
        "stop",
        "captured after the purge",
    )
    .await;
    let (_, rest) = get(
        &h.admin,
        &format!("/admin/conclusions?source=native&after={saved}"),
    )
    .await;
    let rows = rest["conclusions"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{rest}");
    assert_eq!(rows[0]["body"], "captured after the purge");
    assert!(rows[0]["seq"].as_i64().unwrap() > saved, "{rest}");
    assert_eq!(rest["last"], rest["next"]);
}

#[tokio::test]
async fn the_store_id_is_stable_per_database_and_last_is_reported_for_both_streams() {
    let h = harness().await;
    let (_, empty_native) = get(&h.admin, "/admin/conclusions?source=native").await;
    let (_, empty_synced) = get(&h.admin, "/admin/conclusions?source=synced").await;
    assert_eq!(empty_native["last"], 0, "{empty_native}");
    assert_eq!(empty_synced["last"], 0, "{empty_synced}");
    let store = empty_native["store"].as_str().expect("store id").to_owned();
    assert_eq!(store.len(), 32, "{store}");
    assert_eq!(empty_synced["store"], store.as_str());

    let session = native_session(&h, h.proj).await;
    observe(&h, h.proj, session, ObservationKind::Stop, "stop", "one").await;
    let (status, reply) = write(
        &h,
        PROJ,
        vec![
            item("a", SessionId::new(), "A", "alpha", "2026-10-19T10:00:00Z"),
            item("b", SessionId::new(), "B", "beta", "2026-10-19T10:01:00Z"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");

    let (_, native) = get(&h.admin, "/admin/conclusions?source=native").await;
    let (_, synced) = get(&h.admin, "/admin/conclusions?source=synced&limit=1").await;
    assert_eq!(native["store"], store.as_str());
    assert_eq!(synced["store"], store.as_str());
    assert_eq!(native["last"], native["next"], "{native}");
    assert_eq!(synced["more"], true);
    assert_eq!(synced["next"], 1);
    assert_eq!(
        synced["last"], 2,
        "last is the stream's, not the page's: {synced}"
    );

    let other = harness().await;
    let (_, theirs) = get(&other.admin, "/admin/conclusions?source=native").await;
    assert_ne!(theirs["store"], store.as_str(), "two fresh stores differ");
}

#[tokio::test]
async fn a_stop_that_gains_a_body_later_joins_the_native_stream_once() {
    let h = harness().await;
    let session = native_session(&h, h.proj).await;
    observe(&h, h.proj, session, ObservationKind::Stop, "stop", "").await;
    let (_, before) = get(&h.admin, "/admin/conclusions?source=native").await;
    assert_eq!(before["conclusions"], json!([]), "{before}");

    let db = rusqlite::Connection::open(h.store.db_path()).expect("db");
    db.execute(
        "UPDATE observations SET body = 'now with text' WHERE session_id = ?1",
        [session.as_bytes().as_slice()],
    )
    .expect("update");
    db.execute(
        "UPDATE observations SET body = 'edited again' WHERE session_id = ?1",
        [session.as_bytes().as_slice()],
    )
    .expect("update");
    drop(db);

    let (_, after) = get(&h.admin, "/admin/conclusions?source=native").await;
    assert_eq!(after["conclusions"].as_array().unwrap().len(), 1, "{after}");
    assert_eq!(after["conclusions"][0]["body"], "edited again");
}

#[tokio::test]
async fn the_listing_refuses_a_bad_source_after_or_limit() {
    let h = harness().await;
    for uri in [
        "/admin/conclusions",
        "/admin/conclusions?source=other",
        "/admin/conclusions?source=native&after=-1",
        "/admin/conclusions?source=native&after=abc",
        "/admin/conclusions?source=native&limit=0",
        "/admin/conclusions?source=native&limit=501",
        "/admin/conclusions?source=synced&limit=abc",
    ] {
        let (status, reply) = get(&h.admin, uri).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{uri}: {reply}");
    }
    let (status, _) = get(&h.admin, "/admin/conclusions?source=synced&limit=500").await;
    assert_eq!(status, StatusCode::OK);
}
