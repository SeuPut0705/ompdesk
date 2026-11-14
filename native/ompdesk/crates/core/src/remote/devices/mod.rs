//! Computer sharing's devices (native-rust ledger R5; was `src/main/remote/devices.ts`' `RemoteDevices` with the
//! decisions of `host-server.ts` and `client.ts`): one instance per main (`remote.devices.open`; a test runs two
//! computers' mains in one process). It keeps the device records (`remote-peers.json`) and the host records
//! (`remote-hosts.json`), reads Tailscale (the 15 s poll, the 5 s scan while a view shows the tailnet's computers,
//! the probes), listens as a host on this computer's tailnet addresses and rebinds when they change, decides who may
//! connect (`gate`) and which device a node holds (`bind`), keeps each known host's link up (`client.rs`), matches
//! code-paired hosts to nodes once, forgets code-paired devices after the grace period and holds the host's
//! keep-awake policy. Main keeps what only it can say or do and is asked (`remote.ask`): Mobile web's allowed accounts
//! and blocks (`policy`), the person's approval (`admit`), each device link's hello (`open`), and every request and
//! event on a link. Main mirrors the records from `remote.devices.state` for its synchronous readers; the quota's
//! counts are main's writes (`remote.devices.peerPatch`), applied here in the order sent.

pub mod client;
pub(crate) mod gate;
pub mod native;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio::task::AbortHandle;

use super::address;
use super::dial;
use super::handshake::{Failure, Probe};
use super::host::{self, ListenParams};
use super::identity::Identity;
use super::link::Liveness;
use super::store::{self, Kind, Store};
use super::tailnet;
use crate::clock;
use crate::server::{Call, Events, Fault, PushCall, Registry, Reply};
use client::{Addresses, Client, ClientOptions, Stored};

/// Tailscale's side is read this often.
pub const TAILNET_POLL_MS: u64 = 15_000;
/// The tailnet's computers are probed this often while a view shows them.
pub const TAILNET_SCAN_MS: u64 = 5_000;
const PROBE_CONCURRENCY: usize = 8;
/// A device paired by code that never connected again is forgotten this long after the switch to Tailscale.
pub const LEGACY_PEER_GRACE_MS: u64 = 30 * 24 * 60 * 60_000;
/// A rebind still running this long is logged once (`rebind-slow`).
const REBIND_SLOW_MS: u64 = 2_000;

/// Where an instance reads Tailscale: its own cached reads (`tailnet.rs`), or main's answers (devices.test's rig).
#[derive(Clone, Copy)]
enum Source {
    Core(u64),
    Main,
}

#[derive(Default)]
struct HostRole {
    /// Started (sharing on) and not stopped.
    running: bool,
    /// The tailnet addresses it was asked to listen on.
    bound: Vec<String>,
    /// Those it listens on now.
    listening: Vec<String>,
    port: Option<u32>,
    listen_error: Option<Value>,
    /// What the last `listening`/`not-listening` line said.
    logged: Option<String>,
    /// Device links open: link → device id.
    links: HashMap<u64, String>,
    versions: HashMap<u64, String>,
    /// Connections in their handshake: link → when taken in, and the device record bound.
    arriving: HashMap<u64, (u64, Option<Map<String, Value>>)>,
}

impl HostRole {
    /// The `host:port` addresses it listens on now.
    fn addresses(&self) -> Vec<String> {
        match self.port {
            Some(port) => self
                .listening
                .iter()
                .map(|host| address::format(host, port))
                .collect(),
            None => Vec::new(),
        }
    }
}

struct Inner {
    name: String,
    loopback: bool,
    keep_awake_enabled: bool,
    running_tabs: bool,
    migrated_at: Option<f64>,
    disposed: bool,
    phase: &'static str,
    tailnet_name: Option<String>,
    host: HostRole,
    clients: HashMap<String, Arc<Client>>,
    /// Where each node's host answered last (`ip:port`).
    found: HashMap<String, String>,
    /// Whether each known host's node was online in the last poll.
    node_online: HashMap<String, bool>,
    computers: Vec<Map<String, Value>>,
    watchers: HashSet<u64>,
    poll_timer: Option<AbortHandle>,
    scan_timer: Option<AbortHandle>,
    /// The last quota patch applied (main's numbering).
    patched: u64,
}

pub struct Devices {
    pub id: u64,
    events: Events,
    identity: Arc<Identity>,
    app_version: String,
    port: Option<u32>,
    port_setting: Option<String>,
    refuse: HashMap<String, String>,
    liveness: Option<Liveness>,
    traffic: bool,
    traffic_ms: Option<u64>,
    source: Source,
    keep_awake: Option<u64>,
    peers: Arc<Mutex<Store>>,
    hosts: Arc<Mutex<Store>>,
    inner: Mutex<Inner>,
    effects: Option<Arc<dyn native::Effects>>,
    /// One rebind, migration and scan pass at a time; a call during one waits for it (false: none running).
    binding: Pass,
    migrating: Pass,
    scanning: Pass,
    me: Weak<Devices>,
}

/// One pass at a time: a caller that finds one running waits for it instead of starting another.
#[derive(Default)]
struct Pass(Mutex<Option<watch::Receiver<bool>>>);

impl Pass {
    /// Runs `pass` unless one is running, which is waited for instead.
    async fn run<F: Future<Output = ()>>(&self, pass: impl FnOnce() -> F) {
        let waiting = {
            let mut running = self.0.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(receiver) = running.as_ref() {
                Err(receiver.clone())
            } else {
                let (sender, receiver) = watch::channel(false);
                *running = Some(receiver);
                Ok(sender)
            }
        };
        match waiting {
            Ok(sender) => {
                // However the pass ends (done, or dropped: a watch that stopped aborts its timer mid-scan, a request
                // is cancelled), the next caller runs a new one and whoever waited on this one goes on.
                let _ended = Ended { pass: self, sender };
                pass().await;
            }
            Err(mut receiver) => {
                let _ = receiver.wait_for(|done| *done).await;
            }
        }
    }

    async fn wait(&self) {
        let waiting = self.0.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(mut receiver) = waiting {
            let _ = receiver.wait_for(|done| *done).await;
        }
    }
}

/// Ends a running pass when dropped: its slot is free again and its waiters are told.
struct Ended<'a> {
    pass: &'a Pass,
    sender: watch::Sender<bool>,
}

impl Drop for Ended<'_> {
    fn drop(&mut self) {
        *self.pass.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let _ = self.sender.send(true);
    }
}

static INSTANCES: LazyLock<Mutex<HashMap<u64, Arc<Devices>>>> = LazyLock::new(Mutex::default);
static CLIENTS: LazyLock<Mutex<HashMap<u64, Arc<Client>>>> = LazyLock::new(Mutex::default);
/// Listens run one at a time in the order asked, as node's binds did (a test's two computers start together).
static LISTENS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) fn instance(id: u64) -> Option<Arc<Devices>> {
    locked(&INSTANCES).get(&id).cloned()
}

fn instance_or_fault(id: u64) -> Result<Arc<Devices>, Fault> {
    instance(id).ok_or_else(|| Fault::new("no_devices", "No such devices instance"))
}

fn text(record: &Map<String, Value>, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn is_ip(text: &str) -> bool {
    text.parse::<std::net::IpAddr>().is_ok()
}

impl Devices {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        locked(&self.inner)
    }

    fn this(&self) -> Arc<Devices> {
        self.me
            .upgrade()
            .expect("an instance is held while it runs")
    }

    pub fn name(&self) -> String {
        self.inner().name.clone()
    }

    fn log(&self, event: &str, details: Value) {
        self.events.send(
            "remote.log",
            &json!({"host": self.id, "event": event, "details": details}),
        );
    }

    async fn status(&self) -> Option<Value> {
        match self.source {
            Source::Core(tailnet) => tailnet::status(tailnet, None).await,
            Source::Main => super::ask(
                &self.events,
                "tailnet",
                json!({"devices": self.id, "op": "status"}),
            )
            .await
            .filter(Value::is_object),
        }
    }

    async fn phase(&self) -> String {
        match self.source {
            Source::Core(tailnet) => tailnet::phase(tailnet, None).await.to_owned(),
            Source::Main => super::ask(
                &self.events,
                "tailnet",
                json!({"devices": self.id, "op": "phase"}),
            )
            .await
            .and_then(|phase| phase.as_str().map(str::to_owned))
            .unwrap_or_else(|| "not-running".into()),
        }
    }

    async fn whois(&self, ip: &str) -> Option<Value> {
        match self.source {
            Source::Core(tailnet) => tailnet::whois(tailnet, ip, None).await,
            Source::Main => super::ask(
                &self.events,
                "tailnet",
                json!({"devices": self.id, "op": "whois", "ip": ip}),
            )
            .await
            .filter(Value::is_object),
        }
    }

    /// What main mirrors, after every change.
    fn tell(&self) {
        let snapshot = self.snapshot();
        self.events.send("remote.devices.state", &snapshot);
        if let Some(effects) = &self.effects {
            effects.changed(snapshot);
        }
    }

    fn snapshot(&self) -> Value {
        let peers = locked(&self.peers).list();
        let hosts = locked(&self.hosts).list();
        let inner = self.inner();
        let addresses = inner.host.addresses();
        json!({
                "devices": self.id,
                "phase": inner.phase,
                "tailnetName": inner.tailnet_name,
                "host": {
                    "port": inner.host.port,
                    "addresses": addresses,
                    "listenError": inner.host.listen_error,
                },
                "peers": peers,
                "hosts": hosts,
                "patched": inner.patched,
        })
    }

    /// The host's keep-awake follows sharing, General's switch, its device links and its devices' running turns.
    fn keep_awake(&self) {
        let Some(policy) = self.keep_awake else {
            return;
        };
        let input = {
            let inner = self.inner();
            crate::keepawake::Input {
                enabled: !inner.disposed && inner.host.running && inner.keep_awake_enabled,
                connected: !inner.host.links.is_empty(),
                running: inner.running_tabs,
            }
        };
        crate::keepawake::update(policy, input);
    }

    // ---- the poll -------------------------------------------------------------------------------------------

    /// Read Tailscale's side: phase, this computer's login, the host's addresses, the code-paired hosts.
    async fn poll(&self) {
        if self.inner().disposed {
            return;
        }
        let phase = self.phase().await;
        let status = if phase == "ready" {
            self.status().await
        } else {
            None
        };
        if let Some(status) = &status {
            if let Some(login) = status.get("login").and_then(Value::as_str) {
                self.events.send(
                    "remote.devices.adoptLogin",
                    &json!({"devices": self.id, "login": login}),
                );
                if let Some(effects) = &self.effects {
                    effects.adopt_login(login);
                }
            }
            if let Some(name) = status.get("selfName").and_then(Value::as_str) {
                self.inner().tailnet_name = Some(name.to_owned());
            }
            let this = self.this();
            let status = status.clone();
            self.migrating
                .run(|| async move { this.migrate(&status).await })
                .await;
        }
        if let Some(status) = &status {
            self.wake_returned_hosts(status);
        }
        self.rebind().await;
        let phase = phase_name(&phase);
        let changed = {
            let mut inner = self.inner();
            let changed = inner.phase != phase;
            inner.phase = phase;
            changed
        };
        // Back on the tailnet: known hosts are reachable at their nodes again.
        if changed && phase == "ready" {
            self.wake("tailnet");
        }
        self.tell();
    }

    /// A host whose node was offline in the last poll and is online now: its link checks or retries at once.
    fn wake_returned_hosts(&self, status: &Value) {
        let peers = status.get("peers").and_then(Value::as_array);
        let hosts = locked(&self.hosts).list();
        for host in hosts {
            let (Some(device), Some(node)) = (text(&host, "deviceId"), text(&host, "nodeId"))
            else {
                continue;
            };
            let online = peers.is_some_and(|peers| {
                peers.iter().any(|peer| {
                    peer.get("nodeId").and_then(Value::as_str) == Some(&node)
                        && peer.get("online") == Some(&Value::Bool(true))
                })
            });
            let client = {
                let mut inner = self.inner();
                let was = inner.node_online.insert(node, online);
                (online && was == Some(false))
                    .then(|| inner.clients.get(&device).cloned())
                    .flatten()
            };
            if let Some(client) = client {
                client.wake("tailnet");
            }
        }
    }

    /// Hosts an older release paired by code have no node: each is matched to a node once (stored address among the
    /// node's tailnet addresses, then among its endpoints, then its announced name), the rest forgotten.
    async fn migrate(&self, status: &Value) {
        if self.inner().migrated_at.is_some() {
            return;
        }
        let candidates: Vec<&Value> = status
            .get("peers")
            .and_then(Value::as_array)
            .map(|peers| {
                peers
                    .iter()
                    .filter(|peer| peer.get("login").is_some_and(|login| !login.is_null()))
                    .collect()
            })
            .unwrap_or_default();
        let has = |peer: &Value, key: &str, stored: &HashSet<String>| {
            client::strings(peer.get(key))
                .iter()
                .any(|item| stored.contains(item))
        };
        let lower = |text: &str| crate::fs::order::js_trim(text).to_lowercase();
        let mut forgotten = Vec::new();
        let mut removed = Vec::new();
        let hosts = locked(&self.hosts).list();
        for host in hosts {
            if host.get("nodeId").is_some_and(|node| !node.is_null()) {
                continue;
            }
            let Some(device) = text(&host, "deviceId") else {
                continue;
            };
            let stored: HashSet<String> = client::strings(host.get("addresses"))
                .iter()
                .filter_map(|text| {
                    address::parse(text, address::DEFAULT_REMOTE_PORT).map(|target| target.host)
                })
                .collect();
            let name = lower(&text(&host, "name").unwrap_or_default());
            let node = candidates
                .iter()
                .find(|peer| has(peer, "ips", &stored))
                .or_else(|| {
                    candidates
                        .iter()
                        .find(|peer| has(peer, "endpoints", &stored))
                })
                .or_else(|| {
                    candidates.iter().find(|peer| {
                        lower(peer.get("name").and_then(Value::as_str).unwrap_or_default()) == name
                    })
                });
            if let Some(node) = node {
                // Its stored addresses (LAN, old ports) are of no use any more: the node's tailnet address is.
                let _ = locked(&self.hosts).update(
                    &device,
                    vec![
                        (
                            "nodeId".into(),
                            Some(node.get("nodeId").cloned().unwrap_or(Value::Null)),
                        ),
                        ("addresses".into(), Some(json!([]))),
                    ],
                );
                let client = self.inner().clients.get(&device).cloned();
                if let Some(client) = client {
                    client.connect();
                }
                continue;
            }
            self.unlink(&device);
            let _ = locked(&self.hosts).remove(&device);
            forgotten.push(text(&host, "name").unwrap_or_default());
            removed.push(device);
        }
        let at = clock::now_ms();
        self.inner().migrated_at = Some(at as f64);
        self.events.send(
            "remote.devices.migrated",
            &json!({"devices": self.id, "at": at, "forgotten": forgotten, "removed": removed}),
        );
        if let Some(effects) = &self.effects {
            effects.migrated(at as f64, forgotten, removed);
        }
    }

    /// A device an older release paired by code that never connected over Tailscale goes after the grace period.
    fn forget_stale_legacy_peers(&self) {
        let Some(migrated_at) = self.inner().migrated_at else {
            return;
        };
        if (clock::now_ms() as f64) - migrated_at < LEGACY_PEER_GRACE_MS as f64 {
            return;
        }
        let mut peers = locked(&self.peers);
        for peer in peers.list() {
            if peer.get("nodeId").is_none_or(Value::is_null)
                && let Some(device) = text(&peer, "deviceId")
            {
                let _ = peers.remove(&device);
            }
        }
    }

    fn wake(&self, trigger: &str) {
        let clients: Vec<Arc<Client>> = self.inner().clients.values().cloned().collect();
        for client in clients {
            client.wake(trigger);
        }
    }

    fn unlink(&self, device: &str) {
        let client = self.inner().clients.remove(device);
        if let Some(client) = client {
            locked(&CLIENTS).remove(&client.id);
            client.close();
        }
    }

    // ---- the host role --------------------------------------------------------------------------------------

    /// This computer's tailnet addresses: the only ones the host listens on.
    async fn bind_hosts(&self) -> Vec<String> {
        let Some(status) = self.status().await else {
            return Vec::new();
        };
        if status.get("backend").and_then(Value::as_str) != Some("running") {
            return Vec::new();
        }
        let loopback = self.inner().loopback;
        client::strings(status.get("selfIps"))
            .into_iter()
            .filter(|ip| {
                tailnet::is_tailnet_address(ip) || (loopback && (ip == "127.0.0.1" || ip == "::1"))
            })
            .collect()
    }

    async fn start_host(&self) {
        {
            let mut inner = self.inner();
            if inner.disposed {
                return;
            }
            inner.host.running = true;
        }
        self.rebind().await;
        self.keep_awake();
        self.tell();
    }

    async fn stop_host(&self) {
        self.inner().host.running = false;
        self.binding.wait().await;
        host::stop(self.id).await;
        {
            let mut inner = self.inner();
            let role = &mut inner.host;
            role.arriving.clear();
            role.bound.clear();
            role.listening.clear();
            role.port = None;
            role.listen_error = None;
            role.logged = None;
        }
        self.keep_awake();
        self.tell();
    }

    /// Listen on exactly the current tailnet addresses, or try the ports again; concurrent calls share one pass.
    async fn rebind(&self) {
        let this = self.this();
        self.binding
            .run(|| async move { this.rebind_pass().await })
            .await;
    }

    async fn rebind_pass(&self) {
        if !self.inner().host.running {
            return;
        }
        let began = clock::now_ms();
        let this = self.this();
        let slow = clock::after(Duration::from_millis(REBIND_SLOW_MS), move || {
            let links = this.inner().host.links.len();
            this.log("rebind-slow", json!({"links": links}));
        });
        let mut wanted = self.bind_hosts().await;
        wanted.sort();
        wanted.dedup();
        let proceed = {
            let inner = self.inner();
            let role = &inner.host;
            role.running && !(wanted == role.bound && (role.port.is_some() || wanted.is_empty()))
        };
        if proceed {
            self.listen_on(&wanted).await;
            self.log_listen(wanted.len(), clock::now_ms().saturating_sub(began));
            self.tell();
        }
        slow.cancel();
    }

    async fn listen_on(&self, hosts: &[String]) {
        {
            let mut inner = self.inner();
            let role = &mut inner.host;
            role.bound.clear();
            role.listening.clear();
            role.port = None;
            role.listen_error = None;
        }
        let params = ListenParams {
            host: self.id,
            addresses: hosts.to_vec(),
            port: self.port,
            port_setting: self.port_setting.clone(),
            app_version: self.app_version.clone(),
            liveness: self.liveness,
            traffic: self.traffic,
            traffic_ms: self.traffic_ms,
            refuse: self.refuse.clone(),
        };
        let listened = {
            let _turn = LISTENS.lock().await;
            host::listen(params, self.events.clone(), Arc::clone(&self.identity)).await
        };
        let Ok(listened) = listened else {
            return;
        };
        let mut inner = self.inner();
        let role = &mut inner.host;
        role.port = listened.port;
        role.listening = listened.listening;
        role.listen_error = listened.listen_error;
        if role.port.is_some() {
            role.bound = hosts.to_vec();
        }
    }

    /// Where it listens after a rebind that changed it: ports and counts, never an address; once per change.
    fn log_listen(&self, wanted: usize, ms: u64) {
        let (event, details, links) = {
            let mut inner = self.inner();
            let links = inner.host.links.len();
            let (event, details) = match inner.host.port {
                None => ("not-listening", json!({"wanted": wanted})),
                Some(port) => (
                    "listening",
                    json!({"port": port, "addresses": inner.host.listening.len()}),
                ),
            };
            let said = format!("{event} {details}");
            if inner.host.logged.as_deref() == Some(said.as_str()) {
                return;
            }
            inner.host.logged = Some(said);
            (event, details, links)
        };
        let mut details = details;
        details["links"] = links.into();
        details["ms"] = ms.into();
        self.log(event, details);
    }

    // ---- the tailnet's computers ----------------------------------------------------------------------------

    /// Where a node's host answers: the first candidate port that answers a probe, on the node's address.
    async fn probe_node(&self, node: &Value) -> (Option<String>, Probe) {
        let ips = client::strings(node.get("ips"));
        let Some(ip) = ips
            .iter()
            .find(|ip| address::is_ipv4(ip))
            .or_else(|| ips.iter().find(|ip| is_ip(ip)))
        else {
            return (None, Probe::Refused("unreachable".into()));
        };
        let node_id = node
            .get("nodeId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let last = self.inner().found.get(&node_id).cloned();
        let addresses = self.candidates(ip, last.as_deref());
        // This computer itself (a test's two apps on one address) is passed over.
        let (address, probe) = dial::probe_any(&addresses, Some(&self.identity.device_id)).await;
        let mut inner = self.inner();
        match &address {
            Some(found) => {
                inner.found.insert(node_id, found.clone());
            }
            None => {
                inner.found.remove(&node_id);
            }
        }
        (address, probe)
    }

    fn candidates(&self, ip: &str, first: Option<&str>) -> Vec<String> {
        super::candidate_addresses(ip, first, self.port_setting.as_deref())
    }

    async fn scan(&self) -> Vec<Map<String, Value>> {
        let this = self.this();
        self.scanning
            .run(|| async move { this.scan_once().await })
            .await;
        self.inner().computers.clone()
    }

    async fn scan_once(&self) {
        let status = self.status().await;
        let nodes: Vec<Value> = match &status {
            Some(status) if status.get("backend").and_then(Value::as_str) == Some("running") => {
                status
                    .get("peers")
                    .and_then(Value::as_array)
                    .map(|peers| {
                        peers
                            .iter()
                            .filter(|peer| {
                                peer.get("online") == Some(&Value::Bool(true))
                                    && !peer
                                        .get("os")
                                        .and_then(Value::as_str)
                                        .is_some_and(is_mobile_os)
                            })
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        };
        let next = Arc::new(Mutex::new(0usize));
        let nodes = Arc::new(nodes);
        let results: Arc<Mutex<Found>> = Arc::new(Mutex::new(vec![None; nodes.len()]));
        let mut workers = tokio::task::JoinSet::new();
        for _ in 0..PROBE_CONCURRENCY.min(nodes.len()) {
            let (this, next, nodes, results) = (
                self.this(),
                Arc::clone(&next),
                Arc::clone(&nodes),
                Arc::clone(&results),
            );
            workers.spawn(async move {
                loop {
                    let index = {
                        let mut next = locked(&next);
                        let index = *next;
                        *next += 1;
                        index
                    };
                    let Some(node) = nodes.get(index) else {
                        break;
                    };
                    let (address, probe) = this.probe_node(node).await;
                    locked(&results)[index] = Some(computer(node, address.as_deref(), &probe));
                }
            });
        }
        while workers.join_next().await.is_some() {}
        let computers: Vec<Map<String, Value>> = locked(&results).drain(..).flatten().collect();
        self.inner().computers = computers;
        self.mark_computers();
    }

    /// Mark the computers this device already uses, and push the list.
    fn mark_computers(&self) {
        let nodes: HashSet<String> = locked(&self.hosts)
            .list()
            .iter()
            .filter_map(|host| text(host, "nodeId"))
            .collect();
        let computers = {
            let mut inner = self.inner();
            for computer in &mut inner.computers {
                let connected = computer
                    .get("nodeId")
                    .and_then(Value::as_str)
                    .is_some_and(|node| nodes.contains(node));
                computer.insert("connected".into(), connected.into());
            }
            inner.computers.clone()
        };
        self.events.send(
            "remote.devices.computers",
            &json!({"devices": self.id, "computers": computers}),
        );
        if let Some(effects) = &self.effects {
            effects.computers(computers);
        }
    }

    /// A known host's addresses now: its node's current tailnet address on the port it answered on in this run, then
    /// on every candidate port. Stored addresses are never dialed; a host with no node has nothing to dial.
    async fn host_addresses(&self, host: Map<String, Value>) -> Vec<String> {
        let Some(node_id) = text(&host, "nodeId") else {
            return Vec::new();
        };
        let Some(status) = self.status().await else {
            return Vec::new();
        };
        let node = status
            .get("peers")
            .and_then(Value::as_array)
            .and_then(|peers| {
                peers
                    .iter()
                    .find(|peer| peer.get("nodeId").and_then(Value::as_str) == Some(&node_id))
            });
        let ips = client::strings(node.and_then(|node| node.get("ips")));
        let Some(ip) = ips.iter().find(|ip| address::is_ipv4(ip)).or(ips.first()) else {
            return Vec::new();
        };
        let (found, own) = {
            let inner = self.inner();
            (inner.found.get(&node_id).cloned(), inner.host.addresses())
        };
        // This computer's own host is never the one dialed, as the probe passes it over: two apps on one address (the
        // rig's loopback, the e2e harness) that restarted in the other order hold each other's former ports, and the
        // first dial would reach its own host, whose refusal is not the host's answer and ends the attempt.
        let mut addresses = self.candidates(ip, found.as_deref());
        addresses.retain(|address| !own.contains(address));
        addresses
    }

    /// Connect to a computer of the tailnet by its node; pins its key (`key_mismatch` for another one).
    async fn connect(
        &self,
        node_id: &str,
        capabilities: &Map<String, Value>,
    ) -> Result<Map<String, Value>, Failure> {
        let status = self.status().await;
        if status
            .as_ref()
            .and_then(|status| status.get("backend"))
            .and_then(Value::as_str)
            != Some("running")
        {
            return Err(Failure::new("tailscale_off", "Tailscale is not running"));
        }
        let node = status
            .as_ref()
            .and_then(|status| status.get("peers"))
            .and_then(Value::as_array)
            .and_then(|peers| {
                peers
                    .iter()
                    .find(|peer| peer.get("nodeId").and_then(Value::as_str) == Some(node_id))
            })
            .cloned()
            .ok_or_else(|| Failure::new("unreachable", "That computer is not on the tailnet"))?;
        let (address, probe) = self.probe_node(&node).await;
        let Some(address) = address else {
            return Err(Failure::new(
                "unreachable",
                "OMPdesk does not answer on that computer",
            ));
        };
        if let Probe::Refused(code) = probe {
            return Err(Failure::new(&code, code.clone()));
        }
        let name = self.name();
        let record = client::connect_first(
            &self.hosts,
            &self.identity,
            &address,
            &name,
            &self.app_version,
            node_id,
            capabilities,
        )
        .await?;
        self.inner().found.insert(node_id.to_owned(), address);
        self.mark_computers();
        self.tell();
        Ok(record)
    }

    async fn dispose(&self) {
        let clients: Vec<Arc<Client>> = {
            let mut inner = self.inner();
            inner.disposed = true;
            for timer in [inner.poll_timer.take(), inner.scan_timer.take()]
                .into_iter()
                .flatten()
            {
                timer.abort();
            }
            inner.clients.drain().map(|(_, client)| client).collect()
        };
        for client in clients {
            locked(&CLIENTS).remove(&client.id);
            client.close();
        }
        self.stop_host().await;
        locked(&INSTANCES).remove(&self.id);
    }
}

fn phase_name(phase: &str) -> &'static str {
    match phase {
        "ready" => "ready",
        "needs-login" => "needs-login",
        "not-installed" => "not-installed",
        _ => "not-running",
    }
}

/// Each probed node's computer, in the tailnet's order.
type Found = Vec<Option<Map<String, Value>>>;

/// Phones and tablets run no OMPdesk: never probed.
fn is_mobile_os(os: &str) -> bool {
    ["ios", "ipados", "android"]
        .iter()
        .any(|mobile| os.eq_ignore_ascii_case(mobile))
}

fn computer(node: &Value, address: Option<&str>, probe: &Probe) -> Map<String, Value> {
    let field = |key: &str| node.get(key).cloned().unwrap_or(Value::Null);
    let (name, state, refusal, device) = match (address, probe) {
        (
            Some(_),
            Probe::Ok {
                device_id, name, ..
            },
        ) => (
            Value::from(name.clone()),
            "available",
            Value::Null,
            Value::from(device_id.clone()),
        ),
        (Some(_), Probe::Refused(code)) => (
            field("name"),
            "refused",
            Value::from(code.clone()),
            Value::Null,
        ),
        (
            None,
            Probe::Ok {
                device_id, name, ..
            },
        ) => (
            Value::from(name.clone()),
            "absent",
            Value::Null,
            Value::from(device_id.clone()),
        ),
        (None, Probe::Refused(_)) => (field("name"), "absent", Value::Null, Value::Null),
    };
    let mut computer = Map::new();
    computer.insert("nodeId".into(), field("nodeId"));
    computer.insert("name".into(), name);
    computer.insert("login".into(), field("login"));
    computer.insert("state".into(), state.into());
    computer.insert("refusal".into(), refusal);
    computer.insert("deviceId".into(), device);
    computer.insert("connected".into(), false.into());
    computer
}

/// A devices instance's clients find their host at its node's tailnet address.
struct AtNode(Weak<Devices>);

impl Addresses for AtNode {
    fn resolve(
        &self,
        host: Map<String, Value>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Vec<String>> + Send>> {
        let devices = self.0.upgrade();
        Box::pin(async move {
            match devices {
                Some(devices) => devices.host_addresses(host).await,
                None => Vec::new(),
            }
        })
    }
}

// ---- the host's handshake decisions, called by `host.rs` -----------------------------------------------------

/// A connection to this instance's host was taken in: its handshake starts (the `open` line's `ms` counts from here).
pub(crate) fn accepted(devices: u64, link: u64) {
    if let Some(devices) = instance(devices) {
        devices
            .inner()
            .host
            .arriving
            .insert(link, (clock::now_ms(), None));
    }
}

/// What main is told with a device's hello: its record, and how long the handshake took. None drops the connection
/// (a device removed while its handshake ran).
pub(crate) fn arriving(devices: u64, link: u64) -> Option<(Map<String, Value>, u64)> {
    let devices = instance(devices)?;
    let (at, peer) = devices.inner().host.arriving.get(&link).cloned()?;
    let device = text(peer.as_ref()?, "deviceId")?;
    let current = locked(&devices.peers).get(&device)?;
    Some((current, clock::now_ms().saturating_sub(at)))
}

/// Main took the device's link (`open` answered with its hello): its record names it and says when it was seen.
pub(crate) fn opened(devices: u64, link: u64, name: Option<&str>, app_version: Option<&str>) {
    let Some(devices) = instance(devices) else {
        return;
    };
    let Some((_, Some(peer))) = devices.inner().host.arriving.remove(&link) else {
        return;
    };
    let Some(device) = text(&peer, "deviceId") else {
        return;
    };
    let mut patch = Vec::new();
    if let Some(name) = name {
        patch.push(("name".into(), Some(Value::from(name))));
    }
    patch.push(("lastSeenAt".into(), Some(Value::from(clock::now_ms()))));
    let _ = locked(&devices.peers).update(&device, patch);
    {
        let mut inner = devices.inner();
        inner.host.links.insert(link, device.clone());
        if let Some(version) = app_version {
            inner.host.versions.insert(link, version.to_owned());
        }
    }
    let weak = Arc::downgrade(&devices);
    super::on_link_end(link, move |_| {
        if let Some(devices) = weak.upgrade() {
            devices.link_closed(link);
        }
    });
    devices.tell();
    devices.keep_awake();
    // The computer that just connected may be one this device uses as a host: it is up, so dial it now.
    let client = devices.inner().clients.get(&device).cloned();
    if let Some(client) = client {
        client.wake("peer");
    }
}

/// A connection ended before main took it.
pub(crate) fn dropped(devices: u64, link: u64) {
    if let Some(devices) = instance(devices) {
        devices.inner().host.arriving.remove(&link);
    }
}

impl Devices {
    fn link_closed(&self, link: u64) {
        let Some(device) = self.inner().host.links.remove(&link) else {
            return;
        };
        self.inner().host.versions.remove(&link);
        let _ = locked(&self.peers).update(
            &device,
            vec![("lastSeenAt".into(), Some(Value::from(clock::now_ms())))],
        );
        self.tell();
        self.keep_awake();
    }
}

// ---- methods ---------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    identity: String,
    user_data: PathBuf,
    app_version: String,
    name: String,
    #[serde(default)]
    loopback: bool,
    port: Option<u32>,
    port_setting: Option<String>,
    #[serde(default)]
    refuse: HashMap<String, String>,
    liveness: Option<Liveness>,
    #[serde(default)]
    traffic: bool,
    traffic_ms: Option<u64>,
    /// The core's tailnet instance (`remote.tailnet.open`); absent: main answers (`tailnet` asks).
    tailnet: Option<u64>,
    /// The host's keep-awake policy (`keepAwake.open`), driven from here.
    keep_awake: Option<u64>,
    #[serde(default)]
    keep_awake_enabled: bool,
    /// Pref `remote.tailnetMigratedAt`; absent: code-paired hosts are matched on the first poll.
    migrated_at: Option<f64>,
}

async fn open(call: Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    let identity = super::identity(&params.identity)?;
    let source = params.tailnet.map_or(Source::Main, Source::Core);
    let devices = Devices::construct(
        native::Config {
            events: call.events.clone(),
            identity,
            user_data: params.user_data,
            app_version: params.app_version,
            name: params.name,
            loopback: params.loopback,
            port: params.port,
            port_setting: params.port_setting,
            refuse: params.refuse,
            liveness: params.liveness,
            traffic: params.traffic,
            traffic_ms: params.traffic_ms,
            keep_awake: params.keep_awake,
            keep_awake_enabled: params.keep_awake_enabled,
            migrated_at: params.migrated_at,
        },
        source,
        None,
    );
    Reply::json(&json!({"devices":devices.id,"state":devices.snapshot()}))
}

impl Devices {
    fn construct(
        params: native::Config,
        source: Source,
        effects: Option<Arc<dyn native::Effects>>,
    ) -> Arc<Self> {
        let id = super::next_id();
        let devices = Arc::new_cyclic(|me| Devices {
            id,
            events: params.events,
            identity: params.identity,
            app_version: params.app_version,
            port: params.port,
            port_setting: params.port_setting,
            refuse: params.refuse,
            liveness: params.liveness,
            traffic: params.traffic,
            traffic_ms: params.traffic_ms,
            source,
            keep_awake: params.keep_awake,
            peers: store::open(&params.user_data, Kind::Peers),
            hosts: store::open(&params.user_data, Kind::Hosts),
            effects,
            inner: Mutex::new(Inner {
                name: params.name,
                loopback: params.loopback,
                keep_awake_enabled: params.keep_awake_enabled,
                running_tabs: false,
                migrated_at: params.migrated_at,
                disposed: false,
                phase: "not-running",
                tailnet_name: None,
                host: HostRole::default(),
                clients: HashMap::new(),
                found: HashMap::new(),
                node_online: HashMap::new(),
                computers: Vec::new(),
                watchers: HashSet::new(),
                poll_timer: None,
                scan_timer: None,
                patched: 0,
            }),
            binding: Pass::default(),
            migrating: Pass::default(),
            scanning: Pass::default(),
            me: me.clone(),
        });
        locked(&INSTANCES).insert(id, Arc::clone(&devices));
        devices
    }
}

#[derive(Deserialize)]
struct DevicesParams {
    devices: u64,
}

/// Launch: forget stale code-paired devices, read Tailscale now and every `TAILNET_POLL_MS`.
async fn start(call: Call) -> Result<Reply, Fault> {
    let params: DevicesParams = call.params()?;
    let devices = instance_or_fault(params.devices)?;
    devices.launch();
    Reply::json(&Value::Null)
}

/// One poll now (a Tailscale action finished); answered once it ran.
async fn poll(call: Call) -> Result<Reply, Fault> {
    let params: DevicesParams = call.params()?;
    instance_or_fault(params.devices)?.poll().await;
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct SetHostParams {
    devices: u64,
    enabled: bool,
}

async fn set_host(call: Call) -> Result<Reply, Fault> {
    let params: SetHostParams = call.params()?;
    let devices = instance_or_fault(params.devices)?;
    if params.enabled {
        devices.start_host().await;
    } else {
        devices.stop_host().await;
    }
    Reply::json(&Value::Null)
}

async fn rebind(call: Call) -> Result<Reply, Fault> {
    let params: DevicesParams = call.params()?;
    instance_or_fault(params.devices)?.rebind().await;
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
struct WatchParams {
    devices: u64,
    watcher: u64,
    on: bool,
}

/// A view shows (`on`) or stops showing the tailnet's computers; answers what is known now.
async fn watch_tailnet(call: Call) -> Result<Reply, Fault> {
    let params: WatchParams = call.params()?;
    let devices = instance_or_fault(params.devices)?;
    Reply::json(&devices.watch(params.watcher, params.on).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectParams {
    devices: u64,
    node_id: String,
    #[serde(default)]
    capabilities: Map<String, Value>,
}

/// `{host}`, or `{failed: {code, message}}` with the code main maps to `remote_<code>`.
async fn connect(call: Call) -> Result<Reply, Fault> {
    let params: ConnectParams = call.params()?;
    let devices = instance_or_fault(params.devices)?;
    match devices.connect(&params.node_id, &params.capabilities).await {
        Ok(host) => Reply::json(&json!({"host": host})),
        Err(failure) => {
            Reply::json(&json!({"failed": {"code": failure.code, "message": failure.message}}))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceParams {
    devices: u64,
    device_id: String,
}

/// Forget a device and drop its connections; it may come back while its login is allowed.
async fn revoke(call: Call) -> Result<Reply, Fault> {
    let params: DeviceParams = call.params()?;
    let devices = instance_or_fault(params.devices)?;
    let removed = devices.revoke_peer(&params.device_id)?;
    Reply::json(&removed)
}

/// A known host removed here: its link ends and its record goes.
async fn remove_host(call: Call) -> Result<Reply, Fault> {
    let params: DeviceParams = call.params()?;
    let devices = instance_or_fault(params.devices)?;
    devices.remove_host(&params.device_id)?;
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerNameParams {
    devices: u64,
    device_id: String,
    name: String,
}

/// A connected device named itself (`peer.name`).
async fn peer_name(call: Call) -> Result<Reply, Fault> {
    let params: PeerNameParams = call.params()?;
    let devices = instance_or_fault(params.devices)?;
    let updated = locked(&devices.peers)
        .update(
            &params.device_id,
            vec![("name".into(), Some(Value::from(params.name)))],
        )
        .map_err(|error| Fault::new("io", error.to_string()))?;
    devices.tell();
    Reply::json(&updated)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigureParams {
    devices: u64,
    name: Option<String>,
    loopback: Option<bool>,
    keep_awake_enabled: Option<bool>,
    running: Option<bool>,
}

fn configure(push: PushCall) {
    let Ok(params) = serde_json::from_str::<ConfigureParams>(push.params.get()) else {
        return;
    };
    let Some(devices) = instance(params.devices) else {
        return;
    };
    let clients: Vec<Arc<Client>> = {
        let mut inner = devices.inner();
        if let Some(loopback) = params.loopback {
            inner.loopback = loopback;
        }
        if let Some(enabled) = params.keep_awake_enabled {
            inner.keep_awake_enabled = enabled;
        }
        if let Some(running) = params.running {
            inner.running_tabs = running;
        }
        match &params.name {
            Some(name) => {
                inner.name = name.clone();
                inner.clients.values().cloned().collect()
            }
            None => Vec::new(),
        }
    };
    if let Some(name) = &params.name {
        for client in clients {
            client.set_name(name);
        }
    }
    devices.keep_awake();
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchParams {
    devices: u64,
    seq: u64,
    device_id: String,
    /// The fields main's quota wrote (`limits`, `usage`); a null value removes the field.
    patch: Map<String, Value>,
}

/// Main's quota changed a device's limits or counts: applied in the order sent, told with the next state.
fn peer_patch(push: PushCall) {
    let Ok(params) = serde_json::from_str::<PatchParams>(push.params.get()) else {
        return;
    };
    let Some(devices) = instance(params.devices) else {
        return;
    };
    let patch = params
        .patch
        .into_iter()
        .map(|(key, value)| (key, (!value.is_null()).then_some(value)))
        .collect();
    let _ = locked(&devices.peers).update(&params.device_id, patch);
    devices.inner().patched = params.seq;
}

fn wake_push(push: PushCall) {
    #[derive(Deserialize)]
    struct WakeParams {
        devices: u64,
        trigger: String,
    }
    if let Ok(params) = serde_json::from_str::<WakeParams>(push.params.get())
        && let Some(devices) = instance(params.devices)
    {
        devices.wake(&params.trigger);
    }
}

async fn dispose(call: Call) -> Result<Reply, Fault> {
    let params: DevicesParams = call.params()?;
    if let Some(devices) = instance(params.devices) {
        devices.dispose().await;
    }
    Reply::json(&Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientOpenParams {
    /// A devices instance's client finds its host on the tailnet and is woken with it; without, it dials the
    /// record's stored addresses (the transport tests).
    devices: Option<u64>,
    identity: String,
    /// Where `remote-hosts.json` is (a devices instance's own when absent).
    user_data: Option<PathBuf>,
    host: Map<String, Value>,
    app_version: String,
    name: String,
    #[serde(default)]
    capabilities: Map<String, Value>,
    liveness: Option<Liveness>,
}

async fn client_open(call: Call) -> Result<Reply, Fault> {
    let params: ClientOpenParams = call.params()?;
    let identity = super::identity(&params.identity)?;
    let devices = params.devices.map(instance_or_fault).transpose()?;
    let store = match (&params.user_data, &devices) {
        (Some(user_data), _) => Some(store::open(user_data, Kind::Hosts)),
        (None, Some(devices)) => Some(Arc::clone(&devices.hosts)),
        (None, None) => None,
    };
    let addresses: Box<dyn Addresses> = match &devices {
        Some(devices) => Box::new(AtNode(Arc::downgrade(devices))),
        None => Box::new(Stored),
    };
    let client = Client::new(ClientOptions {
        events: call.events.clone(),
        identity,
        host: params.host,
        name: params.name,
        app_version: params.app_version,
        capabilities: params.capabilities,
        liveness: params.liveness.unwrap_or_default(),
        store,
        addresses,
    });
    locked(&CLIENTS).insert(client.id, Arc::clone(&client));
    if let Some(devices) = devices {
        let old = devices
            .inner()
            .clients
            .insert(client.device_id.clone(), Arc::clone(&client));
        if let Some(old) = old {
            locked(&CLIENTS).remove(&old.id);
            old.close();
        }
    }
    Reply::json(&json!({"client": client.id}))
}

#[derive(Deserialize)]
struct ClientPush {
    client: u64,
    trigger: Option<String>,
    name: Option<String>,
}

fn on_client(push: &PushCall, act: impl FnOnce(&Arc<Client>, &ClientPush)) {
    let Ok(params) = serde_json::from_str::<ClientPush>(push.params.get()) else {
        return;
    };
    let client = locked(&CLIENTS).get(&params.client).cloned();
    if let Some(client) = client {
        act(&client, &params);
    }
}

fn client_close(push: PushCall) {
    on_client(&push, |client, _| {
        locked(&CLIENTS).remove(&client.id);
        for devices in locked(&INSTANCES).values() {
            let mut inner = devices.inner();
            if inner
                .clients
                .get(&client.device_id)
                .is_some_and(|held| held.id == client.id)
            {
                inner.clients.remove(&client.device_id);
            }
        }
        client.close();
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectFirstParams {
    identity: String,
    user_data: PathBuf,
    address: String,
    name: String,
    app_version: String,
    node_id: String,
    #[serde(default)]
    capabilities: Map<String, Value>,
}

/// First contact outside a devices instance (the transport tests' `connectFirst`).
async fn connect_first(call: Call) -> Result<Reply, Fault> {
    let params: ConnectFirstParams = call.params()?;
    let identity = super::identity(&params.identity)?;
    let store = store::open(&params.user_data, Kind::Hosts);
    match client::connect_first(
        &store,
        &identity,
        &params.address,
        &params.name,
        &params.app_version,
        &params.node_id,
        &params.capabilities,
    )
    .await
    {
        Ok(host) => Reply::json(&json!({"host": host})),
        Err(failure) => Reply::json(
            &json!({"failed": {"code": failure.code, "message": failure.message, "refused": false}}),
        ),
    }
}

pub fn register(registry: &mut Registry) {
    registry.add("remote.devices.open", |call| Box::pin(open(call)));
    registry.add("remote.devices.start", |call| Box::pin(start(call)));
    registry.add("remote.devices.poll", |call| Box::pin(poll(call)));
    registry.add("remote.devices.setHost", |call| Box::pin(set_host(call)));
    registry.add("remote.devices.rebind", |call| Box::pin(rebind(call)));
    registry.add("remote.devices.watch", |call| Box::pin(watch_tailnet(call)));
    registry.add("remote.devices.connect", |call| Box::pin(connect(call)));
    registry.add("remote.devices.revoke", |call| Box::pin(revoke(call)));
    registry.add("remote.devices.removeHost", |call| {
        Box::pin(remove_host(call))
    });
    registry.add("remote.devices.peerName", |call| Box::pin(peer_name(call)));
    registry.add("remote.devices.dispose", |call| Box::pin(dispose(call)));
    registry.add_push("remote.devices.configure", configure);
    registry.add_push("remote.devices.peerPatch", peer_patch);
    registry.add_push("remote.devices.wake", wake_push);
    registry.add("remote.client.open", |call| Box::pin(client_open(call)));
    registry.add("remote.connectFirst", |call| Box::pin(connect_first(call)));
    registry.add_push("remote.client.connect", |push| {
        on_client(&push, |client, _| client.connect());
    });
    registry.add_push("remote.client.wake", |push| {
        on_client(&push, |client, params| {
            client.wake(params.trigger.as_deref().unwrap_or("focus"));
        });
    });
    registry.add_push("remote.client.close", client_close);
    registry.add_push("remote.client.hostRenamed", |push| {
        on_client(&push, |client, params| {
            if let Some(name) = &params.name {
                client.host_renamed(name);
            }
        });
    });
    registry.add_push("remote.client.name", |push| {
        on_client(&push, |client, params| {
            if let Some(name) = &params.name {
                client.set_name(name);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_pass_dropped_midway_lets_the_next_one_run() {
        let pass = Arc::new(Pass::default());
        let (started, began) = tokio::sync::oneshot::channel::<()>();
        let running = Arc::clone(&pass);
        let aborted = tokio::spawn(async move {
            running
                .run(|| async move {
                    let _ = started.send(());
                    std::future::pending::<()>().await;
                })
                .await;
        });
        began.await.unwrap();
        let waiter = {
            let pass = Arc::clone(&pass);
            tokio::spawn(async move { pass.wait().await })
        };
        aborted.abort();
        let _ = aborted.await;
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("a waiter on the dropped pass goes on")
            .unwrap();
        let mut ran = false;
        let flag = &mut ran;
        tokio::time::timeout(
            Duration::from_secs(5),
            pass.run(move || async move { *flag = true }),
        )
        .await
        .expect("the next pass runs");
        assert!(
            ran,
            "the next pass ran its own work, not the dropped one's wait"
        );
    }

    #[test]
    fn phones_and_tablets_are_never_probed() {
        for os in ["iOS", "ipados", "ANDROID"] {
            assert!(is_mobile_os(os), "{os}");
        }
        for os in ["macOS", "windows", "linux", "iOSX", ""] {
            assert!(!is_mobile_os(os), "{os}");
        }
    }

    /// The rows `#scanOnce` built: a probe's name and device only when it let this device in, a refusal only from
    /// an address that answered.
    #[test]
    fn a_computer_row_says_what_its_probe_found() {
        let node = json!({"nodeId": "nPC", "name": "office", "login": "me@x"});
        let ok = Probe::Ok {
            device_id: "dev".into(),
            name: "Office PC".into(),
            app_version: "1.0.0".into(),
        };
        let row =
            |address: Option<&str>, probe: &Probe| Value::Object(computer(&node, address, probe));
        assert_eq!(
            row(Some("100.64.0.2:47821"), &ok),
            json!({"nodeId": "nPC", "name": "Office PC", "login": "me@x", "state": "available", "refusal": null, "deviceId": "dev", "connected": false})
        );
        assert_eq!(
            row(
                Some("100.64.0.2:47821"),
                &Probe::Refused("not_allowed".into())
            ),
            json!({"nodeId": "nPC", "name": "office", "login": "me@x", "state": "refused", "refusal": "not_allowed", "deviceId": null, "connected": false})
        );
        assert_eq!(
            row(None, &Probe::Refused("unreachable".into())),
            json!({"nodeId": "nPC", "name": "office", "login": "me@x", "state": "absent", "refusal": null, "deviceId": null, "connected": false})
        );
    }

    #[test]
    fn an_unknown_phase_reads_as_not_running() {
        for phase in ["ready", "needs-login", "not-installed", "not-running"] {
            assert_eq!(phase_name(phase), phase);
        }
        assert_eq!(phase_name("starting"), "not-running");
    }

    #[tokio::test]
    async fn a_pass_running_is_shared_by_a_second_caller() {
        let pass = Arc::new(Pass::default());
        let runs = Arc::new(Mutex::new(0));
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let first = {
            let (pass, runs) = (Arc::clone(&pass), Arc::clone(&runs));
            tokio::spawn(async move {
                pass.run(|| async move {
                    *locked(&runs) += 1;
                    let _ = released.await;
                })
                .await;
            })
        };
        while locked(&runs).eq(&0) {
            tokio::task::yield_now().await;
        }
        let second = {
            let (pass, runs) = (Arc::clone(&pass), Arc::clone(&runs));
            tokio::spawn(async move {
                pass.run(|| async move {
                    *locked(&runs) += 1;
                })
                .await;
            })
        };
        tokio::task::yield_now().await;
        let _ = release.send(());
        first.await.expect("first");
        second.await.expect("second");
        assert_eq!(*locked(&runs), 1);
        pass.run(|| async { *locked(&runs) += 1 }).await;
        assert_eq!(*locked(&runs), 2);
    }
}
