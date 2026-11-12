//! The request matrix captured from the TypeScript server (`src/main/web/web-edge-matrix.test.ts` writes
//! `matrix.json`) replayed against the Rust edge: the same requests over a raw socket, a fixed clock, the same seeded
//! devices and blocks, the same fakes. Every row must answer with the same status, the same headers in the same order
//! (names compared without case; `Date`, `Connection` and `Keep-Alive` are not compared, see `KNOWN_DIFFERENCES` for
//! the rest) and the same body SHA-256, and have the same effects on the fakes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::{Request, Response};
use p256::ecdsa::signature::Signer as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::assets::Assets;
use super::auth::{Policy, base64url, lenient_base64};
use super::body::Out;
use super::deps::{
    Blobs, BoxFuture, Connection, Desktop, HookOutcome, Hooks, PairingDetails, PairingOutcome,
    Peer, Router, Upload, UploadFailure, Uploads, Whois,
};
use super::devices::{DEFAULT_GRANTS, Device, MemoryBlocks, MemoryDevices};
use super::hex;
use super::server::{Deps, Edge};

const MATRIX: &str = include_str!("matrix.json");

#[derive(Deserialize)]
struct Matrix {
    fixtures: Fixtures,
    rows: Vec<Row>,
}

#[derive(Deserialize)]
struct Fixtures {
    now: i64,
    allowed: Vec<String>,
    #[serde(rename = "deviceKey")]
    device_key: serde_json::Value,
    devices: serde_json::Value,
    blocked: serde_json::Value,
    whois: HashMap<String, WhoisEntry>,
}

#[derive(Deserialize, Clone)]
struct WhoisEntry {
    #[serde(rename = "nodeId")]
    node_id: Option<String>,
    #[serde(rename = "nodeName")]
    node_name: Option<String>,
    login: Option<String>,
}

#[derive(Deserialize)]
struct PolicyRow {
    host: String,
    #[serde(rename = "publicPort")]
    public_port: u16,
    secure: bool,
    #[serde(rename = "servePrefix")]
    serve_prefix: Option<String>,
    #[serde(rename = "pendingPrefix")]
    pending_prefix: Option<String>,
}

#[derive(Deserialize)]
struct RequestRow {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    #[serde(default)]
    templated: bool,
    repeat: Option<usize>,
    #[serde(default, rename = "distinctIp")]
    distinct_ip: bool,
}

#[derive(Deserialize, PartialEq, Debug, Clone)]
struct AnswerRow {
    status: u16,
    headers: Vec<(String, String)>,
    #[serde(rename = "bodyLen")]
    body_len: usize,
    #[serde(rename = "bodySha256")]
    body_sha256: String,
}

#[derive(Deserialize, PartialEq, Debug, Default, Clone)]
struct Effects {
    unpaired: usize,
    connected: usize,
    hooks: Vec<Vec<String>>,
    uploads: Vec<String>,
    blobs: Vec<String>,
}

#[derive(Deserialize)]
struct Row {
    id: String,
    policy: PolicyRow,
    blocks: bool,
    confirm: Option<String>,
    #[serde(default, rename = "noRoot")]
    no_root: bool,
    requests: Vec<RequestRow>,
    answers: Vec<AnswerRow>,
    effects: Effects,
}

/// Rows whose answer is known to differ, by id prefix, with the reason; a row listed here that now matches fails.
const KNOWN_DIFFERENCES: &[(&str, &str)] = &[];

struct Recorder {
    effects: Mutex<Effects>,
}

struct Fakes {
    recorder: Arc<Recorder>,
    whois: HashMap<String, WhoisEntry>,
    confirm: Option<String>,
    root: Option<PathBuf>,
    previous: PathBuf,
}

impl Whois for Fakes {
    fn peer(&self, address: &str) -> BoxFuture<'_, Option<Peer>> {
        let peer = self.whois.get(address).map(|e| Peer {
            node_id: e.node_id.clone(),
            node_name: e.node_name.clone(),
            login: e.login.clone(),
        });
        Box::pin(async move { peer })
    }
}

impl Desktop for Fakes {
    fn confirm_new_devices(&self) -> BoxFuture<'_, bool> {
        let asked = self.confirm.is_some();
        Box::pin(async move { asked })
    }

    fn confirm(&self, _details: PairingDetails) -> BoxFuture<'_, PairingOutcome> {
        let approve = self.confirm.as_deref() == Some("approve");
        Box::pin(async move {
            if approve {
                PairingOutcome::Approved {
                    grants: DEFAULT_GRANTS.iter().map(|g| (*g).to_owned()).collect(),
                }
            } else {
                PairingOutcome::Refused("declined")
            }
        })
    }

    fn device_connected(&self, _device: &Device) {
        self.recorder.effects.lock().unwrap().connected += 1;
    }

    fn unpaired_auth(&self, _address: &str) {
        self.recorder.effects.lock().unwrap().unpaired += 1;
    }

    fn decline_all(&self) {}
}

impl Hooks for Fakes {
    fn webhook(&self, id: &str, bearer: &str, detail: &str) -> BoxFuture<'_, HookOutcome> {
        self.recorder.effects.lock().unwrap().hooks.push(vec![
            id.to_owned(),
            bearer.to_owned(),
            detail.to_owned(),
        ]);
        let outcome = match id {
            "fire" => HookOutcome::Fired,
            "deny" => HookOutcome::Denied,
            "off" => HookOutcome::Off,
            _ => HookOutcome::Unknown,
        };
        Box::pin(async move { outcome })
    }
}

impl Uploads for Fakes {
    fn receive(
        &self,
        device_id: &str,
        request: Request<Incoming>,
    ) -> BoxFuture<'_, Result<Upload, UploadFailure>> {
        let device_id = device_id.to_owned();
        Box::pin(async move {
            let size = request
                .into_body()
                .collect()
                .await
                .map(|c| c.to_bytes().len())
                .unwrap_or(0);
            self.recorder
                .effects
                .lock()
                .unwrap()
                .uploads
                .push(format!("{device_id}:{size}"));
            Ok(Upload {
                path: "/up/x.bin".to_owned(),
                name: "x.bin".to_owned(),
                size: size as u64,
            })
        })
    }
}

impl Blobs for Fakes {
    fn serve(
        &self,
        device_id: &str,
        target: &str,
        _request: Request<Incoming>,
    ) -> BoxFuture<'_, Response<Out>> {
        self.recorder
            .effects
            .lock()
            .unwrap()
            .blobs
            .push(format!("{device_id}:{target}"));
        let body = format!("blob:{device_id}:{target}");
        Box::pin(async move {
            let mut response = Response::new(Out::sized(body.clone().into()));
            response
                .headers_mut()
                .insert("content-type", "application/octet-stream".parse().unwrap());
            response
                .headers_mut()
                .insert("content-length", body.len().to_string().parse().unwrap());
            response
        })
    }
}

impl Assets for Fakes {
    fn root(&self) -> Option<PathBuf> {
        self.root.clone()
    }

    fn previous_builds(&self) -> Vec<PathBuf> {
        vec![self.previous.clone()]
    }
}

struct NoRouter;

impl Router for NoRouter {
    fn connection_count<'a>(&'a self, _device_id: &'a str) -> BoxFuture<'a, usize> {
        Box::pin(async { 0 })
    }

    fn retire<'a>(&'a self, _device_id: &'a str, _connection_id: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    fn attach<'a>(
        &'a self,
        _device_id: &'a str,
        _outbox: super::deps::Outbox,
        _resume_from: Option<&'a str>,
    ) -> BoxFuture<'a, Option<Box<dyn Connection>>> {
        Box::pin(async { None })
    }

    fn close_all(&self, _code: u16, _reason: &str) {}
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn set_time(path: &Path, at: SystemTime) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

/// The fixtures folder with the modification times git does not keep (`setStaticTimes` in the capture).
fn static_root(now: i64) -> PathBuf {
    let root = std::env::temp_dir().join(format!("web-matrix-static-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    copy_dir(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src/web/testdata/static"),
        &root,
    );
    let day = Duration::from_secs(24 * 60 * 60);
    let at = SystemTime::UNIX_EPOCH + Duration::from_millis(now as u64);
    for name in ["app-built.js", "app-stale.js"] {
        set_time(&root.join("assets").join(name), at - day * 10);
    }
    set_time(&root.join("assets/app-built.js.br"), at - day);
    set_time(&root.join("assets/app-stale.js.br"), at - day * 20);
    root
}

struct Raw {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(eol) = data.windows(2).position(|w| w == b"\r\n") else {
            return out;
        };
        let size =
            usize::from_str_radix(std::str::from_utf8(&data[..eol]).unwrap_or("0").trim(), 16)
                .unwrap_or(0);
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&data[eol + 2..eol + 2 + size]);
        data = &data[eol + 2 + size + 2..];
    }
}

async fn send(
    port: u16,
    request: &RequestRow,
    headers: &[(String, String)],
    body: Option<&str>,
) -> Raw {
    let mut head = format!(
        "{} {} HTTP/1.1\r\n",
        request.method,
        request.target.replace("{port}", &port.to_string())
    );
    for (name, value) in headers {
        head.push_str(&format!(
            "{name}: {}\r\n",
            value.replace("{port}", &port.to_string())
        ));
    }
    if let Some(body) = body {
        head.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    head.push_str("connection: close\r\n\r\n");
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    if let Some(body) = body {
        stream.write_all(body.as_bytes()).await.unwrap();
    }
    let mut data = Vec::new();
    let _ = stream.read_to_end(&mut data).await;
    let end = data
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or_else(|| {
            panic!(
                "no response to {head:?}: {:?}",
                String::from_utf8_lossy(&data)
            )
        });
    let text: String = data[..end].iter().map(|&b| b as char).collect();
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: Vec<(String, String)> = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_owned(), value.trim().to_owned())
        })
        .collect();
    let chunked = headers.iter().any(|(n, v)| {
        n.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked")
    });
    let rest = &data[end + 4..];
    let body = if request.method == "HEAD" {
        Vec::new()
    } else if chunked {
        dechunk(rest)
    } else {
        rest.to_vec()
    };
    Raw {
        status,
        headers,
        body,
    }
}

/// Replace `"key":"value"` values with `"key":"<token>"`, as the capture did for the answers that carry a random one.
fn blank_tokens(text: &str) -> String {
    let mut text = text.to_owned();
    for key in ["nonce", "ticket", "deviceId"] {
        let marker = format!("\"{key}\":\"");
        let mut out = String::new();
        let mut rest = text.as_str();
        while let Some(at) = rest.find(&marker) {
            out.push_str(&rest[..at + marker.len()]);
            rest = &rest[at + marker.len()..];
            let end = rest.find('"').unwrap_or(rest.len());
            out.push_str("<token>");
            rest = &rest[end..];
        }
        out.push_str(rest);
        text = out;
    }
    // `"expiresAt":<digits>` -> `"expiresAt":0`.
    let marker = "\"expiresAt\":";
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find(marker) {
        out.push_str(&rest[..at + marker.len()]);
        rest = rest[at + marker.len()..].trim_start_matches(|c: char| c.is_ascii_digit());
        out.push('0');
    }
    out.push_str(rest);
    out
}

fn normalize(raw: Raw) -> AnswerRow {
    let headers: Vec<(String, String)> = raw
        .headers
        .into_iter()
        .filter(|(name, _)| {
            !matches!(
                name.to_ascii_lowercase().as_str(),
                "date" | "connection" | "keep-alive"
            )
        })
        .map(|(name, value)| {
            if name.eq_ignore_ascii_case("set-cookie") {
                let blanked = ["__Host-ompdesk=", "ompdesk="].iter().find_map(|prefix| {
                    value.strip_prefix(prefix).and_then(|rest| {
                        rest.split_once(';')
                            .filter(|(v, _)| !v.is_empty())
                            .map(|(_, tail)| format!("{prefix}<cookie>;{tail}"))
                    })
                });
                (name, blanked.unwrap_or(value))
            } else {
                (name, value)
            }
        })
        .collect();
    let json = headers
        .iter()
        .any(|(n, v)| n.eq_ignore_ascii_case("content-type") && v.contains("json"));
    let body = if json {
        blank_tokens(&String::from_utf8_lossy(&raw.body)).into_bytes()
    } else {
        raw.body
    };
    AnswerRow {
        status: raw.status,
        headers,
        body_len: body.len(),
        body_sha256: hex(&Sha256::digest(&body)),
    }
}

fn lowered(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(n, v)| (n.to_ascii_lowercase(), v.clone()))
        .collect()
}

async fn run_row(row: &Row, fixtures: &Fixtures, root: &Path) -> (Vec<AnswerRow>, Effects) {
    let recorder = Arc::new(Recorder {
        effects: Mutex::new(Effects::default()),
    });
    let fakes = Arc::new(Fakes {
        recorder: recorder.clone(),
        whois: fixtures.whois.clone(),
        confirm: row.confirm.clone(),
        root: (!row.no_root).then(|| root.to_path_buf()),
        previous: root.join("prev"),
    });
    let now = fixtures.now;
    let blocks = if row.blocks {
        MemoryBlocks::from_json(&fixtures.blocked)
    } else {
        MemoryBlocks::default()
    };
    let edge = Edge::new(Deps {
        policy: Policy {
            host: row.policy.host.clone(),
            public_port: row.policy.public_port,
            secure: row.policy.secure,
            serve_prefix: row.policy.serve_prefix.clone(),
            pending_prefix: row.policy.pending_prefix.clone(),
            allowed_users: fixtures.allowed.clone(),
        },
        devices: Arc::new(MemoryDevices::from_json(&fixtures.devices)),
        blocks: Arc::new(blocks),
        whois: fakes.clone(),
        desktop: fakes.clone(),
        router: Arc::new(NoRouter),
        uploads: fakes.clone(),
        blobs: fakes.clone(),
        hooks: Some(fakes.clone()),
        assets: fakes.clone(),
        push_public_key: Arc::new(|| format!("B{}", "p".repeat(86))),
        clock: Arc::new(move || now),
    });
    let running = edge.start(0).await.unwrap();
    let key = {
        let d = lenient_base64(fixtures.device_key["d"].as_str().unwrap());
        p256::ecdsa::SigningKey::from_slice(&d).unwrap()
    };
    let (mut answers, mut last, mut n) = (Vec::new(), String::new(), 0);
    for request in &row.requests {
        let times = request.repeat.unwrap_or(1);
        for i in 0..times {
            n += 1;
            let mut body = request.body.clone();
            if request.templated {
                let nonce = last
                    .split("\"nonce\":\"")
                    .nth(1)
                    .and_then(|r| r.split('"').next())
                    .unwrap_or("")
                    .to_owned();
                let sig: p256::ecdsa::Signature = key.sign(nonce.as_bytes());
                body = body.map(|b| {
                    b.replace("{nonce}", &nonce)
                        .replace("{sig}", &base64url(&sig.to_bytes()))
                });
            }
            let headers: Vec<(String, String)> = request
                .headers
                .iter()
                .map(|(k, v)| {
                    if request.distinct_ip && k == "x-forwarded-for" {
                        (k.clone(), format!("10.0.{n}.1"))
                    } else {
                        (k.clone(), v.clone())
                    }
                })
                .collect();
            let raw = send(running.port, request, &headers, body.as_deref()).await;
            last = String::from_utf8_lossy(&raw.body).into_owned();
            if i == times - 1 {
                answers.push(normalize(raw));
            }
        }
    }
    running.stop().await;
    let effects = recorder.effects.lock().unwrap().clone();
    (answers, effects)
}

fn differences(row: &Row, got: &[AnswerRow], effects: &Effects) -> Vec<String> {
    let mut out = Vec::new();
    for (i, (want, have)) in row.answers.iter().zip(got).enumerate() {
        if want.status != have.status {
            out.push(format!(
                "request {i}: status {} want {}",
                have.status, want.status
            ));
        }
        if lowered(&want.headers) != lowered(&have.headers) {
            out.push(format!(
                "request {i}: headers\n    got  {:?}\n    want {:?}",
                lowered(&have.headers),
                lowered(&want.headers)
            ));
        }
        if want.body_sha256 != have.body_sha256 {
            out.push(format!(
                "request {i}: body {} bytes {} want {} bytes {}",
                have.body_len, have.body_sha256, want.body_len, want.body_sha256
            ));
        }
    }
    if row.answers.len() != got.len() {
        out.push(format!("{} answers, want {}", got.len(), row.answers.len()));
    }
    if *effects != row.effects {
        out.push(format!("effects {effects:?} want {:?}", row.effects));
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn every_captured_row_answers_the_same() {
    let matrix: Matrix = serde_json::from_str(MATRIX).unwrap();
    assert!(matrix.rows.len() > 300, "{} rows", matrix.rows.len());
    let root = static_root(matrix.fixtures.now);
    let (mut failures, mut explained) = (Vec::new(), 0);
    for row in &matrix.rows {
        let (answers, effects) = run_row(row, &matrix.fixtures, &root).await;
        let diff = differences(row, &answers, &effects);
        let known = KNOWN_DIFFERENCES
            .iter()
            .find(|(prefix, _)| row.id.starts_with(prefix));
        match (diff.is_empty(), known) {
            (true, None) => {}
            (true, Some((prefix, _))) => failures.push(format!(
                "{}: matches, but {prefix} is listed as a difference",
                row.id
            )),
            (false, Some(_)) => explained += 1,
            (false, None) => failures.push(format!("{}\n  {}", row.id, diff.join("\n  "))),
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    eprintln!(
        "{} rows, {} with a listed difference, {} unexplained",
        matrix.rows.len(),
        explained,
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "{} rows differ:\n{}",
        failures.len(),
        failures
            .iter()
            .take(25)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
