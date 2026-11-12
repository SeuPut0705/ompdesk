//! One framed connection (was `Link` in `src/main/remote/wire.ts`). A `Conn` is a socket in its handshake: plain
//! messages pulled one at a time, encryption switched on with `secure`. `Conn::into_link` hands it to a task that
//! answers pings, drops a peer silent for `dead_ms`, and gives main every other message once main listens. Payloads
//! stay raw until delivered, so frames that arrived with the last plain message are opened under the keys installed
//! after it.
//!
//! Main holds a link by its number: `remote.send` (the message's JSON as the push's bytes), `remote.deflate`,
//! `remote.listen`, `remote.check`, `remote.close`, `remote.destroy` (pushes, in the order main sent them). The link
//! tells main `remote.message` (the JSON as the event's bytes), `remote.checked` and `remote.closed`.

use std::collections::VecDeque;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior, sleep_until};

use super::codec::{self, FrameDecoder, Incoming, Opener, Outgoing, Sealer};
use super::traffic::{Direction, LinkTraffic};
use crate::server::Events;

/// How long a graceful close waits for the peer before destroying the socket.
const CLOSE_GRACE: Duration = Duration::from_secs(1);
const PING: &[u8] = br#"{"t":"ping"}"#;
const PONG: &[u8] = br#"{"t":"pong"}"#;

/// A link's beats: a ping every `ping_ms` once it listens, dead after `dead_ms` without a frame. Tests shorten them.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Liveness {
    pub ping_ms: u64,
    pub dead_ms: u64,
}

impl Default for Liveness {
    fn default() -> Liveness {
        Liveness {
            ping_ms: 10_000,
            dead_ms: 30_000,
        }
    }
}

/// Why a link ended: the peer or the network closed it, silence, a bad frame, or this side ended it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Closed,
    Dead,
    Protocol,
    Local,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Closed => "closed",
            Reason::Dead => "dead",
            Reason::Protocol => "protocol",
            Reason::Local => "local",
        }
    }

    pub fn parse(text: &str) -> Reason {
        match text {
            "closed" => Reason::Closed,
            "dead" => Reason::Dead,
            "protocol" => Reason::Protocol,
            _ => Reason::Local,
        }
    }
}

/// Why a handshake read failed: the words `Link.receive` rejected with.
#[derive(Debug, PartialEq, Eq)]
pub enum ReceiveError {
    TimedOut,
    Closed,
}

impl ReceiveError {
    pub fn message(&self) -> &'static str {
        match self {
            ReceiveError::TimedOut => "handshake timed out",
            ReceiveError::Closed => "connection closed",
        }
    }
}

/// A socket in its handshake.
pub struct Conn {
    reader: OwnedReadHalf,
    writer: OwnedWriteHalf,
    decoder: FrameDecoder,
    pending: VecDeque<Vec<u8>>,
    /// The socket ended or a frame was bad: nothing more is read, and what is pending is all there is.
    ended: bool,
    sealer: Option<Sealer>,
    opener: Option<Opener>,
    outgoing: Outgoing,
    incoming: Incoming,
}

impl Conn {
    pub fn new(stream: TcpStream) -> Conn {
        let _ = stream.set_nodelay(true);
        let (reader, writer) = stream.into_split();
        Conn {
            reader,
            writer,
            decoder: FrameDecoder::new(),
            pending: VecDeque::new(),
            ended: false,
            sealer: None,
            opener: None,
            outgoing: Outgoing::new(),
            incoming: Incoming::new(),
        }
    }

    /// The peer's address, `::ffff:` dropped as the host's gate reads it.
    pub fn peer_ip(&self) -> String {
        let ip = self
            .reader
            .peer_addr()
            .map(|address| address.ip().to_string())
            .unwrap_or_default();
        match ip.get(..7) {
            Some(prefix) if prefix.eq_ignore_ascii_case("::ffff:") => ip[7..].to_owned(),
            _ => ip,
        }
    }

    /// Sends one message, sealed once `secure` ran. A message past the frame cap is not sent.
    pub async fn send<T: Serialize>(&mut self, message: &T) -> std::io::Result<()> {
        let json = serde_json::to_vec(message).map_err(std::io::Error::other)?;
        self.send_json(&json).await
    }

    pub async fn send_json(&mut self, json: &[u8]) -> std::io::Result<()> {
        let payload = match &mut self.sealer {
            Some(sealer) => sealer.seal(json),
            None => json.to_vec(),
        };
        let frame = codec::encode_frame(&payload)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        self.writer.write_all(&frame).await
    }

    /// Encrypt everything sent and require everything received to open from now on.
    pub fn secure(&mut self, send: &[u8; 32], receive: &[u8; 32]) {
        self.sealer = Some(Sealer::new(send));
        self.opener = Some(Opener::new(receive));
    }

    /// The next message (its JSON), within `timeout`. A frame that does not decode ends the read as the link's
    /// destroy did (`connection closed`).
    pub async fn receive(&mut self, timeout: Duration) -> Result<(Value, Vec<u8>), ReceiveError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(payload) = self.pending.pop_front() {
                let secure = self.opener.is_some();
                let decoded = match &mut self.opener {
                    Some(opener) => opener.open(&payload).ok(),
                    None => Some(payload),
                }
                .and_then(|body| {
                    self.incoming
                        .json(&body, secure)
                        .ok()
                        .map(|json| json.into_owned())
                });
                let parsed = decoded.and_then(|json| {
                    codec::message_type(&json).ok()?;
                    serde_json::from_slice::<Value>(&json)
                        .ok()
                        .map(|value| (value, json))
                });
                return match parsed {
                    Some(message) => Ok(message),
                    None => {
                        self.pending.clear();
                        self.ended = true;
                        Err(ReceiveError::Closed)
                    }
                };
            }
            if self.ended {
                return Err(ReceiveError::Closed);
            }
            let mut chunk = [0u8; 16 * 1024];
            let read = tokio::select! {
                read = self.reader.read(&mut chunk) => read,
                () = sleep_until(deadline) => return Err(ReceiveError::TimedOut),
            };
            match read {
                Ok(0) | Err(_) => self.ended = true,
                Ok(n) => match self.decoder.push(&chunk[..n]) {
                    Ok(frames) => self.pending.extend(frames),
                    Err(_) => {
                        self.pending.clear();
                        self.ended = true;
                    }
                },
            }
        }
    }

    /// Flushes what was sent and ends the socket, waiting up to a second for the peer.
    pub async fn close(mut self) {
        let _ = self.writer.shutdown().await;
        let mut sink = [0u8; 4096];
        let _ = tokio::time::timeout(CLOSE_GRACE, async {
            while matches!(self.reader.read(&mut sink).await, Ok(n) if n > 0) {}
        })
        .await;
    }

    /// Runs the link from here on. Nothing is delivered before main's `remote.listen` (or `listen` here).
    pub fn into_link(
        self,
        id: u64,
        events: Events,
        liveness: Liveness,
        options: LinkOptions,
    ) -> Link {
        let (link, receiver) = channel();
        self.run(id, events, liveness, options, receiver);
        link
    }

    /// Runs the link on commands queued before it ran (a host's link main took before its hello went out).
    pub fn run(
        self,
        id: u64,
        events: Events,
        liveness: Liveness,
        options: LinkOptions,
        receiver: mpsc::UnboundedReceiver<Command>,
    ) {
        let Conn {
            reader,
            writer,
            decoder,
            pending,
            ended,
            sealer,
            opener,
            outgoing,
            incoming,
        } = self;
        let task = Task {
            id,
            events,
            liveness,
            reader: Reader {
                reader,
                decoder,
                pending,
                ended,
                opener,
                incoming,
            },
            sender: Sender { sealer, outgoing },
            listening: options.listen,
            traffic: options.traffic,
            tap: false,
            closing: None,
            check: None,
            check_replies: Vec::new(),
            last_received: Instant::now(),
        };
        tokio::spawn(task.run(writer, receiver));
    }

    /// Turns deflating on before the link runs (the host, after its hello).
    pub fn deflate_sent(&mut self, context: bool) {
        self.outgoing.deflate(context);
    }
}

#[derive(Default)]
pub struct LinkOptions {
    /// Deliver and ping from the start (the host, whose main already holds the connection).
    pub listen: bool,
    /// Count what crosses for the traffic line (the host's device links), flushed every `every`.
    pub traffic: Option<TrafficOptions>,
}

pub struct TrafficOptions {
    pub every: Duration,
}

pub enum Command {
    Send(Vec<u8>),
    /// Tell main each frame's wire bytes from now on (`remote.wire`, and `bytes` on each message): the harnesses.
    Tap,
    Deflate {
        context: bool,
    },
    Listen,
    Check {
        window: Duration,
        /// Told whether a frame came in time (core-side callers: a reconnecting client's wake); a link that ends first
        /// drops it, which reads as not alive.
        reply: Option<oneshot::Sender<bool>>,
    },
    Close,
    Destroy(Reason),
}

/// A link's handle and the queue its task will read.
pub fn channel() -> (Link, mpsc::UnboundedReceiver<Command>) {
    let (commands, receiver) = mpsc::unbounded_channel();
    (Link { commands }, receiver)
}

/// A running link's handle.
#[derive(Clone)]
pub struct Link {
    commands: mpsc::UnboundedSender<Command>,
}

impl Link {
    pub fn command(&self, command: Command) {
        let _ = self.commands.send(command);
    }
}

#[derive(Serialize)]
struct LinkRef {
    link: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<usize>,
}

#[derive(Serialize)]
struct Wire {
    link: u64,
    tx: bool,
    bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    t: Option<&'static str>,
}

#[derive(Serialize)]
struct Closed {
    link: u64,
    reason: &'static str,
}

#[derive(Serialize)]
struct Checked {
    link: u64,
    alive: bool,
}

#[derive(Serialize)]
struct TrafficLine {
    link: u64,
    details: serde_json::Map<String, Value>,
}

/// The receiving half of a running link.
struct Reader {
    reader: OwnedReadHalf,
    decoder: FrameDecoder,
    pending: VecDeque<Vec<u8>>,
    ended: bool,
    opener: Option<Opener>,
    incoming: Incoming,
}

/// The sending half: what seals and deflates; the socket's writer is its own task.
struct Sender {
    sealer: Option<Sealer>,
    outgoing: Outgoing,
}

struct Task {
    id: u64,
    events: Events,
    liveness: Liveness,
    reader: Reader,
    sender: Sender,
    listening: bool,
    traffic: Option<TrafficOptions>,
    tap: bool,
    /// When a graceful close gives up on the peer.
    closing: Option<Instant>,
    /// When a liveness check drops the link.
    check: Option<Instant>,
    /// Who waits on the check under way, beside main's `remote.checked`.
    check_replies: Vec<oneshot::Sender<bool>>,
    last_received: Instant,
}

impl Task {
    async fn run(mut self, writer: OwnedWriteHalf, mut commands: mpsc::UnboundedReceiver<Command>) {
        let (frames, writer) = spawn_writer(writer);
        let mut traffic = self.traffic.as_ref().map(|_| LinkTraffic::new());
        let mut traffic_since = Instant::now();
        let every = self.traffic.as_ref().map(|options| options.every);
        let mut traffic_tick = every.map(|every| {
            let mut tick = tokio::time::interval_at(Instant::now() + every, every);
            tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
            tick
        });
        let ping_every = Duration::from_millis(self.liveness.ping_ms.max(1));
        let mut ping = tokio::time::interval_at(Instant::now() + ping_every, ping_every);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut frames = Some(frames);
        let mut chunk = vec![0u8; 64 * 1024];
        let reason = 'link: loop {
            if self.listening
                && let Some(reason) = self.drain(frames.as_ref(), traffic.as_mut())
            {
                break 'link reason;
            }
            let far = Instant::now() + Duration::from_secs(86_400);
            tokio::select! {
                read = self.reader.reader.read(&mut chunk), if !self.reader.ended => match read {
                    Ok(0) | Err(_) => {
                        self.reader.ended = true;
                        break 'link if self.closing.is_some() { Reason::Local } else { Reason::Closed };
                    }
                    Ok(n) => match self.reader.decoder.push(&chunk[..n]) {
                        Ok(more) => self.reader.pending.extend(more),
                        Err(_) => break 'link Reason::Protocol,
                    },
                },
                command = commands.recv() => match command {
                    None => break 'link Reason::Local,
                    Some(Command::Send(json)) => {
                        if self.closing.is_none() {
                            let bytes = send(&mut self.sender, frames.as_ref(), traffic.as_mut(), &json);
                            self.wire(true, bytes, None);
                        }
                    }
                    Some(Command::Tap) => self.tap = true,
                    Some(Command::Deflate { context }) => self.sender.outgoing.deflate(context),
                    Some(Command::Listen) => {
                        if !self.listening {
                            self.listening = true;
                            self.last_received = Instant::now();
                            ping.reset();
                        }
                    }
                    Some(Command::Check { window, reply }) => {
                        self.check_replies.extend(reply);
                        if self.check.is_none() {
                            self.check = Some(Instant::now() + window);
                            let bytes = send(&mut self.sender, frames.as_ref(), traffic.as_mut(), PING);
                            self.wire(true, bytes, Some("ping"));
                        }
                    }
                    Some(Command::Close) => {
                        if self.closing.is_none() {
                            self.closing = Some(Instant::now() + CLOSE_GRACE);
                            // The writer flushes what is queued, then ends the socket.
                            frames = None;
                        }
                    }
                    Some(Command::Destroy(reason)) => break 'link reason,
                },
                _ = ping.tick(), if self.listening => {
                    if self.last_received.elapsed() >= Duration::from_millis(self.liveness.dead_ms) {
                        break 'link Reason::Dead;
                    }
                    if self.closing.is_none() {
                        let bytes = send(&mut self.sender, frames.as_ref(), traffic.as_mut(), PING);
                        self.wire(true, bytes, Some("ping"));
                    }
                },
                () = sleep_until(self.check.unwrap_or(far)), if self.check.is_some() => break 'link Reason::Dead,
                () = sleep_until(self.closing.unwrap_or(far)), if self.closing.is_some() => break 'link Reason::Local,
                () = maybe_tick(&mut traffic_tick) => {
                    if let Some(traffic) = traffic.as_mut() {
                        self.flush_traffic(traffic, &mut traffic_since);
                    }
                },
            }
        };
        writer.abort();
        super::forget_link(self.id);
        super::link_ended(self.id, reason);
        if let Some(traffic) = traffic.as_mut() {
            self.flush_traffic(traffic, &mut traffic_since);
        }
        self.events.send(
            "remote.closed",
            &Closed {
                link: self.id,
                reason: reason.as_str(),
            },
        );
    }

    /// Delivers what is pending; `Some` when a frame was bad (the link ends `protocol`).
    fn drain(
        &mut self,
        frames: Option<&mpsc::UnboundedSender<Vec<u8>>>,
        mut traffic: Option<&mut LinkTraffic>,
    ) -> Option<Reason> {
        while let Some(payload) = self.reader.pending.pop_front() {
            let wire_bytes = payload.len() + 4;
            let secure = self.reader.opener.is_some();
            let body = match &mut self.reader.opener {
                Some(opener) => match opener.open(&payload) {
                    Ok(body) => body,
                    Err(_) => return Some(Reason::Protocol),
                },
                None => payload,
            };
            let json = match self.reader.incoming.json(&body, secure) {
                Ok(json) => json.into_owned(),
                Err(_) => return Some(Reason::Protocol),
            };
            let Ok(kind) = codec::message_type(&json) else {
                return Some(Reason::Protocol);
            };
            self.last_received = Instant::now();
            if let Some(traffic) = traffic.as_deref_mut() {
                traffic.record(Direction::Rx, &json, wire_bytes);
            }
            if self.check.take().is_some() {
                for reply in self.check_replies.drain(..) {
                    let _ = reply.send(true);
                }
                self.events.send(
                    "remote.checked",
                    &Checked {
                        link: self.id,
                        alive: true,
                    },
                );
            }
            match kind.as_str() {
                "ping" => {
                    self.wire(false, wire_bytes, Some("ping"));
                    if self.closing.is_none() {
                        let bytes = send(&mut self.sender, frames, traffic.as_deref_mut(), PONG);
                        self.wire(true, bytes, Some("pong"));
                    }
                }
                "pong" => self.wire(false, wire_bytes, Some("pong")),
                _ => self.events.send_bin(
                    "remote.message",
                    &LinkRef {
                        link: self.id,
                        bytes: self.tap.then_some(wire_bytes),
                    },
                    json,
                ),
            }
        }
        None
    }

    /// A frame's wire bytes for main's count, while tapped (`bytes` 0: nothing was sent).
    fn wire(&self, tx: bool, bytes: usize, t: Option<&'static str>) {
        if self.tap && (bytes > 0 || !tx) {
            self.events.send(
                "remote.wire",
                &Wire {
                    link: self.id,
                    tx,
                    bytes,
                    t,
                },
            );
        }
    }

    fn flush_traffic(&self, traffic: &mut LinkTraffic, since: &mut Instant) {
        let window = traffic.take();
        let now = Instant::now();
        let ms = now.duration_since(*since).as_millis() as u64;
        *since = now;
        if let Some(details) = super::traffic::details(&window, ms) {
            self.events.send(
                "remote.traffic",
                &TrafficLine {
                    link: self.id,
                    details,
                },
            );
        }
    }
}

async fn maybe_tick(tick: &mut Option<tokio::time::Interval>) {
    match tick {
        Some(tick) => {
            tick.tick().await;
        }
        None => std::future::pending().await,
    }
}

/// Seals, frames and queues one message; a message in the context joins it once queued. Answers the frame's wire
/// bytes, 0 when nothing was sent.
fn send(
    conn: &mut Sender,
    frames: Option<&mpsc::UnboundedSender<Vec<u8>>>,
    traffic: Option<&mut LinkTraffic>,
    json: &[u8],
) -> usize {
    let Some(frames) = frames else { return 0 };
    let body = match conn.outgoing.body(json) {
        Ok(body) => body,
        Err(error) => {
            eprintln!("ompdesk-core: remote link dropped a message: {error}");
            return 0;
        }
    };
    let in_context = body.in_context;
    let payload = match &mut conn.sealer {
        Some(sealer) => sealer.seal(&body.bytes),
        None => body.bytes.into_owned(),
    };
    let frame = match codec::encode_frame(&payload) {
        Ok(frame) => frame,
        Err(error) => {
            eprintln!("ompdesk-core: remote link dropped a message: {error}");
            return 0;
        }
    };
    let bytes = frame.len();
    if let Some(traffic) = traffic {
        traffic.record(Direction::Tx, json, bytes);
    }
    if frames.send(frame).is_ok() && in_context {
        conn.outgoing.commit(json);
    }
    bytes
}

fn spawn_writer(
    mut writer: OwnedWriteHalf,
) -> (mpsc::UnboundedSender<Vec<u8>>, tokio::task::JoinHandle<()>) {
    let (frames, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
    let task = tokio::spawn(async move {
        while let Some(frame) = queue.recv().await {
            if writer.write_all(&frame).await.is_err() {
                return;
            }
        }
        let _ = writer.shutdown().await;
    });
    (frames, task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Frame;
    use tokio::net::TcpListener;

    const KEY_AB: [u8; 32] = [7; 32];
    const KEY_BA: [u8; 32] = [9; 32];

    /// A link (`a`, run as main holds it) and the raw other end (`b`), sealed both ways.
    async fn pair(
        liveness: Liveness,
    ) -> (
        Link,
        Conn,
        mpsc::UnboundedReceiver<Frame>,
        mpsc::UnboundedSender<Frame>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (dialed, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
        let mut a = Conn::new(dialed.unwrap());
        let mut b = Conn::new(accepted.unwrap().0);
        a.secure(&KEY_AB, &KEY_BA);
        b.secure(&KEY_BA, &KEY_AB);
        let (events, keep, frames) = Events::capture();
        let link = a.into_link(1, events, liveness, LinkOptions::default());
        (link, b, frames, keep)
    }

    fn event(frame: &Frame) -> (Value, Option<Vec<u8>>) {
        let (head, bin) = frame.parts();
        (
            serde_json::from_slice(head).unwrap(),
            bin.map(<[u8]>::to_vec),
        )
    }

    async fn closed(frames: &mut mpsc::UnboundedReceiver<Frame>) -> String {
        loop {
            let (head, _) = event(&frames.recv().await.unwrap());
            if head["event"] == "remote.closed" {
                return head["data"]["reason"].as_str().unwrap().to_owned();
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_check_drops_a_silent_peer_when_its_window_passes_not_before() {
        let (link, _silent, mut frames, _keep) = pair(Liveness::default()).await;
        link.command(Command::Listen);
        let started = Instant::now();
        link.command(Command::Check {
            reply: None,
            window: Duration::from_millis(3_000),
        });
        assert_eq!(closed(&mut frames).await, "dead");
        let took = started.elapsed();
        assert!(
            took >= Duration::from_millis(3_000) && took < Duration::from_millis(3_100),
            "{took:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn drops_a_peer_silent_past_the_dead_timer() {
        let (link, _silent, mut frames, _keep) = pair(Liveness {
            ping_ms: 10_000,
            dead_ms: 30_000,
        })
        .await;
        let started = Instant::now();
        link.command(Command::Listen);
        assert_eq!(closed(&mut frames).await, "dead");
        // The dead check runs on the ping beat: the first beat at or past 30 s of silence.
        assert_eq!(started.elapsed().as_secs(), 30);
    }

    #[tokio::test]
    async fn answers_a_ping_and_delivers_the_rest_in_order_only_once_main_listens() {
        let (link, mut peer, mut frames, _keep) = pair(Liveness::default()).await;
        peer.send(&serde_json::json!({"t": "one"})).await.unwrap();
        peer.send(&serde_json::json!({"t": "ping"})).await.unwrap();
        peer.send(&serde_json::json!({"t": "two", "n": 2}))
            .await
            .unwrap();
        assert!(frames.try_recv().is_err(), "nothing before listen");
        link.command(Command::Listen);
        let mut got = Vec::new();
        while got.len() < 2 {
            let (head, bin) = event(&frames.recv().await.unwrap());
            assert_eq!(head["event"], "remote.message");
            got.push(String::from_utf8(bin.unwrap()).unwrap());
        }
        assert_eq!(got, [r#"{"t":"one"}"#, r#"{"t":"two","n":2}"#]);
        let (pong, _) = peer.receive(Duration::from_secs(5)).await.unwrap();
        assert_eq!(pong, serde_json::json!({"t": "pong"}));
    }

    #[tokio::test]
    async fn a_graceful_close_sends_what_was_queued_then_ends_local() {
        let (link, mut peer, mut frames, _keep) = pair(Liveness::default()).await;
        link.command(Command::Listen);
        link.command(Command::Send(br#"{"t":"last"}"#.to_vec()));
        link.command(Command::Close);
        let (last, _) = peer.receive(Duration::from_secs(5)).await.unwrap();
        assert_eq!(last, serde_json::json!({"t": "last"}));
        drop(peer);
        assert_eq!(closed(&mut frames).await, "local");
    }
}
