//! A paired host's browser sign-in, finished in THIS computer's browser (was `src/main/remote/sign-in-relay.ts`'s
//! listener; main's `startSignInRelay` reads the authorization URL and answers the forwards). Stock's flow runs on the
//! host, so the authorization URL's `redirect_uri` is the host's loopback callback, and the provider sends this
//! computer's browser to this computer's loopback. While the host's `login` runs, this computer listens on that port
//! on its own loopback, hands the browser's callback to main (`signIn` ask; main sends it over the link as
//! `host.signIn.callback`) and gives the browser the page the host's omp answered.
//!
//! Guards: loopback only (both families for `localhost`, as stock binds them), the callback's exact path, the flow's
//! `state`, a loopback Host header (no DNS rebinding), one use, and an end with the sign-in, at Cancel or after
//! stock's own callback timeout. A port this computer already uses is reported, not shared. Nothing here logs the
//! query (it carries the authorization code).

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{CONNECTION, CONTENT_TYPE, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::ask;
use crate::server::{Call, Events, Fault, PushCall, Reply};

struct Relay {
    id: u64,
    path: String,
    state: String,
    loopback_hosts: Vec<String>,
    destination: Destination,
    closed: watch::Sender<bool>,
    busy: Mutex<bool>,
}

pub type Forward = Arc<
    dyn Fn(String, String) -> Pin<Box<dyn Future<Output = Result<Page, Fault>> + Send>>
        + Send
        + Sync,
>;
enum Destination {
    Legacy(Events),
    Native {
        forward: Forward,
        failure: Words,
        ended: Arc<dyn Fn() + Send + Sync>,
    },
}
pub enum ListenState {
    Listening,
    Busy(u16),
    Closed,
}

/// Owns only the callback listener, not remote authority. Dropping it also cancels a bind in progress.
pub struct NativeRelay {
    relay: Arc<Relay>,
    hosts: Vec<String>,
    port: u16,
}
impl NativeRelay {
    pub fn prepare(
        authorization_url: &str,
        forward: Forward,
        failure: Words,
        ended: Arc<dyn Fn() + Send + Sync>,
    ) -> Option<Self> {
        let authorize = url::Url::parse(authorization_url).ok()?;
        let redirect = authorize
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")?
            .1
            .into_owned();
        let callback = url::Url::parse(&redirect).ok()?;
        let host = callback.host_str()?;
        if callback.scheme() != "http" || !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
            return None;
        }
        let port = callback.port()?;
        let state = authorize
            .query_pairs()
            .find(|(key, _)| key == "state")?
            .1
            .into_owned();
        if state.is_empty() {
            return None;
        }
        let hosts = if host == "localhost" {
            vec!["127.0.0.1".into(), "::1".into()]
        } else {
            vec![host.trim_matches(['[', ']']).to_owned()]
        };
        Some(Self {
            relay: Arc::new(Relay {
                id: 0,
                path: callback.path().to_owned(),
                state,
                loopback_hosts: vec!["localhost".into(), "127.0.0.1".into(), "[::1]".into()],
                destination: Destination::Native {
                    forward,
                    failure,
                    ended,
                },
                closed: watch::channel(false).0,
                busy: Mutex::new(false),
            }),
            hosts,
            port,
        })
    }
    pub fn listen(&self) -> impl Future<Output = ListenState> + Send + 'static {
        listen(
            Arc::clone(&self.relay),
            self.hosts.clone(),
            self.port,
            5 * 60 * 1000,
        )
    }
}
impl Drop for NativeRelay {
    fn drop(&mut self) {
        self.relay.close();
    }
}

static RELAYS: LazyLock<Mutex<HashMap<u64, Arc<Relay>>>> = LazyLock::new(Mutex::default);

fn relays() -> MutexGuard<'static, HashMap<u64, Arc<Relay>>> {
    RELAYS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Relay {
    fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Stops listening; a callback on its way finishes (its page is the one the browser shows). Main hears the end
    /// once (`remotebytes.signInEnded`), after every ask this relay made.
    fn close(&self) {
        self.stop(true);
    }
    fn stop(&self, notify: bool) {
        if self.closed.send_replace(true) {
            return;
        }
        match &self.destination {
            Destination::Legacy(events) => {
                relays().remove(&self.id);
                events.send("remotebytes.signInEnded", &json!({"relay":self.id}));
            }
            Destination::Native { ended, .. } if notify => ended(),
            Destination::Native { .. } => {}
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    relay: u64,
    port: u16,
    /// The redirect URI's path (`url.pathname`).
    path: String,
    state: String,
    /// The addresses to listen on: `127.0.0.1` and `::1` for `localhost`, else the one the URI names.
    hosts: Vec<String>,
    /// The Host header names a browser may send (`LOOPBACK_HOSTS`).
    loopback_hosts: Vec<String>,
    timeout_ms: u64,
}

/// `remotebytes.signInStart` → `{listening: true}`, or `{listening: false, port}` when this computer already uses
/// the port (then nothing listens), or `{closed: true}` when it was closed meanwhile.
pub async fn start(call: Call) -> Result<Reply, Fault> {
    let params: StartParams = call.params()?;
    let relay = Arc::new(Relay {
        id: params.relay,
        path: params.path,
        state: params.state,
        loopback_hosts: params.loopback_hosts,
        destination: Destination::Legacy(call.events.clone()),
        closed: watch::channel(false).0,
        busy: Mutex::new(false),
    });
    relays().insert(relay.id, relay.clone());
    match listen(relay, params.hosts, params.port, params.timeout_ms).await {
        ListenState::Listening => Reply::json(&json!({"listening":true})),
        ListenState::Busy(port) => Reply::json(&json!({"listening":false,"port":port})),
        ListenState::Closed => Reply::json(&json!({"closed":true})),
    }
}

async fn listen(relay: Arc<Relay>, hosts: Vec<String>, port: u16, timeout_ms: u64) -> ListenState {
    if relay.is_closed() {
        return ListenState::Closed;
    }
    let timer = relay.clone();
    let mut closing = relay.closed.subscribe();
    tokio::spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(timeout_ms)) => timer.close(),
            () = ended(&mut closing) => {}
        }
    });
    let mut listeners = Vec::new();
    for (index, host) in hosts.iter().enumerate() {
        let bound = TcpListener::bind((host.as_str(), port)).await;
        if relay.is_closed() {
            return ListenState::Closed;
        }
        match bound {
            Ok(listener) => listeners.push(listener),
            // A computer without IPv6 has no `::1` to take: the IPv4 listener serves alone, as stock's does.
            Err(error) if index > 0 && error.kind() != std::io::ErrorKind::AddrInUse => {}
            Err(_) => {
                relay.stop(false);
                return ListenState::Busy(port);
            }
        }
    }
    for listener in listeners {
        tokio::spawn(accept(relay.clone(), listener));
    }
    ListenState::Listening
}

/// `remotebytes.signInClose {relay}`: the sign-in ended or a newer page replaced it.
pub fn close(push: PushCall) {
    let Ok(params) = serde_json::from_str::<Map<String, Value>>(push.params.get()) else {
        return;
    };
    let relay = params
        .get("relay")
        .and_then(Value::as_u64)
        .and_then(|id| relays().get(&id).cloned());
    if let Some(relay) = relay {
        relay.close();
    }
}

/// Resolves once the relay closed (the guard `wait_for` gives is no `Send`, so it never crosses an await).
async fn ended(closed: &mut watch::Receiver<bool>) {
    let _ = closed.wait_for(|closed| *closed).await;
}

async fn accept(relay: Arc<Relay>, listener: TcpListener) {
    let mut closed = relay.closed.subscribe();
    loop {
        tokio::select! {
            () = ended(&mut closed) => return,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                tokio::spawn(serve(relay.clone(), stream));
            }
        }
    }
}

/// One connection: one answer (`connection: close`), and an idle one ends with the relay.
async fn serve(relay: Arc<Relay>, stream: tokio::net::TcpStream) {
    let mut closed = relay.closed.subscribe();
    let handler = relay.clone();
    let service = service_fn(move |request| {
        let relay = handler.clone();
        async move { Ok::<_, std::convert::Infallible>(handle(&relay, request).await) }
    });
    let connection = http1::Builder::new().serve_connection(TokioIo::new(stream), service);
    tokio::pin!(connection);
    tokio::select! {
        _ = connection.as_mut() => {}
        () = ended(&mut closed) => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
    }
}

fn answer(status: u16, content_type: Option<&str>, body: String) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = response.headers_mut();
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(CONNECTION, HeaderValue::from_static("close"));
    if let Some(content_type) = content_type {
        let value = HeaderValue::from_str(content_type)
            .unwrap_or(HeaderValue::from_static("text/plain; charset=utf-8"));
        headers.insert(CONTENT_TYPE, value);
    }
    response
}

/// `new URL("http://" + host).hostname`, empty when that is no URL.
pub(super) fn host_name(header: &str) -> String {
    url::Url::parse(&format!("http://{header}"))
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default()
}

/// What `new URL(request.url, "http://localhost")` reads of a request target: its path, its first `state` and its
/// query without `?`.
pub(super) struct Target {
    pub path: String,
    pub state: Option<String>,
    pub query: String,
}

pub(super) fn target(request_target: &str) -> Option<Target> {
    let base = url::Url::parse("http://localhost").ok()?;
    let target = base.join(request_target).ok()?;
    let state = target
        .query_pairs()
        .find(|(name, _)| name == "state")
        .map(|(_, value)| value.into_owned());
    Some(Target {
        path: target.path().to_owned(),
        state,
        query: target.query().unwrap_or_default().to_owned(),
    })
}

fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for char in text.chars() {
        match char {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(char),
        }
    }
    escaped
}

/// The page's words when the host could not take the callback: how to finish by pasting the address.
pub(super) fn failure_page(title: &str, message: &str) -> String {
    let (title, message) = (escape_html(title), escape_html(message));
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title></head><body style=\"font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem\"><h1 style=\"font-size:1.25rem\">{title}</h1><p>{message}</p></body></html>"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
pub struct Words {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Deserialize)]
struct Forwarded {
    page: Option<Page>,
    failure: Option<Words>,
    /// Main closed the stand-in before its close reached here: nothing was forwarded.
    #[serde(default)]
    closed: bool,
}

async fn handle(relay: &Relay, request: Request<Incoming>) -> Response<Full<Bytes>> {
    let host = request
        .headers()
        .get(hyper::header::HOST)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .unwrap_or_default();
    if !relay.loopback_hosts.contains(&host_name(&host)) {
        return answer(403, None, String::new());
    }
    let callback = target(&request.uri().to_string())
        .filter(|target| request.method() == hyper::Method::GET && target.path == relay.path)
        .filter(|target| target.state.as_deref() == Some(relay.state.as_str()));
    let Some(callback) = callback else {
        return answer(404, Some("text/plain; charset=utf-8"), "Not Found".into());
    };
    {
        let mut busy = relay.busy.lock().unwrap_or_else(|p| p.into_inner());
        if *busy || relay.is_closed() {
            return answer(409, Some("text/plain; charset=utf-8"), String::new());
        }
        *busy = true;
    }
    let forwarded = match &relay.destination {
        Destination::Legacy(events) => {
            let mut data = Map::new();
            data.insert("path".into(), callback.path.into());
            data.insert("query".into(), callback.query.into());
            ask(events, None, relay.id, "signIn", data)
                .await
                .ok()
                .and_then(|answer| serde_json::from_str::<Forwarded>(answer.get()).ok())
        }
        Destination::Native {
            forward, failure, ..
        } => Some(match forward(callback.path, callback.query).await {
            Ok(page) => Forwarded {
                page: Some(page),
                failure: None,
                closed: false,
            },
            Err(_) => Forwarded {
                page: None,
                failure: Some(failure.clone()),
                closed: false,
            },
        }),
    };
    match forwarded {
        Some(Forwarded { closed: true, .. }) => {
            relay.close();
            answer(409, Some("text/plain; charset=utf-8"), String::new())
        }
        Some(Forwarded {
            page: Some(page), ..
        }) => {
            // The sign-in ends as its callback arrives; the connection still writes this page.
            relay.close();
            answer(page.status, Some(&page.content_type), page.body)
        }
        other => {
            *relay.busy.lock().unwrap_or_else(|p| p.into_inner()) = false;
            let words = other
                .and_then(|forwarded| forwarded.failure)
                .unwrap_or_default();
            answer(
                502,
                Some("text/html; charset=utf-8"),
                failure_page(&words.title, &words.message),
            )
        }
    }
}

#[cfg(test)]
mod native_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn get(port: u16, path: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }
    #[tokio::test]
    async fn native_callback_keeps_state_and_one_use_guards_without_a_node_ask() {
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let (sent, mut callbacks) = tokio::sync::mpsc::unbounded_channel();
        let forward: Forward = Arc::new(move |path, query| {
            sent.send((path, query)).unwrap();
            Box::pin(async {
                Ok(Page {
                    status: 200,
                    content_type: "text/plain".into(),
                    body: "Signed in".into(),
                })
            })
        });
        let authorize = format!(
            "https://provider.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A{port}%2Fcallback&state=flow"
        );
        let relay =
            NativeRelay::prepare(&authorize, forward, Words::default(), Arc::new(|| {})).unwrap();
        assert!(matches!(relay.listen().await, ListenState::Listening));
        let rejected = get(port, "/callback?state=other&code=not-forwarded").await;
        assert!(rejected.starts_with("HTTP/1.1 404"));
        let accepted = get(port, "/callback?state=flow&code=one").await;
        assert!(accepted.starts_with("HTTP/1.1 200"));
        assert!(accepted.ends_with("Signed in"));
        assert_eq!(
            callbacks.recv().await.unwrap(),
            ("/callback".into(), "state=flow&code=one".into())
        );
        assert!(callbacks.try_recv().is_err());
        assert!(relay.relay.is_closed());
    }
    #[tokio::test]
    async fn cancelled_native_bind_never_opens_a_listener() {
        let forward: Forward =
            Arc::new(|_, _| Box::pin(async { Err(Fault::new("closed", "closed")) }));
        assert!(NativeRelay::prepare("https://provider.example/?redirect_uri=https%3A%2F%2Flocalhost%3A12345%2Fcb&state=s",Arc::clone(&forward),Words::default(),Arc::new(||{})).is_none());
        let relay = NativeRelay::prepare(
            "https://provider.example/?redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcb&state=s",
            forward,
            Words::default(),
            Arc::new(|| {}),
        )
        .unwrap();
        let listening = relay.listen();
        drop(relay);
        assert!(matches!(listening.await, ListenState::Closed));
    }
}
