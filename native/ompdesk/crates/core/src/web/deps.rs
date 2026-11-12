//! What the edge asks of the rest of the application, as plain Rust: the tailnet's `whois`, the desktop's say over a
//! new device, the schedule service's webhook, the upload and blob stores, the WebSocket router and the clock. Main
//! (or, until the cut-over, a test's fake) implements them; no core method is registered by the edge itself yet.

use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use hyper::body::Incoming;
use hyper::{HeaderMap, Request, Response};
use tokio::sync::mpsc::UnboundedSender;

use super::auth::Policy;
use super::body::Out;
use super::devices::Device;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Milliseconds since the epoch; a test fixes it.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The node and user behind a tailnet address (`tailscale whois`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub node_id: Option<String>,
    pub node_name: Option<String>,
    /// `None` for a tagged node: it has no user.
    pub login: Option<String>,
}

pub trait Whois: Send + Sync {
    /// `None` when whois does not know the address or failed (a failed answer is not kept).
    fn peer(&self, address: &str) -> BoxFuture<'_, Option<Peer>>;
}

pub struct PairingDetails {
    pub name: String,
    pub user_agent: String,
    pub tailscale_login: String,
    pub ip: String,
}

pub enum PairingOutcome {
    Approved {
        grants: Vec<String>,
    },
    /// `declined` or `timeout`: the reason the page is told.
    Refused(&'static str),
}

/// The desktop's part in a new device.
pub trait Desktop: Send + Sync {
    /// Hold a new device until the desktop approves it (Settings, off by default); read when a device pairs.
    fn confirm_new_devices(&self) -> BoxFuture<'_, bool>;
    fn confirm(&self, details: PairingDetails) -> BoxFuture<'_, PairingOutcome>;
    /// A device was just made without asking: the desktop is told once, with the way to block it.
    fn device_connected(&self, device: &Device);
    /// A device authentication failed three times within a minute; told once.
    fn unpaired_auth(&self, address: &str);
    /// The server stops: everything still waiting is declined.
    fn decline_all(&self);
    /// The published address, the serve secrets and the allowed logins as they stand now (Mobile web's service and
    /// Settings own them), read for every request; `None` keeps the edge's own (`Edge::configure`).
    fn policy(&self) -> BoxFuture<'_, Option<Policy>> {
        Box::pin(async { None })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookOutcome {
    Fired,
    Unknown,
    Denied,
    Off,
    /// No schedule service runs yet: 503.
    Unavailable,
}

/// The schedule service that answers `POST /hooks/<id>`; the bearer is compared there, in constant time.
pub trait Hooks: Send + Sync {
    fn webhook(&self, id: &str, bearer: &str, detail: &str) -> BoxFuture<'_, HookOutcome>;
}

pub struct Upload {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// A refused upload: the status and the message the page reads.
pub struct UploadFailure {
    pub status: u16,
    pub message: String,
}

pub trait Uploads: Send + Sync {
    fn receive(
        &self,
        device_id: &str,
        request: Request<Incoming>,
    ) -> BoxFuture<'_, Result<Upload, UploadFailure>>;
}

pub trait Blobs: Send + Sync {
    /// The whole answer for a blob URL (`target` is the request target with the serve prefix off).
    fn serve(
        &self,
        device_id: &str,
        target: &str,
        request: Request<Incoming>,
    ) -> BoxFuture<'_, Response<Out>>;
}

/// What the router sends down a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    Text(String),
    Ping,
    Close(u16, String),
    /// Drop the connection without a close handshake.
    Terminate,
}

/// Bytes queued for a page and not yet written to its socket past which the connection closes 4408 (`ws-router.ts`
/// closed a slow consumer by `ws`'s `bufferedAmount`; the socket's queue is the edge's now).
pub const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;
pub const CLOSE_SLOW_CONSUMER: u16 = 4408;

/// The way to a page's socket: what the router sends, counted until the socket wrote it.
#[derive(Clone)]
pub struct Outbox {
    sender: UnboundedSender<Outgoing>,
    queued: Arc<AtomicUsize>,
    slow: Arc<AtomicBool>,
}

impl Outbox {
    pub fn new(sender: UnboundedSender<Outgoing>) -> Self {
        Self {
            sender,
            queued: Arc::default(),
            slow: Arc::default(),
        }
    }

    /// Queue a frame; false once the socket is gone. A text that takes the queue past `MAX_BUFFERED_BYTES` closes the
    /// connection 4408 instead, and nothing more is queued after that close.
    pub fn send(&self, outgoing: Outgoing) -> bool {
        if self.slow.load(Ordering::Acquire) {
            return false;
        }
        if let Outgoing::Text(text) = &outgoing {
            let queued = self.queued.fetch_add(text.len(), Ordering::AcqRel) + text.len();
            if queued > MAX_BUFFERED_BYTES {
                self.slow.store(true, Ordering::Release);
                return self
                    .sender
                    .send(Outgoing::Close(
                        CLOSE_SLOW_CONSUMER,
                        "slow consumer".to_owned(),
                    ))
                    .is_ok();
            }
        }
        self.sender.send(outgoing).is_ok()
    }

    /// The socket wrote a text of this many bytes.
    pub fn written(&self, bytes: usize) {
        let _ = self
            .queued
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                Some(queued.saturating_sub(bytes))
            });
    }
}

/// One page connection the router holds.
pub trait Connection: Send + Sync {
    fn receive(&self, text: String);
    fn close(&self, code: u16, reason: &str);
    /// The socket is gone.
    fn dispose(&self);
}

/// The WebSocket router (`ws-router.ts`; its frame handling moves in 8c, until then main's, reached over the pipe).
/// The edge checks the ticket and hands the upgraded socket over.
pub trait Router: Send + Sync {
    fn connection_count<'a>(&'a self, device_id: &'a str) -> BoxFuture<'a, usize>;
    /// The page's previous connection continues in this one.
    fn retire<'a>(&'a self, device_id: &'a str, connection_id: &'a str) -> BoxFuture<'a, ()>;
    /// `None` when the device has too many connections.
    fn attach<'a>(
        &'a self,
        device_id: &'a str,
        outbox: Outbox,
        resume_from: Option<&'a str>,
    ) -> BoxFuture<'a, Option<Box<dyn Connection>>>;
    fn close_all(&self, code: u16, reason: &str);
}

/// The request's headers as the edge hands them to a store.
pub type Headers = HeaderMap;
