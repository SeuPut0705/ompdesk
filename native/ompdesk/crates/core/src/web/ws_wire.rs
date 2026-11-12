//! The WebSocket crate's evidence: what a phone's socket costs on the wire through the core's upgrade (yawc framing under
//! `ws`'s answer) against what `ws` 8.22 cost for the same 200 messages (captured 12 Nov 2026 with
//! `perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 } }`, the options of `server.ts`).
//!
//! The 200 messages are generated here by the same recipe the capture used (a fixed linear generator, items of JSON
//! text cut at a size cycle of 40/400/1500/60/3000 bytes); their SHA-256 is pinned, so both sides sent the same bytes.

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use http_body_util::Empty;
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use yawc::{Frame, OpCode, Role, WebSocket};

use super::ws::{self, UpgradeHeaders};

const MESSAGES_SHA256: &str = "e27c7a06e2742878bdc9afa50dbb8907cc647ec1e4d89173dac5ce4861d06db8";

fn messages() -> Vec<String> {
    let mut seed: i64 = 1;
    let mut rnd = move || {
        let next = (seed as f64 * 1_103_515_245.0 + 12_345.0) as i64 & 0x7fff_ffff;
        seed = next;
        next as f64 / 2_147_483_647.0
    };
    let sizes = [40usize, 400, 1500, 60, 3000];
    (0..200)
        .map(|i| {
            let target = sizes[i % 5];
            let mut items = Vec::new();
            let mut len = 0;
            while len < target {
                let id = (rnd() * 1e6).floor() as u64;
                let kind = ["message", "tool", "state"][(rnd() * 3.0).floor() as usize];
                let text = "lorem ipsum dolor sit amet ".repeat(1 + (rnd() * 3.0).floor() as usize);
                let item = serde_json::json!({"id": format!("item-{id}"), "kind": kind, "text": text, "n": i});
                len += item.to_string().len();
                items.push(item);
            }
            serde_json::json!({"t": "frame", "seq": i, "items": items}).to_string()
        })
        .collect()
}

#[test]
fn the_stream_is_the_one_ws_carried() {
    let all = messages();
    let mut sha = Sha256::new();
    sha.update(all.join("\n").as_bytes());
    assert_eq!(super::hex(&sha.finalize()), MESSAGES_SHA256);
    assert_eq!(all.iter().map(String::len).sum::<usize>(), 219_765);
    assert_eq!(all.iter().filter(|m| m.len() >= 1024).count(), 80);
}

/// A listener that upgrades each connection with the core's handshake and sends `send` to it, then echoes the byte
/// length and a hash of every message it receives as a text message `<len>:<sha256>`.
async fn serve(send: Vec<String>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let send = send.clone();
            tokio::spawn(async move {
                let service = service_fn(move |mut req: Request<Incoming>| {
                    let send = send.clone();
                    async move {
                        let header = |name: &str| {
                            req.headers()
                                .get(name)
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_owned)
                        };
                        let (upgrade, key, version, protocol, extensions) = (
                            header("upgrade"),
                            header("sec-websocket-key"),
                            header("sec-websocket-version"),
                            header("sec-websocket-protocol"),
                            header("sec-websocket-extensions"),
                        );
                        let verdict = ws::accept(&UpgradeHeaders {
                            method: req.method().as_str(),
                            upgrade: upgrade.as_deref(),
                            key: key.as_deref(),
                            version: version.as_deref(),
                            protocol: protocol.as_deref(),
                            extensions: extensions.as_deref(),
                        });
                        let accepted = match verdict {
                            Ok(accepted) => accepted,
                            Err(refusal) => {
                                return Ok::<_, std::convert::Infallible>(
                                    Response::builder()
                                        .status(refusal.status)
                                        .body(Empty::<Bytes>::new())
                                        .unwrap(),
                                );
                            }
                        };
                        let mut response = Response::builder()
                            .status(StatusCode::SWITCHING_PROTOCOLS)
                            .header("upgrade", "websocket")
                            .header("connection", "Upgrade")
                            .header("sec-websocket-accept", accepted.digest.as_str());
                        if let Some(protocol) = accepted.protocol {
                            response = response.header("sec-websocket-protocol", protocol);
                        }
                        if let Some(extensions) = &accepted.extensions {
                            response =
                                response.header("sec-websocket-extensions", extensions.as_str());
                        }
                        let extensions = accepted.extensions.clone();
                        tokio::spawn(async move {
                            let upgraded = hyper::upgrade::on(&mut req).await.unwrap();
                            let mut socket = WebSocket::from_stream_with_extensions(
                                TokioIo::new(upgraded),
                                Role::Server,
                                extensions.as_deref(),
                                ws::options_for(extensions.as_deref()),
                            )
                            .unwrap();
                            for message in send {
                                socket.send(Frame::text(message)).await.unwrap();
                            }
                            while let Some(frame) = socket.next().await {
                                if frame.opcode() == OpCode::Text {
                                    let mut sha = Sha256::new();
                                    sha.update(frame.payload());
                                    let echo = format!(
                                        "{}:{}",
                                        frame.payload().len(),
                                        super::hex(&sha.finalize())
                                    );
                                    socket.send(Frame::text(echo)).await.unwrap();
                                } else if frame.opcode() == OpCode::Close {
                                    break;
                                }
                            }
                        });
                        Ok(response.body(Empty::<Bytes>::new()).unwrap())
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    });
    addr
}

struct Wire {
    head: String,
    bytes: usize,
    frames: usize,
    compressed: usize,
}

/// What the server sent after its handshake answer: `count` frames read off the raw socket.
async fn capture(addr: SocketAddr, offer: Option<&str>, count: usize) -> Wire {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let extensions = offer
        .map(|o| format!("Sec-WebSocket-Extensions: {o}\r\n"))
        .unwrap_or_default();
    stream
        .write_all(
            format!(
                "GET /ws HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ompdesk.v1\r\n{extensions}\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut head_end = None;
    let (mut off, mut frames, mut compressed) = (0usize, 0usize, 0usize);
    loop {
        if head_end.is_none() {
            head_end = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
            if let Some(start) = head_end {
                off = start;
            }
        }
        if let Some(start) = head_end {
            loop {
                let rest = &buf[off..];
                if rest.len() < 2 {
                    break;
                }
                let (len, header) = match rest[1] & 0x7f {
                    126 if rest.len() >= 4 => (u16::from_be_bytes([rest[2], rest[3]]) as usize, 4),
                    126 => break,
                    127 if rest.len() >= 10 => (
                        u64::from_be_bytes(rest[2..10].try_into().unwrap()) as usize,
                        10,
                    ),
                    127 => break,
                    n => (n as usize, 2),
                };
                if rest.len() < header + len {
                    break;
                }
                frames += 1;
                if rest[0] & 0x40 != 0 {
                    compressed += 1;
                }
                off += header + len;
            }
            if frames >= count {
                let head = String::from_utf8_lossy(&buf[..start]).into_owned();
                return Wire {
                    head,
                    bytes: buf.len() - start,
                    frames,
                    compressed,
                };
            }
        }
        let n = stream.read(&mut chunk).await.unwrap();
        assert!(n > 0, "server closed early");
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn answer(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_owned())
    })
}

#[tokio::test]
async fn wire_cost_against_ws() {
    let all = messages();
    let addr = serve(all).await;
    // (offer, ws 8.22's bytes after the handshake, its frames, and how many of them carried RSV1), measured on the
    // same 200 messages.
    let cases: [(Option<&str>, usize, usize); 5] = [
        (
            Some("permessage-deflate; client_max_window_bits"),
            19_700,
            200,
        ),
        (
            Some("permessage-deflate; client_max_window_bits=15"),
            19_700,
            200,
        ),
        (
            Some("permessage-deflate; client_no_context_takeover; server_no_context_takeover"),
            52_979,
            80,
        ),
        (
            Some("permessage-deflate; server_max_window_bits=10"),
            21_185,
            200,
        ),
        (None, 220_511, 0),
    ];
    for (offer, ts_bytes, ts_compressed) in cases {
        let wire = capture(addr, offer, 200).await;
        eprintln!(
            "offer {offer:?}: answer {:?}, bytes {} (ws {ts_bytes}), frames {}, compressed {} (ws {ts_compressed})",
            answer(&wire.head, "sec-websocket-extensions"),
            wire.bytes,
            wire.frames,
            wire.compressed
        );
        assert_eq!(
            wire.compressed, ts_compressed,
            "{offer:?}: which messages are compressed"
        );
        let (low, high) = (ts_bytes as f64 * 0.97, ts_bytes as f64 * 1.03);
        assert!(
            (low..=high).contains(&(wire.bytes as f64)),
            "{offer:?}: {} bytes against ws's {ts_bytes}",
            wire.bytes
        );
    }
}
