//! The remote host's application policy. `Host` is implemented by the native application over its existing pool,
//! session index, machine and file services. Its opaque Owner is constructed at the authenticated link handoff,
//! not by the network parser. The service never launches another worker or forwards effects to Node.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use super::delivery::DeliveryLedger;
use super::events::delta::{ReadEncoder, encoded_read_key};
use super::events::encoder::{BATCH_INTERVAL, Options, Sender};
use super::quota::{PeerQuota, assistant_tokens, command_uses_model};
use super::requests::{RemoteError, RemoteRequests};
use crate::remotebytes::native::LoopbackCallback;
use crate::server::Fault;

const GRACE: Duration = Duration::from_secs(10 * 60);
const MAX_COMMAND_MS: u64 = 960_000;
type ResultValue = Result<Value, RemoteError>;
type Key = (String, String);

#[derive(Clone, Debug)]
pub struct Peer {
    pub device_id: String,
    pub name: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Open {
    pub rtab: String,
    pub cwd: Option<String>,
    pub kind: Option<String>,
    #[serde(default)]
    pub fresh: bool,
    pub session_path: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub cwd: String,
    pub kind: String,
    pub status: String,
    pub status_detail: Value,
    pub process_alive: bool,
    pub omp: String,
    pub session_path: Option<String>,
    pub viewing: bool,
    pub busy: bool,
    pub awaiting_connection: bool,
    pub scheduled_retry: Value,
    pub views: usize,
    pub run: Value,
    pub asks: Vec<Value>,
    pub sign_ins: Vec<String>,
    pub pending_plan: Option<Value>,
    pub kept: Option<Value>,
}

/// Only the canonical native pool implementation chooses Target and Owner. `acquire` atomically applies its
/// session claim/tombstone/removal fencing and creates either one runner or a view. `close` ends views before
/// disposal, captures the pool's generation-bound exit receipt and waits for that exact generation to exit.
/// `command`/`side_channel` use the canonical answer/plan claims; this service has no second answer ledger.
pub trait Host: Send + Sync + 'static {
    type Owner: Clone + Send + Sync + 'static;
    type Target: Clone + Send + Sync + 'static;
    fn peer(&self, owner: &Self::Owner) -> Peer;
    fn acquire(
        &self,
        owner: &Self::Owner,
        options: Open,
    ) -> impl Future<Output = Result<Self::Target, Fault>> + Send;
    fn snapshot(&self, target: &Self::Target) -> Result<Snapshot, Fault>;
    /// Install before starting a target; callbacks run in source order before command completion, outside source locks.
    fn listen(
        &self,
        target: &Self::Target,
        event: Arc<dyn Fn(String, Value) + Send + Sync>,
    ) -> Result<(), Fault>;
    fn start(&self, target: &Self::Target) -> Result<(), Fault>;
    fn restart(
        &self,
        target: &Self::Target,
        cwd: Option<String>,
        session: Option<String>,
    ) -> Result<(), Fault>;
    fn adopt_cwd(&self, target: &Self::Target, cwd: String) -> Result<bool, Fault>;
    fn command(
        &self,
        owner: &Self::Owner,
        target: &Self::Target,
        command: Value,
        timeout: Option<Duration>,
    ) -> impl Future<Output = ResultValue> + Send;
    fn side_channel(
        &self,
        owner: &Self::Owner,
        target: &Self::Target,
        frame: Value,
    ) -> impl Future<Output = Result<(), Fault>> + Send;
    fn close(&self, target: Self::Target) -> impl Future<Output = Result<(), Fault>> + Send;
    fn cancel_wait(&self, target: &Self::Target) -> impl Future<Output = Result<(), Fault>> + Send;
    fn sync_image_generation(&self, target: &Self::Target) -> Result<(), Fault>;
    fn upload(
        &self,
        owner: &Self::Owner,
        upload: super::uploads::Upload,
    ) -> impl Future<Output = ResultValue> + Send;
    /// Validate with the owning native service before quota admission; do not run the operation until polled.
    fn prepare_request(
        &self,
        owner: &Self::Owner,
        request: HostRequest,
    ) -> Result<impl Future<Output = ResultValue> + Send, Fault>;
    fn disconnected(&self, owner: &Self::Owner);
    /// Same source change reaches local windows and phone pages, in addition to this service's remote links.
    fn publish(&self, event: &str, data: &Value);
}

#[derive(Clone, Copy, Debug)]
pub enum RequestKind {
    Session,
    File,
    Machine,
    Memory,
    Git,
    Terminal,
    LaunchProfile,
    Workspace,
    Device,
}
#[derive(Clone, Debug)]
pub struct HostRequest {
    pub kind: RequestKind,
    pub method: &'static str,
    pub params: Value,
    /// A resolved root is a scoped host tab's cwd, never a device-supplied replacement for an existing tab.
    pub root: Option<String>,
}

struct HostCall {
    name: String,
    request: Value,
    delivered: bool,
    resent: bool,
}
struct Tab<T> {
    target: T,
    rtab: String,
    peer: String,
    former: Vec<String>,
    connection: Option<RemoteRequests>,
    serial: u64,
    grace: u64,
    calls: HashMap<String, HostCall>,
    sender: Sender,
    slim: Value,
    reads: HashMap<String, ReadEncoder>,
    sent_commands: Option<String>,
    epoch: String,
    callback: Option<LoopbackCallback>,
}
struct State<T> {
    serial: u64,
    tabs: HashMap<Key, Tab<T>>,
    revisions: HashMap<Key, u64>,
    gates: HashMap<Key, Arc<AsyncMutex<()>>>,
    connections: HashMap<String, (RemoteRequests, Value)>,
    opening: HashSet<Key>,
}
impl<T> Default for State<T> {
    fn default() -> Self {
        Self {
            serial: 0,
            tabs: HashMap::new(),
            revisions: HashMap::new(),
            gates: HashMap::new(),
            connections: HashMap::new(),
            opening: HashSet::new(),
        }
    }
}

pub struct Config {
    /// The canonical pool/layout bound, supplied by native application assembly.
    pub max_former_tab_ids: usize,
}
#[derive(Clone)]
pub struct Resume {
    pub tab: String,
    pub cwd: String,
    pub kind: String,
    pub session_path: Option<String>,
}
pub struct HostServices<H: Host> {
    host: Arc<H>,
    quota: Arc<PeerQuota>,
    deliveries: DeliveryLedger,
    state: Mutex<State<H::Target>>,
    uploads: Mutex<super::uploads::UploadParts>,
    grace: Duration,
    config: Config,
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}
fn invalid(message: &str) -> RemoteError {
    Fault::new("invalid_params", message.to_owned()).into()
}
fn rtab(params: &Value) -> Result<&str, RemoteError> {
    params["rtab"]
        .as_str()
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 128)
        .ok_or_else(|| invalid("Invalid rtab"))
}
fn sign_in_unavailable() -> RemoteError {
    Fault::new(
        "sign_in_unavailable",
        "No browser sign-in in this tab waits for that callback",
    )
    .into()
}
fn callback_params(params: &Value) -> Result<(&str, &str), RemoteError> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid("Invalid callback"))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "rtab" | "path" | "query"))
    {
        return Err(invalid("Invalid callback"));
    }
    rtab(params)?;
    let path = params["path"]
        .as_str()
        .filter(|path| path.starts_with('/') && path.encode_utf16().count() <= 2048)
        .ok_or_else(|| invalid("Invalid callback path"))?;
    let query = params["query"]
        .as_str()
        .filter(|query| query.encode_utf16().count() <= 16384)
        .ok_or_else(|| invalid("Invalid callback query"))?;
    Ok((path, query))
}

struct Admission<T> {
    target: Option<T>,
    serial: u64,
    closed: Option<T>,
    revision: u64,
    callback: Option<LoopbackCallback>,
}

impl<H: Host> HostServices<H> {
    pub fn new(
        host: Arc<H>,
        quota: Arc<PeerQuota>,
        deliveries: DeliveryLedger,
        config: Config,
    ) -> Arc<Self> {
        Arc::new(Self {
            host,
            quota,
            deliveries,
            state: Mutex::new(State::default()),
            uploads: Mutex::default(),
            grace: GRACE,
            config,
        })
    }
    /// The caller is authenticated by Base before this function runs; no request contains an Owner.
    pub fn serve(
        self: &Arc<Self>,
        owner: H::Owner,
        connection: RemoteRequests,
        slim: Value,
    ) -> Result<(), Fault> {
        let peer = self.host.peer(&owner);
        lock(&self.state)
            .connections
            .insert(peer.device_id.clone(), (connection.clone(), slim));
        let mut requests = connection
            .take_requests()
            .ok_or_else(|| Fault::new("link_taken", "Remote link already has a dispatcher"))?;
        let service = Arc::clone(self);
        let closed = connection.clone();
        let ended_owner = owner.clone();
        tokio::spawn(async move {
            let mut changes = closed.changes();
            if *changes.borrow() {
                let _ = changes.wait_for(|online| !*online).await;
            }
            service.disconnected(&ended_owner, &closed);
        });
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let mut changes = connection.changes();
            loop {
                let request = tokio::select! {
                    request = requests.recv() => match request { Some(request) => request, None => break },
                    _ = changes.wait_for(|online| !*online) => break,
                };
                let answer = service.call(&owner, &request.method, request.params, &connection);
                let connection = connection.clone();
                tokio::spawn(async move {
                    let _ = connection.answer(request.id, answer.await);
                });
            }
        });
        Ok(())
    }

    fn target(&self, peer: &str, rtab: &str) -> Result<H::Target, RemoteError> {
        lock(&self.state)
            .tabs
            .get(&(peer.to_owned(), rtab.to_owned()))
            .map(|tab| tab.target.clone())
            .ok_or_else(|| Fault::new("unknown_tab", "Unknown tab").into())
    }

    pub fn call(
        self: &Arc<Self>,
        owner: &H::Owner,
        method: &str,
        params: Value,
        connection: &RemoteRequests,
    ) -> impl Future<Output = ResultValue> + Send + 'static {
        let prepared = (|| {
            if method == "host.signIn.callback" {
                callback_params(&params)?;
            }
            let peer = self.host.peer(owner);
            let mut admission = Admission {
                target: None,
                serial: 0,
                closed: None,
                revision: 0,
                callback: None,
            };
            if method == "tab.open" {
                let key = (peer.device_id, rtab(&params)?.to_owned());
                admission.revision = *lock(&self.state).revisions.entry(key).or_default();
            } else if method == "tab.close" {
                let key = (peer.device_id, rtab(&params)?.to_owned());
                admission.closed = self.take_close(&key, Some(connection), None)?;
            } else if method == "host.signIn.callback"
                || method.starts_with("tab.")
                || (params.get("rtab").is_some()
                    && (method.starts_with("fs.")
                        || method.starts_with("host.fs.")
                        || matches!(
                            method,
                            "host.bench.run" | "terminal.request" | "host.signIn.callback"
                        )))
            {
                let mut state = lock(&self.state);
                let key = (peer.device_id, rtab(&params)?.to_owned());
                let tab = state
                    .tabs
                    .get_mut(&key)
                    .ok_or_else(|| RemoteError::from(Fault::new("unknown_tab", "Unknown tab")))?;
                if !tab
                    .connection
                    .as_ref()
                    .is_some_and(|held| held.same_connection(connection))
                {
                    return Err(Fault::new(
                        "remote_offline",
                        "This connection no longer owns the remote tab",
                    )
                    .into());
                }
                admission.target = Some(tab.target.clone());
                admission.serial = tab.serial;
                if method == "host.signIn.callback" {
                    let (path, query) = callback_params(&params)?;
                    if self.host.snapshot(&tab.target)?.sign_ins.is_empty()
                        || !tab
                            .callback
                            .as_ref()
                            .is_some_and(|callback| callback.matches(path, query))
                    {
                        return Err(sign_in_unavailable());
                    }
                    admission.callback = tab.callback.take();
                }
            }
            Ok::<_, RemoteError>(admission)
        })();
        let service = Arc::clone(self);
        let owner = owner.clone();
        let method = method.to_owned();
        let connection = connection.clone();
        async move {
            service
                .run_call(&owner, &method, params, &connection, prepared?)
                .await
        }
    }

    async fn run_call(
        self: &Arc<Self>,
        owner: &H::Owner,
        method: &str,
        mut params: Value,
        connection: &RemoteRequests,
        admission: Admission<H::Target>,
    ) -> ResultValue {
        let peer = self.host.peer(owner);
        let target = || {
            admission
                .target
                .clone()
                .ok_or_else(|| RemoteError::from(Fault::new("unknown_tab", "Unknown tab")))
        };
        match method {
            "host.signIn.callback" => {
                let callback = admission.callback.ok_or_else(sign_in_unavailable)?;
                let Value::String(query) = params["query"].take() else {
                    return Err(invalid("Invalid callback query"));
                };
                let page = callback.replay(query).await?;
                serde_json::to_value(page).map_err(|_| invalid("Invalid callback page"))
            }
            "tab.open" => {
                self.open(owner, params, connection, admission.revision)
                    .await
            }
            "tab.start" => {
                let target = target()?;
                self.host.start(&target)?;
                Ok(Value::Null)
            }
            "tab.restart" => {
                let target = target()?;
                let cwd = optional_text(&params, "cwd")?;
                let session = optional_text(&params, "sessionPath")?;
                self.host.restart(&target, cwd, session)?;
                Ok(Value::Null)
            }
            "tab.adoptCwd" => {
                let target = target()?;
                let cwd = params["cwd"]
                    .as_str()
                    .ok_or_else(|| invalid("cwd required"))?;
                Ok(json!(self.host.adopt_cwd(&target, cwd.to_owned())?))
            }
            "tab.close" => {
                if let Some(target) = admission.closed {
                    self.host.close(target).await?;
                }
                Ok(Value::Null)
            }
            "tab.command" => {
                self.command(owner, params, target()?, admission.serial)
                    .await
            }
            "tab.sideChannel" => {
                let target = target()?;
                if !params["frame"].is_object() {
                    return Err(invalid("frame must be an object"));
                }
                self.host
                    .side_channel(owner, &target, params["frame"].clone())
                    .await?;
                if matches!(
                    params["frame"]["type"].as_str(),
                    Some("host_tool_result" | "host_uri_result")
                ) && let Some(id) = params["frame"]["id"].as_str()
                    && let Some(tab) = lock(&self.state)
                        .tabs
                        .get_mut(&(peer.device_id, rtab(&params)?.to_owned()))
                        .filter(|tab| tab.serial == admission.serial)
                {
                    tab.calls.remove(id);
                }
                Ok(Value::Null)
            }
            "tab.cancelWait" => {
                let target = target()?;
                self.host.cancel_wait(&target).await?;
                Ok(Value::Null)
            }
            "tab.syncImageGeneration" => {
                let target = target()?;
                self.host.sync_image_generation(&target)?;
                Ok(Value::Null)
            }
            "host.files.upload" => {
                self.host
                    .upload(owner, super::uploads::whole(params)?)
                    .await
            }
            "host.files.uploadPart" => {
                let part = lock(&self.uploads).push(&peer.device_id, params)?;
                match part {
                    super::uploads::PartResult::Complete(upload) => {
                        self.host.upload(owner, upload).await
                    }
                    super::uploads::PartResult::Waiting {
                        received,
                        upload,
                        generation,
                    } => {
                        let service = Arc::downgrade(self);
                        tokio::spawn(async move {
                            tokio::time::sleep(super::uploads::IDLE).await;
                            if let Some(service) = service.upgrade() {
                                lock(&service.uploads).expire(&peer.device_id, &upload, generation);
                            }
                        });
                        Ok(json!({"received":received}))
                    }
                }
            }
            "tabs.kept" => {
                let state = lock(&self.state);
                let mut tabs = Vec::new();
                for tab in state
                    .tabs
                    .values()
                    .filter(|tab| tab.peer == peer.device_id && tab.connection.is_none())
                {
                    let snapshot = self.host.snapshot(&tab.target)?;
                    if !snapshot.viewing
                        && let Some(mut kept) = snapshot.kept
                    {
                        kept["rtab"] = tab.rtab.clone().into();
                        kept["formerRtabs"] = json!(tab.former);
                        tabs.push(kept);
                    }
                }
                Ok(json!({"tabs":tabs}))
            }
            _ => {
                let (kind, canonical) = host_method(method).ok_or_else(|| {
                    RemoteError::from(Fault::new(
                        "unsupported",
                        format!("Unknown method {method}"),
                    ))
                })?;
                let root = if admission.target.is_some() {
                    let target = target()?;
                    Some(self.host.snapshot(&target)?.cwd)
                } else {
                    optional_text(&params, "cwd")?
                };
                let weight = match canonical {
                    "host.bench.run" => (params["options"]["models"].as_array().map_or(0, Vec::len)
                        as f64
                        * params["options"]["runs"].as_f64().unwrap_or(0.0))
                    .max(1.0),
                    "host.modelSetup.run" => 1.0,
                    _ => 0.0,
                };
                let operation = self.host.prepare_request(
                    owner,
                    HostRequest {
                        kind,
                        method: canonical,
                        params,
                        root,
                    },
                )?;
                let reservation = if weight > 0.0 {
                    Some(self.quota.reserve(&peer.device_id, weight)?)
                } else {
                    None
                };
                let result = operation.await;
                if (result.as_ref().is_err()
                    || result.as_ref().is_ok_and(|value| value["success"] == false))
                    && let Some(reservation) = reservation
                {
                    reservation.refund()?;
                }
                result
            }
        }
    }

    async fn open(
        self: &Arc<Self>,
        owner: &H::Owner,
        params: Value,
        connection: &RemoteRequests,
        revision: u64,
    ) -> ResultValue {
        let peer = self.host.peer(owner);
        let options: Open =
            serde_json::from_value(params).map_err(|error| invalid(&error.to_string()))?;
        rtab(&json!({"rtab":options.rtab}))?;
        if options
            .kind
            .as_ref()
            .is_some_and(|kind| kind != "agent" && kind != "chat")
        {
            return Err(invalid("Invalid session kind"));
        }
        let key = (peer.device_id.clone(), options.rtab.clone());
        let gate = lock(&self.state)
            .gates
            .entry(key.clone())
            .or_default()
            .clone();
        let _gate = gate.lock().await;
        if lock(&self.state).revisions.get(&key).copied().unwrap_or(0) != revision {
            return Err(Fault::new("unknown_tab", "The device closed this tab").into());
        }
        let adopted = {
            let mut state = lock(&self.state);
            if !state.tabs.contains_key(&key)
                && let Some(path) = options.session_path.as_ref()
            {
                let old = state
                    .tabs
                    .iter()
                    .find(|(_, tab)| {
                        tab.peer == peer.device_id
                            && self
                                .host
                                .snapshot(&tab.target)
                                .ok()
                                .and_then(|s| s.session_path)
                                .as_ref()
                                == Some(path)
                    })
                    .map(|(key, _)| key.clone());
                if let Some(old) = old {
                    if state.tabs[&old]
                        .connection
                        .as_ref()
                        .is_some_and(|held| held.same_connection(connection))
                    {
                        return Err(RemoteError {
                            fault: Fault::new(
                                "session_open_in_tab",
                                "Session is already open in another tab on this device",
                            ),
                            holder: Some(
                                json!({"device":peer.device_id,"rtab":old.1,"name":peer.name}),
                            ),
                        });
                    }
                    let Some(mut tab) = state.tabs.remove(&old) else {
                        return Err(Fault::new("unknown_tab", "Unknown tab").into());
                    };
                    tab.former.insert(0, tab.rtab.clone());
                    tab.former.truncate(self.config.max_former_tab_ids);
                    tab.rtab = key.1.clone();
                    tab.calls.values_mut().for_each(|call| {
                        call.resent |= call.delivered;
                        call.delivered = false;
                    });
                    state.tabs.insert(key.clone(), tab);
                }
            }
            if let Some(tab) = state.tabs.get_mut(&key) {
                tab.grace += 1;
                tab.connection = Some(connection.clone());
                tab.sender.dispose();
                let slim = state_slim(&state.connections, &peer.device_id);
                if let Some(tab) = state.tabs.get_mut(&key) {
                    if tab.slim != slim {
                        tab.reads.clear();
                        tab.epoch = super::crypto::random_device_id();
                    }
                    tab.sender = Sender::new(Options::from_value(&slim));
                    tab.slim = slim;
                    tab.sent_commands = None;
                }
                true
            } else {
                false
            }
        };
        if adopted {
            return self.reattach(&key);
        }
        lock(&self.state).opening.insert(key.clone());
        let acquired = self.host.acquire(owner, options).await;
        let target = match acquired {
            Ok(target) => target,
            Err(error) => {
                lock(&self.state).opening.remove(&key);
                return Err(error.into());
            }
        };
        self.install(key.clone(), target, Some(connection.clone()), revision)
            .await?;
        self.reattach(&key)
    }

    /// Restore a native resume marker before its device returns. Base supplies the stored execution peer's Owner.
    pub async fn revive(
        self: &Arc<Self>,
        owner: &H::Owner,
        marker: Resume,
    ) -> Result<Option<String>, RemoteError> {
        let peer = self.host.peer(owner);
        let prefix = format!("peer:{}:", peer.device_id);
        let Some(id) = marker.tab.strip_prefix(&prefix) else {
            return Ok(None);
        };
        if rtab(&json!({"rtab":id})).is_err() {
            return Ok(None);
        }
        if !matches!(marker.kind.as_str(), "agent" | "chat") {
            return Err(invalid("Invalid session kind"));
        }
        let key = (peer.device_id, id.to_owned());
        let (gate, revision) = {
            let mut state = lock(&self.state);
            let revision = *state.revisions.entry(key.clone()).or_default();
            (
                state.gates.entry(key.clone()).or_default().clone(),
                revision,
            )
        };
        let _gate = gate.lock().await;
        if lock(&self.state).tabs.contains_key(&key) {
            return Ok(Some(marker.tab));
        }
        if lock(&self.state).revisions.get(&key).copied().unwrap_or(0) != revision {
            return Ok(None);
        }
        let options = Open {
            rtab: key.1.clone(),
            cwd: Some(marker.cwd),
            kind: Some(marker.kind),
            fresh: false,
            session_path: marker.session_path,
        };
        let target = self.host.acquire(owner, options).await?;
        let serial = self.install(key.clone(), target, None, revision).await?;
        self.grace(key, serial, 0);
        Ok(Some(marker.tab))
    }
    async fn install(
        self: &Arc<Self>,
        key: Key,
        target: H::Target,
        connection: Option<RemoteRequests>,
        revision: u64,
    ) -> Result<u64, RemoteError> {
        let serial = {
            let mut state = lock(&self.state);
            state.opening.remove(&key);
            if state.revisions.get(&key).copied().unwrap_or(0) != revision {
                None
            } else {
                state.serial += 1;
                let serial = state.serial;
                let slim = state_slim(&state.connections, &key.0);
                state.tabs.insert(
                    key.clone(),
                    Tab {
                        target: target.clone(),
                        rtab: key.1.clone(),
                        peer: key.0.clone(),
                        former: Vec::new(),
                        connection,
                        serial,
                        grace: 0,
                        calls: HashMap::new(),
                        sender: Sender::new(Options::from_value(&slim)),
                        slim,
                        reads: HashMap::new(),
                        sent_commands: None,
                        epoch: super::crypto::random_device_id(),
                        callback: None,
                    },
                );
                Some(serial)
            }
        };
        let Some(serial) = serial else {
            self.host.close(target).await?;
            return Err(Fault::new("unknown_tab", "The device closed this tab").into());
        };
        let service = Arc::downgrade(self);
        if let Err(error) = self.host.listen(
            &target,
            Arc::new(move |name, arg| {
                if let Some(service) = service.upgrade() {
                    service.feed(serial, name, arg);
                }
            }),
        ) {
            let target = {
                let mut state = lock(&self.state);
                if state.tabs.get(&key).is_some_and(|tab| tab.serial == serial) {
                    *state.revisions.entry(key.clone()).or_default() += 1;
                    state.tabs.remove(&key).map(|mut tab| {
                        tab.sender.dispose();
                        tab.target
                    })
                } else {
                    None
                }
            };
            if let Some(target) = target {
                self.host.close(target).await?;
            }
            return Err(error.into());
        }
        Ok(serial)
    }

    fn reattach(self: &Arc<Self>, key: &Key) -> ResultValue {
        let target = self.target(&key.0, &key.1)?;
        let snapshot = self.host.snapshot(&target)?;
        let attached = snapshot.status != "asleep";
        if attached {
            self.emit(key, "run", snapshot.run.clone());
            self.emit(key, "status", status_arg(&snapshot));
        }
        self.emit(key, "signIn", json!({"active":snapshot.sign_ins}));
        self.emit(key, "openAsks", json!(snapshot.asks));
        if let Some(plan) = snapshot.pending_plan {
            self.emit(key, "events", json!([plan]));
        }
        self.emit(
            key,
            "awaitingConnection",
            json!(snapshot.awaiting_connection),
        );
        self.emit(key, "scheduledRetry", snapshot.scheduled_retry);
        let mut state = lock(&self.state);
        if let Some(tab) = state.tabs.get_mut(key)
            && let Some(connection) = &tab.connection
        {
            for call in tab.calls.values_mut().filter(|call| !call.delivered) {
                let mut request = call.request.clone();
                if call.name == "hostToolCall" && call.resent {
                    request["resent"] = true.into();
                }
                call.delivered = true;
                let _ = send_event(connection, &tab.rtab, &call.name, &request);
            }
        }
        Ok(
            json!({"cwd":snapshot.cwd,"kind":snapshot.kind,"attached":attached,"viewing":snapshot.viewing}),
        )
    }

    async fn command(
        self: &Arc<Self>,
        owner: &H::Owner,
        params: Value,
        target: H::Target,
        serial: u64,
    ) -> ResultValue {
        let peer = self.host.peer(owner);
        let id = rtab(&params)?.to_owned();
        let mut command = params["command"]
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("command must be an object"))?;
        if command
            .get("type")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(invalid("command type required"));
        }
        let delivery = command
            .remove("deliveryId")
            .and_then(|id| id.as_str().filter(|id| !id.is_empty()).map(str::to_owned));
        let timeout = match params.get("timeoutMs") {
            Some(value) => Some(Duration::from_millis(
                value
                    .as_u64()
                    .filter(|ms| *ms > 0 && *ms <= MAX_COMMAND_MS)
                    .ok_or_else(|| invalid("Invalid command timeout"))?,
            )),
            None => None,
        };
        let service = Arc::clone(self);
        let owner = owner.clone();
        let fresh = params["fresh"] == true;
        let work = move || async move {
            let command = Value::Object(command);
            let reservation = if command_uses_model(&command) {
                Some(service.quota.reserve(&peer.device_id, 1.0)?)
            } else {
                None
            };
            let mut result = service
                .host
                .command(&owner, &target, command.clone(), timeout)
                .await;
            if (result.as_ref().is_err()
                || result
                    .as_ref()
                    .is_ok_and(|response| response["success"] != true))
                && let Some(reservation) = reservation
            {
                reservation.refund()?;
            }
            if let Ok(response) = &mut result
                && response["success"] == true
            {
                service.encode_read(&(peer.device_id, id), serial, &command, response, fresh);
            }
            result
        };
        if let Some(delivery) = delivery {
            self.deliveries.run(delivery, work).await
        } else {
            work().await
        }
    }

    fn encode_read(
        &self,
        key: &Key,
        serial: u64,
        command: &Value,
        response: &mut Value,
        fresh: bool,
    ) {
        let Some((read, needs)) = encoded_read_key(command) else {
            return;
        };
        if response["data"]["unchanged"] == true {
            return;
        }
        let mut state = lock(&self.state);
        let Some(tab) = state.tabs.get_mut(key).filter(|tab| tab.serial == serial) else {
            return;
        };
        if tab.slim[needs] != true {
            return;
        }
        let encoder = tab.reads.entry(read).or_insert_with(|| {
            ReadEncoder::new(
                tab.epoch.clone(),
                tab.slim["shiftedReads"] == true,
                matches!(needs, "rosterReads" | "jobsReads"),
            )
        });
        response["data"] = encoder.encode(response.get("data"), fresh);
    }

    fn feed(self: &Arc<Self>, serial: u64, name: String, mut arg: Value) {
        let key = {
            let state = lock(&self.state);
            let Some(key) = state
                .tabs
                .iter()
                .find(|(_, tab)| tab.serial == serial)
                .map(|(key, _)| key.clone())
            else {
                return;
            };
            key
        };
        let mut tokens = 0.0;
        {
            let mut state = lock(&self.state);
            let Some(tab) = state.tabs.get_mut(&key).filter(|tab| tab.serial == serial) else {
                return;
            };
            if matches!(name.as_str(), "hostToolCall" | "hostUriRequest")
                && let Some(id) = arg["id"].as_str()
            {
                tab.calls.insert(
                    id.into(),
                    HostCall {
                        name: name.clone(),
                        request: arg.clone(),
                        delivered: tab.connection.is_some(),
                        resent: false,
                    },
                );
            }
            if name == "status" && arg["status"] != "ready" {
                tab.calls.clear();
                tab.callback = None;
            }
            if name == "signIn" && arg["active"].as_array().is_some_and(Vec::is_empty) {
                tab.callback = None;
            }
            if name == "extensionUi"
                && arg["method"] == "open_url"
                && arg["launchUrl"].is_string()
                && self
                    .host
                    .snapshot(&tab.target)
                    .is_ok_and(|snapshot| !snapshot.sign_ins.is_empty())
            {
                tab.callback = arg["url"].as_str().and_then(LoopbackCallback::parse);
            }
            if name == "frame"
                && matches!(
                    arg["type"].as_str(),
                    Some("host_tool_cancel" | "host_uri_cancel")
                )
                && let Some(id) = arg["targetId"].as_str()
            {
                tab.calls.remove(id);
            }
            if name == "status"
                && let Ok(snapshot) = self.host.snapshot(&tab.target)
            {
                arg = status_arg(&snapshot);
            }
            if name == "events"
                && self
                    .host
                    .snapshot(&tab.target)
                    .is_ok_and(|snapshot| !snapshot.viewing)
            {
                tokens = arg
                    .as_array()
                    .map_or(0.0, |events| events.iter().map(assistant_tokens).sum());
            }
        }
        if tokens > 0.0
            && let Err(error) = self.quota.record(&key.0, 0.0, tokens)
        {
            self.host.publish(
                "quota.saveFailed",
                &json!({"code":error.code,"message":error.message}),
            );
        }
        if name == "beforeResponse" {
            self.flush(&key);
        } else if name != "frame" {
            self.emit(&key, &name, arg);
        }
    }

    fn emit(self: &Arc<Self>, key: &Key, name: &str, arg: Value) {
        let mut state = lock(&self.state);
        let Some(tab) = state.tabs.get_mut(key) else {
            return;
        };
        let Some(connection) = tab.connection.clone() else {
            return;
        };
        if name == "commandsUpdate" {
            let json = super::events::js::stringify(&arg);
            if tab.sent_commands.as_ref() == Some(&json) {
                return;
            }
            tab.sent_commands = Some(json);
        }
        let rtab = tab.rtab.clone();
        let mut send = |name, arg| send_event(&connection, &rtab, name, &arg).is_ok();
        if tab.slim["events"] != true {
            let _ = send_event(&connection, &rtab, name, &arg);
            return;
        }
        let timer = match name {
            "events" => {
                if let Some(events) = arg.as_array() {
                    tab.sender.events(events, &mut send);
                }
                None
            }
            "subagentFrame" => tab.sender.subagent_frame(arg, &mut send),
            _ => {
                tab.sender.flush(&mut send);
                let _ = send_event(&connection, &rtab, name, &arg);
                None
            }
        };
        if let Some(timer) = timer {
            let weak = Arc::downgrade(self);
            let key = key.clone();
            let serial = tab.serial;
            tokio::spawn(async move {
                tokio::time::sleep(BATCH_INTERVAL).await;
                if let Some(service) = weak.upgrade() {
                    let mut state = lock(&service.state);
                    if let Some(tab) = state.tabs.get_mut(&key).filter(|tab| tab.serial == serial)
                        && let Some(connection) = tab.connection.clone()
                    {
                        let rtab = tab.rtab.clone();
                        tab.sender.timer(timer, &mut |name, arg| {
                            send_event(&connection, &rtab, name, &arg).is_ok()
                        });
                    }
                }
            });
        }
    }

    fn flush(&self, key: &Key) {
        let mut state = lock(&self.state);
        if let Some(tab) = state.tabs.get_mut(key)
            && let Some(connection) = tab.connection.clone()
        {
            let rtab = tab.rtab.clone();
            tab.sender
                .flush(&mut |name, arg| send_event(&connection, &rtab, name, &arg).is_ok());
        }
    }
    pub fn broadcast(&self, event: &str, data: &Value) {
        for (connection, _) in lock(&self.state).connections.values() {
            let _ = connection.emit(event, data);
        }
        self.host.publish(event, data);
    }
    pub fn disconnected(self: &Arc<Self>, owner: &H::Owner, connection: &RemoteRequests) {
        self.host.disconnected(owner);
        let peer = self.host.peer(owner);
        let mut expired = Vec::new();
        {
            let mut state = lock(&self.state);
            if state
                .connections
                .get(&peer.device_id)
                .is_some_and(|(held, _)| held.same_connection(connection))
            {
                state.connections.remove(&peer.device_id);
            }
            for (key, tab) in &mut state.tabs {
                if tab
                    .connection
                    .as_ref()
                    .is_some_and(|held| held.same_connection(connection))
                {
                    tab.connection = None;
                    tab.sender.dispose();
                    tab.grace += 1;
                    expired.push((key.clone(), tab.serial, tab.grace));
                }
            }
        }
        for (key, serial, grace) in expired {
            self.grace(key, serial, grace);
        }
    }
    fn grace(self: &Arc<Self>, key: Key, serial: u64, grace: u64) {
        let service = Arc::downgrade(self);
        let delay = self.grace;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(delay).await;
                let Some(service) = service.upgrade() else {
                    return;
                };
                let target = {
                    let state = lock(&service.state);
                    let Some(tab) = state.tabs.get(&key).filter(|tab| {
                        tab.serial == serial && tab.grace == grace && tab.connection.is_none()
                    }) else {
                        return;
                    };
                    tab.target.clone()
                };
                let keep = service.host.snapshot(&target).is_ok_and(|s| {
                    s.busy
                        || s.views > 0
                        || (!s.viewing && (s.awaiting_connection || !s.scheduled_retry.is_null()))
                });
                if !keep {
                    if let Ok(Some(target)) = service.take_close(&key, None, Some((serial, grace)))
                    {
                        let _ = service.host.close(target).await;
                    }
                    return;
                }
            }
        });
    }
    fn take_close(
        &self,
        key: &Key,
        connection: Option<&RemoteRequests>,
        expired: Option<(u64, u64)>,
    ) -> Result<Option<H::Target>, Fault> {
        let mut state = lock(&self.state);
        if let Some((serial, grace)) = expired
            && !state.tabs.get(key).is_some_and(|tab| {
                tab.serial == serial && tab.grace == grace && tab.connection.is_none()
            })
        {
            return Ok(None);
        }
        if let Some(connection) = connection
            && state
                .tabs
                .get(key)
                .and_then(|tab| tab.connection.as_ref())
                .is_some_and(|held| !held.same_connection(connection))
        {
            return Err(Fault::new(
                "remote_offline",
                "This connection no longer owns the remote tab",
            ));
        }
        *state.revisions.entry(key.clone()).or_default() += 1;
        Ok(state.tabs.remove(key).map(|mut tab| {
            tab.sender.dispose();
            tab.target
        }))
    }
    async fn close(&self, key: &Key) -> Result<(), Fault> {
        let target = self.take_close(key, None, None)?;
        if let Some(target) = target {
            self.host.close(target).await?;
        }
        Ok(())
    }
    pub async fn drop_peer(&self, device_id: &str) -> Result<(), Fault> {
        lock(&self.uploads).drop_peer(device_id);
        let keys: Vec<_> = {
            let mut state = lock(&self.state);
            state.connections.remove(device_id);
            state
                .revisions
                .keys()
                .filter(|(peer, _)| peer == device_id)
                .cloned()
                .chain(
                    state
                        .tabs
                        .keys()
                        .filter(|(peer, _)| peer == device_id)
                        .cloned(),
                )
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        };
        for key in keys {
            self.close(&key).await?;
        }
        Ok(())
    }
}
fn optional_text(params: &Value, key: &str) -> Result<Option<String>, RemoteError> {
    match params.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(invalid("Expected a string")),
    }
}
fn state_slim(connections: &HashMap<String, (RemoteRequests, Value)>, peer: &str) -> Value {
    connections
        .get(peer)
        .map(|(_, slim)| slim.clone())
        .unwrap_or_else(|| json!({}))
}
fn status_arg(snapshot: &Snapshot) -> Value {
    json!({"status":if snapshot.status == "waiting" {"error"} else {&snapshot.status},"statusPayload":snapshot.status_detail,"processAlive":snapshot.process_alive,"cwd":snapshot.cwd,"kind":snapshot.kind,"omp":snapshot.omp})
}
fn send_event(
    connection: &RemoteRequests,
    rtab: &str,
    name: &str,
    arg: &Value,
) -> Result<(), RemoteError> {
    match connection.emit("tab.event", &json!({"rtab":rtab,"name":name,"arg":arg})) {
        Err(error)
            if error.fault.code == "too_large" && matches!(name, "events" | "subagentFrame") =>
        {
            let Some(events) = arg.as_array().filter(|events| events.len() > 1) else {
                return Err(error);
            };
            let middle = events.len() / 2;
            send_event(
                connection,
                rtab,
                name,
                &Value::Array(events[..middle].to_vec()),
            )?;
            send_event(
                connection,
                rtab,
                name,
                &Value::Array(events[middle..].to_vec()),
            )
        }
        result => result,
    }
}

fn host_method(method: &str) -> Option<(RequestKind, &'static str)> {
    use RequestKind::*;
    Some(match method {
        "sessions.list" => (Session, "sessions.list"),
        "sessions.search" => (Session, "sessions.search"),
        "sessions.messages" => (Session, "sessions.messages"),
        "sessions.pace" => (Session, "sessions.pace"),
        "sessions.kindFor" => (Session, "sessions.kindFor"),
        "sessions.folder" => (Session, "sessions.folder"),
        "sessions.delete" => (Session, "sessions.delete"),
        "sessions.stop" => (Session, "sessions.stop"),
        "sessions.rename" => (Session, "sessions.rename"),
        "sessions.move" => (Session, "sessions.move"),
        "sessions.summaries" => (Session, "sessions.summaries"),
        "sessions.remoteOpened" => (Session, "sessions.remoteOpened"),
        "sessions.deleted" => (Session, "sessions.deleted"),
        "host.mobileWeb.link" => (Machine, "host.mobileWeb.link"),
        "fs.list" => (File, "fs.list"),
        "fs.read" => (File, "fs.read"),
        "fs.stat" => (File, "fs.stat"),
        "fs.mutate" => (File, "fs.mutate"),
        "fs.search" => (File, "fs.search"),
        "fs.readImage" => (File, "fs.readImage"),
        "host.fs.readBinary" => (File, "host.fs.readBinary"),
        "host.fs.readRange" => (File, "host.fs.readRange"),
        "fs.readPlan" => (File, "fs.readPlan"),
        "fs.listDirs" => (File, "fs.listDirs"),
        "workspace.default" => (Workspace, "workspace.default"),
        "launchProfile.get" => (LaunchProfile, "launchProfile.get"),
        "launchProfile.update" => (LaunchProfile, "launchProfile.update"),
        "terminal.shells" => (Terminal, "terminal.shells"),
        "terminal.request" => (Terminal, "terminal.request"),
        "peer.name" => (Device, "peer.name"),
        "host.rename" => (Device, "host.rename"),
        "host.models.list" => (Machine, "host.models.list"),
        "host.models.upsert" => (Machine, "host.models.upsert"),
        "host.models.delete" => (Machine, "host.models.delete"),
        "host.models.override" => (Machine, "host.models.override"),
        "host.stats.fetch" => (Machine, "host.stats.fetch"),
        "host.bench.run" => (Machine, "host.bench.run"),
        "host.bench.abort" => (Machine, "host.bench.abort"),
        "host.modelSetup.run" => (Machine, "host.modelSetup.run"),
        "host.modelSetup.status" => (Machine, "host.modelSetup.status"),
        "host.modelSetup.abort" => (Machine, "host.modelSetup.abort"),
        "host.modelSetup.pick.get" => (Machine, "host.modelSetup.pick.get"),
        "host.modelSetup.pick.set" => (Machine, "host.modelSetup.pick.set"),
        "host.accountRotation.get" => (Machine, "host.accountRotation.get"),
        "host.accountRotation.set" => (Machine, "host.accountRotation.set"),
        "host.creditSpend.get" => (Machine, "host.creditSpend.get"),
        "host.creditSpend.set" => (Machine, "host.creditSpend.set"),
        "host.builtinRea.get" => (Machine, "host.builtinRea.get"),
        "host.builtinRea.set" => (Machine, "host.builtinRea.set"),
        "host.localEngines.get" => (Machine, "host.localEngines.get"),
        "host.localEngines.set" => (Machine, "host.localEngines.set"),
        "host.desktop.get" => (Machine, "host.desktop.get"),
        "host.desktop.update" => (Machine, "host.desktop.update"),
        "host.ompUpdate.get" => (Machine, "host.ompUpdate.get"),
        "host.ompUpdate.now" => (Machine, "host.ompUpdate.now"),
        "host.schedules.command" => (Machine, "host.schedules.command"),
        "host.schedules.log" => (Machine, "host.schedules.log"),
        "host.schedules.create" => (Machine, "host.schedules.create"),
        "host.projects.command" => (Machine, "host.projects.command"),
        "host.git.facts" => (Git, "host.git.facts"),
        "host.git.evidence" => (Git, "host.git.evidence"),
        "host.git.landing" => (Git, "host.git.landing"),
        "host.git.removeWorktree" => (Git, "host.git.removeWorktree"),
        "host.git.discardWorktree" => (Git, "host.git.discardWorktree"),
        "host.git.merge" => (Git, "host.git.merge"),
        "host.git.worktreeCreate" => (Git, "host.git.worktreeCreate"),
        "host.memory.pull" => (Memory, "host.memory.pull"),
        "host.memory.push" => (Memory, "host.memory.push"),
        "host.memory.conclusions.pull" => (Memory, "host.memory.conclusions.pull"),
        "host.memory.conclusions.push" => (Memory, "host.memory.conclusions.push"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests;
