use super::super::deps::Peer;
use super::super::desktop::NativeDesktop;
use super::super::devices::{Devices, NewDevice, PushSettings, PushSubscription};
use super::super::pairing::Confirmations;
use super::*;
use futures_util::{SinkExt, StreamExt};
use hyper::body::Bytes;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use yawc::{Frame, Role, WebSocket};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ompdesk-native-web-{}", router::uuid()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct World {
    released: AtomicUsize,
}
impl Text for World {
    fn text(&self, key: &str, params: &[(&str, String)]) -> String {
        super::super::notification_fixture::text(key, "en", params)
    }
}
impl Host for World {
    fn active_tab(&self, _: &Invocation) -> Option<String> {
        Some("tab".into())
    }
    fn tab_facts(&self, _: &str) -> Option<TabFacts> {
        None
    }
    fn release_device<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), Fault>> {
        self.released.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}
impl Whois for World {
    fn peer(&self, _: &str) -> BoxFuture<'_, Option<Peer>> {
        Box::pin(async {
            Some(Peer {
                node_id: Some("test-node".into()),
                node_name: Some("Phone".into()),
                login: Some("owner@example.invalid".into()),
            })
        })
    }
}
impl Assets for World {
    fn root(&self) -> Option<PathBuf> {
        None
    }
    fn previous_builds(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}
impl ModelImages for World {
    fn to_model(&self, _: Value) -> BoxFuture<'_, Result<Value, Fault>> {
        Box::pin(async {
            Err(Fault::new(
                "unexpected_image",
                "JPEG should not need conversion",
            ))
        })
    }
}
impl MediaOpener for World {
    fn open<'a>(
        &'a self,
        _: &'a str,
        url: &'a str,
        range: Option<&'a str>,
    ) -> BoxFuture<'a, Option<blobs::MediaAnswer>> {
        assert_eq!(url, "omp-media://test");
        assert_eq!(range, Some("bytes=2-4"));
        Box::pin(async {
            let (tx, rx) = mpsc::channel(1);
            tx.send(Bytes::from_static(b"234")).await.unwrap();
            drop(tx);
            Some(blobs::MediaAnswer {
                status: 206,
                headers: vec![
                    ("content-type".into(), "video/mp4".into()),
                    ("content-length".into(), "3".into()),
                    ("content-range".into(), "bytes 2-4/10".into()),
                ],
                body: rx,
            })
        })
    }
}

fn config() -> router::Config {
    serde_json::from_value(json!({"channels":{"batch":"rpc:events","streams":["rpc:events"],"heavy":[],"prefsSet":"prefs:set"},"protocol":2,"features":{"push":true,"preview":true,"upload":true,"passkey":false},"policy":{
        "prefs:get":{"dir":"invoke","permission":"device-self","mode":"pass"},
        "rpc:command-for-tab":{"dir":"invoke","permission":"workspace","mode":"pass"},
        "fs:media-stream":{"dir":"invoke","permission":"workspace","mode":"transform"},
        "rpc:events":{"dir":"push","mode":"pass"},
        "mobile-web:pairing-request":{"dir":"push","mode":"transform"}
    }})).unwrap()
}

struct Harness {
    app: Arc<Application>,
    events: mpsc::UnboundedReceiver<NativeEvent>,
    port: u16,
    _frames: mpsc::UnboundedSender<crate::wire::Frame>,
    confirmations: Arc<Confirmations>,
    requests: mpsc::UnboundedReceiver<super::super::pairing::Request>,
    _world: Arc<World>,
}
impl Harness {
    async fn new(dir: &std::path::Path, confirm: bool) -> Self {
        let (events, frames, _rx) = Events::capture();
        let world = Arc::new(World {
            released: AtomicUsize::new(0),
        });
        let (tx, requests) = mpsc::unbounded_channel();
        let clock: Clock = Arc::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
        });
        let confirmations = Arc::new(Confirmations::new(
            clock.clone(),
            Arc::new(move |request| {
                let _ = tx.send(request.clone());
            }),
        ));
        let desktop = Arc::new(NativeDesktop::new(
            confirmations.clone(),
            confirm,
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        ));
        let (app, events) = Application::new(
            Config {
                user_data: dir.into(),
                static_root: None,
                router: config(),
            },
            Deps {
                events,
                clock,
                desktop,
                whois: world.clone(),
                hooks: None,
                assets: world.clone(),
                images: world.clone(),
                media: world.clone(),
                host: world.clone(),
            },
        )
        .unwrap();
        let port = app.start(0).await.unwrap();
        app.configure(Change {
            public_port: Some(port),
            serve_prefix: Some(Some(app.serve_secret().into())),
            allowed_users: Some(vec!["owner@example.invalid".into()]),
            ..Change::default()
        });
        Self {
            app,
            events,
            port,
            _frames: frames,
            confirmations,
            requests,
            _world: world,
        }
    }
    fn headers(&self, cookie: &str) -> String {
        format!(
            "host: 127.0.0.1:{}\r\norigin: http://127.0.0.1:{}\r\ntailscale-user-login: owner@example.invalid\r\nx-forwarded-for: 100.64.0.42\r\nuser-agent: NativeWebTest\r\ncookie: {cookie}\r\n",
            self.port, self.port
        )
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        content_type: &str,
        body: &[u8],
        extra: &str,
    ) -> (u16, String, Vec<u8>) {
        request(
            self.port,
            &self.headers(cookie),
            self.app.serve_secret(),
            method,
            path,
            content_type,
            body,
            extra,
        )
        .await
    }
    async fn pair(&self) -> (String, String) {
        let (status, headers, body) = self
            .request("POST", "/api/pair", "", "application/json", b"{}", "")
            .await;
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
        let cookie = headers
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
                    .map(|(_, value)| value.trim())
            })
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let body: Value = serde_json::from_slice(&body).unwrap();
        (body["deviceId"].as_str().unwrap().into(), cookie)
    }
    async fn ticket(&self, cookie: &str) -> String {
        let (status, _, body) = self
            .request(
                "POST",
                "/api/session",
                cookie,
                "application/json",
                b"{}",
                "",
            )
            .await;
        assert_eq!(status, 200);
        serde_json::from_slice::<Value>(&body).unwrap()["ticket"]
            .as_str()
            .unwrap()
            .into()
    }
    async fn socket(&self, cookie: &str, resume: Option<&str>) -> WebSocket<TcpStream> {
        let ticket = self.ticket(cookie).await;
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        let resume = resume
            .map(|id| format!(", resume.{id}"))
            .unwrap_or_default();
        let request = format!(
            "GET /{}/ws HTTP/1.1\r\n{}upgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-protocol: ompdesk.v1, ticket.{ticket}{resume}\r\n\r\n",
            self.app.serve_secret(),
            self.headers(cookie)
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        let mut byte = [0];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(stream.read(&mut byte).await.unwrap(), 1);
            head.push(byte[0]);
        }
        assert!(String::from_utf8_lossy(&head).starts_with("HTTP/1.1 101"));
        WebSocket::from_stream_with_extensions(stream, Role::Client, None, yawc::Options::default())
            .unwrap()
    }
    async fn resync(&mut self) {
        loop {
            if let NativeEvent::Resync { conn, .. } = self.events.recv().await.unwrap() {
                self.app.router.resynced(conn);
                return;
            }
        }
    }
    async fn call(&mut self) -> Pending {
        loop {
            if let NativeEvent::Call(call) = self.events.recv().await.unwrap() {
                return self.app.begin(call).expect("admitted call");
            }
        }
    }
}

async fn request(
    port: u16,
    headers: &str,
    prefix: &str,
    method: &str,
    path: &str,
    content_type: &str,
    body: &[u8],
    extra: &str,
) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "{method} /{prefix}{path} HTTP/1.1\r\n{headers}content-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let end = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, head, bytes[end + 4..].to_vec())
}
async fn frame(socket: &mut WebSocket<TcpStream>) -> Value {
    let frame = socket.next().await.unwrap();
    serde_json::from_slice(frame.payload()).unwrap()
}

#[tokio::test]
async fn native_pair_invoke_upload_media_resume_and_revoke_keep_the_phone_contract() {
    let dir = Scratch::new();
    let mut h = Harness::new(&dir.0, false).await;
    let (device, cookie) = h.pair().await;
    let mut socket = h.socket(&cookie, None).await;
    h.resync().await;
    let hello = frame(&mut socket).await;
    assert_eq!(hello["resumed"], false);
    let conn = hello["connId"].as_str().unwrap().to_owned();
    socket
        .send(Frame::text(r#"{"t":"inv","id":1,"ch":"prefs:get","a":[]}"#))
        .await
        .unwrap();
    let mut pending = h.call().await;
    h.app.land(&mut pending).await.unwrap();
    h.app
        .deliver(
            &device,
            "rpc:events",
            json!({"tabId":"tab","payload":[{"type":"agent_start"}]}),
        )
        .unwrap();
    h.app.finish(
        pending,
        Reply::json(&json!({"theme":"dark","apiKey":"private","updateToken":"private"})),
    );
    let pushed = frame(&mut socket).await;
    assert_eq!(pushed["t"], "evt");
    assert_eq!(pushed["seq"], 1);
    let response = frame(&mut socket).await;
    assert_eq!(response["v"], json!({"theme":"dark"}));
    socket
        .send(Frame::text(r#"{"t":"ack","seq":1}"#))
        .await
        .unwrap();
    let body=b"--upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nphoto-bytes\r\n--upload--\r\n";
    let (status, _, uploaded) = h
        .request(
            "POST",
            "/upload",
            &cookie,
            "multipart/form-data; boundary=upload",
            body,
            "",
        )
        .await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&uploaded));
    let uploaded: Value = serde_json::from_slice(&uploaded).unwrap();
    let command = json!({"t":"inv","id":2,"ch":"rpc:command-for-tab","a":[{"tabId":"tab","command":{"type":"prompt","images":[{"type":"image","mimeType":"image/jpeg","upload":uploaded["path"]}]}}]});
    socket.send(Frame::text(command.to_string())).await.unwrap();
    let mut pending = h.call().await;
    h.app.land(&mut pending).await.unwrap();
    assert_eq!(
        pending.args[0]["command"]["images"][0]["data"],
        "cGhvdG8tYnl0ZXM="
    );
    assert_eq!(h.app.quota.usage(&device).unwrap().requests, 1.0);
    h.app
        .finish(pending, Reply::json(&json!({"success":false})));
    frame(&mut socket).await;
    assert_eq!(h.app.quota.usage(&device).unwrap().requests, 0.0);
    assert!(
        h.app
            .payloads
            .uploads
            .take(&device, uploaded["path"].as_str().unwrap())
            .await
            .is_err()
    );
    socket
        .send(Frame::text(
            r#"{"t":"inv","id":3,"ch":"fs:media-stream","a":[]}"#,
        ))
        .await
        .unwrap();
    let pending = h.call().await;
    h.app.finish(
        pending,
        Reply::json(&json!({"ok":true,"url":"omp-media://test","mime":"video/mp4"})),
    );
    let media = frame(&mut socket).await;
    let url = media["v"]["url"].as_str().unwrap();
    assert!(url.starts_with("/blob/"));
    let (status, headers, bytes) = h
        .request(
            "GET",
            url,
            &cookie,
            "application/json",
            b"",
            "range: bytes=2-4\r\n",
        )
        .await;
    assert_eq!(status, 206);
    assert!(headers.contains("content-range: bytes 2-4/10"));
    assert_eq!(bytes, b"234");
    drop(socket);
    loop {
        if let NativeEvent::Connections { change: "end", .. } = h.events.recv().await.unwrap() {
            break;
        }
    }
    let mut socket = h.socket(&cookie, Some(&conn)).await;
    let hello = frame(&mut socket).await;
    assert_eq!(hello["resumed"], true);
    h.app.block(&device).await.unwrap();
    let closed = socket.next().await.unwrap();
    assert_eq!(closed.opcode(), yawc::OpCode::Close);
    assert_eq!(&closed.payload()[..2], &4401u16.to_be_bytes());
    assert_eq!(
        h.request(
            "POST",
            "/api/session",
            &cookie,
            "application/json",
            b"{}",
            ""
        )
        .await
        .0,
        401
    );
    assert_eq!(
        h.request("POST", "/api/pair", "", "application/json", b"{}", "")
            .await
            .0,
        403
    );
    h.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_block_added_while_approval_waits_cannot_enroll_after_the_revoke() {
    let dir = Scratch::new();
    let mut h = Harness::new(&dir.0, true).await;
    let (old, _) = h.app.stores.devices.create(
        NewDevice {
            name: "Old phone".into(),
            user_agent: "Test".into(),
            tailscale_login: Some("owner@example.invalid".into()),
            node_id: Some("test-node".into()),
            public_key: None,
            grants: DEFAULT_GRANTS.iter().map(|s| (*s).to_owned()).collect(),
        },
        1000,
    );
    let port = h.port;
    let headers = h.headers("");
    let prefix = h.app.serve_secret().to_owned();
    let pairing = tokio::spawn(async move {
        request(
            port,
            &headers,
            &prefix,
            "POST",
            "/api/pair",
            "application/json",
            b"{}",
            "",
        )
        .await
    });
    let approval = h.requests.recv().await.unwrap();
    h.app.block(&old.device_id).await.unwrap();
    assert!(h.confirmations.respond(&approval.id, true, None));
    let (status, _, body) = pairing.await.unwrap();
    assert_eq!(status, 403);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "blocked"
    );
    assert!(h.app.stores.devices.list().is_empty());
    h.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_new_vapid_key_drops_old_subscriptions_before_the_listener_answers() {
    let dir = Scratch::new();
    let devices = store::stores(&dir.0).devices.clone();
    let (device, _) = devices.create(
        NewDevice {
            name: "Phone".into(),
            user_agent: "Test".into(),
            tailscale_login: None,
            node_id: None,
            public_key: None,
            grants: Vec::new(),
        },
        1000,
    );
    devices.set_push(
        &device.device_id,
        PushSettings {
            subscription: Some(PushSubscription {
                endpoint: "https://push.example.invalid/old".into(),
                p256dh: "old".into(),
                auth: "old".into(),
            }),
            ..PushSettings::default()
        },
    );
    let h = Harness::new(&dir.0, false).await;
    assert!(
        devices
            .get(&device.device_id)
            .unwrap()
            .push
            .unwrap()
            .subscription
            .is_none()
    );
    assert!(
        !super::super::push::loaded(&dir.0)
            .unwrap()
            .public_key()
            .is_empty()
    );
    h.app.shutdown().await.unwrap();
}
