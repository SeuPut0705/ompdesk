//! App-owned MCP HTTP service. Stock omp still discovers the mounted roots and owns MCP OAuth.
//! There is no policy worker: this listener, its sessions and REA children live with the native app.

mod memory;
pub mod policy;
pub mod rea;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::convert::Infallible;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use http_body_util::BodyExt;
use hyper::body::{Body, Bytes, Frame, Incoming, SizeHint};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};

pub use rea::ReaConfig;

const SESSION_HEADER: &str = "mcp-session-id";
const HELD_MAX: usize = 1000;
const READY_WAIT: Duration = Duration::from_secs(10);

pub struct Config {
    /// Zero on a new launch. A restarted app service may ask for its previous port.
    pub port: u16,
    pub rea: ReaConfig,
    pub memory_state_file: Option<PathBuf>,
}

impl Config {
    /// Machine supplies its resolved spawn environment. The shipped REA pin remains the only version source.
    pub fn bundled(builtin_dir: &std::path::Path, user_data: &std::path::Path, env: BTreeMap<String, String>, windows: bool) -> io::Result<Self> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Pin { version: String, curated_tools: Vec<String> }
        let pin: Pin = serde_json::from_slice(&std::fs::read(builtin_dir.join("rea/rea-config.json"))?)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        Ok(Self {
            port: 0,
            rea: ReaConfig {
                command: if windows { "npx.cmd" } else { "npx" }.into(),
                args: vec!["-y".into(), format!("rea-agents@{}", pin.version), "mcp".into()],
                env,
                cache_dir: Some(user_data.join("rea")),
                version: pin.version,
                curated_tools: pin.curated_tools,
            },
            memory_state_file: Some(user_data.join("recall.json")),
        })
    }
}

struct Events {
    held: VecDeque<Bytes>,
    stream: Option<(u64, mpsc::UnboundedSender<Bytes>)>,
    generation: u64,
}

struct Session {
    rea: Arc<rea::Rea>,
    events: Mutex<Events>,
    end: watch::Sender<bool>,
}

struct Inner {
    config: Config,
    auth: String,
    cache: Arc<rea::Cache>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

/// One instance held by NativeApp, never one per page, tab or authenticated device.
/// The secret has no Debug or serialization implementation.
pub struct McpHub {
    inner: Arc<Inner>,
    port: watch::Receiver<u16>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<io::Result<()>>>>,
    restart: mpsc::UnboundedSender<oneshot::Sender<io::Result<u16>>>,
}

impl McpHub {
    pub async fn start(mut config: Config) -> io::Result<Self> {
        // Never inherit the app-only bearer through REA, including an app started inside another session.
        config.rea.env.remove("OMP_GUI_MCP_HUB_SECRET");
        let mut secret = [0; 32];
        crate::sys::random(&mut secret)?;
        let listener = tokio::time::timeout(READY_WAIT, bind(config.port))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "MCP hub did not listen in time"))??;
        let port = listener.local_addr()?.port();
        let cache = Arc::new(rea::Cache::new(&config.rea));
        let inner = Arc::new(Inner {
            config,
            auth: format!("Bearer {}", crate::hex(&secret)),
            cache,
            sessions: Mutex::new(HashMap::new()),
            tasks: Mutex::new(Vec::new()),
        });
        let (stop, stopped) = watch::channel(false);
        let (done_tx, done) = watch::channel(false);
        let (port_tx, port_rx) = watch::channel(port);
        let (restart, requested) = mpsc::unbounded_channel();
        let own = Arc::clone(&inner);
        let task = tokio::spawn(async move {
            let result = serve(own, listener, stopped, requested, port_tx).await;
            done_tx.send_replace(true);
            result
        });
        Ok(Self {
            inner,
            port: port_rx,
            stop,
            done,
            task: tokio::sync::Mutex::new(Some(task)),
            restart,
        })
    }

    pub fn port(&self) -> u16 {
        *self.port.borrow()
    }

    pub fn omp_env(&self, cwd: &str) -> BTreeMap<String, String> {
        if *self.stop.borrow() {
            return BTreeMap::new();
        }
        BTreeMap::from([
            ("OMP_GUI_MCP_HUB".into(), format!("http://127.0.0.1:{}", self.port())),
            ("OMP_GUI_MCP_AUTH".into(), self.inner.auth.clone()),
            ("OMP_GUI_MCP_CWD".into(), encode_cwd(cwd)),
        ])
    }

    /// Restarts the listener without changing the launch bearer. Existing sessions are ended and joined first.
    pub async fn restart(&self) -> io::Result<u16> {
        let (tx, rx) = oneshot::channel();
        self.restart.send(tx).map_err(|_| io::Error::other("MCP hub stopped"))?;
        rx.await.map_err(|_| io::Error::other("MCP hub stopped"))?
    }

    pub async fn shutdown(&self) -> io::Result<()> {
        self.stop.send_replace(true);
        if let Some(task) = self.task.lock().await.take() {
            task.await.map_err(io::Error::other)?
        } else {
            let mut done = self.done.clone();
            while !*done.borrow_and_update() {
                if done.changed().await.is_err() {
                    return Err(io::Error::other("MCP hub owner exited before joining"));
                }
            }
            Ok(())
        }
    }

    /// A process host passes its open stdin pipe here. EOF or a read failure shuts down and joins the service.
    pub async fn own_until(&self, mut owner: impl AsyncRead + Unpin) -> io::Result<()> {
        let mut bytes = [0; 1024];
        while owner.read(&mut bytes).await.is_ok_and(|n| n != 0) {}
        self.shutdown().await
    }
}

impl Drop for McpHub {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

fn encode_cwd(cwd: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(cwd.len());
    for byte in cwd.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

async fn bind(port: u16) -> io::Result<TcpListener> {
    match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => Ok(listener),
        Err(_) if port != 0 => TcpListener::bind(("127.0.0.1", 0)).await,
        Err(error) => Err(error),
    }
}

async fn serve(
    inner: Arc<Inner>,
    mut listener: TcpListener,
    mut stopped: watch::Receiver<bool>,
    mut restart: mpsc::UnboundedReceiver<oneshot::Sender<io::Result<u16>>>,
    port: watch::Sender<u16>,
) -> io::Result<()> {
    let mut connections = JoinSet::new();
    let result = loop {
        if *stopped.borrow() { break Ok(()); }
        tokio::select! {
            biased;
            _ = stopped.changed() => break Ok(()),
            Some(answer) = restart.recv() => {
                let previous = *port.borrow();
                drop(listener);
                connections.abort_all();
                while connections.join_next().await.is_some() {}
                inner.close_all().await;
                match bind(previous).await {
                    Ok(next) => {
                        let at = next.local_addr()?.port();
                        listener = next;
                        port.send_replace(at);
                        let _ = answer.send(Ok(at));
                    }
                    Err(error) => {
                        let _ = answer.send(Err(io::Error::new(error.kind(), error.to_string())));
                        break Err(error);
                    }
                }
            }
            accepted = listener.accept() => {
                let (socket, _) = match accepted { Ok(socket) => socket, Err(error) => break Err(error) };
                let own = Arc::clone(&inner);
                let _ = socket.set_nodelay(true);
                connections.spawn(async move {
                    let service = service_fn(move |request| {
                        let own = Arc::clone(&own);
                        async move { Ok::<_, Infallible>(own.request(request).await) }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(socket), service).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    };
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    inner.close_all().await;
    result
}

impl Inner {
    fn close(self: &Arc<Self>, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(id) {
            session.end.send_replace(true);
            session.events.lock().unwrap().stream = None;
            self.tasks.lock().unwrap().push(tokio::spawn(async move { session.rea.close().await; }));
        }
    }

    async fn close_all(self: &Arc<Self>) {
        let sessions: Vec<_> = self.sessions.lock().unwrap().drain().map(|(_, v)| v).collect();
        let mut closing = JoinSet::new();
        for session in sessions {
            session.end.send_replace(true);
            session.events.lock().unwrap().stream = None;
            closing.spawn(async move { session.rea.close().await; });
        }
        while closing.join_next().await.is_some() {}
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for task in tasks { let _ = task.await; }
    }

    fn open(self: &Arc<Self>, cwd: Option<String>) -> io::Result<(String, Arc<Session>)> {
        let mut random = [0; 16];
        crate::sys::random(&mut random)?;
        let id = crate::hex(&random);
        let (events, mut received) = mpsc::unbounded_channel::<Value>();
        let (closed, mut exited) = mpsc::unbounded_channel();
        let (end, mut ended) = watch::channel(false);
        let session = Arc::new(Session {
            rea: rea::Rea::new(self.config.rea.clone(), cwd, Arc::clone(&self.cache), events, closed),
            events: Mutex::new(Events { held: VecDeque::new(), stream: None, generation: 0 }),
            end,
        });
        self.sessions.lock().unwrap().insert(id.clone(), Arc::clone(&session));
        let own = Arc::downgrade(self);
        let target = Arc::clone(&session);
        let task_id = id.clone();
        self.tasks.lock().unwrap().push(tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    Some(message) = received.recv() => {
                        let frame = Bytes::from(format!("data: {message}\n\n"));
                        let mut state = target.events.lock().unwrap();
                        if let Some((_, stream)) = &state.stream {
                            let _ = stream.send(frame);
                        } else if state.held.len() < HELD_MAX { state.held.push_back(frame); }
                    }
                    _ = ended.changed() => break,
                    _ = exited.recv() => {
                        if let Some(own) = own.upgrade() { own.close(&task_id); }
                        break;
                    }
                }
            }
        }));
        Ok((id, session))
    }

    async fn request(self: Arc<Self>, request: Request<Incoming>) -> Response<Out> {
        let given = request.headers().get("authorization").map_or(&[][..], |value| value.as_bytes());
        if !bool::from(given.ct_eq(self.auth.as_bytes())) { return response(401, Out::empty()); }
        let (parts, body) = request.into_parts();
        let path = parts.uri.path();
        if path != "/rea" && path != "/memory" { return response(404, Out::empty()); }
        if path == "/memory" && parts.method != Method::POST { return response(405, Out::empty()); }
        let session_id = parts.headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
        if path == "/rea" {
            if parts.method == Method::DELETE {
                if let Some(id) = &session_id { self.close(id); }
                return response(200, Out::empty());
            }
            if parts.method == Method::GET {
                let Some(id) = session_id else { return response(404, Out::empty()); };
                let Some(session) = self.sessions.lock().unwrap().get(&id).cloned() else { return response(404, Out::empty()); };
                let (tx, rx) = mpsc::unbounded_channel();
                let generation = {
                    let mut state = session.events.lock().unwrap();
                    state.generation += 1;
                    let generation = state.generation;
                    let _ = tx.send(Bytes::from_static(b": open\n\n"));
                    for frame in state.held.drain(..) { let _ = tx.send(frame); }
                    state.stream = Some((generation, tx));
                    generation
                };
                let mut answer = response(200, Out::stream(rx, StreamLease { inner: Arc::downgrade(&self), id: id.clone(), generation }));
                answer.headers_mut().insert("content-type", hyper::header::HeaderValue::from_static("text/event-stream"));
                answer.headers_mut().insert("cache-control", hyper::header::HeaderValue::from_static("no-cache"));
                set_session(&mut answer, &id);
                return answer;
            }
        }
        if parts.method != Method::POST { return response(405, Out::empty()); }
        let bytes = match body.collect().await { Ok(body) => body.to_bytes(), Err(_) => return response(400, Out::empty()) };
        let message: Value = match serde_json::from_slice(&bytes) {
            Ok(message) => message,
            Err(_) => return rpc_response(400, json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})),
        };
        if path == "/memory" { return memory::post(message, &bytes, self.config.memory_state_file.as_deref()).await; }
        let (id, session) = if let Some(id) = session_id {
            let session = self.sessions.lock().unwrap().get(&id).cloned();
            let Some(session) = session else { return response(404, Out::empty()); };
            (id, session)
        } else {
            if message.get("method").and_then(Value::as_str) != Some("initialize") {
                return rpc_response(400, json!({"jsonrpc":"2.0","id":message.get("id").unwrap_or(&Value::Null),"error":{"code":-32600,"message":"Initialize a session first"}}));
            }
            let cwd = parts.uri.query().and_then(|query| url::form_urlencoded::parse(query.as_bytes()).find(|(name, _)| name == "cwd").map(|(_, value)| value.into_owned())).filter(|value| !value.is_empty());
            match self.open(cwd) { Ok(session) => session, Err(_) => return response(500, Out::empty()) }
        };
        let mut answer = match session.rea.receive(message) {
            Some(reply) => match reply.await {
                Ok(message) => rpc_response(200, message),
                Err(_) => response(503, Out::empty()),
            },
            None => response(202, Out::empty()),
        };
        set_session(&mut answer, &id);
        answer
    }
}

fn set_session(response: &mut Response<Out>, id: &str) {
    if let Ok(value) = id.parse() { response.headers_mut().insert(SESSION_HEADER, value); }
}

struct StreamLease { inner: Weak<Inner>, id: String, generation: u64 }
impl Drop for StreamLease {
    fn drop(&mut self) {
        let Some(inner) = self.inner.upgrade() else { return; };
        let session = inner.sessions.lock().unwrap().get(&self.id).cloned();
        if let Some(session) = session {
            let current = {
                let mut state = session.events.lock().unwrap();
                if state.stream.as_ref().is_some_and(|(generation, _)| *generation == self.generation) {
                    state.stream = None;
                    true
                } else { false }
            };
            if current && session.rea.running() { inner.close(&self.id); }
        }
    }
}

pub(super) struct Out {
    bytes: Option<Bytes>,
    stream: Option<mpsc::UnboundedReceiver<Bytes>>,
    _lease: Option<StreamLease>,
}
impl Out {
    fn empty() -> Self { Self::bytes(Bytes::new()) }
    fn bytes(bytes: Bytes) -> Self { Self { bytes: Some(bytes), stream: None, _lease: None } }
    fn stream(stream: mpsc::UnboundedReceiver<Bytes>, lease: StreamLease) -> Self { Self { bytes: None, stream: Some(stream), _lease: Some(lease) } }
}
impl Body for Out {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if let Some(stream) = &mut self.stream { return stream.poll_recv(cx).map(|data| data.map(|data| Ok(Frame::data(data)))); }
        Poll::Ready(self.bytes.take().filter(|bytes| !bytes.is_empty()).map(|bytes| Ok(Frame::data(bytes))))
    }
    fn is_end_stream(&self) -> bool { self.stream.is_none() && self.bytes.as_ref().is_none_or(Bytes::is_empty) }
    fn size_hint(&self) -> SizeHint { self.bytes.as_ref().map_or_else(SizeHint::default, |bytes| SizeHint::with_exact(bytes.len() as u64)) }
}
pub(super) fn response(status: u16, body: Out) -> Response<Out> {
    let mut response = Response::new(body);
    *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
    response
}
pub(super) fn rpc_response(status: u16, message: Value) -> Response<Out> {
    let mut answer = response(status, Out::bytes(Bytes::from(message.to_string())));
    answer.headers_mut().insert("content-type", hyper::header::HeaderValue::from_static("application/json"));
    answer
}

#[cfg(test)]
mod tests;
