//! Remote devices (native-rust ledger R1-R3 and R5; was `src/main/remote/{crypto,identity,address,wire,client,
//! host-server,link-traffic,devices}.ts`' transport and decisions): the identity's keys, the candidate ports, the
//! dial, both handshakes, the sealed and deflated frames, ping and dead, the host's traffic line, and the devices
//! instance (`devices/`: records, Tailscale's side, the host's listener and gate, each known host's reconnecting
//! client). Main keeps what only it can say (Mobile web's lists and blocks, the person's approval, the hello's
//! answer) and every request and event on a link, which it holds by the link's number.
//!
//! Methods: `remote.identity`, `remote.connect` and `remote.handshake` (one handshake, cancellable: the
//! cross-implementation tests'), `remote.probe`, `remote.probeHost`, `remote.answer` (main's answer to an ask),
//! `remote.testLink` (a link to an address under keys the test chose, no handshake), and `devices/`' `remote.devices.*`,
//! `remote.client.*`, `remote.connectFirst`. Pushes on a link: `remote.send`, `remote.deflate`, `remote.listen`,
//! `remote.tap`, `remote.check`, `remote.close`, `remote.destroy`. Events: `remote.message`, `remote.checked`,
//! `remote.closed`, `remote.traffic`, `remote.ask` (`policy`, `admit`, `open`, `tailnet`, `locate`), `remote.log`. The event
//! encoding's methods are `events`'.

pub mod address;
pub mod codec;
pub mod crypto;
pub mod devices;
mod dial;
pub mod events;
mod handshake;
mod host;
pub mod identity;
mod link;
pub mod quota;
pub mod store;
pub mod tailnet;
pub mod traffic;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::server::{Call, Events, Fault, PushCall, Registry, Reply};
use handshake::{Expected, Failure, Probe};
use identity::Identity;
use link::{Command, Conn, Liveness, Reason};

/// How long a connected socket waits for its handshake request before it is dropped.
const UNCLAIMED: Duration = Duration::from_secs(10);

#[derive(Default)]
struct State {
    next: u64,
    /// Each identity loaded, by device id (a test runs two computers' mains in one process).
    identities: HashMap<String, Arc<Identity>>,
    links: HashMap<u64, link::Link>,
    /// Sockets a client connected, waiting for their handshake.
    conns: HashMap<u64, Conn>,
    hosts: HashMap<u64, host::Host>,
    asks: HashMap<u64, oneshot::Sender<Value>>,
    /// Core-side code told when a link ends (a reconnecting client), registered before the link runs.
    enders: HashMap<u64, Box<dyn FnOnce(Reason) + Send>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

fn state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn next_id() -> u64 {
    let mut state = state();
    state.next += 1;
    state.next
}

/// A link ended: it is nobody's any more.
fn forget_link(id: u64) {
    let mut state = state();
    state.links.remove(&id);
    for host in state.hosts.values_mut() {
        host.forget(id);
    }
}

/// Calls `ended` when link `id` ends, before its `remote.closed` reaches main. Register before the link runs.
pub(crate) fn on_link_end(id: u64, ended: impl FnOnce(Reason) + Send + 'static) {
    state().enders.insert(id, Box::new(ended));
}

/// A link's task ended with `reason`.
pub(crate) fn link_ended(id: u64, reason: Reason) {
    let ender = state().enders.remove(&id);
    if let Some(ender) = ender {
        ender(reason);
    }
}

/// Asks main (`remote.ask`) and waits for its `remote.answer`; None when main never answers (its core went).
pub(crate) async fn ask(events: &Events, kind: &str, data: Value) -> Option<Value> {
    let (answer, answered) = oneshot::channel();
    let call = {
        let mut state = state();
        state.next += 1;
        let call = state.next;
        state.asks.insert(call, answer);
        call
    };
    let mut message = Map::new();
    message.insert("call".into(), call.into());
    message.insert("kind".into(), kind.into());
    if let Value::Object(fields) = data {
        message.extend(fields);
    }
    events.send("remote.ask", &message);
    answered.await.ok()
}

pub(crate) fn identity(device_id: &str) -> Result<Arc<Identity>, Fault> {
    state()
        .identities
        .get(device_id)
        .cloned()
        .ok_or_else(|| Fault::new("no_identity", "The remote identity is not loaded"))
}

pub fn register(registry: &mut Registry) {
    devices::register(registry);
    store::register(registry);
    tailnet::register(registry);
    registry.add("remote.identity", |call| Box::pin(load_identity(call)));
    registry.add("remote.connect", |call| Box::pin(connect(call)));
    registry.add("remote.handshake", |call| Box::pin(handshake_call(call)));
    registry.add("remote.probe", |call| Box::pin(probe(call)));
    registry.add("remote.probeHost", |call| Box::pin(probe_host(call)));
    registry.add("remote.answer", |call| Box::pin(answer(call)));
    registry.add("remote.testLink", |call| Box::pin(test_link(call)));
    events::register(registry);
    registry.add_push("remote.send", |mut push| {
        if let Some(bin) = push.bin.take() {
            on_link(&push, Command::Send(bin));
        }
    });
    registry.add_push("remote.deflate", |push| {
        let context = params::<Map<String, Value>>(&push)
            .and_then(|p| p.get("context").and_then(Value::as_bool))
            .unwrap_or(false);
        on_link(&push, Command::Deflate { context });
    });
    registry.add_push("remote.listen", |push| on_link(&push, Command::Listen));
    registry.add_push("remote.tap", |push| on_link(&push, Command::Tap));
    registry.add_push("remote.check", |push| {
        let window = params::<Map<String, Value>>(&push)
            .and_then(|p| p.get("windowMs").and_then(Value::as_u64))
            .unwrap_or(3_000);
        on_link(
            &push,
            Command::Check {
                window: Duration::from_millis(window),
                reply: None,
            },
        );
    });
    registry.add_push("remote.close", |push| on_link(&push, Command::Close));
    registry.add_push("remote.destroy", |push| {
        let reason = params::<Map<String, Value>>(&push)
            .and_then(|p| p.get("reason").and_then(Value::as_str).map(Reason::parse))
            .unwrap_or(Reason::Local);
        on_link(&push, Command::Destroy(reason));
    });
}

fn params<T: serde::de::DeserializeOwned>(push: &PushCall) -> Option<T> {
    serde_json::from_str(push.params.get()).ok()
}

fn on_link(push: &PushCall, command: Command) {
    let Some(id) =
        params::<Map<String, Value>>(push).and_then(|p| p.get("link").and_then(Value::as_u64))
    else {
        return;
    };
    if let Some(link) = state().links.get(&id) {
        link.command(command);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityParams {
    user_data: PathBuf,
}

async fn load_identity(call: Call) -> Result<Reply, Fault> {
    let params: IdentityParams = call.params()?;
    let loaded = tokio::task::spawn_blocking(move || identity::load_or_create(&params.user_data))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?
        .map_err(|error| Fault::new("io", error.to_string()))?;
    let reply = json!({"deviceId": loaded.device_id, "publicKey": loaded.keys.public});
    state()
        .identities
        .insert(loaded.device_id.clone(), Arc::new(loaded));
    Reply::json(&reply)
}

/// A computer's candidate addresses on its tailnet IP (`port_setting`: main's `OMP_GUI_REMOTE_PORT`), the one it last
/// answered on first.
pub(crate) fn candidate_addresses(
    ip: &str,
    first: Option<&str>,
    port_setting: Option<&str>,
) -> Vec<String> {
    let mut list: Vec<String> = address::candidates(address::remote_port(port_setting))
        .into_iter()
        .map(|port| address::format(ip, port))
        .collect();
    if let Some(first) = first
        && let Some(at) = list.iter().position(|address| address == first)
    {
        let first = list.remove(at);
        list.insert(0, first);
    }
    list
}

fn failed(failure: &Failure, refused: bool) -> Value {
    json!({"failed": {"code": failure.code, "message": failure.message, "refused": refused}})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectParams {
    addresses: Vec<String>,
    timeout_ms: Option<u64>,
}

/// The first of the addresses that connects (staggered), held for its handshake.
async fn connect(call: Call) -> Result<Reply, Fault> {
    let params: ConnectParams = call.params()?;
    let timeout = params
        .timeout_ms
        .map_or(dial::CONNECT_TIMEOUT, Duration::from_millis);
    match dial::first_to_connect(&params.addresses, timeout, Some(&call.scope)).await {
        Err(failure) => Reply::json(&failed(&failure.failure, failure.refused)),
        Ok((address, stream)) => {
            let id = next_id();
            state().conns.insert(id, Conn::new(stream));
            tokio::spawn(async move {
                tokio::time::sleep(UNCLAIMED).await;
                state().conns.remove(&id);
            });
            Reply::json(&json!({"conn": id, "address": address}))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeParams {
    /// This computer's device id (`remote.identity`).
    identity: String,
    conn: u64,
    address: String,
    expected: Option<ExpectedParams>,
    name: String,
    app_version: String,
    #[serde(default)]
    capabilities: Map<String, Value>,
    liveness: Option<Liveness>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedParams {
    device_id: String,
    static_pub: String,
}

/// Auth on a connected socket; on success the link runs, delivering nothing until main's `remote.listen`.
async fn handshake_call(call: Call) -> Result<Reply, Fault> {
    let params: HandshakeParams = call.params()?;
    let identity = identity(&params.identity)?;
    let Some(mut conn) = state().conns.remove(&params.conn) else {
        return Reply::json(&failed(&Failure::unreachable("connection closed"), false));
    };
    let expected = params.expected.map(|expected| Expected {
        device_id: expected.device_id,
        static_pub: expected.static_pub,
    });
    let attempt = handshake::client(
        &mut conn,
        &identity,
        &params.address,
        expected.as_ref(),
        &params.name,
        &params.app_version,
        &params.capabilities,
    );
    let answer = tokio::select! {
        answer = attempt => answer,
        () = call.scope.on_cancel() => Err(Failure::unreachable("connection closed")),
    };
    match answer {
        Err(failure) => Reply::json(&failed(&failure, false)),
        Ok(host) => {
            let id = next_id();
            let link = conn.into_link(
                id,
                call.events.clone(),
                params.liveness.unwrap_or_default(),
                link::LinkOptions::default(),
            );
            state().links.insert(id, link);
            Reply::json(&json!({
                "link": id,
                "hello": host.hello,
                "host": {"deviceId": host.device_id, "name": host.name, "staticPub": host.static_pub},
            }))
        }
    }
}

fn probe_json(probe: &Probe) -> Value {
    match probe {
        Probe::Ok {
            device_id,
            name,
            app_version,
        } => json!({"ok": true, "deviceId": device_id, "name": name, "appVersion": app_version}),
        Probe::Refused(code) => json!({"ok": false, "code": code}),
    }
}

#[derive(Deserialize)]
struct ProbeParams {
    addresses: Vec<String>,
    skip: Option<String>,
}

async fn probe(call: Call) -> Result<Reply, Fault> {
    let params: ProbeParams = call.params()?;
    let (address, found) = dial::probe_any(&params.addresses, params.skip.as_deref()).await;
    Reply::json(&json!({"address": address, "probe": probe_json(&found)}))
}

#[derive(Deserialize)]
struct ProbeHostParams {
    address: String,
}

async fn probe_host(call: Call) -> Result<Reply, Fault> {
    let params: ProbeHostParams = call.params()?;
    match dial::probe_host(&params.address).await {
        Ok(found) => Reply::json(&json!({"probe": probe_json(&found)})),
        Err(failure) => Reply::json(&failed(&failure, false)),
    }
}

#[derive(Deserialize)]
struct AnswerParams {
    call: u64,
    result: Box<RawValue>,
}

async fn answer(call: Call) -> Result<Reply, Fault> {
    let params: AnswerParams = call.params()?;
    let waiting = state().asks.remove(&params.call);
    if let Some(waiting) = waiting {
        let value = serde_json::from_str(params.result.get()).unwrap_or(Value::Null);
        let _ = waiting.send(value);
    }
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestLinkParams {
    address: String,
    /// Hex keys; none: the link stays plain.
    send_key: Option<String>,
    receive_key: Option<String>,
    liveness: Option<Liveness>,
}

fn key(hex: &str) -> Result<[u8; 32], Fault> {
    let bad = || Fault::new("invalid_params", "a key is 64 hex digits");
    if hex.len() != 64 {
        return Err(bad());
    }
    let mut key = [0u8; 32];
    for (at, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[at * 2..at * 2 + 2], 16).map_err(|_| bad())?;
    }
    Ok(key)
}

/// The tests' link: a socket to `address`, sealed under the keys given, run as a handshake leaves a link (nothing
/// delivered before `remote.listen`). What a released TypeScript peer sends must reach it unchanged, and the other
/// way round, with no handshake in between to blame.
async fn test_link(call: Call) -> Result<Reply, Fault> {
    let params: TestLinkParams = call.params()?;
    let stream = dial::dial(&params.address, dial::CONNECT_TIMEOUT)
        .await
        .map_err(|failure| Fault::new(failure.failure.code, failure.failure.message))?;
    let mut conn = Conn::new(stream);
    if let (Some(send), Some(receive)) = (&params.send_key, &params.receive_key) {
        conn.secure(&key(send)?, &key(receive)?);
    }
    let id = next_id();
    let link = conn.into_link(
        id,
        call.events.clone(),
        params.liveness.unwrap_or_default(),
        link::LinkOptions::default(),
    );
    state().links.insert(id, link);
    Reply::json(&json!({"link": id}))
}
