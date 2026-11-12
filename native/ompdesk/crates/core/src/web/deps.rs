//! What the edge asks of the rest of the application, as plain Rust: the tailnet's `whois`, the desktop's say over a
//! new device, the schedule service's webhook, the upload and blob stores, the WebSocket router and the clock. Main
//! (or, until the cut-over, a test's fake) implements them; no core method is registered by the edge itself yet.

use std::pin::Pin;
use std::sync::Arc;

use hyper::body::Incoming;
use hyper::{HeaderMap, Request, Response};
use tokio::sync::mpsc::UnboundedSender;

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
    /// Hold a new device until the desktop approves it (Settings, off by default).
    fn confirm_new_devices(&self) -> bool;
    fn confirm(&self, details: PairingDetails) -> BoxFuture<'_, PairingOutcome>;
    /// A device was just made without asking: the desktop is told once, with the way to block it.
    fn device_connected(&self, device: &Device);
    /// A device authentication failed three times within a minute; told once.
    fn unpaired_auth(&self, address: &str);
    /// The server stops: everything still waiting is declined.
    fn decline_all(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookOutcome {
    Fired,
    Unknown,
    Denied,
    Off,
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

/// One page connection the router holds.
pub trait Connection: Send + Sync {
    fn receive(&self, text: String);
    fn close(&self, code: u16, reason: &str);
    /// The socket is gone.
    fn dispose(&self);
}

/// The WebSocket router (`ws-router.ts`; its frame handling moves in 8c). The edge checks the ticket and hands the
/// upgraded socket over.
pub trait Router: Send + Sync {
    fn connection_count(&self, device_id: &str) -> usize;
    /// The page's previous connection continues in this one.
    fn retire(&self, device_id: &str, connection_id: &str);
    /// `None` when the device has too many connections.
    fn attach(
        &self,
        device_id: &str,
        outbox: UnboundedSender<Outgoing>,
        resume_from: Option<&str>,
    ) -> Option<Box<dyn Connection>>;
    fn close_all(&self, code: u16, reason: &str);
}

/// The request's headers as the edge hands them to a store.
pub type Headers = HeaderMap;
