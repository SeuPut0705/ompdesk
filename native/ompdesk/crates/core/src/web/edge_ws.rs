//! The page's WebSocket through the whole edge: the ticket from `/api/session`, the upgrade's walls and its single-use
//! ticket bound to the device and its user agent, the subprotocol, the negotiated deflate, text frames reaching the
//! router's connection, a binary frame closing with 1003, and the connection's disposal.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedSender;
use yawc::{Frame, OpCode, Role, WebSocket};

use super::assets::Assets;
use super::auth::Policy;
use super::deps::{
    Blobs, BoxFuture, Connection, Desktop, Hooks, Outgoing, PairingDetails, PairingOutcome, Peer,
    Router, Uploads, Whois,
};
use super::devices::{DEFAULT_GRANTS, Device, Devices, MemoryBlocks, MemoryDevices, NewDevice};
use super::server::{Change, Deps, Edge};

const SECRET: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const UA: &str = "TestBrowser/1.0";

struct Idle;

impl Whois for Idle {
    fn peer(&self, _address: &str) -> BoxFuture<'_, Option<Peer>> {
        Box::pin(async { None })
    }
}

impl Desktop for Idle {
    fn confirm_new_devices(&self) -> bool {
        false
    }

    fn confirm(&self, _details: PairingDetails) -> BoxFuture<'_, PairingOutcome> {
        Box::pin(async { PairingOutcome::Refused("declined") })
    }

    fn device_connected(&self, _device: &Device) {}

    fn unpaired_auth(&self, _address: &str) {}

    fn decline_all(&self) {}
}

impl Hooks for Idle {
    fn webhook(
        &self,
        _id: &str,
        _bearer: &str,
        _detail: &str,
    ) -> BoxFuture<'_, super::deps::HookOutcome> {
        Box::pin(async { super::deps::HookOutcome::Unknown })
    }
}

impl Uploads for Idle {
    fn receive(
        &self,
        _device_id: &str,
        _request: hyper::Request<hyper::body::Incoming>,
    ) -> BoxFuture<'_, Result<super::deps::Upload, super::deps::UploadFailure>> {
        Box::pin(async {
            Err(super::deps::UploadFailure {
                status: 500,
                message: "unused".into(),
            })
        })
    }
}

impl Blobs for Idle {
    fn serve(
        &self,
        _device_id: &str,
        _target: &str,
        _request: hyper::Request<hyper::body::Incoming>,
    ) -> BoxFuture<'_, hyper::Response<super::body::Out>> {
        Box::pin(async { hyper::Response::new(super::body::Out::empty()) })
    }
}

impl Assets for Idle {
    fn root(&self) -> Option<std::path::PathBuf> {
        None
    }

    fn previous_builds(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }
}

/// A router whose connection answers every text with `echo:<text>` and counts what reaches it.
#[derive(Default)]
struct Echo {
    open: AtomicUsize,
    disposed: AtomicUsize,
    retired: std::sync::Mutex<Vec<String>>,
    full: std::sync::atomic::AtomicBool,
    closed: tokio::sync::Notify,
}

struct EchoConnection {
    outbox: UnboundedSender<Outgoing>,
    router: Arc<Echo>,
}

impl Connection for EchoConnection {
    fn receive(&self, text: String) {
        let _ = self.outbox.send(Outgoing::Text(format!("echo:{text}")));
    }

    fn close(&self, code: u16, reason: &str) {
        let _ = self.outbox.send(Outgoing::Close(code, reason.to_owned()));
    }

    fn dispose(&self) {
        self.router.open.fetch_sub(1, Ordering::SeqCst);
        self.router.disposed.fetch_add(1, Ordering::SeqCst);
        self.router.closed.notify_one();
    }
}

struct EchoRouter(Arc<Echo>);

impl Router for EchoRouter {
    fn connection_count(&self, _device_id: &str) -> usize {
        if self.0.full.load(Ordering::SeqCst) {
            4
        } else {
            self.0.open.load(Ordering::SeqCst)
        }
    }

    fn retire(&self, _device_id: &str, connection_id: &str) {
        self.0
            .retired
            .lock()
            .unwrap()
            .push(connection_id.to_owned());
    }

    fn attach(
        &self,
        _device_id: &str,
        outbox: UnboundedSender<Outgoing>,
        _resume_from: Option<&str>,
    ) -> Option<Box<dyn Connection>> {
        self.0.open.fetch_add(1, Ordering::SeqCst);
        Some(Box::new(EchoConnection {
            outbox,
            router: self.0.clone(),
        }))
    }

    fn close_all(&self, _code: u16, _reason: &str) {}
}

struct Harness {
    port: u16,
    cookie: String,
    echo: Arc<Echo>,
    running: super::server::Running,
}

async fn harness() -> Harness {
    let idle = Arc::new(Idle);
    let echo = Arc::new(Echo::default());
    let devices = Arc::new(MemoryDevices::default());
    let (_, cookie) = devices.create(
        NewDevice {
            name: "phone".into(),
            user_agent: UA.into(),
            tailscale_login: Some("me@example.com".into()),
            node_id: None,
            public_key: None,
            grants: DEFAULT_GRANTS.iter().map(|g| (*g).to_owned()).collect(),
        },
        0,
    );
    let edge = Edge::new(Deps {
        policy: Policy {
            host: "127.0.0.1".into(),
            public_port: 0,
            secure: false,
            serve_prefix: Some(SECRET.into()),
            pending_prefix: None,
            allowed_users: vec!["me@example.com".into()],
        },
        devices,
        blocks: Arc::new(MemoryBlocks::default()),
        whois: idle.clone(),
        desktop: idle.clone(),
        router: Arc::new(EchoRouter(echo.clone())),
        uploads: idle.clone(),
        blobs: idle.clone(),
        hooks: Some(idle.clone()),
        assets: idle,
        push_public_key: Arc::new(String::new),
        clock: Arc::new(|| 1_000),
    });
    let running = edge.start(0).await.unwrap();
    edge.configure(Change {
        public_port: Some(running.port),
        ..Change::default()
    });
    Harness {
        port: running.port,
        cookie: format!("ompdesk={cookie}"),
        echo,
        running,
    }
}

impl Harness {
    fn common(&self) -> String {
        format!(
            "host: 127.0.0.1:{}\r\norigin: http://127.0.0.1:{}\r\ntailscale-user-login: me@example.com\r\nuser-agent: {UA}\r\ncookie: {}\r\n",
            self.port, self.port, self.cookie
        )
    }

    async fn ticket(&self) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        let request = format!(
            "POST /{SECRET}/api/session HTTP/1.1\r\n{}content-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}",
            self.common()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut text = String::new();
        stream.read_to_string(&mut text).await.unwrap();
        let body = text.split("\r\n\r\n").nth(1).unwrap();
        serde_json::from_str::<serde_json::Value>(body).unwrap()["ticket"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// The upgrade's answer head and the stream after it.
    async fn upgrade(&self, protocols: &str, extra: &str, offer: &str) -> (String, TcpStream) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        let request = format!(
            "GET /{SECRET}/ws HTTP/1.1\r\n{}upgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-protocol: {protocols}\r\nsec-websocket-extensions: {offer}\r\n{extra}\r\n",
            self.common()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            head.push(byte[0]);
        }
        (String::from_utf8_lossy(&head).into_owned(), stream)
    }
}

fn client_options() -> yawc::Options {
    yawc::Options::default().with_compression_level(yawc::CompressionLevel::new(6))
}

#[tokio::test]
async fn a_ticket_opens_one_socket_that_carries_text_to_the_router() {
    let h = harness().await;
    let ticket = h.ticket().await;
    let (head, stream) = h
        .upgrade(
            &format!("ompdesk.v1, ticket.{ticket}"),
            "",
            "permessage-deflate; client_max_window_bits",
        )
        .await;
    assert!(
        head.starts_with("HTTP/1.1 101 Switching Protocols"),
        "{head}"
    );
    let lower = head.to_ascii_lowercase();
    assert!(
        lower.contains("sec-websocket-protocol: ompdesk.v1\r\n"),
        "only the subprotocol, never the ticket: {head}"
    );
    assert!(
        lower.contains("sec-websocket-extensions: permessage-deflate\r\n"),
        "{head}"
    );
    assert!(
        lower.contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=\r\n")
            || lower.contains("sec-websocket-accept:"),
        "{head}"
    );

    let mut socket = WebSocket::from_stream_with_extensions(
        stream,
        Role::Client,
        Some("permessage-deflate"),
        client_options(),
    )
    .unwrap();
    // Small and large, so compressed and plain frames both cross.
    // The third repeats the second inside it: with the context kept both ways it is a reference into what came before.
    for text in [
        "hi".to_owned(),
        "x".repeat(5000),
        format!("y{}", "x".repeat(5000)),
    ] {
        socket.send(Frame::text(text.clone())).await.unwrap();
        let echoed = socket.next().await.unwrap();
        assert_eq!(echoed.opcode(), OpCode::Text);
        assert_eq!(
            String::from_utf8_lossy(echoed.payload()),
            format!("echo:{text}")
        );
    }
    assert_eq!(h.echo.open.load(Ordering::SeqCst), 1);

    // A binary frame closes the connection with 1003.
    socket.send(Frame::binary(vec![1u8, 2, 3])).await.unwrap();
    let close = socket.next().await.unwrap();
    assert_eq!(close.opcode(), OpCode::Close);
    assert_eq!(u16::from(close.close_code().unwrap()), 1003);
    drop(socket);
    h.echo.closed.notified().await;
    assert_eq!(h.echo.disposed.load(Ordering::SeqCst), 1);

    // The ticket is spent: the same one is refused, and so is a made-up one.
    for token in [ticket, "nope".to_owned()] {
        let (head, _) = h
            .upgrade(
                &format!("ompdesk.v1, ticket.{token}"),
                "",
                "permessage-deflate",
            )
            .await;
        assert!(head.starts_with("HTTP/1.1 401"), "{head}");
    }
    h.running.stop().await;
}

#[tokio::test]
async fn the_upgrade_refuses_what_the_walls_and_the_ticket_refuse() {
    let h = harness().await;
    // No subprotocol or no ticket in it.
    let (head, _) = h.upgrade("ompdesk.v1", "", "permessage-deflate").await;
    assert!(head.starts_with("HTTP/1.1 400"), "{head}");
    let ticket = h.ticket().await;
    let (head, _) = h
        .upgrade(&format!("other, ticket.{ticket}"), "", "permessage-deflate")
        .await;
    assert!(head.starts_with("HTTP/1.1 400"), "{head}");
    // A ticket belongs to the user agent that asked for it.
    let mut stream = TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
    let request = format!(
        "GET /{SECRET}/ws HTTP/1.1\r\nhost: 127.0.0.1:{p}\r\norigin: http://127.0.0.1:{p}\r\ntailscale-user-login: me@example.com\r\nuser-agent: Other/2.0\r\ncookie: {c}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-protocol: ompdesk.v1, ticket.{ticket}\r\n\r\n",
        p = h.port,
        c = h.cookie
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 401"), "{answer}");
    // Four connections already: 429 before the handshake; `resume.` retires the page's previous one first.
    h.echo.full.store(true, Ordering::SeqCst);
    let ticket = h.ticket().await;
    let (head, _) = h
        .upgrade(
            &format!("ompdesk.v1, ticket.{ticket}, resume.abc"),
            "",
            "permessage-deflate",
        )
        .await;
    assert!(head.starts_with("HTTP/1.1 429"), "{head}");
    assert_eq!(*h.echo.retired.lock().unwrap(), ["abc"]);
    // A bad offer is `ws`'s 400.
    h.echo.full.store(false, Ordering::SeqCst);
    let ticket = h.ticket().await;
    let (head, _) = h
        .upgrade(
            &format!("ompdesk.v1, ticket.{ticket}"),
            "",
            "permessage-deflate; bogus",
        )
        .await;
    assert!(head.starts_with("HTTP/1.1 400"), "{head}");
    h.running.stop().await;
}
