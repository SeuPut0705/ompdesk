//! `memory_query(conclusions=true)`, proven end to end through the real tool
//! over JSON-RPC.
//!
//! A session's last assistant message (a `Stop` observation with a body) is
//! its conclusion. Page search ranks compiled pages; this opt-in leg ranks the
//! conclusions themselves, one per session, so "what did we decide about X"
//! finds the deciding turn even when no page quotes it.

use ai_memory_core::{
    AgentKind, NewObservation, NewPage, NewSession, ObservationKind, PagePath, ProjectId,
    Sanitized, Sanitizer, SessionId, Tier, WorkspaceId,
};
use ai_memory_mcp::AiMemoryServer;
use ai_memory_store::Store;
use axum::Router;
use axum::body::Body;
use axum::http::Request;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const WS: &str = "default";
const PROJ: &str = "scratch";

struct Seeded {
    _tmp: TempDir,
    router: Router,
    /// Has a session page titled `Session: CI fixes`; two matching conclusions.
    paged: SessionId,
    /// No page; a first prompt titled `why is deploy slow`.
    prompted: SessionId,
    /// No page, no prompt: the title falls back to the session id.
    bare: SessionId,
}

async fn session(store: &Store, ws: WorkspaceId, proj: ProjectId) -> SessionId {
    let id = SessionId::new();
    store
        .writer
        .begin_session(NewSession {
            occurred_at: None,
            id,
            workspace_id: ws,
            project_id: proj,
            agent_kind: AgentKind::ClaudeCode,
            cwd: Some("/repo".into()),
            actor_user: None,
        })
        .await
        .expect("session");
    id
}

async fn observe(
    store: &Store,
    (ws, proj): (WorkspaceId, ProjectId),
    session_id: SessionId,
    kind: ObservationKind,
    title: &str,
    body: &str,
) {
    store
        .writer
        .insert_observation(Sanitized::new(
            NewObservation {
                occurred_at: None,
                session_id,
                workspace_id: ws,
                project_id: proj,
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

async fn page(store: &Store, ws: WorkspaceId, proj: ProjectId, path: String, title: &str) {
    store
        .writer
        .upsert_page(NewPage {
            workspace_id: ws,
            project_id: proj,
            path: PagePath::new(path).unwrap(),
            title: title.into(),
            body: "zircon notes".into(),
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
}

async fn seeded() -> Seeded {
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
        .get_or_create_project(ws, "other", None)
        .await
        .expect("other");
    let here = (ws, proj);

    let paged = session(&store, ws, proj).await;
    observe(
        &store,
        here,
        paged,
        ObservationKind::Stop,
        "stop",
        "zircon zircon zircon: pinned the flaky test to the zircon pool.",
    )
    .await;
    observe(
        &store,
        here,
        paged,
        ObservationKind::Stop,
        "stop",
        "Earlier turn: the zircon pool was only a guess, the driver was not checked yet and \
         nothing else was said about it in that long reply.",
    )
    .await;
    page(
        &store,
        ws,
        proj,
        format!("sessions/{paged}.md"),
        "Session: CI fixes",
    )
    .await;
    page(&store, ws, proj, "notes/zircon.md".into(), "Zircon pool").await;

    let prompted = session(&store, ws, proj).await;
    observe(
        &store,
        here,
        prompted,
        ObservationKind::UserPrompt,
        "why is deploy slow",
        "why is deploy slow",
    )
    .await;
    observe(
        &store,
        here,
        prompted,
        ObservationKind::Stop,
        "stop",
        "The deploy is slow because the cache was cold; a zircon runner warms it up in a long \
         pipeline of many other unrelated steps, none of which matter here at all.",
    )
    .await;

    let bare = session(&store, ws, proj).await;
    observe(
        &store,
        here,
        bare,
        ObservationKind::Stop,
        "stop",
        "The gizmo rollout finished.",
    )
    .await;

    // Must never surface: an empty Stop whose TITLE matches, a prompt that
    // matches, and a matching conclusion in another project.
    let silent = session(&store, ws, proj).await;
    observe(&store, here, silent, ObservationKind::Stop, "zircon", "").await;
    observe(
        &store,
        here,
        silent,
        ObservationKind::UserPrompt,
        "prompt",
        "zircon zircon zircon zircon",
    )
    .await;
    let elsewhere = session(&store, ws, other).await;
    observe(
        &store,
        (ws, other),
        elsewhere,
        ObservationKind::Stop,
        "stop",
        "zircon zircon zircon zircon zircon",
    )
    .await;

    let server = AiMemoryServer::new(store.reader.clone(), store.writer.clone(), ws, proj);
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_stateful_mode(false)
            .with_json_response(true),
    );
    Seeded {
        _tmp: tmp,
        router: Router::new().nest_service("/mcp", service),
        paged,
        prompted,
        bare,
    }
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
    let resp = router.clone().oneshot(req).await.expect("oneshot");
    let bytes = axum::body::to_bytes(resp.into_body(), 4_000_000)
        .await
        .expect("body");
    let v: Value = serde_json::from_slice(&bytes).expect("json-rpc");
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

#[tokio::test]
async fn conclusions_return_one_best_stop_per_session_best_first() {
    let seeded = seeded().await;
    let payload = query(&seeded.router, args("zircon")).await;

    let rows = payload["conclusion_hits"]
        .as_array()
        .expect("conclusion_hits");
    let sessions: Vec<&str> = rows
        .iter()
        .map(|r| r["session_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        sessions,
        [seeded.paged.to_string(), seeded.prompted.to_string()],
        "one row per session, best first, no empty/other-project/non-Stop rows: {payload}"
    );
    let first = &rows[0];
    assert!(
        first["excerpt"]
            .as_str()
            .unwrap()
            .contains("<mark>zircon</mark>"),
        "{first}"
    );
    assert!(
        !first["excerpt"].as_str().unwrap().contains("Earlier turn"),
        "the session's best conclusion wins, not its other Stop: {first}"
    );
    assert!(
        first["created_at"].as_str().unwrap().ends_with('Z'),
        "{first}"
    );
    let (a, b) = (
        rows[0]["rank"].as_f64().unwrap(),
        rows[1]["rank"].as_f64().unwrap(),
    );
    assert!(a <= b, "bm25 ranks ascend, best first: {a} {b}");
    // Page hits are a separate leg and still come back.
    assert!(
        payload["hits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["path"] == "notes/zircon.md"),
        "{payload}"
    );
}

#[tokio::test]
async fn conclusion_title_prefers_session_page_then_first_prompt_then_session_id() {
    let seeded = seeded().await;
    let by_session = |payload: &Value, id: SessionId| -> String {
        payload["conclusion_hits"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["session_id"] == id.to_string().as_str())
            .unwrap_or_else(|| panic!("no row for {id}: {payload}"))["title"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let zircon = query(&seeded.router, args("zircon")).await;
    assert_eq!(by_session(&zircon, seeded.paged), "Session: CI fixes");
    assert_eq!(by_session(&zircon, seeded.prompted), "why is deploy slow");
    let gizmo = query(&seeded.router, args("gizmo")).await;
    assert_eq!(by_session(&gizmo, seeded.bare), seeded.bare.to_string());
}

#[tokio::test]
async fn conclusions_are_independent_of_page_hits_and_the_raw_fallback() {
    let seeded = seeded().await;
    let payload = query(&seeded.router, args("gizmo")).await;
    assert_eq!(payload["hits"], json!([]), "{payload}");
    let rows = payload["conclusion_hits"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{payload}");
    // The raw fallback fires on the empty page leg; conclusions do not depend
    // on it and do not change it.
    assert_eq!(
        payload["raw_hits"].as_array().unwrap().len(),
        1,
        "{payload}"
    );
}

#[tokio::test]
async fn conclusions_are_capped_at_limit() {
    let seeded = seeded().await;
    let mut capped = args("zircon");
    capped["limit"] = json!(1);
    let payload = query(&seeded.router, capped).await;
    let rows = payload["conclusion_hits"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{payload}");
    assert_eq!(rows[0]["session_id"], seeded.paged.to_string().as_str());
}

#[tokio::test]
async fn conclusions_are_absent_unless_asked() {
    let seeded = seeded().await;
    for arguments in [
        json!({ "query": "zircon", "workspace": WS, "project": PROJ }),
        json!({ "query": "zircon", "workspace": WS, "project": PROJ, "conclusions": false }),
    ] {
        let payload = query(&seeded.router, arguments).await;
        assert!(payload.get("conclusion_hits").is_none(), "{payload}");
    }
}

#[tokio::test]
async fn conclusions_are_ignored_on_the_as_of_path() {
    let seeded = seeded().await;
    let mut time_travel = args("zircon");
    time_travel["as_of"] = json!("2999-01-01T00:00:00Z");
    let payload = query(&seeded.router, time_travel).await;
    assert!(payload.get("conclusion_hits").is_none(), "{payload}");
}
