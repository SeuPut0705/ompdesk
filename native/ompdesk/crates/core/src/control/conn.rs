//! One connection to the control socket (was the per-connection half of `src/main/control-socket/server.ts`): it
//! frames JSON lines, makes the first line prove the token, and hands every later request to the router. Nothing here
//! knows what a request means.
//!
//! Limits: the hello within its timeout and at most 64 KiB, later lines at most `MAX_FRAME_BYTES`; at most
//! `max_in_flight` requests running, and past that, or while the connection's output backs up, nothing more is read
//! from it until a request answers or the output drains.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Waker};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::events::Sink;
use super::frame::Frame;
use super::link::Link;
use super::router::{self, Connection, Failure};
use super::{Caller, js};

pub const PROTOCOL_VERSION: f64 = 1.0;
/// A request line is at most this.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// A line before the hello is at most this: nobody unauthenticated makes the server hold megabytes.
const PRE_AUTH_FRAME_BYTES: usize = 64 * 1024;
/// How long a connection that was hung up on is kept for its client to close first.
pub const LINGER: Duration = Duration::from_secs(5);
/// Output waiting to be written past this counts as backed up (node's stream high-water mark).
const HIGH_WATER: usize = 16 * 1024;
const DEFAULT_CALLER: &str = "cli";

/// What a connection is served with.
#[derive(Clone)]
pub struct Serving {
    pub link: Arc<Link>,
    pub token: Arc<str>,
    /// Where a caller without a folder of its own starts (main's `os.homedir()`).
    pub home: Arc<str>,
    pub caller_prefix: Arc<str>,
    pub hello_timeout: Duration,
    pub max_in_flight: usize,
    /// Whether the transport can end its side and still read (a Unix socket): then a connection that was hung up on
    /// is read to its end, so the answer is never lost to a reset. A named pipe has no such half; it is closed once
    /// the answer is written, which its client reads before the end.
    pub half_close: bool,
}

enum Out {
    Line(Vec<u8>),
    End,
}

/// A connection's output: lines queued for its one writer.
pub struct Output {
    lines: mpsc::UnboundedSender<Out>,
    queued: AtomicUsize,
    /// Set when a write found the output backed up; cleared when it drained.
    blocked: AtomicBool,
    closed: AtomicBool,
    drained: Notify,
}

impl Output {
    fn end(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.lines.send(Out::End);
    }
}

impl Sink for Output {
    fn write(&self, line: String) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        let bytes = line.into_bytes();
        let queued = self.queued.fetch_add(bytes.len(), Ordering::SeqCst) + bytes.len();
        let taken = queued < HIGH_WATER;
        if !taken {
            self.blocked.store(true, Ordering::SeqCst);
        }
        if self.lines.send(Out::Line(bytes)).is_err() {
            return false;
        }
        taken
    }
}

async fn write_out<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut lines: mpsc::UnboundedReceiver<Out>,
    output: Arc<Output>,
) {
    while let Some(out) = lines.recv().await {
        match out {
            Out::Line(bytes) => {
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
                let left = output.queued.fetch_sub(bytes.len(), Ordering::SeqCst) - bytes.len();
                if left == 0 && output.blocked.swap(false, Ordering::SeqCst) {
                    output.drained.notify_one();
                }
            }
            Out::End => {
                let _ = writer.shutdown().await;
                break;
            }
        }
    }
    // Nothing more is written: whoever waits on the output goes on.
    output.closed.store(true, Ordering::SeqCst);
    output.blocked.store(false, Ordering::SeqCst);
    output.drained.notify_one();
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
struct HelloResult<'a> {
    protocol: u32,
    caller: &'a str,
}

pub fn ok_line(id: &str, result: &str) -> String {
    format!("{{\"id\":{id},\"ok\":true,\"result\":{result}}}\n")
}

pub fn error_line(id: &str, code: &str, message: &str) -> String {
    // Two strings: serializing cannot fail.
    let error = serde_json::to_string(&ErrorBody { code, message }).unwrap_or_default();
    format!("{{\"id\":{id},\"ok\":false,\"error\":{error}}}\n")
}

/// `/^[a-z0-9_-]{1,32}$/`.
fn is_caller_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}

/// The caller one connection's hello describes. The name is the process's own claim, so the id is per connection: a
/// second process that claims the same name owns nothing of the first's.
pub fn outside_caller(hello: &Frame, connection: u64, home: &str) -> Caller {
    let name = hello
        .text("caller")
        .filter(|name| is_caller_name(name))
        .unwrap_or_else(|| DEFAULT_CALLER.to_owned());
    let cwd = hello
        .text("cwd")
        .filter(|cwd| js::is_absolute(cwd) && Path::new(cwd).is_dir())
        .unwrap_or_else(|| home.to_owned());
    Caller {
        id: format!("outside:{name}#{connection}"),
        title: format!("outside process \"{name}\" (self-declared)"),
        name,
        cwd,
    }
}

/// Whether `given` is the token, in time that does not depend on where they differ.
fn token_matches(given: Option<String>, expected: &str) -> bool {
    let Some(given) = given else {
        return false;
    };
    if given.len() != expected.len() {
        return false;
    }
    given
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |differing, (a, b)| differing | (a ^ b))
        == 0
}

/// How a connection's reading ends.
enum End {
    /// Our side ends after this answer (none: the hello never came); the client is expected to close.
    HangUp(Option<String>),
    /// The client closed, or reading failed.
    Closed,
    /// The listener closed.
    Destroyed,
}

struct Conn {
    serving: Serving,
    number: u64,
    output: Arc<Output>,
    caller: Option<Arc<Caller>>,
    /// Lines read but not started yet.
    queued: VecDeque<String>,
    in_flight: usize,
    /// The bytes of the line being read.
    pending: Vec<u8>,
    requests: JoinSet<()>,
    done: mpsc::UnboundedSender<(String, Result<String, Failure>)>,
}

impl Conn {
    fn limit(&self) -> usize {
        if self.caller.is_some() {
            MAX_FRAME_BYTES
        } else {
            PRE_AUTH_FRAME_BYTES
        }
    }

    fn oversize(&self) -> Option<String> {
        Some(error_line(
            "0",
            "bad_request",
            &format!("A request line is at most {} bytes", self.limit()),
        ))
    }

    /// Takes what was read; some when the connection is hung up on, with the answer to end on.
    fn on_bytes(&mut self, chunk: &[u8]) -> Option<Option<String>> {
        let mut from = 0;
        while from < chunk.len() {
            let Some(found) = chunk[from..].iter().position(|byte| *byte == b'\n') else {
                if self.pending.len() + (chunk.len() - from) > self.limit() {
                    return Some(self.oversize());
                }
                self.pending.extend_from_slice(&chunk[from..]);
                break;
            };
            let end = from + found;
            if self.pending.len() + (end - from) > self.limit() {
                return Some(self.oversize());
            }
            self.pending.extend_from_slice(&chunk[from..end]);
            let line = String::from_utf8_lossy(&self.pending).into_owned();
            self.pending.clear();
            from = end + 1;
            if js::is_blank(&line) {
                continue;
            }
            // The hello decides the limit of every later line, so it is never queued behind anything.
            if self.caller.is_none() && self.queued.is_empty() {
                if let Some(hang_up) = self.on_line(&line) {
                    return Some(hang_up);
                }
            } else {
                self.queued.push_back(line);
            }
            if let Some(hang_up) = self.pump() {
                return Some(hang_up);
            }
        }
        None
    }

    /// Lines are taken one by one, a new one only while the cap allows (a chunk may hold many).
    fn pump(&mut self) -> Option<Option<String>> {
        while self.in_flight < self.serving.max_in_flight {
            let line = self.queued.pop_front()?;
            if let Some(hang_up) = self.on_line(&line) {
                return Some(hang_up);
            }
        }
        None
    }

    fn on_line(&mut self, line: &str) -> Option<Option<String>> {
        let frame = Frame::parse(line);
        let id = frame.as_ref().and_then(Frame::id);
        let id_or_zero = id.as_deref().unwrap_or("0");
        let method = frame.as_ref().and_then(|frame| frame.text("method"));
        let Some(caller) = &self.caller else {
            let hello = frame.filter(|_| method.as_deref() == Some("hello"));
            let Some(hello) = hello else {
                return Some(Some(error_line(
                    id_or_zero,
                    "unauthorized",
                    "The first request must be hello with the token",
                )));
            };
            if !token_matches(hello.text("token"), &self.serving.token) {
                return Some(Some(error_line(id_or_zero, "unauthorized", "Wrong token")));
            }
            if hello.number("protocol") != Some(PROTOCOL_VERSION) {
                return Some(Some(error_line(
                    id_or_zero,
                    "protocol_mismatch",
                    &format!(
                        "This OMPdesk speaks protocol {PROTOCOL_VERSION}, the client sent {}",
                        js::string_of(hello.raw("protocol"))
                    ),
                )));
            }
            let mut caller = outside_caller(&hello, self.number, &self.serving.home);
            if !self.serving.caller_prefix.is_empty() {
                caller.id = format!(
                    "outside:{}#{}{:020}",
                    caller.name, self.serving.caller_prefix, self.number
                );
            }
            let result = match serde_json::to_string(&HelloResult {
                protocol: 1,
                caller: &caller.id,
            }) {
                Ok(result) => result,
                Err(error) => {
                    return Some(Some(error_line(
                        id_or_zero,
                        "unavailable",
                        &error.to_string(),
                    )));
                }
            };
            self.caller = Some(Arc::new(caller));
            self.output.write(ok_line(id_or_zero, &result));
            return None;
        };
        let (Some(frame), Some(id), Some(method)) = (frame, id.as_ref(), method) else {
            self.output.write(error_line(
                id_or_zero,
                "bad_request",
                "A request is a JSON object with a numeric id and a method",
            ));
            return None;
        };
        if method == "hello" {
            self.output
                .write(error_line(id, "bad_request", "hello was already sent"));
            return None;
        }
        self.in_flight += 1;
        let link = Arc::clone(&self.serving.link);
        let connection = Connection {
            caller: Arc::clone(caller),
            number: self.number,
            sink: Arc::clone(&self.output) as Arc<dyn Sink>,
        };
        let done = self.done.clone();
        let id = id.clone();
        let mut request = Box::pin(async move {
            let result = router::handle(link, connection, id.clone(), frame).await;
            let _ = done.send((id, result));
        });
        // What a request does before its first wait (its ask of main) happens in line order, as the TypeScript's
        // synchronous call did; a task started by the scheduler would let a later line's ask overtake.
        if request
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
        {
            self.requests.spawn(request);
        }
        None
    }
}

async fn closed(shutdown: &mut watch::Receiver<bool>) {
    // A listener that is gone counts as closed.
    let _ = shutdown.wait_for(|closed| *closed).await;
}

/// Serves one connection until it ends, then lets its caller go.
pub async fn serve<R, W>(
    serving: Serving,
    number: u64,
    mut reader: R,
    writer: W,
    mut shutdown: watch::Receiver<bool>,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (lines, queue) = mpsc::unbounded_channel();
    let output = Arc::new(Output {
        lines,
        queued: AtomicUsize::new(0),
        blocked: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        drained: Notify::new(),
    });
    let mut writing = tokio::spawn(write_out(writer, queue, Arc::clone(&output)));
    let (done, mut answers) = mpsc::unbounded_channel();
    let mut conn = Conn {
        serving,
        number,
        output: Arc::clone(&output),
        caller: None,
        queued: VecDeque::new(),
        in_flight: 0,
        pending: Vec::new(),
        requests: JoinSet::new(),
        done,
    };
    let hello_by = Instant::now() + conn.serving.hello_timeout;
    let mut chunk = vec![0u8; 64 * 1024];
    let end = loop {
        while conn.requests.try_join_next().is_some() {}
        // Read more only while the requests running are under the cap and the answers are being taken.
        let reading =
            !output.blocked.load(Ordering::SeqCst) && conn.in_flight < conn.serving.max_in_flight;
        tokio::select! {
            biased;
            () = closed(&mut shutdown) => break End::Destroyed,
            Some((id, result)) = answers.recv() => {
                conn.in_flight -= 1;
                output.write(match result {
                    Ok(result) => ok_line(&id, &result),
                    Err(failure) => error_line(&id, failure.code, &failure.message),
                });
                if let Some(hang_up) = conn.pump() {
                    break End::HangUp(hang_up);
                }
            }
            () = output.drained.notified() => {
                if output.closed.load(Ordering::SeqCst) {
                    break End::Closed;
                }
                conn.serving.link.drained(number);
            },
            () = tokio::time::sleep_until(hello_by), if conn.caller.is_none() => break End::HangUp(None),
            read = reader.read(&mut chunk), if reading => match read {
                Ok(0) | Err(_) => break End::Closed,
                Ok(count) => {
                    if let Some(hang_up) = conn.on_bytes(&chunk[..count]) {
                        break End::HangUp(hang_up);
                    }
                }
            },
        }
    };
    // Whatever still ran is cut off, as the TypeScript's abort signal cut it: nothing more is answered.
    conn.requests.abort_all();
    while conn.requests.join_next().await.is_some() {}
    conn.serving.link.unsubscribe(number);
    if !matches!(end, End::Destroyed) {
        if let End::HangUp(Some(answer)) = end {
            output.write(answer);
        }
        // Our side ends once what is queued was written. After a hang-up the input is still taken and discarded:
        // closing on unread input would reset the connection and lose the answer. The timers are only for a client
        // that neither reads nor closes.
        output.end();
        let half_close = conn.serving.half_close;
        let ending = async {
            let _ = tokio::join!(
                tokio::time::timeout(LINGER, &mut writing),
                discard(&mut reader, &mut chunk, half_close),
            );
        };
        tokio::select! {
            () = closed(&mut shutdown) => {}
            () = ending => {}
        }
    }
    output.closed.store(true, Ordering::SeqCst);
    writing.abort();
    if let Some(caller) = conn.caller {
        conn.serving.link.release(caller);
    }
}

/// A transport without a half to end (a named pipe) shows its client our end only when it is closed, so it is closed
/// once the client sent nothing for this long: what libuv does with a pipe it shut down.
const PIPE_EOF_GRACE: Duration = Duration::from_millis(50);

/// Takes and drops input until the client closes (or, on a pipe, falls silent).
async fn discard<R: AsyncRead + Unpin>(reader: &mut R, chunk: &mut [u8], half_close: bool) {
    let drain = async {
        loop {
            let read = if half_close {
                reader.read(chunk).await
            } else {
                match tokio::time::timeout(PIPE_EOF_GRACE, reader.read(chunk)).await {
                    Ok(read) => read,
                    Err(_) => return,
                }
            };
            if !matches!(read, Ok(count) if count > 0) {
                return;
            }
        }
    };
    let _ = tokio::time::timeout(LINGER, drain).await;
}

/// Turns a connection past the cap away: one answer, then our side ends.
pub async fn turn_away<R, W>(
    mut reader: R,
    mut writer: W,
    half_close: bool,
    mut shutdown: watch::Receiver<bool>,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let answer = error_line(
        "0",
        "unavailable",
        "Too many connections to OMPdesk; try again shortly",
    );
    if writer.write_all(answer.as_bytes()).await.is_err() {
        return;
    }
    let _ = writer.shutdown().await;
    let mut chunk = vec![0u8; 4096];
    tokio::select! {
        () = closed(&mut shutdown) => {}
        () = discard(&mut reader, &mut chunk, half_close) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{Tuning, link::Ask};
    use std::io;
    use std::pin::Pin;
    use std::task::Poll;

    struct BrokenWriter;

    impl AsyncWrite for BrokenWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_output_releases_its_caller_without_waiting_for_input_eof() {
        let (asks, mut heard) = mpsc::unbounded_channel();
        let link = Link::new(Tuning::default(), move |ask| {
            let _ = asks.send(ask);
        });
        let serving = Serving {
            link,
            token: "token".into(),
            home: "/home".into(),
            caller_prefix: "".into(),
            hello_timeout: Duration::from_secs(10),
            max_in_flight: 16,
            half_close: false,
        };
        let (mut client, reader) = tokio::io::duplex(4096);
        let (_shutdown, closed) = watch::channel(false);
        let served = tokio::spawn(serve(serving, 1, reader, BrokenWriter, closed));
        client
            .write_all(b"{\"id\":1,\"method\":\"hello\",\"token\":\"token\",\"protocol\":1}\n")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), served)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(heard.recv().await, Some(Ask::Release { caller }) if caller.id == "outside:cli#1")
        );
        // `client` still owns the input: the server ended on its failed output, not an EOF.
        assert!(client.write_all(b"x").await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn requests_sent_together_reach_main_in_line_order() {
        let (asks, mut heard) = mpsc::unbounded_channel();
        let link = Link::new(Tuning::default(), move |ask| {
            let _ = asks.send(ask);
        });
        let serving = Serving {
            link,
            token: "token".into(),
            home: "/home".into(),
            caller_prefix: "".into(),
            hello_timeout: Duration::from_secs(10),
            max_in_flight: 16,
            half_close: false,
        };
        let (mut client, reader) = tokio::io::duplex(64 * 1024);
        let (_shutdown, closed) = watch::channel(false);
        let served = tokio::spawn(serve(serving, 1, reader, tokio::io::sink(), closed));
        let mut lines =
            String::from("{\"id\":1,\"method\":\"hello\",\"token\":\"token\",\"protocol\":1}\n");
        let sent: Vec<String> = (2..18).map(|id| format!("\"tool{id}\"")).collect();
        for (index, tool) in sent.iter().enumerate() {
            lines.push_str(&format!(
                "{{\"id\":{},\"method\":\"tool\",\"tool\":{tool}}}\n",
                index + 2
            ));
        }
        client.write_all(lines.as_bytes()).await.unwrap();
        let mut ran = Vec::new();
        while ran.len() < sent.len() {
            if let Some(Ask::Run { tool, .. }) = heard.recv().await {
                ran.push(tool.get().to_owned());
            }
        }
        assert_eq!(ran, sent);
        served.abort();
    }
}
