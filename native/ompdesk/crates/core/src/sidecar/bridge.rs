//! The client of the gui-bridge extension (`resources/gui-bridge`) that each omp loads with `-e` (was the socket client
//! of `src/main/bridge-client.ts`). The extension listens on the Unix socket / named pipe passed in `OMP_GUI_BRIDGE`;
//! this side connects once the omp printed `ready`. Wire: newline-delimited JSON, `{id, method, params}` out,
//! `{id, ok, result | error, code?}` and pushed `{event}` frames in.
//!
//! One task owns a connection's state, so a request never interleaves with a close. A request waits for a connect
//! that is under way and fails with its failure. `sidecar.bridge` faults: `bridge_unavailable` (not connected, closed
//! or lost: `LocalCommandError`'s code of the TypeScript), `bridge_timeout`, the bridge's own `code` verbatim, and
//! `bridge_error` for a bridge error that had no code (a plain `Error` there).

use std::collections::HashMap;
use std::future::{Future, pending};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::frames::{Frame, Lines, head_of};
use crate::fs::error::uv_code;
use crate::server::Fault;

/// How long a connect may take (`connect(timeoutMs = 3_000)`).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
type Stream = Box<dyn Io>;

/// A fresh per-spawn endpoint. macOS caps unix socket paths at 104 bytes, so the name stays short.
pub fn new_address() -> String {
    let mut random = [0u8; 4];
    // The system's generator cannot fail in practice; a zero suffix still differs by process and spawn time.
    if crate::sys::random(&mut random).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        random = nanos.to_le_bytes();
    }
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let name = format!("omp-gui-{}-{suffix}", std::process::id());
    if cfg!(windows) {
        format!("\\\\.\\pipe\\{name}")
    } else {
        std::env::temp_dir()
            .join(format!("{name}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// Removes a unix socket file the bridge left behind (named pipes vanish on their own).
pub fn remove_address(address: &str) {
    if !cfg!(windows) {
        let _ = std::fs::remove_file(address);
    }
}

/// What the connection tells its owner besides answers.
pub enum Out {
    /// A pushed `{event}` frame: its inner object, passed on as the bytes the bridge wrote.
    Event(Frame),
    /// An established connection ended.
    Lost,
}

pub type Sink = Arc<dyn Fn(Out) + Send + Sync>;

/// Why a bridge request failed: a `code` and the message.
pub type BridgeFault = Fault;

fn unavailable(message: impl Into<String>) -> Fault {
    Fault::new("bridge_unavailable", message)
}

type Reply = oneshot::Sender<Result<Option<Box<RawValue>>, Fault>>;

enum Cmd {
    Connect {
        timeout: Duration,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Request {
        method: String,
        params: Option<Box<RawValue>>,
        timeout: Option<Duration>,
        reply: Reply,
    },
    Expire(u64),
    Close,
}

/// A handle on one omp's bridge connection.
#[derive(Clone)]
pub struct Bridge {
    cmds: mpsc::UnboundedSender<Cmd>,
    connected: Arc<AtomicBool>,
}

impl Bridge {
    /// `address` is `None` for a spawn without a bridge: nothing ever connects, every request is refused.
    pub fn new(address: Option<String>, sink: Sink) -> Bridge {
        let (cmds, inbox) = mpsc::unbounded_channel();
        let connected = Arc::new(AtomicBool::new(false));
        let task = Task {
            address: address.unwrap_or_default(),
            inbox,
            self_cmds: cmds.clone(),
            connected: Arc::clone(&connected),
            sink,
            writer: None,
            pending: HashMap::new(),
            next_id: 0,
            closed: false,
        };
        tokio::spawn(task.run());
        Bridge { cmds, connected }
    }

    /// Whether the socket is open.
    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    /// Connects once; resolves when connected, fails on failure or timeout.
    pub async fn connect(&self, timeout: Duration) -> Result<(), String> {
        let (reply, answer) = oneshot::channel();
        if self.cmds.send(Cmd::Connect { timeout, reply }).is_err() {
            return Err("GUI bridge is closed".into());
        }
        answer
            .await
            .unwrap_or_else(|_| Err("GUI bridge is closed".into()))
    }

    /// `timeout`: a request the bridge has not answered by then fails (`bridge_timeout`) and is forgotten, so a frozen
    /// omp leaves no entry behind. Without it a request waits as long as the bridge takes (a user prompt, a login).
    pub async fn request(
        &self,
        method: &str,
        params: Option<Box<RawValue>>,
        timeout: Option<Duration>,
    ) -> Result<Option<Box<RawValue>>, Fault> {
        let (reply, answer) = oneshot::channel();
        let sent = self.cmds.send(Cmd::Request {
            method: method.to_owned(),
            params,
            timeout,
            reply,
        });
        if sent.is_err() {
            return Err(unavailable("GUI bridge is not connected"));
        }
        answer
            .await
            .unwrap_or_else(|_| Err(unavailable("GUI bridge closed")))
    }

    /// Closes the connection; everything waiting on it fails.
    pub fn close(&self) {
        let _ = self.cmds.send(Cmd::Close);
    }
}

struct Waiting {
    method: String,
    params: Option<Box<RawValue>>,
    timeout: Option<Duration>,
    reply: Reply,
}

struct Connecting {
    attempt: Pin<Box<dyn Future<Output = Result<Stream, String>> + Send>>,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
    /// Requests made while it ran: they go out once it succeeds and fail with its failure otherwise.
    requests: Vec<Waiting>,
}

struct InFlight {
    method: String,
    timeout_ms: u128,
    reply: Reply,
    timer: Option<JoinHandle<()>>,
}

struct Task {
    address: String,
    inbox: mpsc::UnboundedReceiver<Cmd>,
    self_cmds: mpsc::UnboundedSender<Cmd>,
    connected: Arc<AtomicBool>,
    sink: Sink,
    writer: Option<mpsc::UnboundedSender<Vec<u8>>>,
    pending: HashMap<u64, InFlight>,
    next_id: u64,
    closed: bool,
}

/// An established connection's read side, and the lines it has cut so far.
struct Reading {
    half: ReadHalf<Stream>,
    lines: Lines,
}

impl Task {
    async fn run(mut self) {
        let mut connecting: Option<Connecting> = None;
        let mut reading: Option<Reading> = None;
        let mut buffer = vec![0u8; 64 * 1024];
        while !self.closed {
            tokio::select! {
                cmd = self.inbox.recv() => {
                    let Some(cmd) = cmd else { break };
                    self.command(cmd, &mut connecting);
                }
                outcome = async {
                    match connecting.as_mut() {
                        Some(connecting) => connecting.attempt.as_mut().await,
                        None => pending().await,
                    }
                } => {
                    if let Some(done) = connecting.take() {
                        reading = self.connected_or_failed(done, outcome);
                    }
                }
                read = async {
                    match reading.as_mut() {
                        Some(reading) => reading.half.read(&mut buffer).await,
                        None => pending().await,
                    }
                } => {
                    self.read(&mut reading, &buffer, read);
                }
            }
        }
        // Closed: whatever waited fails as `close()` failed it.
        if let Some(connecting) = connecting.take() {
            for waiter in connecting.waiters {
                let _ = waiter.send(Err("GUI bridge is closed".into()));
            }
            for request in connecting.requests {
                let _ = request
                    .reply
                    .send(Err(Fault::new("bridge_error", "GUI bridge is closed")));
            }
        }
        self.connected.store(false, Ordering::Release);
        self.fail_all("GUI bridge closed");
    }

    fn command(&mut self, cmd: Cmd, connecting: &mut Option<Connecting>) {
        match cmd {
            Cmd::Close => self.closed = true,
            Cmd::Expire(id) => {
                if let Some(entry) = self.pending.remove(&id) {
                    let message = format!(
                        "GUI bridge did not answer {} within {}ms",
                        entry.method, entry.timeout_ms
                    );
                    let _ = entry.reply.send(Err(Fault::new("bridge_timeout", message)));
                }
            }
            Cmd::Connect { timeout, reply } => {
                if self.writer.is_some() {
                    let _ = reply.send(Ok(()));
                } else if let Some(connecting) = connecting {
                    connecting.waiters.push(reply);
                } else {
                    let address = self.address.clone();
                    *connecting = Some(Connecting {
                        attempt: Box::pin(connect(address, timeout)),
                        waiters: vec![reply],
                        requests: Vec::new(),
                    });
                }
            }
            Cmd::Request {
                method,
                params,
                timeout,
                reply,
            } => {
                let waiting = Waiting {
                    method,
                    params,
                    timeout,
                    reply,
                };
                match connecting {
                    Some(connecting) => connecting.requests.push(waiting),
                    None => self.send(waiting),
                }
            }
        }
    }

    fn connected_or_failed(
        &mut self,
        done: Connecting,
        outcome: Result<Stream, String>,
    ) -> Option<Reading> {
        match outcome {
            Ok(stream) => {
                let (half, mut write) = tokio::io::split(stream);
                let (writer, mut lines) = mpsc::unbounded_channel::<Vec<u8>>();
                // Its own task: a request larger than the socket's buffer never holds the reads behind it.
                tokio::spawn(async move {
                    while let Some(line) = lines.recv().await {
                        if write.write_all(&line).await.is_err() {
                            break;
                        }
                    }
                });
                self.writer = Some(writer);
                self.connected.store(true, Ordering::Release);
                for waiter in done.waiters {
                    let _ = waiter.send(Ok(()));
                }
                for request in done.requests {
                    self.send(request);
                }
                Some(Reading {
                    half,
                    lines: Lines::default(),
                })
            }
            Err(message) => {
                for waiter in done.waiters {
                    let _ = waiter.send(Err(message.clone()));
                }
                for request in done.requests {
                    let _ = request
                        .reply
                        .send(Err(Fault::new("bridge_error", message.clone())));
                }
                None
            }
        }
    }

    fn send(&mut self, waiting: Waiting) {
        let Some(writer) = self.writer.as_ref() else {
            let _ = waiting
                .reply
                .send(Err(unavailable("GUI bridge is not connected")));
            return;
        };
        self.next_id += 1;
        let id = self.next_id;
        // A string always serializes.
        let method = serde_json::to_string(&waiting.method).unwrap_or_default();
        let mut line = format!("{{\"id\":{id},\"method\":{method}");
        if let Some(params) = &waiting.params {
            line.push_str(",\"params\":");
            line.push_str(params.get());
        }
        line.push_str("}\n");
        if writer.send(line.into_bytes()).is_err() {
            let _ = waiting
                .reply
                .send(Err(unavailable("GUI bridge is not connected")));
            return;
        }
        let timer = waiting.timeout.map(|timeout| {
            let cmds = self.self_cmds.clone();
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                let _ = cmds.send(Cmd::Expire(id));
            })
        });
        self.pending.insert(
            id,
            InFlight {
                method: waiting.method,
                timeout_ms: waiting.timeout.map_or(0, |t| t.as_millis()),
                reply: waiting.reply,
                timer,
            },
        );
    }

    fn read(&mut self, reading: &mut Option<Reading>, buffer: &[u8], read: std::io::Result<usize>) {
        match read {
            Ok(n) if n > 0 => {
                let Some(state) = reading.as_mut() else {
                    return;
                };
                let mut lines = Vec::new();
                state
                    .lines
                    .push(&buffer[..n], |line| lines.push(line.to_vec()));
                for line in lines {
                    self.frame(&line);
                }
            }
            Ok(_) => self.lost(reading, "GUI bridge disconnected".into()),
            Err(error) => self.lost(reading, format!("{} {error}", uv_code(&error))),
        }
    }

    fn lost(&mut self, reading: &mut Option<Reading>, reason: String) {
        *reading = None;
        self.writer = None;
        self.connected.store(false, Ordering::Release);
        self.fail_all(&reason);
        (self.sink)(Out::Lost);
    }

    fn fail_all(&mut self, reason: &str) {
        for (_, entry) in self.pending.drain() {
            if let Some(timer) = entry.timer {
                timer.abort();
            }
            let _ = entry.reply.send(Err(unavailable(reason)));
        }
    }

    fn frame(&mut self, line: &[u8]) {
        let text = String::from_utf8_lossy(line);
        if text.trim().is_empty() {
            return;
        }
        let Ok(frame) =
            serde_json::from_str::<std::collections::BTreeMap<String, &RawValue>>(&text)
        else {
            return;
        };
        if let Some(event) = frame.get("event") {
            // An event is an object with a string `type`; anything else under `event` is ignored.
            if head_of(event.get()).is_some_and(|(ty, _)| ty.is_some())
                && let Some(frame) = Frame::from_json(event.get())
            {
                (self.sink)(Out::Event(frame));
            }
            return;
        }
        let Some(id) = frame
            .get("id")
            .and_then(|id| serde_json::from_str::<f64>(id.get()).ok())
            .filter(|id| id.fract() == 0.0 && *id >= 0.0)
        else {
            return;
        };
        let Some(entry) = self.pending.remove(&(id as u64)) else {
            return;
        };
        if let Some(timer) = entry.timer {
            timer.abort();
        }
        let ok = frame
            .get("ok")
            .is_some_and(|ok| serde_json::from_str::<bool>(ok.get()).unwrap_or(false));
        if ok {
            let result = frame
                .get("result")
                .and_then(|raw| RawValue::from_string(raw.get().to_owned()).ok());
            let _ = entry.reply.send(Ok(result));
            return;
        }
        let message = frame
            .get("error")
            .and_then(|e| serde_json::from_str::<String>(e.get()).ok())
            .unwrap_or_else(|| "GUI bridge error".into());
        // The bridge codes failures the GUI can explain (`unsupported_omp`: a missing omp internal).
        let fault = match frame
            .get("code")
            .and_then(|c| serde_json::from_str::<String>(c.get()).ok())
        {
            Some(code) => Fault::new(code, message),
            None => Fault::new("bridge_error", message),
        };
        let _ = entry.reply.send(Err(fault));
    }
}

#[cfg(unix)]
async fn open(address: &str) -> std::io::Result<Stream> {
    Ok(Box::new(tokio::net::UnixStream::connect(address).await?))
}

#[cfg(windows)]
async fn open(address: &str) -> std::io::Result<Stream> {
    use tokio::net::windows::named_pipe::ClientOptions;
    /// ERROR_PIPE_BUSY: every instance of the pipe is in use; libuv waits for one, so does this.
    const PIPE_BUSY: i32 = 231;
    loop {
        match ClientOptions::new().open(address) {
            Ok(client) => return Ok(Box::new(client)),
            Err(error) if error.raw_os_error() == Some(PIPE_BUSY) => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// One attempt, with the deadline `connect(timeoutMs)` gave it.
async fn connect(address: String, timeout: Duration) -> Result<Stream, String> {
    match tokio::time::timeout(timeout, open(&address)).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => Err(format!("connect {} {address}", uv_code(&error))),
        Err(_) => Err(format!(
            "GUI bridge did not accept a connection within {}ms",
            timeout.as_millis()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A stand-in for resources/gui-bridge: answers `echo`, fails `boom` (coded for `old`), pushes one event per
    /// connection, never answers `silent` and splits the reply of `split`.
    async fn serve(stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static) {
        let (read, mut write) = tokio::io::split(stream);
        let event = "{\"event\":{\"type\":\"btw_delta\",\"text\":\"hi\"}}\n";
        if write.write_all(event.as_bytes()).await.is_err() {
            return;
        }
        let mut read = tokio::io::BufReader::new(read);
        let mut line = String::new();
        use tokio::io::AsyncBufReadExt;
        while let Ok(n) = read.read_line(&mut line).await {
            if n == 0 {
                break;
            }
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            line.clear();
            let id = request["id"].clone();
            let method = request["method"].as_str().unwrap();
            let reply = match method {
                "silent" => continue,
                "split" => {
                    let big = format!(
                        "{}\n",
                        serde_json::json!({ "id": id, "ok": true, "result": "x".repeat(200_000) })
                    );
                    let events = format!(
                        "{}{}{}\n{}\n",
                        &big[150_000..],
                        "",
                        "{\"event\":{\"type\":\"btw_delta\",\"text\":\"a\"}}",
                        "{\"event\":{\"type\":\"btw_delta\",\"text\":\"b\"}}"
                    );
                    write.write_all(&big.as_bytes()[..7]).await.unwrap();
                    write.flush().await.unwrap();
                    write.write_all(&big.as_bytes()[7..150_000]).await.unwrap();
                    write.flush().await.unwrap();
                    write.write_all(events.as_bytes()).await.unwrap();
                    continue;
                }
                "echo" => serde_json::json!({ "id": id, "ok": true, "result": request["params"] }),
                "old" => serde_json::json!({
                    "id": id, "ok": false, "error": "Plan mode is unavailable", "code": "unsupported_omp",
                }),
                "drop" => break,
                other => {
                    serde_json::json!({ "id": id, "ok": false, "error": format!("bad {other}") })
                }
            };
            write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
        }
    }

    #[cfg(unix)]
    fn listen(address: &str) {
        let listener = tokio::net::UnixListener::bind(address).unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream));
            }
        });
    }

    #[cfg(windows)]
    fn listen(address: &str) {
        use tokio::net::windows::named_pipe::ServerOptions;
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(address)
            .unwrap();
        let address = address.to_owned();
        tokio::spawn(async move {
            loop {
                if server.connect().await.is_err() {
                    break;
                }
                let next = ServerOptions::new().create(&address).unwrap();
                tokio::spawn(serve(std::mem::replace(&mut server, next)));
            }
        });
    }

    type Events = Arc<Mutex<Vec<String>>>;

    fn bridge_at(address: &str) -> (Bridge, Events, Arc<AtomicBool>) {
        let events: Events = Arc::default();
        let lost = Arc::new(AtomicBool::new(false));
        let (seen, gone) = (Arc::clone(&events), Arc::clone(&lost));
        let sink: Sink = Arc::new(move |out| match out {
            Out::Event(frame) => seen.lock().unwrap().push(frame.text().into_owned()),
            Out::Lost => gone.store(true, Ordering::SeqCst),
        });
        (Bridge::new(Some(address.to_owned()), sink), events, lost)
    }

    fn raw(json: &str) -> Option<Box<RawValue>> {
        Some(RawValue::from_string(json.to_owned()).unwrap())
    }

    fn text(answer: Result<Option<Box<RawValue>>, Fault>) -> Result<String, (String, String)> {
        answer
            .map(|raw| raw.map_or_else(|| "undefined".into(), |raw| raw.get().to_owned()))
            .map_err(|fault| (fault.code.into_owned(), fault.message))
    }

    #[tokio::test]
    async fn rejects_a_request_the_bridge_never_answers_once_its_timeout_passes_and_keeps_serving_the_others()
     {
        let address = new_address();
        listen(&address);
        let (bridge, _, _) = bridge_at(&address);
        bridge.connect(CONNECT_TIMEOUT).await.unwrap();
        let silent = bridge
            .request("silent", None, Some(Duration::from_millis(40)))
            .await;
        let (code, message) = text(silent).unwrap_err();
        assert_eq!(code, "bridge_timeout");
        assert_eq!(message, "GUI bridge did not answer silent within 40ms");
        assert_eq!(
            text(bridge.request("echo", raw("7"), None).await),
            Ok("7".into())
        );
        bridge.close();
        remove_address(&address);
    }

    #[tokio::test]
    async fn correlates_requests_surfaces_bridge_errors_and_delivers_pushed_events() {
        let address = new_address();
        listen(&address);
        let (bridge, events, _) = bridge_at(&address);
        bridge.connect(CONNECT_TIMEOUT).await.unwrap();
        assert!(bridge.connected());

        assert_eq!(
            text(bridge.request("echo", raw("{\"n\":1}"), None).await),
            Ok("{\"n\":1}".into())
        );
        assert_eq!(
            text(bridge.request("boom", None, None).await),
            Err(("bridge_error".into(), "bad boom".into()))
        );
        assert_eq!(
            text(bridge.request("old", None, None).await),
            Err(("unsupported_omp".into(), "Plan mode is unavailable".into()))
        );
        assert_eq!(
            events.lock().unwrap().as_slice(),
            ["{\"type\":\"btw_delta\",\"text\":\"hi\"}"]
        );

        bridge.close();
        // The close is the task's: wait until the handle sees it.
        for _ in 0..200 {
            if !bridge.connected() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!bridge.connected());
        assert_eq!(
            text(bridge.request("echo", None, None).await),
            Err((
                "bridge_unavailable".into(),
                "GUI bridge is not connected".into()
            ))
        );
        remove_address(&address);
    }

    #[tokio::test]
    async fn reassembles_a_reply_split_across_writes_and_frames_sharing_one_write() {
        let address = new_address();
        listen(&address);
        let (bridge, events, _) = bridge_at(&address);
        bridge.connect(CONNECT_TIMEOUT).await.unwrap();
        let split = text(bridge.request("split", None, None).await).unwrap();
        assert_eq!(split.len(), 200_002);
        assert_eq!(
            text(bridge.request("echo", raw("1"), None).await),
            Ok("1".into())
        );
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [
                "{\"type\":\"btw_delta\",\"text\":\"hi\"}",
                "{\"type\":\"btw_delta\",\"text\":\"a\"}",
                "{\"type\":\"btw_delta\",\"text\":\"b\"}",
            ]
        );
        bridge.close();
        remove_address(&address);
    }

    #[tokio::test]
    async fn rejects_requests_when_no_bridge_ever_listened() {
        let (bridge, _, _) = bridge_at(&new_address());
        assert!(bridge.connect(Duration::from_millis(500)).await.is_err());
        assert!(!bridge.connected());
        assert_eq!(
            text(bridge.request("capabilities", None, None).await),
            Err((
                "bridge_unavailable".into(),
                "GUI bridge is not connected".into()
            ))
        );
        // A spawn without a bridge has no address at all.
        let none = Bridge::new(None, Arc::new(|_| {}));
        assert!(none.connect(Duration::from_millis(500)).await.is_err());
    }

    #[tokio::test]
    async fn closed_before_connecting_it_fails_the_connect_and_refuses_the_next() {
        let (bridge, _, _) = bridge_at(&new_address());
        let connecting = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.connect(Duration::from_secs(30)).await })
        };
        bridge.close();
        // The attempt either failed on its own (nothing listens) or was cancelled by the close: never connected.
        assert!(connecting.await.unwrap().is_err());
        assert!(!bridge.connected());
        assert_eq!(
            bridge.connect(CONNECT_TIMEOUT).await,
            Err("GUI bridge is closed".into())
        );
    }

    #[tokio::test]
    async fn fails_outstanding_requests_when_an_established_connection_ends() {
        let address = new_address();
        listen(&address);
        let (bridge, _, lost) = bridge_at(&address);
        bridge.connect(CONNECT_TIMEOUT).await.unwrap();
        // The stand-in ends the connection on `drop`.
        let failed = bridge.request("drop", None, None).await;
        let (code, message) = text(failed).unwrap_err();
        assert_eq!(code, "bridge_unavailable");
        assert_eq!(message, "GUI bridge disconnected");
        assert!(!bridge.connected());
        for _ in 0..200 {
            if lost.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(lost.load(Ordering::SeqCst), "the loss was never told");
        bridge.close();
        remove_address(&address);
    }

    #[tokio::test]
    async fn a_request_made_while_connecting_waits_for_the_connect() {
        let address = new_address();
        let (bridge, _, _) = bridge_at(&address);
        let connecting = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.connect(Duration::from_secs(5)).await })
        };
        // The first attempt may fail at once (nothing listens yet), so listen first and retry through a new call.
        listen(&address);
        let first = connecting.await.unwrap();
        if first.is_err() {
            bridge.connect(Duration::from_secs(5)).await.unwrap();
        }
        assert_eq!(
            text(bridge.request("echo", raw("3"), None).await),
            Ok("3".into())
        );
        bridge.close();
        remove_address(&address);
    }

    #[test]
    fn makes_a_short_address_of_its_own_each_time() {
        let (a, b) = (new_address(), new_address());
        assert_ne!(a, b);
        let pid = std::process::id();
        if cfg!(windows) {
            assert!(
                a.starts_with(&format!("\\\\.\\pipe\\omp-gui-{pid}-")),
                "{a}"
            );
        } else {
            assert!(
                a.contains(&format!("omp-gui-{pid}-")) && a.ends_with(".sock"),
                "{a}"
            );
            assert!(a.len() < 104);
        }
    }
}
