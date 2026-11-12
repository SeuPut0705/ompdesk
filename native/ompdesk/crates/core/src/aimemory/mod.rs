//! The client of the local ai-memory server (was `src/main/ai-memory/client.ts`): `/healthz`, the `/api/v1` REST
//! reads, the `/admin/*` routes and MCP `tools/call` on `/mcp`, each as one `aimemory.*` method that answers the
//! shape main and the page read. Main keeps what it knows about the server (its URL and ai-memory's data folder,
//! handed in with every request as `server`) and every caller's signature.
//!
//! One method per question, not one generic request with a route: the rules that turn the server's JSON into the
//! app's shapes live with the request, so the memory units that follow into the core call them in process, a
//! question that takes several reads (a search with its page lists, the merged lists, a delete with its checkpoint,
//! a retirement) is one round trip from main, and main can never ask for a route of its own making with the token
//! on it.
//!
//! The token: the root bearer token `init` wrote into `<data dir>/auth-tokens/default` is read here at each
//! request and goes into the `authorization` header of that request to the server main named, nowhere else. It is
//! in no fault (`Client::fault` blanks it in the words a server answered; the transport's own failures carry no
//! request data at all) and the core logs no request. `aimemory.token` answers it to main, which copies it to the
//! clipboard as the web console's password.
//!
//! Names: `memory.*` is this computer's RAM (`memory/`), so the memory server's methods are `aimemory.*`.

mod client;
mod ops;
mod value;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Number, Value, json};

use self::client::{Client, Server};
use self::ops::{
    ConclusionInput, CopyInput, CreateInput, DeleteInput, PageAt, ProjectRef, Repository,
    RetireInput, SessionPageInput, WriteInput,
};
use self::value::get;
use crate::fs::order::is_js_space;
use crate::server::{Call, Fault, Registry, Reply};

/// Where ai-memory's server listens unless its config says otherwise; `src/main/ai-memory/client.ts` spells it too.
const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:49374";

/// The first `key = "value"` that starts a line of `toml`, as `/^\s*key\s*=\s*"([^"]+)"/m` found it.
fn quoted<'a>(toml: &'a str, key: &str) -> Option<&'a str> {
    let line_starts = std::iter::once(0).chain(
        toml.char_indices()
            .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(at, c)| at + c.len_utf8()),
    );
    for start in line_starts {
        let value = (|| {
            let rest = toml[start..].trim_start_matches(is_js_space);
            let rest = rest.strip_prefix(key)?.trim_start_matches(is_js_space);
            let rest = rest.strip_prefix('=')?.trim_start_matches(is_js_space);
            let rest = rest.strip_prefix('"')?;
            Some(&rest[..rest.find('"')?])
        })();
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            return Some(value);
        }
    }
    None
}

/// The server URL ai-memory's own config names: `server_url`, else `http://<bind>`, else the default.
pub fn server_url_from_config(toml: Option<&str>) -> String {
    let toml = toml.unwrap_or_default();
    if let Some(explicit) = quoted(toml, "server_url") {
        return explicit.trim_end_matches('/').to_owned();
    }
    match quoted(toml, "bind") {
        Some(bind) => format!("http://{bind}"),
        None => DEFAULT_SERVER_URL.to_owned(),
    }
}

/// One member of a request's params.
fn member<T: DeserializeOwned>(params: &Value, name: &str) -> Result<T, Fault> {
    T::deserialize(get(params, name))
        .map_err(|error| Fault::new("invalid_params", format!("{name}: {error}")))
}

fn out<T: Serialize>(value: T) -> Result<Value, Fault> {
    serde_json::to_value(value).map_err(|error| Fault::new("internal", error.to_string()))
}

/// Answers the operation `op` (a method's name after `aimemory.`).
async fn answer(op: &str, params: &Value) -> Result<Value, Fault> {
    let client = Client::new(member::<Option<Server>>(params, "server")?.unwrap_or_default());
    let text = |name: &str| member::<String>(params, name);
    Ok(match op {
        "serverUrl" => json!(server_url_from_config(
            member::<Option<String>>(params, "toml")?.as_deref()
        )),
        "token" => json!(client.token().await),
        "healthy" => json!(client.healthy().await),
        "status" => out(client.status().await)?,
        "projects" => out(client.projects().await?)?,
        "nameStatus" => json!(client.name_status(&member(params, "project")?).await?),
        "renameUnclaimedProject" => {
            client
                .rename_unclaimed_project(&text("workspace")?, &text("projectId")?, &text("to")?)
                .await?;
            Value::Null
        }
        "search" => {
            let project: Option<ProjectRef> = member(params, "project")?;
            out(client.search(&text("query")?, project.as_ref()).await?)?
        }
        "pages" => out(client.pages(&member(params, "project")?).await?)?,
        "allPages" => out(client.all_pages(&member(params, "project")?).await?)?,
        "overview" => out(client.overview(&member(params, "project")?).await?)?,
        "sessions" => {
            let limit: Option<Number> = member(params, "limit")?;
            let offset: Option<Number> = member(params, "offset")?;
            let project = member(params, "project")?;
            out(client
                .sessions(&project, limit.as_ref(), offset.as_ref())
                .await?)?
        }
        "observations" => {
            let offset = member::<Option<f64>>(params, "offset")?.unwrap_or_default();
            let kinds = member::<Option<Vec<String>>>(params, "kinds")?.unwrap_or_default();
            let project = member(params, "project")?;
            out(client
                .observations(&project, &text("sessionId")?, offset, &kinds)
                .await?)?
        }
        "profile" => out(client.profile().await?)?,
        "lint" => out(client.lint(&member(params, "project")?).await?)?,
        "sweep" => {
            let dry_run = member(params, "dryRun")?;
            out(client.sweep(&member(params, "project")?, dry_run).await?)?
        }
        "writePage" => {
            let (at, input): (PageAt, WriteInput) =
                (member(params, "input")?, member(params, "input")?);
            client.write_page(&at, &input).await?;
            Value::Null
        }
        "writeSessionPage" => {
            let (at, input): (PageAt, SessionPageInput) =
                (member(params, "input")?, member(params, "input")?);
            client.write_session_page(&at, &input).await?;
            Value::Null
        }
        "createPage" => {
            let (at, input): (PageAt, CreateInput) =
                (member(params, "input")?, member(params, "input")?);
            json!(client.create_page(&at, &input).await?)
        }
        "deletePage" => {
            let (at, input): (PageAt, DeleteInput) =
                (member(params, "ref")?, member(params, "ref")?);
            out(client.delete_page(&at, &input).await?)?
        }
        "headCheckpoint" => json!(client.head_checkpoint().await?),
        "restorePage" => {
            client
                .restore_page(&member(params, "ref")?, &text("rev")?)
                .await?;
            Value::Null
        }
        "feedback" => {
            client
                .feedback(&member(params, "ref")?, &text("signal")?)
                .await?;
            Value::Null
        }
        "cancelHandoff" => {
            client
                .cancel_handoff(&member(params, "project")?, &text("id")?)
                .await?;
            Value::Null
        }
        "recent" => out(client.recent(&member(params, "project")?).await?)?,
        "recentEverywhere" => out(client.recent_everywhere().await?)?,
        "handoffs" => out(client.handoffs(member(params, "project")?).await?)?,
        "page" => out(client.page(&member(params, "ref")?).await?)?,
        "retirePage" => {
            let (at, input): (PageAt, RetireInput) =
                (member(params, "ref")?, member(params, "ref")?);
            json!(client.retire_page(&at, &input).await?)
        }
        "pageCopy" => out(client.page_copy(&member(params, "ref")?).await?)?,
        "writePageCopy" => {
            let (at, copy): (PageAt, CopyInput) =
                (member(params, "copy")?, member(params, "copy")?);
            let origin: Option<String> = member(params, "origin")?;
            let expected: Option<String> = member(params, "expected")?;
            json!(
                client
                    .write_page_copy(&at, &copy, origin.as_deref(), expected.as_deref())
                    .await?
            )
        }
        "conclusions" => {
            let (after, limit): (Number, Number) =
                (member(params, "after")?, member(params, "limit")?);
            out(client.conclusions(&text("source")?, &after, &limit).await?)?
        }
        "writeConclusions" => {
            let items: Vec<ConclusionInput> = member(params, "items")?;
            let repository: Option<Repository> = member(params, "repository")?;
            let project = member(params, "project")?;
            out(client
                .write_conclusions(&project, &text("origin")?, &items, repository.as_ref())
                .await?)?
        }
        _ => {
            return Err(Fault::new(
                "internal",
                format!("aimemory.{op} is not an operation"),
            ));
        }
    })
}

/// One request: answered by its operation, or `cancelled` once main gave up on it (the connections it held close).
async fn handle(op: &'static str, call: Call) -> Result<Reply, Fault> {
    let params: Value = call.params()?;
    tokio::select! {
        answer = answer(op, &params) => Reply::json(&answer?),
        () = call.scope.on_cancel() => Err(Fault::cancelled()),
    }
}

pub fn register(registry: &mut Registry) {
    macro_rules! operations {
        ($($op:literal),+ $(,)?) => {
            $(registry.add(concat!("aimemory.", $op), |call| Box::pin(handle($op, call)));)+
        };
    }
    operations![
        "serverUrl",
        "token",
        "healthy",
        "status",
        "projects",
        "nameStatus",
        "renameUnclaimedProject",
        "search",
        "pages",
        "allPages",
        "overview",
        "sessions",
        "observations",
        "profile",
        "lint",
        "sweep",
        "writePage",
        "writeSessionPage",
        "createPage",
        "deletePage",
        "headCheckpoint",
        "restorePage",
        "feedback",
        "cancelHandoff",
        "recent",
        "recentEverywhere",
        "handoffs",
        "page",
        "retirePage",
        "pageCopy",
        "writePageCopy",
        "conclusions",
        "writeConclusions",
    ];
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::*;
    use crate::fs::disk::make_temp_dir;
    use crate::http::tests::read_request;

    /// A table of `captured.json`: what the TypeScript client sent and answered for the same scenarios before it was
    /// deleted (commit `c609c6c4`, `fetch` scripted per scenario).
    fn captured(table: &str) -> Vec<Value> {
        let tables: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        tables[table].as_array().unwrap().clone()
    }

    /// What a fake server saw of one request, in the capture's words.
    fn seen(request: &[u8]) -> (String, Value) {
        let end = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let head = String::from_utf8_lossy(&request[..end]).into_owned();
        let mut lines = head.split("\r\n");
        let mut words = lines.next().unwrap().split(' ');
        let (method, path) = (words.next().unwrap(), words.next().unwrap());
        let header = |name: &str| {
            head.split("\r\n")
                .skip(1)
                .find_map(|line| line.strip_prefix(&format!("{name}: ")))
                .map_or(Value::Null, |value| json!(value))
        };
        let body = &request[end + 4..];
        let record = json!({
            "method": method,
            "path": path,
            "authorization": header("authorization"),
            "contentType": header("content-type"),
            "accept": header("accept"),
            "body": serde_json::from_slice::<Value>(body).unwrap_or(Value::Null),
        });
        (format!("{method} {path}"), record)
    }

    struct Fake {
        url: String,
        requests: Arc<Mutex<Vec<Value>>>,
    }

    /// A server on 127.0.0.1 that answers `routes` (`"GET /path"` → `{status?, json? | text?}`) and ends the
    /// connection of any other request without a word, as the capture's `fetch` threw for one.
    async fn fake(routes: Value) -> Fake {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (routes, log) = (routes.clone(), Arc::clone(&log));
                tokio::spawn(async move {
                    let request = read_request(&mut socket).await;
                    let (key, record) = seen(&request);
                    log.lock().unwrap().push(record);
                    let route = get(&routes, &key);
                    if route.is_null() {
                        return;
                    }
                    let status = get(route, "status").as_u64().unwrap_or(200);
                    let body = match get(route, "text") {
                        Value::String(text) => text.clone(),
                        _ if status == 204 => String::new(),
                        _ => get(route, "json").to_string(),
                    };
                    let answer = format!(
                        "HTTP/1.1 {status} Status\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(answer.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Fake { url, requests }
    }

    /// A data folder with `token` as its root token file (none: no file).
    fn data_dir(token: Option<&str>) -> PathBuf {
        let dir = make_temp_dir("ompdesk-core-aimemory-").unwrap();
        if let Some(token) = token {
            std::fs::create_dir(dir.join("auth-tokens")).unwrap();
            std::fs::write(dir.join("auth-tokens").join("default"), token).unwrap();
        }
        dir
    }

    fn sorted(mut requests: Vec<Value>) -> Vec<Value> {
        requests.sort_by_key(|request| request.to_string());
        requests
    }

    #[tokio::test]
    async fn sends_and_answers_what_the_typescript_client_did() {
        let steps = captured("steps");
        assert!(steps.len() >= 130);
        for step in steps {
            let name = step["name"].as_str().unwrap();
            let server = fake(step["routes"].clone()).await;
            let dir = data_dir(match &step["token"] {
                Value::Null if step.get("token").is_some() => None,
                Value::String(token) => Some(token.as_str()),
                _ => Some("secret-token\n"),
            });
            let mut params = match &step["params"] {
                Value::Object(params) => params.clone(),
                _ => serde_json::Map::new(),
            };
            let url = format!(
                "{}{}",
                server.url,
                step["prefix"].as_str().unwrap_or_default()
            );
            params.insert(
                "server".to_owned(),
                json!({
                    "url": if step["noUrl"] == true { Value::Null } else { json!(url) },
                    "dataDir": if step["noDataDir"] == true { Value::Null } else { json!(dir) },
                }),
            );
            let answered = answer(step["method"].as_str().unwrap(), &Value::Object(params)).await;
            match (answered, step.get("error")) {
                (Ok(mut result), None) => {
                    let mut expected = step["result"].clone();
                    if let (Some(result), Some(expected)) =
                        (result.as_object_mut(), expected.as_object_mut())
                        && expected.remove("deletedAt").is_some()
                    {
                        let at = result.remove("deletedAt").unwrap();
                        let at = at.as_str().unwrap();
                        assert!(
                            at.len() == 24 && at.starts_with("20") && at.ends_with('Z'),
                            "{name}"
                        );
                    }
                    assert_eq!(result, expected, "{name}");
                }
                (Err(fault), Some(expected)) => {
                    assert_eq!(json!(fault.message), *expected, "{name}")
                }
                (answered, expected) => panic!("{name}: {answered:?}, expected {expected:?}"),
            }
            let requests = std::mem::take(&mut *server.requests.lock().unwrap());
            let expected = step["requests"].as_array().unwrap().clone();
            assert_eq!(sorted(requests), sorted(expected), "{name}");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[tokio::test]
    async fn every_registered_method_is_an_operation() {
        let mut registry = Registry::default();
        register(&mut registry);
        let unknown = answer("nothing", &json!({})).await.unwrap_err();
        assert_eq!(unknown.code, "internal");
        // Each method the capture names is registered (a duplicate or a typo panics in `register`).
        for step in captured("steps") {
            let op = step["method"].as_str().unwrap().to_owned();
            let fault = answer(&op, &json!({"server": 5})).await.unwrap_err();
            assert_eq!(fault.code, "invalid_params", "{op}");
        }
    }

    #[test]
    fn reads_the_server_url_from_ai_memory_s_config_as_the_typescript_did() {
        let rows = captured("serverUrl");
        assert!(rows.len() >= 24);
        for row in rows {
            assert_eq!(
                json!(server_url_from_config(row["toml"].as_str())),
                row["url"],
                "{:?}",
                row["toml"]
            );
        }
    }

    #[test]
    fn strips_the_marks_of_a_search_snippet_as_the_typescript_did() {
        for row in captured("plainSnippet") {
            assert_eq!(
                json!(ops::plain_snippet(row["snippet"].as_str().unwrap())),
                row["plain"]
            );
        }
    }

    /// A long token whose parts no ordinary message holds.
    const TOKEN: &str = "root-7f3c9a1e5b2d4860aa17c0de-token";

    fn free_of_the_token(text: &str) {
        assert!(!text.contains(TOKEN), "{text}");
        assert!(!text.contains(&TOKEN[5..21]), "{text}");
    }

    #[tokio::test]
    async fn a_fault_carries_nothing_of_the_token() {
        let dir = data_dir(Some(&format!("{TOKEN}\n")));
        let echo = format!("denied for Bearer {TOKEN} ({TOKEN})");
        let tool = |text: &str| json!({"json": {"jsonrpc": "2.0", "id": 1, "result": {"isError": true, "content": [{"type": "text", "text": text}]}}});
        let project = json!({"workspace": "w", "project": "p"});
        let page = json!({"workspace": "w", "project": "p", "path": "a.md"});
        let write = json!({"workspace": "w", "project": "p", "path": "a.md", "body": "b", "tier": "semantic", "kind": "note"});
        // Each: the routes of a server that says the token back, the request, and the fault's words.
        let cases = [
            (
                json!({"GET /api/v1/projects": {"status": 401, "json": {"error": echo}}}),
                ("projects", json!({})),
                "denied for Bearer *** (***)".to_owned(),
            ),
            (
                json!({"GET /api/v1/projects": {"status": 500, "text": echo}}),
                ("projects", json!({})),
                "Memory answered 500".to_owned(),
            ),
            (
                json!({"GET /api/v1/projects": {"text": echo}}),
                ("projects", json!({})),
                "expected value at line 1 column 1".to_owned(),
            ),
            (
                json!({"POST /mcp": {"json": {"jsonrpc": "2.0", "id": 1, "error": {"message": echo}}}}),
                ("feedback", json!({"ref": page, "signal": "helpful"})),
                "denied for Bearer *** (***)".to_owned(),
            ),
            (
                json!({"POST /mcp": tool(&echo)}),
                ("createPage", json!({"input": write})),
                "denied for Bearer *** (***)".to_owned(),
            ),
            (
                json!({"POST /admin/lint": {"status": 400, "json": {"error": echo}}}),
                ("lint", json!({"project": project})),
                "denied for Bearer *** (***)".to_owned(),
            ),
            (
                json!({}),
                ("pages", json!({"project": project})),
                "Memory is not running".to_owned(),
            ),
            (
                json!({"GET /admin/checkpoints?limit=1": {"json": []}, "POST /admin/delete-page": {"json": {}}}),
                ("deletePage", json!({"ref": page})),
                "Memory kept no checkpoint of this page".to_owned(),
            ),
        ];
        for (routes, (op, params), message) in cases {
            let server = fake(routes).await;
            let mut params = params;
            params["server"] = json!({"url": server.url, "dataDir": dir});
            let fault = answer(op, &params).await.unwrap_err();
            assert_eq!(fault.message, message, "{op}");
            free_of_the_token(&format!("{fault:?}"));
            // The request did carry it, to the server and nowhere else.
            let requests = server.requests.lock().unwrap();
            assert!(!requests.is_empty(), "{op}");
            for request in requests.iter() {
                assert_eq!(
                    request["authorization"],
                    json!(format!("Bearer {TOKEN}")),
                    "{op}"
                );
            }
        }
        // No server, an address this client cannot dial, and params that are wrong: none reads the token into its words.
        for (params, code) in [
            (
                json!({"server": {"url": "http://127.0.0.1:1", "dataDir": dir}, "project": project}),
                "memory_down",
            ),
            (
                json!({"server": {"url": "https://127.0.0.1:1", "dataDir": dir}, "project": project}),
                "memory_down",
            ),
            (
                json!({"server": {"url": null, "dataDir": dir}, "project": project}),
                "memory_down",
            ),
            (
                json!({"server": {"url": "http://127.0.0.1:1", "dataDir": dir}, "project": 4}),
                "invalid_params",
            ),
        ] {
            let fault = answer("pages", &params).await.unwrap_err();
            assert_eq!(fault.code, code);
            free_of_the_token(&format!("{fault:?}"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_token_that_cannot_be_a_header_is_never_sent() {
        let dir = data_dir(Some("tok\r\nx-injected: 1"));
        let server = fake(json!({"GET /api/v1/projects": {"json": []}})).await;
        let params = json!({"server": {"url": server.url, "dataDir": dir}});
        let fault = answer("projects", &params).await.unwrap_err();
        assert_eq!(fault.message, "Memory is not running");
        assert!(server.requests.lock().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_that_never_answers_is_not_running_after_its_time() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let held = tokio::spawn(async move {
            let mut sockets = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                sockets.push(socket);
            }
        });
        let server = json!({"url": url, "dataDir": null});
        let project = json!({"workspace": "w", "project": "p"});
        // The clock is paused: each wait ends when its own timer is the next thing due.
        let started = tokio::time::Instant::now();
        assert_eq!(
            answer("healthy", &json!({"server": server})).await,
            Ok(json!(false))
        );
        assert_eq!(started.elapsed(), Duration::from_secs(2));
        let read = answer("pages", &json!({"server": server, "project": project})).await;
        assert_eq!(read.unwrap_err().message, "Memory is not running");
        assert_eq!(started.elapsed(), Duration::from_secs(12));
        let write = answer("lint", &json!({"server": server, "project": project})).await;
        assert_eq!(write.unwrap_err().message, "Memory is not running");
        assert_eq!(started.elapsed(), Duration::from_secs(72));
        held.abort();
    }
}
