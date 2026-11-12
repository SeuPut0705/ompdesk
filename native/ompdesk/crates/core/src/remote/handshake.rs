//! Both handshakes of a remote link (was `handshakeOn` in `src/main/remote/client.ts` and `RemoteHost.#handshake`/
//! `#auth` in `host-server.ts`), handshake v2: each side sends its static and an ephemeral X25519 key; the keying
//! material is DH(eA,eB) || DH(sA,eB) || DH(eA,sB); HKDF over it and the transcript gives one key per direction.
//! Messages are checked as `protocol.ts`'s zod schemas checked them (string lengths in UTF-16 units, unknown fields
//! ignored). Who may connect, which device a node holds and what the hello answers stay main's: the host asks
//! (`remote.ask`: `gate`, `bind`, `open`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::crypto::{self, KeyPair};
use super::identity::Identity;
use super::link::{Conn, ReceiveError};
use crate::control::js::string_of_value;

pub const HANDSHAKE_VERSION: u64 = 2;
pub const PROTOCOL_VERSION: u64 = 1;
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// A failed handshake as `RemoteError` spelled it: a code and its message.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Failure {
        Failure {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// A refusal code alone (`new RemoteError(code)`: its message is the code).
    pub fn code(code: &str) -> Failure {
        Failure::new(code, code)
    }

    /// What `asRemoteError` made of anything that was not a `RemoteError`.
    pub fn unreachable(message: impl Into<String>) -> Failure {
        Failure::new("unreachable", message)
    }
}

impl From<ReceiveError> for Failure {
    fn from(error: ReceiveError) -> Failure {
        Failure::unreachable(error.message())
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A string field of at most `max` UTF-16 units (and at least `min`).
fn text<'a>(message: &'a Value, key: &str, min: usize, max: usize) -> Option<&'a str> {
    let value = message.get(key)?.as_str()?;
    let units = utf16_len(value);
    (units >= min && units <= max).then_some(value)
}

fn raw_key<'a>(message: &'a Value, key: &str) -> Option<&'a str> {
    message
        .get(key)?
        .as_str()
        .filter(|value| crypto::is_raw_key(value))
}

fn device_id(message: &Value) -> Option<&str> {
    text(message, "deviceId", 1, 64)
}

fn device_name(message: &Value) -> Option<&str> {
    text(message, "name", 0, 256)
}

fn kind(message: &Value) -> &str {
    message.get("t").and_then(Value::as_str).unwrap_or_default()
}

/// The two parties of the transcript, in protocol order.
pub struct Party<'a> {
    pub device_id: &'a str,
    pub eph_pub: &'a str,
    pub static_pub: &'a str,
}

fn transcript(client: &Party, host: &Party) -> [u8; 32] {
    crypto::auth_transcript(&[
        client.device_id,
        client.eph_pub,
        client.static_pub,
        host.device_id,
        host.eph_pub,
        host.static_pub,
    ])
}

fn ikm(parts: [Result<[u8; 32], crypto::CryptoError>; 3]) -> Result<Vec<u8>, Failure> {
    let mut ikm = Vec::with_capacity(96);
    for part in parts {
        ikm.extend_from_slice(&part.map_err(|error| Failure::unreachable(error.to_string()))?);
    }
    Ok(ikm)
}

/// The host this device expects at the address (its pinned id and key); None on first contact.
pub struct Expected {
    pub device_id: String,
    pub static_pub: String,
}

/// What a successful client handshake learned.
pub struct HostAnswer {
    /// The host's hello without its `t`: protocol, appVersion, name, platform, ompVersion, home, sep.
    pub hello: Value,
    pub device_id: String,
    pub name: String,
    pub static_pub: String,
}

/// Auth, client side, on a connected socket. `capabilities` go into the hello after its name, in their order.
pub async fn client(
    conn: &mut Conn,
    identity: &Identity,
    address: &str,
    expected: Option<&Expected>,
    name: &str,
    app_version: &str,
    capabilities: &Map<String, Value>,
) -> Result<HostAnswer, Failure> {
    let eph = KeyPair::generate();
    let init = json!({
        "t": "auth-init",
        "v": HANDSHAKE_VERSION,
        "deviceId": identity.device_id,
        "name": name,
        "ephPub": eph.public,
        "staticPub": identity.keys.public,
    });
    send(conn, &init).await?;
    let (reply, _) = conn.receive(HANDSHAKE_TIMEOUT).await?;
    let malformed = || Failure::new("protocol", "malformed auth reply");
    let answer = match kind(&reply) {
        "auth-resp" => (
            device_id(&reply).ok_or_else(malformed)?,
            device_name(&reply).ok_or_else(malformed)?,
            raw_key(&reply, "ephPub").ok_or_else(malformed)?,
            raw_key(&reply, "staticPub").ok_or_else(malformed)?,
        ),
        "auth-fail" | "error" => {
            let code = text(&reply, "code", 0, 64).ok_or_else(malformed)?;
            return Err(Failure::code(code));
        }
        _ => return Err(malformed()),
    };
    let (host_id, _name, host_eph, host_static) = answer;
    if let Some(expected) = expected {
        // Another device now answers at this address.
        if host_id != expected.device_id {
            return Err(Failure::unreachable(format!("{address} is another device")));
        }
        if host_static != expected.static_pub {
            return Err(Failure::new(
                "key_mismatch",
                format!("{address} answers with another key than the one pinned"),
            ));
        }
    }
    let ikm = ikm([
        eph.dh(host_eph),
        identity.keys.dh(host_eph),
        eph.dh(host_static),
    ])?;
    let keys = crypto::auth_keys(
        &ikm,
        &transcript(
            &Party {
                device_id: &identity.device_id,
                eph_pub: &eph.public,
                static_pub: &identity.keys.public,
            },
            &Party {
                device_id: host_id,
                eph_pub: host_eph,
                static_pub: host_static,
            },
        ),
    );
    let (host_id, host_static) = (host_id.to_owned(), host_static.to_owned());
    conn.secure(&keys.ab, &keys.ba);
    let mut hello = Map::new();
    hello.insert("t".into(), "hello".into());
    hello.insert("protocol".into(), PROTOCOL_VERSION.into());
    hello.insert("appVersion".into(), app_version.into());
    hello.insert("name".into(), name.into());
    for (key, value) in capabilities {
        hello.insert(key.clone(), value.clone());
    }
    send(conn, &Value::Object(hello)).await?;
    let (message, _) = conn.receive(HANDSHAKE_TIMEOUT).await?;
    if kind(&message) == "error" {
        let code = match message.get("code") {
            None | Some(Value::Null) => "protocol".to_owned(),
            Some(code) => string_of_value(code),
        };
        return Err(Failure::code(&code));
    }
    let protocol = message.get("protocol");
    if kind(&message) != "hello" || !protocol.is_some_and(is_protocol_number) {
        let spelled = protocol.map_or_else(|| "undefined".to_owned(), string_of_value);
        return Err(Failure::new(
            "protocol",
            format!("host protocol {spelled}, ours {PROTOCOL_VERSION}"),
        ));
    }
    let info =
        host_hello(&message).ok_or_else(|| Failure::new("protocol", "malformed host hello"))?;
    let name = info
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok(HostAnswer {
        hello: info,
        device_id: host_id,
        name,
        static_pub: host_static,
    })
}

/// `protocol` as zod's `z.number()` and `=== 1` read it: the number 1 (`1.0` too).
fn is_protocol_number(value: &Value) -> bool {
    value.as_f64() == Some(PROTOCOL_VERSION as f64)
}

/// `HostHelloMessage` without its `t`, in the schema's key order.
fn host_hello(message: &Value) -> Option<Value> {
    let protocol = message.get("protocol").filter(|value| value.is_number())?;
    let app_version = text(message, "appVersion", 0, 64)?;
    let name = device_name(message)?;
    let platform = text(message, "platform", 0, 32)?;
    let omp_version = match message.get("ompVersion")? {
        Value::Null => Value::Null,
        Value::String(version) if utf16_len(version) <= 64 => Value::String(version.clone()),
        _ => return None,
    };
    let home = message.get("home")?.as_str()?;
    let sep = text(message, "sep", 0, 1)?;
    Some(json!({
        "protocol": protocol,
        "appVersion": app_version,
        "name": name,
        "platform": platform,
        "ompVersion": omp_version,
        "home": home,
        "sep": sep,
    }))
}

async fn send(conn: &mut Conn, message: &Value) -> Result<(), Failure> {
    conn.send(message)
        .await
        .map_err(|_| Failure::unreachable("connection closed"))
}

/// A probe's answer, as `probeOn` read it.
pub enum Probe {
    Ok {
        device_id: String,
        name: String,
        app_version: String,
    },
    Refused(String),
}

/// Asks whether an OMPdesk host answers and would let this device in. Failure: nothing (or something else) answers.
pub async fn probe(mut conn: Conn, address: &str) -> Result<Probe, Failure> {
    let result = probe_on(&mut conn, address).await;
    conn.close().await;
    result
}

async fn probe_on(conn: &mut Conn, address: &str) -> Result<Probe, Failure> {
    send(conn, &json!({"t": "probe", "v": HANDSHAKE_VERSION})).await?;
    let (reply, _) = conn.receive(Duration::from_secs(3)).await?;
    let not_host = || Failure::unreachable(format!("{address} is not an OMPdesk host"));
    match kind(&reply) {
        "probe-ok" => Ok(Probe::Ok {
            device_id: device_id(&reply).ok_or_else(not_host)?.to_owned(),
            name: device_name(&reply).ok_or_else(not_host)?.to_owned(),
            app_version: text(&reply, "appVersion", 0, 64)
                .ok_or_else(not_host)?
                .to_owned(),
        }),
        "error" => Ok(Probe::Refused(
            text(&reply, "code", 0, 64).ok_or_else(not_host)?.to_owned(),
        )),
        _ => Err(not_host()),
    }
}

/// The host's side of one accepted connection, up to the hello. Main decides at three points (`gate`, `bind`,
/// `open`); the answers it gives come back through `ask`.
pub trait HostSide {
    /// May this address connect? `Ok(name)`: this computer's name for a probe's answer; `Err(code)`: refused.
    fn gate(&self, ip: &str) -> impl Future<Output = Result<GatePass, String>> + Send;
    /// The device record for this connection: the peer's static key as main pinned it, and this computer's name for
    /// the answer; `Err(code)`: refused.
    fn bind(
        &self,
        ip: &str,
        init: &Value,
        visitor: &Value,
    ) -> impl Future<Output = Result<Bound, String>> + Send;
    /// The device's hello arrived: main checks it and answers the host's hello (its fields after `t` and
    /// `protocol`), or None to drop the connection.
    fn open(&self, device_id: &str, hello: &Value) -> impl Future<Output = Option<Opened>> + Send;
}

pub struct GatePass {
    pub visitor: Value,
    pub name: String,
}

pub struct Bound {
    pub static_pub: String,
    pub name: String,
}

pub struct Opened {
    /// The host's hello after `t` and `protocol`, in main's order.
    pub hello: Map<String, Value>,
    pub deflate: bool,
    pub context: bool,
}

/// What the host's handshake ended with.
pub enum HostEnd {
    /// A device's link is up: main holds it as `device_id`.
    Linked { conn: Conn, opened: Opened },
    /// Answered (a probe, a refusal) and closed gracefully.
    Closed(Conn),
    /// Destroyed (a malformed opening, a bad key, silence).
    Dropped,
}

/// The host's handshake: opening, gate, auth, hello. `app_version` goes into a probe's answer.
pub async fn host<H: HostSide>(
    mut conn: Conn,
    identity: Arc<Identity>,
    app_version: &str,
    side: &H,
) -> HostEnd {
    let ip = conn.peer_ip();
    let Ok((first, _)) = conn.receive(HANDSHAKE_TIMEOUT).await else {
        return HostEnd::Dropped;
    };
    let opening = kind(&first);
    if !matches!(opening, "probe" | "auth-init") {
        return HostEnd::Dropped;
    }
    if first.get("v").and_then(Value::as_f64) != Some(HANDSHAKE_VERSION as f64) {
        return refuse(conn, "error", "protocol").await;
    }
    let gate = side.gate(&ip).await;
    if opening == "probe" {
        return match gate {
            Err(code) => refuse(conn, "error", &code).await,
            Ok(pass) => {
                let answer = json!({
                    "t": "probe-ok",
                    "deviceId": identity.device_id,
                    "name": pass.name,
                    "appVersion": app_version,
                });
                match conn.send(&answer).await {
                    Ok(()) => HostEnd::Closed(conn),
                    Err(_) => HostEnd::Dropped,
                }
            }
        };
    }
    let (Some(_), Some(init_id), Some(init_name), Some(init_eph), Some(init_static)) = (
        first.get("v").filter(|v| v.is_number()),
        device_id(&first),
        device_name(&first),
        raw_key(&first, "ephPub"),
        raw_key(&first, "staticPub"),
    ) else {
        return HostEnd::Dropped;
    };
    let visitor = match gate {
        Err(code) => return refuse(conn, "auth-fail", &code).await,
        Ok(pass) => pass.visitor,
    };
    let init = json!({"deviceId": init_id, "name": init_name, "staticPub": init_static});
    let bound = match side.bind(&ip, &init, &visitor).await {
        Err(code) => return refuse(conn, "auth-fail", &code).await,
        Ok(bound) => bound,
    };
    let eph = KeyPair::generate();
    let resp = json!({
        "t": "auth-resp",
        "deviceId": identity.device_id,
        "name": bound.name,
        "ephPub": eph.public,
        "staticPub": identity.keys.public,
    });
    if conn.send(&resp).await.is_err() {
        return HostEnd::Dropped;
    }
    // DH(eA,eB) || DH(sA,eB) || DH(eA,sB), computed from the host's side.
    let Ok(ikm) = ikm([
        eph.dh(init_eph),
        eph.dh(&bound.static_pub),
        identity.keys.dh(init_eph),
    ]) else {
        return HostEnd::Dropped;
    };
    let keys = crypto::auth_keys(
        &ikm,
        &transcript(
            &Party {
                device_id: init_id,
                eph_pub: init_eph,
                static_pub: &bound.static_pub,
            },
            &Party {
                device_id: &identity.device_id,
                eph_pub: &eph.public,
                static_pub: &identity.keys.public,
            },
        ),
    );
    conn.secure(&keys.ba, &keys.ab);
    let Ok((hello, _)) = conn.receive(HANDSHAKE_TIMEOUT).await else {
        return HostEnd::Dropped;
    };
    if kind(&hello) != "hello" {
        return HostEnd::Dropped;
    }
    if !hello.get("protocol").is_some_and(is_protocol_number) {
        return refuse(conn, "error", "protocol").await;
    }
    let Some(opened) = side.open(init_id, &hello).await else {
        return HostEnd::Dropped;
    };
    let mut answer = Map::new();
    answer.insert("t".into(), "hello".into());
    answer.insert("protocol".into(), PROTOCOL_VERSION.into());
    for (key, value) in &opened.hello {
        answer.insert(key.clone(), value.clone());
    }
    if conn.send(&Value::Object(answer)).await.is_err() {
        return HostEnd::Dropped;
    }
    HostEnd::Linked { conn, opened }
}

async fn refuse(mut conn: Conn, t: &str, code: &str) -> HostEnd {
    match conn.send(&json!({"t": t, "code": code})).await {
        Ok(()) => HostEnd::Closed(conn),
        Err(_) => HostEnd::Dropped,
    }
}
