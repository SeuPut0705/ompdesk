//! The edge's HTTP/1.1 server on `127.0.0.1` (`web/server.ts`): every request is walled by `auth::check_request`, then
//! routed: `/healthz`, `/api/pair`, `/api/session`, `/api/push`, `/upload`, `/blob/`, `/hooks/<id>` and the built
//! renderer's static files; `/ws` upgrades to the page's WebSocket. Answers carry the same status, headers (in the
//! same order) and body as the TypeScript's (`matrix.json` pins them).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::BodyExt;
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinSet;

use super::assets::{self, Assets, CompressedCache};
use super::auth::{self, Check, Kind, OneTimeTokens, Policy, Why};
use super::body::Out;
use super::deps::{
    Blobs, Clock, Connection, Desktop, HookOutcome, Hooks, Outbox, Outgoing, PairingDetails,
    PairingOutcome, Peer, Router, Uploads, Whois,
};
use super::devices::{
    AuthResult, Blocks, DEFAULT_GRANTS, Device, Devices, NewDevice, PUSH_CATEGORIES, PushSettings,
    PushSubscription, Verdict,
};
use super::hex;
use super::limits::{Pairing, PairingGuard, SlidingWindow, UnpairedThrottle};
use super::refusal::{Refusal, RefusalKind, refusal_page};
use super::ws;

pub const SERVER_HOST: &str = "127.0.0.1";
const JSON_BODY_MAX_BYTES: usize = 32 * 1024;
const SESSION_REQUESTS_PER_MINUTE: usize = 20;
const PUSH_REQUESTS_PER_MINUTE: usize = 20;
/// New devices made in an hour, over all of them: a loop of cleared cookies cannot fill the list.
const NEW_DEVICES_PER_HOUR: usize = 20;
/// How long a whois answer is reused for one tailnet address.
const PEER_CACHE_MS: i64 = 60_000;
const PEER_CACHE_MAX: usize = 256;
const HOOK_PREFIX: &str = "/hooks/";
const HOOK_BODY_MAX_BYTES: usize = 64 * 1024;
const HOOK_DETAIL_CHARS: usize = 400;
const BLOB_URL_PREFIX: &str = "/blob/";
const MAX_CONNECTIONS_PER_DEVICE: usize = 4;
/// How much of an unread request body is read out before the answer goes.
const DRAIN_MAX_BYTES: usize = 1024 * 1024;
const CLOSE_GRACE: Duration = Duration::from_secs(1);
const HEADERS_TIMEOUT: Duration = Duration::from_secs(15);

/// Everything the edge reads of the application.
pub struct Deps {
    /// Mutable: `Edge::configure` changes the published address as Tailscale reports it.
    pub policy: Policy,
    pub devices: Arc<dyn Devices>,
    pub blocks: Arc<dyn Blocks>,
    pub whois: Arc<dyn Whois>,
    pub desktop: Arc<dyn Desktop>,
    pub router: Arc<dyn Router>,
    pub uploads: Arc<dyn Uploads>,
    pub blobs: Arc<dyn Blobs>,
    pub hooks: Option<Arc<dyn Hooks>>,
    pub assets: Arc<dyn Assets>,
    /// The VAPID public key a page subscribes against.
    pub push_public_key: Arc<dyn Fn() -> String + Send + Sync>,
    pub clock: Clock,
}

/// A change of the published address (`ConfigurablePolicy`).
#[derive(Default)]
pub struct Change {
    pub host: Option<String>,
    pub public_port: Option<u16>,
    pub secure: Option<bool>,
    pub serve_prefix: Option<Option<String>>,
    pub pending_prefix: Option<Option<String>>,
    pub allowed_users: Option<Vec<String>>,
}

struct Inner {
    deps: Deps,
    policy: Mutex<Policy>,
    tickets: OneTimeTokens<(String, String)>,
    nonces: OneTimeTokens<String>,
    session_limiter: SlidingWindow,
    push_limiter: SlidingWindow,
    enroll_limiter: SlidingWindow,
    pair_guard: PairingGuard,
    unpaired: UnpairedThrottle,
    peers: Mutex<HashMap<String, (Peer, i64)>>,
    cache: CompressedCache,
    port: AtomicU16,
    /// The page sockets' tasks: the stop waits a moment for their close handshakes, then cuts them off.
    sockets: Mutex<JoinSet<()>>,
}

#[derive(Clone)]
pub struct Edge {
    inner: Arc<Inner>,
}

/// A request's answer before it becomes a hyper response: the headers in the order they are written.
struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Bytes,
    /// Whether the TypeScript's answer carried `content-length`; when not it was chunked.
    sized: bool,
    /// A store's own response (a blob), sent as it is.
    passed: Option<Response<Out>>,
}

impl Reply {
    fn into_response(self) -> Response<Out> {
        if let Some(response) = self.passed {
            return response;
        }
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
        if let Some(map) = builder.headers_mut() {
            for (name, value) in self.headers {
                if let Ok(value) = HeaderValue::from_str(&value) {
                    map.append(HeaderName::from_static(name), value);
                }
            }
        }
        let body = if self.sized {
            Out::sized(self.body)
        } else {
            Out::chunked(self.body)
        };
        builder
            .body(body)
            .unwrap_or_else(|_| Response::new(Out::empty()))
    }
}

/// Node's `http.STATUS_CODES` for the statuses the edge writes.
fn status_text(status: u16) -> &'static str {
    match status {
        101 => "Switching Protocols",
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        421 => "Misdirected Request",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "",
    }
}

fn send_json(status: u16, body: &serde_json::Value, extra: &[(&'static str, String)]) -> Reply {
    let text = body.to_string();
    let mut headers = vec![
        ("content-type", "application/json; charset=utf-8".to_owned()),
        ("content-length", text.len().to_string()),
        ("cache-control", "no-store".to_owned()),
    ];
    headers.extend(extra.iter().cloned());
    Reply {
        status,
        headers,
        body: Bytes::from(text),
        sized: true,
        passed: None,
    }
}

fn send_status(status: u16, extra: &[(&'static str, String)]) -> Reply {
    let mut headers = vec![
        ("content-type", "text/plain; charset=utf-8".to_owned()),
        ("cache-control", "no-store".to_owned()),
    ];
    headers.extend(extra.iter().cloned());
    Reply {
        status,
        headers,
        body: Bytes::from(status_text(status)),
        sized: false,
        passed: None,
    }
}

/// A small HTML answer (the refusal pages): its own CSP allows only inline style, nothing is cached.
fn send_html(status: u16, html: String) -> Reply {
    Reply {
        status,
        headers: vec![
            ("content-type", "text/html; charset=utf-8".to_owned()),
            ("content-length", html.len().to_string()),
            ("cache-control", "no-store".to_owned()),
            ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'".to_owned()),
            ("x-content-type-options", "nosniff".to_owned()),
            ("referrer-policy", "no-referrer".to_owned()),
        ],
        body: Bytes::from(html),
        sized: true,
        passed: None,
    }
}

/// A failed request: the status and the JSON `{error}` the page reads.
struct HttpError {
    status: u16,
    error: String,
    headers: Vec<(&'static str, String)>,
}

fn fail(status: u16, error: &str) -> HttpError {
    HttpError {
        status,
        error: error.to_owned(),
        headers: Vec::new(),
    }
}

fn fail_with(status: u16, error: &str, headers: Vec<(&'static str, String)>) -> HttpError {
    HttpError {
        status,
        error: error.to_owned(),
        headers,
    }
}

impl From<HttpError> for Reply {
    fn from(error: HttpError) -> Self {
        send_json(
            error.status,
            &serde_json::json!({ "error": error.error }),
            &error.headers,
        )
    }
}

type Answer = Result<Reply, HttpError>;

/// A request as the routes see it: the head, the peer and the target with the serve prefix off.
struct Call {
    method: Method,
    headers: HeaderMap,
    remote: IpAddr,
}

fn first_forwarded(headers: &HeaderMap) -> Option<String> {
    let value = auth::single(headers, "x-forwarded-for")?;
    Some(
        value
            .split(',')
            .next()
            .unwrap_or("")
            .trim_matches(auth::js_space)
            .to_owned(),
    )
}

/// The Tailscale address serve put in `X-Forwarded-For`, or `None`.
fn tailnet_address(headers: &HeaderMap) -> Option<String> {
    first_forwarded(headers).filter(|f| !f.is_empty() && f.parse::<IpAddr>().is_ok())
}

/// The peer address for limits and notices: serve's `X-Forwarded-For` (one Tailscale IP), else the socket's.
fn source_address(headers: &HeaderMap, remote: IpAddr) -> String {
    match first_forwarded(headers) {
        Some(f)
            if (3..=45).contains(&f.len())
                && f.bytes()
                    .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.') =>
        {
            f
        }
        _ => remote.to_string(),
    }
}

fn ua_hash(headers: &HeaderMap) -> String {
    hex(&Sha256::digest(
        auth::single(headers, "user-agent")
            .unwrap_or_default()
            .as_bytes(),
    ))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    // /^application\/json\b/i
    let value = auth::single(headers, "content-type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    value.strip_prefix("application/json").is_some_and(|rest| {
        rest.bytes()
            .next()
            .is_none_or(|b| !(b.is_ascii_alphanumeric() || b == b'_'))
    })
}

fn take(request: &mut Option<Request<Incoming>>) -> Request<Incoming> {
    request.take().expect("a request body is taken once")
}

/// The body up to `max` bytes. Past `max` the rest is still read out (to a bound) and thrown away, so the connection
/// can answer before it closes without resetting.
async fn read_body(mut body: Incoming, max: usize) -> Result<Bytes, ()> {
    let mut data = Vec::new();
    let (mut seen, mut over) = (0usize, false);
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { return Err(()) };
        if let Some(chunk) = frame.data_ref() {
            seen += chunk.len();
            if seen > max {
                over = true;
                data = Vec::new();
            } else {
                data.extend_from_slice(chunk);
            }
            if seen > max + DRAIN_MAX_BYTES {
                break;
            }
        }
    }
    if over { Err(()) } else { Ok(Bytes::from(data)) }
}

async fn read_json_body(
    headers: &HeaderMap,
    body: Incoming,
) -> Result<serde_json::Value, HttpError> {
    if !is_json_content_type(headers) {
        return Err(fail(415, "expected application/json"));
    }
    let bytes = read_body(body, JSON_BODY_MAX_BYTES)
        .await
        .map_err(|()| fail(413, "body too large"))?;
    if bytes.is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|_| fail(400, "invalid json"))
}

impl Edge {
    pub fn new(deps: Deps) -> Self {
        let policy = Mutex::new(deps.policy.clone());
        Self {
            inner: Arc::new(Inner {
                deps,
                policy,
                tickets: OneTimeTokens::new(auth::TICKET_TTL_MS),
                nonces: OneTimeTokens::new(auth::TICKET_TTL_MS),
                session_limiter: SlidingWindow::new(SESSION_REQUESTS_PER_MINUTE, 60_000),
                push_limiter: SlidingWindow::new(PUSH_REQUESTS_PER_MINUTE, 60_000),
                enroll_limiter: SlidingWindow::new(NEW_DEVICES_PER_HOUR, 60 * 60_000),
                pair_guard: PairingGuard::default(),
                unpaired: UnpairedThrottle::default(),
                peers: Mutex::new(HashMap::new()),
                cache: CompressedCache::default(),
                port: AtomicU16::new(0),
                sockets: Mutex::new(JoinSet::new()),
            }),
        }
    }

    /// Change the address the server answers to (Tailscale reported a name, serve moved to another port).
    pub fn configure(&self, change: Change) {
        let mut policy = self.inner.policy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(host) = change.host {
            policy.host = host;
        }
        if let Some(port) = change.public_port {
            policy.public_port = port;
        }
        if let Some(secure) = change.secure {
            policy.secure = secure;
        }
        if let Some(prefix) = change.serve_prefix {
            policy.serve_prefix = prefix;
        }
        if let Some(prefix) = change.pending_prefix {
            policy.pending_prefix = prefix;
        }
        if let Some(users) = change.allowed_users {
            policy.allowed_users = users;
        }
    }

    /// Listen on the loopback; `port` 0 picks a free one. Fails when the port is taken.
    pub async fn start(&self, port: u16) -> std::io::Result<Running> {
        let listener = TcpListener::bind((SERVER_HOST, port)).await?;
        let bound = listener.local_addr()?.port();
        self.inner.port.store(bound, Ordering::Relaxed);
        let stop = Arc::new(Notify::new());
        let edge = self.clone();
        let signal = stop.clone();
        let task = tokio::spawn(async move { edge.accept_loop(listener, signal).await });
        Ok(Running {
            port: bound,
            stop,
            task: Some(task),
            edge: self.clone(),
        })
    }

    async fn accept_loop(self, listener: TcpListener, stop: Arc<Notify>) {
        let mut connections: JoinSet<()> = JoinSet::new();
        loop {
            tokio::select! {
                () = stop.notified() => break,
                accepted = listener.accept() => {
                    let Ok((stream, remote)) = accepted else { continue };
                    let _ = stream.set_nodelay(true);
                    let edge = self.clone();
                    connections.spawn(async move {
                        let service = service_fn(move |request| {
                            let edge = edge.clone();
                            async move { Ok::<_, std::convert::Infallible>(edge.handle(request, remote).await) }
                        });
                        let mut builder = http1::Builder::new();
                        builder.timer(TokioTimer::new()).header_read_timeout(HEADERS_TIMEOUT);
                        let _ = builder.serve_connection(TokioIo::new(stream), service).with_upgrades().await;
                    });
                }
            }
        }
        drop(listener);
        self.inner.deps.desktop.decline_all();
        self.inner.deps.router.close_all(1001, "server stopping");
        let mut sockets =
            std::mem::take(&mut *self.inner.sockets.lock().unwrap_or_else(|e| e.into_inner()));
        // A close handshake needs a moment; a peer that does not answer is cut off.
        let _ = tokio::time::timeout(CLOSE_GRACE, async {
            while sockets.join_next().await.is_some() {}
            while connections.join_next().await.is_some() {}
        })
        .await;
        sockets.abort_all();
        connections.abort_all();
        while sockets.join_next().await.is_some() {}
        while connections.join_next().await.is_some() {}
    }

    fn now(&self) -> i64 {
        (self.inner.deps.clock)()
    }

    fn policy(&self) -> Policy {
        self.inner
            .policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The policy as it stands for this request: main's, while main holds the published address and the settings.
    async fn current_policy(&self) -> Policy {
        match self.inner.deps.desktop.policy().await {
            Some(policy) => policy,
            None => self.policy(),
        }
    }

    /// One request, from the walls to the answer.
    pub async fn handle(&self, request: Request<Incoming>, remote: SocketAddr) -> Response<Out> {
        let (parts, body) = request.into_parts();
        let call = Call {
            method: parts.method.clone(),
            headers: parts.headers.clone(),
            remote: remote.ip(),
        };
        let url = parts
            .uri
            .path_and_query()
            .map_or_else(|| "/".to_owned(), |p| p.as_str().to_owned());
        let is_upgrade = call.headers.contains_key("upgrade")
            && auth::single(&call.headers, "connection").is_some_and(|c| {
                c.split(',')
                    .any(|t| t.trim().eq_ignore_ascii_case("upgrade"))
            });
        if is_upgrade {
            let request = Request::from_parts(parts, body);
            return self.upgrade(request, call, &url).await;
        }
        let mut slot = Some(Request::from_parts(parts, body));
        let answer = self.route(call, &url, &mut slot).await;
        // A request nobody read the body of is read out here, as Node read it: closing a socket with unread data
        // resets it, and the client then never sees the answer.
        if let Some(unread) = slot {
            let _ = read_body(unread.into_body(), DRAIN_MAX_BYTES).await;
        }
        match answer {
            Ok(reply) => reply.into_response(),
            Err(error) => Reply::from(error).into_response(),
        }
    }

    /// A walled request: a status, or for a login Tailscale vouches for but we do not allow, the page that says so.
    fn refuse(
        call: &Call,
        policy: &Policy,
        status: u16,
        why: Why,
        login: Option<&str>,
        kind: Kind,
    ) -> Reply {
        if why == Why::Other {
            return send_status(status, &[]);
        }
        if kind != Kind::Page {
            let error = if why == Why::UserNotAllowed {
                "tailscale_user_not_allowed"
            } else {
                "no_tailscale_user"
            };
            return send_json(403, &serde_json::json!({ "error": error }), &[]);
        }
        let accept_language = auth::single(&call.headers, "accept-language");
        send_html(
            403,
            refusal_page(&Refusal {
                kind: if why == Why::UserNotAllowed {
                    RefusalKind::UserNotAllowed
                } else {
                    RefusalKind::NoUser
                },
                login,
                allowed: &policy.allowed_users,
                accept_language: accept_language.as_deref(),
            }),
        )
    }

    /// A blocked device (or login): the page that says so.
    fn refuse_blocked(call: &Call, policy: &Policy, verdict: &Verdict, login: &str) -> Reply {
        let login_scope = matches!(verdict, Verdict::Entry(entry) if entry.scope == super::devices::BlockScope::Login);
        let accept_language = auth::single(&call.headers, "accept-language");
        send_html(
            403,
            refusal_page(&Refusal {
                kind: if login_scope {
                    RefusalKind::BlockedLogin
                } else {
                    RefusalKind::BlockedNode
                },
                login: Some(login),
                allowed: &policy.allowed_users,
                accept_language: accept_language.as_deref(),
            }),
        )
    }

    /// whois for a tailnet address, reused for a minute; a failed answer is not kept.
    async fn peer(&self, address: &str) -> Option<Peer> {
        let now = self.now();
        if let Some((peer, at)) = self
            .inner
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(address)
            && now - at < PEER_CACHE_MS
        {
            return Some(peer.clone());
        }
        let peer = self.inner.deps.whois.peer(address).await;
        if let Some(peer) = &peer {
            let mut peers = self.inner.peers.lock().unwrap_or_else(|e| e.into_inner());
            if peers.len() >= PEER_CACHE_MAX {
                peers.clear();
            }
            peers.insert(address.to_owned(), (peer.clone(), now));
        }
        peer
    }

    fn has_device(&self, headers: &HeaderMap, secure: bool) -> bool {
        auth::device_cookie_value(headers, secure).is_some_and(|cookie| {
            matches!(
                self.inner.deps.devices.authenticate(&cookie, self.now()),
                AuthResult::Ok(_)
            )
        })
    }

    async fn route(
        &self,
        call: Call,
        url: &str,
        request: &mut Option<Request<Incoming>>,
    ) -> Result<Reply, HttpError> {
        let policy = self.current_policy().await;
        // Only a request that came through serve carries the secret prefix; everything below sees it taken off. Before
        // the handler is confirmed the prefix to come names the route, and the check answers it 503.
        let prefix = policy
            .serve_prefix
            .as_ref()
            .or(policy.pending_prefix.as_ref());
        let stripped = prefix.and_then(|prefix| auth::strip_serve_prefix(url, prefix));
        let whole = stripped.as_deref().unwrap_or("/");
        let pathname = whole.split('?').next().unwrap_or("/").to_owned();
        // A webhook call to the loopback address itself carries no serve prefix: the bearer key is its only
        // credential, and nothing a browser can send is accepted.
        if stripped.is_none() {
            let bare = url.split('?').next().unwrap_or("");
            if bare.starts_with(HOOK_PREFIX) {
                return self.direct_hook(call, request, bare).await;
            }
        }

        let is_hook = pathname.starts_with(HOOK_PREFIX);
        let is_api = matches!(
            pathname.as_str(),
            "/api/pair" | "/api/session" | "/api/push" | "/upload" | "/healthz"
        ) || pathname.starts_with(BLOB_URL_PREFIX);
        let kind = if is_hook {
            Kind::Hook
        } else if is_api {
            Kind::Api
        } else {
            Kind::Page
        };
        let (login, target) = match auth::check_request(
            &call.headers,
            call.method.as_str(),
            kind,
            url,
            call.remote,
            &policy,
        ) {
            Check::Ok { login, target } => (login, target),
            Check::Refused {
                status, why, login, ..
            } => {
                return Ok(Self::refuse(
                    &call,
                    &policy,
                    status,
                    why,
                    login.as_deref(),
                    kind,
                ));
            }
        };
        if is_hook {
            return self.hook(&call, request, &pathname).await;
        }
        // A blocked device must not reach the app: a page load without a device cookie asks who the visitor is.
        if assets::is_page(&pathname)
            && self.inner.deps.blocks.active()
            && !self.has_device(&call.headers, policy.secure)
        {
            let peer = match tailnet_address(&call.headers) {
                Some(address) => self.peer(&address).await,
                None => None,
            };
            let node_id = peer.as_ref().and_then(|p| p.node_id.as_deref());
            if let Some(verdict) = self.inner.deps.blocks.check(node_id, Some(&login)) {
                return Ok(Self::refuse_blocked(&call, &policy, &verdict, &login));
            }
        }

        if pathname == "/healthz" {
            if call.method != Method::GET {
                return Err(fail(405, "method not allowed"));
            }
            return Ok(send_json(200, &serde_json::json!({ "ok": true }), &[]));
        }
        match pathname.as_str() {
            "/api/pair" => self.pair(&call, request, &login, &policy).await,
            "/api/session" => self.session(&call, request, &policy).await,
            "/api/push" => self.push(&call, request, &policy).await,
            "/upload" => self.upload(&call, request, &policy).await,
            p if p.starts_with(BLOB_URL_PREFIX) => {
                self.blob(&call, request, &target, &policy).await
            }
            p if p.starts_with("/api/") => Err(fail(404, "not found")),
            _ => self.static_file(&call, &pathname, &policy).await,
        }
    }

    /// `POST /hooks/<id>` on the loopback address itself: no identity header is believed, and anything that marks a
    /// browser is refused first, as is a `Host` that is not this loopback address (DNS rebinding).
    async fn direct_hook(
        &self,
        call: Call,
        request: &mut Option<Request<Incoming>>,
        pathname: &str,
    ) -> Result<Reply, HttpError> {
        let headers = &call.headers;
        if !auth::is_loopback(call.remote) || headers.contains_key("tailscale-funnel-request") {
            return Err(fail(403, "forbidden"));
        }
        if headers.contains_key("origin")
            || headers.contains_key("sec-fetch-site")
            || headers.contains_key("sec-fetch-mode")
        {
            return Err(fail(403, "forbidden"));
        }
        let port = self.inner.port.load(Ordering::Relaxed);
        let host = auth::single(headers, "host").map(|h| h.to_lowercase());
        let loopback = [
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ];
        if !host.is_some_and(|h| loopback.contains(&h)) {
            return Err(fail(421, "wrong host"));
        }
        self.hook(&call, request, pathname).await
    }

    /// The webhook call itself, however it arrived. 202 fired, 404 no such routine, 401 a wrong or missing key, 409 the
    /// routine is off, 413 a body over 64 KiB. A call with no bearer, or for an id that cannot be one, costs nothing:
    /// its body is not read.
    async fn hook(
        &self,
        call: &Call,
        request: &mut Option<Request<Incoming>>,
        pathname: &str,
    ) -> Result<Reply, HttpError> {
        if call.method != Method::POST {
            return Err(fail_with(
                405,
                "method not allowed",
                vec![("allow", "POST".to_owned())],
            ));
        }
        let id = &pathname[HOOK_PREFIX.len().min(pathname.len())..];
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(fail(404, "unknown_hook"));
        }
        let unauthorized = || {
            fail_with(
                401,
                "unauthorized",
                vec![("www-authenticate", "Bearer".to_owned())],
            )
        };
        let too_big = || {
            fail_with(
                413,
                "body too large",
                vec![("connection", "close".to_owned())],
            )
        };
        let bearer = parse_bearer(
            auth::single(&call.headers, "authorization")
                .as_deref()
                .unwrap_or(""),
        )
        .ok_or_else(unauthorized)?;
        // `Number(header) > limit`: an empty or unreadable length is not over it.
        if auth::single(&call.headers, "content-length")
            .and_then(|v| v.trim_matches(auth::js_space).parse::<f64>().ok())
            .is_some_and(|n| n > HOOK_BODY_MAX_BYTES as f64)
        {
            return Err(too_big());
        }
        let bytes = read_body(take(request).into_body(), HOOK_BODY_MAX_BYTES)
            .await
            .map_err(|()| too_big())?;
        let detail = hook_detail(&bytes);
        let Some(service) = &self.inner.deps.hooks else {
            return Err(fail(503, "unavailable"));
        };
        match service.webhook(id, &bearer, &detail).await {
            HookOutcome::Fired => Ok(send_json(202, &serde_json::json!({ "ok": true }), &[])),
            HookOutcome::Unknown => Err(fail(404, "unknown_hook")),
            HookOutcome::Denied => Err(unauthorized()),
            HookOutcome::Off => Err(fail(409, "off")),
            HookOutcome::Unavailable => Err(fail(503, "unavailable")),
        }
    }

    /// The device behind the request's cookie; a failure is counted, and told to the desktop once it repeats.
    fn device(&self, call: &Call, policy: &Policy) -> Result<Device, HttpError> {
        let cookie = auth::device_cookie_value(&call.headers, policy.secure);
        let result = cookie
            .as_ref()
            .map(|cookie| self.inner.deps.devices.authenticate(cookie, self.now()));
        if let Some(AuthResult::Ok(device)) = result {
            return Ok(*device);
        }
        // A visit with no cookie yet is the normal first visit of a new device (it enrolls next), not a stranger.
        if cookie.is_some() && self.inner.unpaired.record(self.now()) {
            self.inner
                .deps
                .desktop
                .unpaired_auth(&source_address(&call.headers, call.remote));
        }
        let mut headers = Vec::new();
        if result.is_some_and(|r| r != AuthResult::Malformed) {
            headers.push(("set-cookie", auth::cleared_device_cookie(policy.secure)));
        }
        Err(fail_with(401, "unauthorized", headers))
    }

    /// `POST /api/pair`: a Tailscale login that is allowed (the walls checked it) connects its device.
    async fn pair(
        &self,
        call: &Call,
        request: &mut Option<Request<Incoming>>,
        login: &str,
        policy: &Policy,
    ) -> Answer {
        if call.method != Method::POST {
            return Err(fail(405, "method not allowed"));
        }
        let deps = &self.inner.deps;
        let address = source_address(&call.headers, call.remote);
        if let Pairing::RetryAfterMs(ms) = self.inner.pair_guard.check(&address, self.now()) {
            return Err(fail_with(
                429,
                "rate_limited",
                vec![("retry-after", ((ms + 999) / 1000).to_string())],
            ));
        }
        let body = read_json_body(&call.headers, take(request).into_body()).await?;
        let invalid = || fail(400, "invalid_request");
        let object = body.as_object().ok_or_else(invalid)?;
        let name = match object.get("name") {
            None => String::new(),
            Some(serde_json::Value::String(name)) if utf16_len(name) <= 200 => name.clone(),
            Some(_) => return Err(invalid()),
        };
        if let Some(id) = object.get("clientInstanceId")
            && !matches!(id, serde_json::Value::String(text) if utf16_len(text) <= 128)
        {
            return Err(invalid());
        }
        let public_key = match object.get("publicKeyJwk") {
            None | Some(serde_json::Value::Null) => None,
            Some(jwk) => {
                Some(auth::parse_public_key_jwk(jwk).ok_or_else(|| fail(400, "invalid_key"))?)
            }
        };
        let forwarded = tailnet_address(&call.headers);
        let peer = match &forwarded {
            Some(address) => self.peer(address).await,
            None => None,
        };
        // whois reads the address serve itself put in; a different login behind it is not what the header claimed.
        if let Some(peer_login) = peer
            .as_ref()
            .and_then(|p| p.login.as_ref())
            .filter(|l| !l.is_empty())
            && peer_login.to_lowercase() != login.to_lowercase()
        {
            return Err(fail(403, "identity_mismatch"));
        }
        let node_id = peer.as_ref().and_then(|p| p.node_id.clone());
        if deps.blocks.check(node_id.as_deref(), Some(login)).is_some() {
            return Err(fail(403, "blocked"));
        }
        if !self.inner.enroll_limiter.hit("*", self.now()) {
            return Err(fail_with(
                429,
                "rate_limited",
                vec![("retry-after", "3600".to_owned())],
            ));
        }
        let user_agent = auth::single(&call.headers, "user-agent").unwrap_or_default();
        let trimmed = name.trim_matches(auth::js_space);
        let device_name = match peer.as_ref().and_then(|p| p.node_name.clone()) {
            Some(node_name) => node_name,
            None if trimmed.is_empty() => "Phone".to_owned(),
            None => trimmed.to_owned(),
        };
        let mut grants: Vec<String> = DEFAULT_GRANTS.iter().map(|g| (*g).to_owned()).collect();
        let asked = deps.desktop.confirm_new_devices().await;
        if asked {
            let outcome = deps
                .desktop
                .confirm(PairingDetails {
                    name: device_name.clone(),
                    user_agent: user_agent.clone(),
                    tailscale_login: login.to_owned(),
                    ip: address.clone(),
                })
                .await;
            match outcome {
                PairingOutcome::Approved { grants: approved } => grants = approved,
                PairingOutcome::Refused(reason) => {
                    self.inner.pair_guard.fail(&address, self.now());
                    return Err(fail(403, reason));
                }
            }
        }
        self.inner.pair_guard.succeed(&address);
        let (device, cookie) = deps.devices.create_checked(
            NewDevice {
                name: device_name,
                user_agent,
                tailscale_login: Some(login.to_owned()),
                node_id,
                public_key,
                grants,
            },
            self.now(),
            &*deps.blocks,
        ).ok_or_else(|| fail(403, "blocked"))?;
        if !asked {
            deps.desktop.device_connected(&device);
        }
        Ok(send_json(
            200,
            &serde_json::json!({ "deviceId": device.device_id, "name": device.name, "grants": device.grants }),
            &[(
                "set-cookie",
                auth::serialize_device_cookie(&cookie, policy.secure, auth::COOKIE_MAX_AGE_SECONDS),
            )],
        ))
    }

    /// `POST /api/session`: a one-use ticket for the WebSocket, after the device proves its key when it has one.
    async fn session(
        &self,
        call: &Call,
        request: &mut Option<Request<Incoming>>,
        policy: &Policy,
    ) -> Answer {
        if call.method != Method::POST {
            return Err(fail(405, "method not allowed"));
        }
        let device = self.device(call, policy)?;
        if !self
            .inner
            .session_limiter
            .hit(&device.device_id, self.now())
        {
            return Err(fail_with(
                429,
                "rate_limited",
                vec![("retry-after", "60".to_owned())],
            ));
        }
        let body = read_json_body(&call.headers, take(request).into_body()).await?;
        let invalid = || fail(400, "invalid_request");
        let object = body.as_object().ok_or_else(invalid)?;
        let field = |key: &str, max: usize| -> Result<Option<String>, HttpError> {
            match object.get(key) {
                None => Ok(None),
                Some(serde_json::Value::String(text)) if utf16_len(text) <= max => {
                    Ok(Some(text.clone()))
                }
                Some(_) => Err(invalid()),
            }
        };
        let (nonce, sig) = (field("nonce", 128)?, field("sig", 256)?);
        if let Some(key) = &device.public_key {
            let (Some(nonce), Some(sig)) = (nonce, sig) else {
                // Step one: the nonce the device will sign.
                let (token, expires) = self
                    .inner
                    .nonces
                    .issue(device.device_id.clone(), self.now());
                return Ok(send_json(
                    200,
                    &serde_json::json!({ "nonce": token, "expiresAt": expires }),
                    &[],
                ));
            };
            let owner = self.inner.nonces.redeem(&nonce, self.now());
            if owner.as_deref() != Some(device.device_id.as_str())
                || !auth::verify_device_proof(key, &nonce, &sig)
            {
                if self.inner.unpaired.record(self.now()) {
                    self.inner
                        .deps
                        .desktop
                        .unpaired_auth(&source_address(&call.headers, call.remote));
                }
                return Err(fail(401, "unauthorized"));
            }
        }
        let (ticket, expires) = self.inner.tickets.issue(
            (device.device_id.clone(), ua_hash(&call.headers)),
            self.now(),
        );
        Ok(send_json(
            200,
            &serde_json::json!({ "ticket": ticket, "expiresAt": expires }),
            &[],
        ))
    }

    /// `GET|POST /api/push`: this device's push state; a POST changes its subscription and what it wants pushed.
    async fn push(
        &self,
        call: &Call,
        request: &mut Option<Request<Incoming>>,
        policy: &Policy,
    ) -> Answer {
        if call.method != Method::GET && call.method != Method::POST {
            return Err(fail_with(
                405,
                "method not allowed",
                vec![("allow", "GET, POST".to_owned())],
            ));
        }
        let device = self.device(call, policy)?;
        if !device.grants.iter().any(|g| g == "device-self") {
            return Err(fail(403, "forbidden"));
        }
        if !self.inner.push_limiter.hit(&device.device_id, self.now()) {
            return Err(fail_with(
                429,
                "rate_limited",
                vec![("retry-after", "60".to_owned())],
            ));
        }
        let mut settings = device.push.clone().unwrap_or_default();
        if call.method == Method::POST {
            let body = read_json_body(&call.headers, take(request).into_body()).await?;
            let update = parse_push_body(&body).ok_or_else(|| fail(400, "invalid_request"))?;
            if let Some(Some(subscription)) = &update.subscription
                && !is_push_endpoint(&subscription.endpoint)
            {
                return Err(fail(400, "invalid_endpoint"));
            }
            settings = PushSettings {
                subscription: match update.subscription {
                    None => settings.subscription,
                    Some(subscription) => subscription,
                },
                hide_content: update.hide_content.unwrap_or(settings.hide_content),
                categories: match update.categories {
                    Some(wanted) => PUSH_CATEGORIES
                        .iter()
                        .filter(|c| wanted.iter().any(|w| w == *c))
                        .map(|c| (*c).to_owned())
                        .collect(),
                    None => settings.categories,
                },
            };
            self.inner
                .deps
                .devices
                .set_push(&device.device_id, settings.clone());
        }
        Ok(send_json(
            200,
            &serde_json::json!({
                "publicKey": (self.inner.deps.push_public_key)(),
                "subscribed": settings.subscription.is_some(),
                "hideContent": settings.hide_content,
                "categories": settings.categories,
            }),
            &[],
        ))
    }

    async fn upload(
        &self,
        call: &Call,
        request: &mut Option<Request<Incoming>>,
        policy: &Policy,
    ) -> Answer {
        if call.method != Method::POST {
            return Err(fail(405, "method not allowed"));
        }
        let device = self.device(call, policy)?;
        if !device.grants.iter().any(|g| g == "workspace") {
            return Err(fail(403, "forbidden"));
        }
        match self
            .inner
            .deps
            .uploads
            .receive(&device.device_id, take(request))
            .await
        {
            Ok(stored) => Ok(send_json(
                200,
                &serde_json::json!({ "path": stored.path, "name": stored.name, "size": stored.size }),
                &[],
            )),
            Err(failure) => Ok(send_json(
                failure.status,
                &serde_json::json!({ "error": failure.message }),
                &[],
            )),
        }
    }

    async fn blob(
        &self,
        call: &Call,
        request: &mut Option<Request<Incoming>>,
        target: &str,
        policy: &Policy,
    ) -> Answer {
        if call.method != Method::GET && call.method != Method::HEAD {
            return Err(fail(405, "method not allowed"));
        }
        let device = self.device(call, policy)?;
        if !device.grants.iter().any(|g| g == "workspace") {
            return Err(fail(403, "forbidden"));
        }
        let response = self
            .inner
            .deps
            .blobs
            .serve(&device.device_id, target, take(request))
            .await;
        Ok(Reply {
            status: 0,
            headers: Vec::new(),
            body: Bytes::new(),
            sized: true,
            passed: Some(response),
        })
    }

    /// The `Content-Security-Policy` of a page: this origin only, `connect-src` naming the WebSocket address.
    fn csp(policy: &Policy) -> String {
        let socket = auth::origin_of(policy).replacen("http", "ws", 1);
        [
            "default-src 'self'".to_owned(),
            "script-src 'self'".to_owned(),
            "style-src 'self' 'unsafe-inline'".to_owned(),
            "font-src 'self' data:".to_owned(),
            "img-src 'self' data: blob:".to_owned(),
            "media-src 'self' blob:".to_owned(),
            format!("connect-src 'self' {socket}"),
            "worker-src 'self' blob:".to_owned(),
            "manifest-src 'self'".to_owned(),
            "base-uri 'none'".to_owned(),
            "form-action 'self'".to_owned(),
            "frame-ancestors 'none'".to_owned(),
        ]
        .join("; ")
    }

    async fn static_file(&self, call: &Call, pathname: &str, policy: &Policy) -> Answer {
        if call.method != Method::GET && call.method != Method::HEAD {
            return Err(fail_with(
                405,
                "method not allowed",
                vec![("allow", "GET, HEAD".to_owned())],
            ));
        }
        let root = self.inner.deps.assets.root();
        let page = assets::is_page(pathname);
        if !assets::is_allowed(pathname) {
            return Err(fail(404, "not found"));
        }
        if assets::is_bad_path(pathname) {
            return Err(fail(400, "bad path"));
        }
        let Some(root) = root else {
            return Err(fail(404, "not found"));
        };
        let relative = if page {
            assets::PAGE_FILE.to_owned()
        } else {
            pathname[1..].to_owned()
        };
        let previous = if pathname.starts_with("/assets/") {
            self.inner.deps.assets.previous_builds()
        } else {
            Vec::new()
        };
        let wants_brotli = assets::accepts_brotli(
            &auth::single(&call.headers, "accept-encoding").unwrap_or_default(),
        );
        let edge = self.clone();
        let relative_for_task = relative.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            let mut base = root.clone();
            let mut file = assets::resolve_file(&root, &relative_for_task);
            if file.is_none() {
                for candidate in previous {
                    file = assets::resolve_file(&candidate, &relative_for_task);
                    base = candidate;
                    if file.is_some() {
                        break;
                    }
                }
            }
            let file = file?;
            let content_type = assets::mime(&file.extension);
            if wants_brotli
                && assets::compressible(content_type)
                && file.size > assets::BROTLI_MIN_BYTES
            {
                let packed = edge
                    .inner
                    .cache
                    .brotli_of(&file, &base, &relative_for_task)
                    .ok()?;
                return Some((content_type, Some(packed), file.size, None));
            }
            let bytes = std::fs::read(&file.path).ok()?;
            Some((content_type, None, file.size, Some(Bytes::from(bytes))))
        })
        .await
        .ok()
        .flatten();
        let Some((content_type, packed, size, plain)) = loaded else {
            return Err(fail(404, "not found"));
        };
        let mut headers = vec![
            ("content-type", content_type.to_owned()),
            (
                "cache-control",
                if pathname.starts_with("/assets/") {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }
                .to_owned(),
            ),
            ("x-content-type-options", "nosniff".to_owned()),
            ("referrer-policy", "no-referrer".to_owned()),
            ("x-frame-options", "DENY".to_owned()),
            ("cross-origin-opener-policy", "same-origin".to_owned()),
            ("vary", "Accept-Encoding".to_owned()),
        ];
        if page {
            headers.push(("content-security-policy", Self::csp(policy)));
        }
        if pathname == "/sw.js" {
            headers.push(("service-worker-allowed", "/".to_owned()));
        }
        let (body, length) = match packed {
            Some(packed) => {
                headers.push(("content-encoding", "br".to_owned()));
                let length = packed.len();
                (packed, length)
            }
            None => (plain.unwrap_or_default(), size as usize),
        };
        headers.push(("content-length", length.to_string()));
        let body = if call.method == Method::HEAD {
            Bytes::new()
        } else {
            body
        };
        Ok(Reply {
            status: 200,
            headers,
            body,
            sized: true,
            passed: None,
        })
    }

    /// The WebSocket upgrade: the secret prefix, the walls, the subprotocol and ticket, the device's cookie, then the
    /// handshake `ws` would have answered and the socket handed to the router.
    async fn upgrade(
        &self,
        mut request: Request<Incoming>,
        call: Call,
        url: &str,
    ) -> Response<Out> {
        let deny = |status: u16| {
            let mut response = Response::new(Out::empty());
            *response.status_mut() =
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            response
                .headers_mut()
                .insert("connection", HeaderValue::from_static("close"));
            response
                .headers_mut()
                .insert("content-length", HeaderValue::from_static("0"));
            response
        };
        let policy = self.current_policy().await;
        let prefix = policy
            .serve_prefix
            .as_ref()
            .or(policy.pending_prefix.as_ref());
        let stripped = prefix.and_then(|p| auth::strip_serve_prefix(url, p));
        if stripped.as_deref().and_then(|s| s.split('?').next()) != Some("/ws")
            || !auth::is_loopback(call.remote)
        {
            return deny(404);
        }
        if let Check::Refused { status, .. } = auth::check_request(
            &call.headers,
            call.method.as_str(),
            Kind::Ws,
            url,
            call.remote,
            &policy,
        ) {
            return deny(status);
        }
        let protocol_header =
            auth::single(&call.headers, "sec-websocket-protocol").unwrap_or_default();
        let protocols: Vec<&str> = protocol_header
            .split(',')
            .map(|p| p.trim_matches(auth::js_space))
            .collect();
        let ticket_token = protocols
            .iter()
            .find_map(|p| p.strip_prefix("ticket."))
            .filter(|t| !t.is_empty());
        let Some(ticket_token) = ticket_token.filter(|_| protocols.contains(&ws::SUBPROTOCOL))
        else {
            return deny(400);
        };
        // The page's previous connection: it may continue without loading its state again.
        let resume_from = protocols
            .iter()
            .find_map(|p| p.strip_prefix("resume."))
            .filter(|r| !r.is_empty());

        let cookie = auth::device_cookie_value(&call.headers, policy.secure);
        let auth_result = cookie
            .as_ref()
            .map(|c| self.inner.deps.devices.authenticate(c, self.now()));
        let ticket = self.inner.tickets.redeem(ticket_token, self.now());
        let device = match (auth_result, ticket) {
            (Some(AuthResult::Ok(device)), Some((ticket_device, ua)))
                if ticket_device == device.device_id && ua == ua_hash(&call.headers) =>
            {
                *device
            }
            _ => {
                if self.inner.unpaired.record(self.now()) {
                    self.inner
                        .deps
                        .desktop
                        .unpaired_auth(&source_address(&call.headers, call.remote));
                }
                return deny(401);
            }
        };
        let router = &self.inner.deps.router;
        if let Some(resume) = resume_from {
            router.retire(&device.device_id, resume).await;
        }
        if router.connection_count(&device.device_id).await >= MAX_CONNECTIONS_PER_DEVICE {
            return deny(429);
        }

        let header = |name: &str| auth::single(&call.headers, name);
        let (upgrade, key, version, protocol, extensions) = (
            header("upgrade"),
            header("sec-websocket-key"),
            header("sec-websocket-version"),
            header("sec-websocket-protocol"),
            header("sec-websocket-extensions"),
        );
        let accepted = match ws::accept(&ws::UpgradeHeaders {
            method: call.method.as_str(),
            upgrade: upgrade.as_deref(),
            key: key.as_deref(),
            version: version.as_deref(),
            protocol: protocol.as_deref(),
            extensions: extensions.as_deref(),
        }) {
            Ok(accepted) => accepted,
            Err(refusal) => {
                let mut response = Response::new(Out::sized(Bytes::from(refusal.message)));
                *response.status_mut() =
                    StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::BAD_REQUEST);
                let map = response.headers_mut();
                map.insert("connection", HeaderValue::from_static("close"));
                map.insert("content-type", HeaderValue::from_static("text/html"));
                map.insert("content-length", HeaderValue::from(refusal.message.len()));
                for (name, value) in refusal.headers {
                    if let (Ok(name), Ok(value)) = (
                        HeaderName::from_bytes(name.to_ascii_lowercase().as_bytes()),
                        HeaderValue::from_str(value),
                    ) {
                        map.insert(name, value);
                    }
                }
                return response;
            }
        };

        let mut response = Response::new(Out::empty());
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let map = response.headers_mut();
        map.insert("upgrade", HeaderValue::from_static("websocket"));
        map.insert("connection", HeaderValue::from_static("Upgrade"));
        if let Ok(digest) = HeaderValue::from_str(&accepted.digest) {
            map.insert("sec-websocket-accept", digest);
        }
        if let Some(protocol) = accepted.protocol {
            map.insert("sec-websocket-protocol", HeaderValue::from_static(protocol));
        }
        if let Some(extensions) = accepted
            .extensions
            .as_deref()
            .and_then(|e| HeaderValue::from_str(e).ok())
        {
            map.insert("sec-websocket-extensions", extensions);
        }

        // The router holds the connection before the page hears the 101, as `ws` attached it in `handleUpgrade`'s
        // callback: a page that saw its socket open is one the router can close.
        let (sender, inbox) = mpsc::unbounded_channel::<Outgoing>();
        let outbox = Outbox::new(sender);
        let connection = router
            .attach(&device.device_id, outbox.clone(), resume_from)
            .await;
        let edge = self.clone();
        let extensions = accepted.extensions.clone();
        let mut sockets = self.inner.sockets.lock().unwrap_or_else(|e| e.into_inner());
        sockets.spawn(async move {
            let Ok(upgraded) = hyper::upgrade::on(&mut request).await else {
                if let Some(connection) = connection {
                    connection.dispose();
                }
                return;
            };
            let Ok(socket) = yawc::WebSocket::from_stream_with_extensions(
                TokioIo::new(upgraded),
                yawc::Role::Server,
                extensions.as_deref(),
                ws::options_for(extensions.as_deref()),
            ) else {
                if let Some(connection) = connection {
                    connection.dispose();
                }
                return;
            };
            edge.run_socket(socket, connection, outbox, inbox).await;
        });
        drop(sockets);
        response
    }

    /// One page connection: frames in go to the router's connection, what the router sends goes out.
    async fn run_socket<S>(
        &self,
        mut socket: yawc::WebSocket<S>,
        connection: Option<Box<dyn Connection>>,
        outbox: Outbox,
        mut inbox: mpsc::UnboundedReceiver<Outgoing>,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
        use futures_util::{SinkExt as _, StreamExt as _};
        let Some(connection) = connection else {
            let _ = socket
                .send(yawc::Frame::close(
                    yawc::close::CloseCode::Again,
                    "too many connections",
                ))
                .await;
            return;
        };
        let connection: Box<dyn Connection> = connection;
        loop {
            tokio::select! {
                frame = socket.next() => match frame {
                    Some(frame) => match frame.opcode() {
                        yawc::OpCode::Text => connection.receive(String::from_utf8_lossy(frame.payload()).into_owned()),
                        yawc::OpCode::Binary => connection.close(1003, "text frames only"),
                        yawc::OpCode::Close => break,
                        _ => {}
                    },
                    None => break,
                },
                outgoing = inbox.recv() => match outgoing {
                    Some(Outgoing::Text(text)) => {
                        let bytes = text.len();
                        let sent = socket.send(yawc::Frame::text(text)).await;
                        outbox.written(bytes);
                        if sent.is_err() { break }
                    }
                    Some(Outgoing::Ping) => if socket.send(yawc::Frame::ping(Bytes::new())).await.is_err() { break },
                    Some(Outgoing::Close(code, reason)) => {
                        let _ = socket.send(yawc::Frame::close(yawc::close::CloseCode::from(code), reason)).await;
                    }
                    Some(Outgoing::Terminate) | None => break,
                },
            }
        }
        connection.dispose();
    }
}

/// `/^Bearer[ \t]+(\S{1,256})$/i` over the `Authorization` value.
fn parse_bearer(value: &str) -> Option<String> {
    let rest = value
        .get(..6)
        .filter(|scheme| scheme.eq_ignore_ascii_case("bearer"))?;
    let _ = rest;
    let after = &value[6..];
    let token = after.trim_start_matches([' ', '\t']);
    if token.len() == after.len() {
        return None;
    }
    let count = token.chars().count();
    (1..=256).contains(&count).then_some(())?;
    (!token.chars().any(auth::js_space)).then(|| token.to_owned())
}

/// The text of a webhook call's body as the routine's run is told it: one line, the first 400 characters.
fn hook_detail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut collapsed = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if auth::js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let text = collapsed.trim_matches(auth::js_space);
    if text.is_empty() {
        return "Webhook call with no body".to_owned();
    }
    let mut units = 0;
    let head: String = text
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= HOOK_DETAIL_CHARS * 2
        })
        .take(HOOK_DETAIL_CHARS)
        .collect();
    format!("Webhook call: {head}")
}

struct PushUpdate {
    /// `None` absent, `Some(None)` null.
    subscription: Option<Option<PushSubscription>>,
    hide_content: Option<bool>,
    categories: Option<Vec<String>>,
}

fn base64url_len(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `PushBody`: a `PushSubscription.toJSON()`, `hideContent`, `categories`.
fn parse_push_body(value: &serde_json::Value) -> Option<PushUpdate> {
    let object = value.as_object()?;
    let subscription = match object.get("subscription") {
        None => None,
        Some(serde_json::Value::Null) => Some(None),
        Some(raw) => {
            let raw = raw.as_object()?;
            let endpoint = raw
                .get("endpoint")?
                .as_str()
                .filter(|e| utf16_len(e) <= 2048)?;
            let keys = raw.get("keys")?.as_object()?;
            let p256dh = keys
                .get("p256dh")?
                .as_str()
                .filter(|k| base64url_len(k, 87))?;
            let auth = keys
                .get("auth")?
                .as_str()
                .filter(|k| base64url_len(k, 22))?;
            Some(Some(PushSubscription {
                endpoint: endpoint.to_owned(),
                p256dh: p256dh.to_owned(),
                auth: auth.to_owned(),
            }))
        }
    };
    let hide_content = match object.get("hideContent") {
        None => None,
        Some(serde_json::Value::Bool(flag)) => Some(*flag),
        Some(_) => return None,
    };
    let categories = match object.get("categories") {
        None => None,
        Some(serde_json::Value::Array(items)) if items.len() <= PUSH_CATEGORIES.len() => {
            let mut out = Vec::new();
            for item in items {
                let name = item.as_str().filter(|n| PUSH_CATEGORIES.contains(n))?;
                out.push(name.to_owned());
            }
            Some(out)
        }
        Some(_) => return None,
    };
    Some(PushUpdate {
        subscription,
        hide_content,
        categories,
    })
}

/// Whether a page may hand the host this URL to POST to: a push service's `https` address (a DNS name on the default
/// port, no credentials). The host sends the request, so a paired page must not aim it at a loopback, LAN or tailnet
/// address, or at an IP literal.
pub fn is_push_endpoint(raw: &str) -> bool {
    if utf16_len(raw) > 2048 {
        return false;
    }
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_lowercase) else {
        return false;
    };
    if !host.contains('.')
        || host.starts_with('[')
        || host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
    {
        return false;
    }
    let host = host.trim_end_matches('.');
    !["local", "localhost", "internal", "lan", "home", "ts.net"]
        .iter()
        .any(|suffix| host.ends_with(&format!(".{suffix}")))
}

/// A running edge; `stop` ends the accept loop, closes the sockets and waits for them.
pub struct Running {
    pub port: u16,
    stop: Arc<Notify>,
    task: Option<tokio::task::JoinHandle<()>>,
    edge: Edge,
}

impl Running {
    pub async fn stop(mut self) {
        self.stop.notify_one();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        self.edge.inner.port.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::is_push_endpoint;

    /// `push.test.ts`'s table, from when the TypeScript server checked a page's endpoint.
    #[test]
    fn a_push_endpoint_is_a_push_services_https_name() {
        for endpoint in [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/QAbc",
            "https://wns2-par02p.notify.windows.com/w/?token=abc",
        ] {
            assert!(is_push_endpoint(endpoint), "{endpoint}");
        }
        for endpoint in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://127.0.0.1/x",
            "https://192.168.1.1/x",
            "https://100.64.0.1/x",
            "https://[fd7a:115c:a1e0::1]/x",
            "https://localhost/x",
            "https://nas.local/x",
            "https://box.lan/x",
            "https://mac.tail-scale.ts.net/x",
            "https://fcm.googleapis.com:4443/x",
            "https://a:b@fcm.googleapis.com/x",
            "",
        ] {
            assert!(!is_push_endpoint(endpoint), "{endpoint}");
        }
    }
}
