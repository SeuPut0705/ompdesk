//! How a request reaches the memory server: its address, the root token, one REST exchange (`send`) and one MCP
//! `tools/call` (`tool`), with the faults they answer.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::OnceCell;
use tokio::task::JoinSet;

use super::value::{get, rows, text};
use crate::fs::order::js_trim;
use crate::http::{self, Request};
use crate::json::whole_surrogates;
use crate::server::Fault;

/// `/healthz` answers at once or the server is not up.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// A lint pass, a sweep and a write touch the disk and the index: more time than a read.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// The shortest token taken out of a fault's words; a shorter one would blank ordinary text.
const TOKEN_MIN: usize = 8;

/// Where the server is, as main knows it now: its URL (`null` before setup found one) and ai-memory's data folder
/// (`null` before the plan named it).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub data_dir: Option<String>,
}

/// One request's view of the server. The token is read once per request of the core, at its first use.
pub struct Client {
    server: Server,
    token: OnceCell<Option<String>>,
}

pub fn down() -> Fault {
    Fault::new("memory_down", "Memory is not running")
}

/// A JSON text as `response.json()` read it: a byte order mark dropped, bytes that are no UTF-8 as U+FFFD.
fn parse(body: &[u8]) -> Result<Value, serde_json::Error> {
    let body = body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(body);
    serde_json::from_str(&whole_surrogates(&String::from_utf8_lossy(body)))
}

impl Client {
    pub fn new(server: Server) -> Arc<Client> {
        Arc::new(Client {
            server,
            token: OnceCell::new(),
        })
    }

    /// The root bearer token `init` wrote into `<data dir>/auth-tokens/default`, or none before it has.
    pub async fn token(&self) -> Option<&str> {
        self.token
            .get_or_init(|| async {
                let file = Path::new(self.server.data_dir.as_deref()?)
                    .join("auth-tokens")
                    .join("default");
                let bytes = tokio::task::spawn_blocking(move || std::fs::read(file))
                    .await
                    .ok()?
                    .ok()?;
                Some(js_trim(&String::from_utf8_lossy(&bytes)).to_owned())
                    .filter(|token| !token.is_empty())
            })
            .await
            .as_deref()
    }

    /// A failure in the server's words. The token is never among them: a server that echoed it reads `***`.
    pub fn fault(&self, code: &'static str, message: &str) -> Fault {
        match self.token.get() {
            Some(Some(token)) if token.len() >= TOKEN_MIN => {
                Fault::new(code, message.replace(token.as_str(), "***"))
            }
            _ => Fault::new(code, message),
        }
    }

    /// `/healthz` answers 2xx within two seconds (no token needed).
    pub async fn healthy(&self) -> bool {
        let Some(url) = self.server.url.as_deref() else {
            return false;
        };
        let url = format!("{url}/healthz");
        let request = Request {
            url: &url,
            headers: &[],
            body: None,
        };
        matches!(
            tokio::time::timeout(HEALTH_TIMEOUT, http::status(request)).await,
            Ok(Ok(200..=299))
        )
    }

    pub async fn get(&self, path: &str) -> Result<Value, Fault> {
        self.send(path, None, READ_TIMEOUT, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, Fault> {
        self.send(path, Some(body), WRITE_TIMEOUT, None).await
    }

    /// One exchange: the server's JSON for a 2xx; its `error` text, else `Memory answered <status>`, for anything
    /// else; `Memory is not running` when no answer came in `timeout`.
    async fn send(
        &self,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        accept: Option<&str>,
    ) -> Result<Value, Fault> {
        let url = self.server.url.as_deref().ok_or_else(down)?;
        let bearer = self.token().await.map(|token| format!("Bearer {token}"));
        let mut headers = Vec::new();
        if let Some(bearer) = &bearer {
            headers.push(("authorization", bearer.as_str()));
        }
        let body = match body {
            Some(body) => {
                headers.push(("content-type", "application/json"));
                Some(
                    serde_json::to_vec(body)
                        .map_err(|error| Fault::new("internal", error.to_string()))?,
                )
            }
            None => None,
        };
        if let Some(accept) = accept {
            headers.push(("accept", accept));
        }
        let url = format!("{url}{path}");
        let request = Request {
            url: &url,
            headers: &headers,
            body: body.as_deref(),
        };
        let response = match tokio::time::timeout(timeout, http::send(request)).await {
            Ok(Ok(response)) => response,
            _ => return Err(down()),
        };
        if !(200..300).contains(&response.status) {
            let detail = parse(&response.body).unwrap_or_default();
            return Err(match text(get(&detail, "error")) {
                "" => Fault::new(
                    "memory_refused",
                    format!("Memory answered {}", response.status),
                ),
                error => self.fault("memory_refused", error),
            });
        }
        parse(&response.body).map_err(|error| Fault::new("memory_json", error.to_string()))
    }

    /// A tool the REST surface has no route for: MCP `tools/call`, one request, no session. Answers the object the
    /// tool's text holds (null when it holds none).
    pub async fn tool(&self, name: &str, arguments: Map<String, Value>) -> Result<Value, Fault> {
        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        });
        let accept = Some("application/json, text/event-stream");
        let body = self
            .send("/mcp", Some(&request), WRITE_TIMEOUT, accept)
            .await?;
        if let Value::String(message) = get(get(&body, "error"), "message") {
            return Err(self.fault("memory_tool", message));
        }
        let result = get(&body, "result");
        let said: String = rows(get(result, "content"))
            .map(|part| text(get(part, "text")))
            .collect();
        if get(result, "isError") == &Value::Bool(true) {
            return Err(match said.as_str() {
                "" => Fault::new("memory_tool", format!("{name} failed")),
                said => self.fault("memory_tool", said),
            });
        }
        Ok(serde_json::from_str(&whole_surrogates(&said)).unwrap_or_default())
    }
}

/// `/precondition/i.test(error.message)`: the server refused a write because the page is not the version named.
pub fn precondition(fault: &Fault) -> bool {
    fault.message.to_ascii_lowercase().contains("precondition")
}

/// Runs `jobs` side by side and answers their results in the order given, as `Promise.all` over them did. Dropping
/// the wait ends them.
pub async fn together<T, F>(jobs: Vec<F>) -> Result<Vec<T>, Fault>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let mut set = JoinSet::new();
    let mut answers: Vec<Option<T>> = jobs.iter().map(|_| None).collect();
    for (index, job) in jobs.into_iter().enumerate() {
        set.spawn(async move { (index, job.await) });
    }
    while let Some(joined) = set.join_next().await {
        let (index, answer) =
            joined.map_err(|_| Fault::new("internal", "A memory read panicked"))?;
        answers[index] = Some(answer);
    }
    Ok(answers.into_iter().flatten().collect())
}
