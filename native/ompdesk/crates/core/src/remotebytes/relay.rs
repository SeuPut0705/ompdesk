//! Agent browsing for a paired device's Preview page, on the host (was the WebSocket of
//! `src/main/remote/preview-relay-tunnels.ts`). The tab's omp runs on this computer, so stock's browser relay
//! (`browser_relay_start`) listens on THIS computer's loopback, out of the device's reach; its extension socket is
//! carried over the link. Main's `PreviewRelayTunnels` remembers what each tab's bridge answered
//! (`relayExtensionUrl`: `ws://127.0.0.1:<port>/ext?token=…`, never an address a device names) and dials exactly
//! that here; this holds the socket, hands main each frame the relay sends (`remotebytes.relay`), and ends the socket
//! when main says or the relay does. A frame past the link's cap would never cross it, so it ends the socket.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use yawc::{Frame, OpCode, Options, WebSocket};

use crate::remote::codec::MAX_FRAME_BYTES;
use crate::server::{Call, Events, Fault, PushCall, Reply, Scope};

enum Command {
    Send(String),
    Close,
}

static SOCKETS: LazyLock<Mutex<HashMap<u64, mpsc::UnboundedSender<Command>>>> =
    LazyLock::new(Mutex::default);

fn sockets() -> MutexGuard<'static, HashMap<u64, mpsc::UnboundedSender<Command>>> {
    SOCKETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unavailable() -> Fault {
    Fault::new("relay_unavailable", "The browser relay did not answer")
}

#[derive(Deserialize)]
struct OpenParams {
    socket: u64,
    target: String,
}

async fn dial(target: &str) -> Option<WebSocket<TcpStream>> {
    let url = url::Url::parse(target).ok()?;
    let stream = TcpStream::connect((url.host_str()?, url.port()?))
        .await
        .ok()?;
    let _ = stream.set_nodelay(true);
    let options = Options::default().with_limits(MAX_FRAME_BYTES, 2 * MAX_FRAME_BYTES);
    WebSocket::handshake(url, stream, options).await.ok()
}

/// `remotebytes.relayOpen {socket, target}`: dials the relay; answers once its socket is open, `relay_unavailable`
/// when it did not answer or the call was cancelled first (main closed the tunnel while it opened, or gave up
/// waiting). Main hears of the socket only after this answers, so nothing else can name it before.
pub async fn open(call: Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    open_socket(
        params.socket,
        &params.target,
        &call.scope,
        call.events.clone(),
    )
    .await?;
    Reply::json(&serde_json::Value::Null)
}

async fn open_socket(id: u64, target: &str, scope: &Scope, events: Events) -> Result<(), Fault> {
    let dialed = tokio::select! {
        biased;
        () = scope.on_cancel() => None,
        socket = dial(target) => socket,
    };
    let socket = dialed.ok_or_else(unavailable)?;
    let (commands, received) = mpsc::unbounded_channel();
    sockets().insert(id, commands);
    tokio::spawn(pump(id, socket, received, events));
    Ok(())
}

/// Frames both ways until main closes the socket (it hears nothing more) or the relay ends it (main hears `close`).
async fn pump(
    id: u64,
    mut socket: WebSocket<TcpStream>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events: Events,
) {
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Send(text)) => {
                    if socket.send(Frame::text(text)).await.is_err() {
                        break;
                    }
                }
                Some(Command::Close) | None => {
                    let _ = socket.send(Frame::close(yawc::close::CloseCode::Normal, b"")).await;
                    return;
                }
            },
            frame = socket.next() => match frame {
                Some(frame) if matches!(frame.opcode(), OpCode::Text | OpCode::Binary) => {
                    let data = String::from_utf8_lossy(frame.payload()).into_owned();
                    events.send("remotebytes.relay", &json!({"socket": id, "kind": "message", "data": data}));
                }
                Some(frame) if frame.opcode() != OpCode::Close => {}
                _ => break,
            },
        }
    }
    sockets().remove(&id);
    events.send("remotebytes.relay", &json!({"socket": id, "kind": "close"}));
}

#[derive(Deserialize)]
struct SendParams {
    socket: u64,
    data: String,
}

/// `remotebytes.relaySend {socket, data}`: one text frame from the device's extension to the relay.
pub fn send(push: PushCall) {
    let Ok(params) = serde_json::from_str::<SendParams>(push.params.get()) else {
        return;
    };
    if let Some(socket) = sockets().get(&params.socket) {
        let _ = socket.send(Command::Send(params.data));
    }
}

#[derive(Deserialize)]
struct CloseParams {
    socket: u64,
}

/// `remotebytes.relayClose {socket}`: main closed the tunnel; nothing more is sent about it.
pub fn close(push: PushCall) {
    let Ok(params) = serde_json::from_str::<CloseParams>(push.params.get()) else {
        return;
    };
    if let Some(socket) = sockets().remove(&params.socket) {
        let _ = socket.send(Command::Close);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A relay that takes the connection and never answers the upgrade: a cancelled open ends at once and leaves
    /// no socket behind.
    #[tokio::test]
    async fn a_cancelled_open_ends_a_stalled_handshake_and_keeps_nothing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let held = tokio::spawn(async move { listener.accept().await.map(|(stream, _)| stream) });
        let scope = Scope::detached();
        let (events, _frames, _received) = Events::capture();
        let target = format!("ws://127.0.0.1:{port}/ext?token=abcdefghijklmnop");
        let opening = {
            let scope = scope.clone();
            tokio::spawn(async move { open_socket(901, &target, &scope, events).await })
        };
        let _stream = held.await.unwrap().unwrap();
        scope.cancel();
        let opened = tokio::time::timeout(Duration::from_secs(5), opening)
            .await
            .expect("the open ends once cancelled")
            .unwrap();
        assert_eq!(opened.unwrap_err().code, "relay_unavailable");
        assert!(!sockets().contains_key(&901));
    }

    /// Closed before it started dialing: no socket is made.
    #[tokio::test]
    async fn an_open_cancelled_before_it_dials_makes_no_socket() {
        let scope = Scope::detached();
        scope.cancel();
        let (events, _frames, _received) = Events::capture();
        let opened = open_socket(
            902,
            "ws://127.0.0.1:9/ext?token=abcdefghijklmnop",
            &scope,
            events,
        )
        .await;
        assert_eq!(opened.unwrap_err().code, "relay_unavailable");
        assert!(!sockets().contains_key(&902));
    }
}
