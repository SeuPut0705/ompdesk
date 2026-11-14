//! Application state around the existing devices/dial/gate machinery. No page data constructs a link, Owner or
//! execution host: Base supplies the native instance and dispatches authenticated calls into these methods.
use super::application_client::{PendingTabCloses, RemoteTab, TabEvent, TabOptions};
use super::devices::{
    Devices,
    client::{Change, Client, LinkState},
    native::Task,
};
use super::quota::{Limits, PeerQuota, Reservation};
use super::requests::{RemoteError, RemoteEvent, RemoteRequests};
use super::session_feed::{
    HostSessionList, Row, SessionList, apply_summary_change, valid_summary_delta,
};
use super::store::Kind;
use crate::remotebytes::native::ContentCache;
use crate::server::Fault;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Preferences {
    pub host_enabled: bool,
    pub device_name: Option<String>,
    pub keep_awake: bool,
    pub keep_tabs_on_quit: bool,
    pub forgotten: Vec<String>,
}
pub enum Saved {
    HostEnabled(bool),
    DeviceName(String),
    Forgotten(Vec<String>),
    Migrated(f64),
}
pub enum TailscaleAction {
    Install,
    StartApp,
}
pub struct Block {
    pub node_id: Option<String>,
    pub login: Option<String>,
    pub name: String,
}
pub enum Scope {
    Local,
    Global,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptTab {
    pub rtab: String,
    pub former_rtabs: Vec<String>,
    pub session_path: String,
    pub cwd: String,
    pub kind: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
impl KeptTab {
    fn parse(value: Value) -> Option<Self> {
        if value.get("title").is_some_and(|title| !title.is_string()) {
            return None;
        }
        let tab: Self = serde_json::from_value(value).ok()?;
        let id = |text: &str| !text.is_empty() && text.encode_utf16().count() <= 128;
        (id(&tab.rtab)
            && tab.former_rtabs.iter().all(|text| id(text))
            && !tab.session_path.is_empty()
            && matches!(tab.kind.as_str(), "agent" | "chat")
            && matches!(
                tab.state.as_str(),
                "running" | "settling" | "asking" | "waiting"
            ))
        .then_some(tab)
    }
}
pub enum Output {
    State(Value),
    Sessions(Value),
    Summaries {
        device: String,
        change: Value,
    },
    HostOnline(String),
    HostEvent {
        device: String,
        event: String,
        data: Value,
    },
    Deleted {
        device: String,
        paths: Vec<String>,
    },
    ModelWait {
        device: String,
        counts: Option<Map<String, Value>>,
    },
    Error(Fault),
}
pub trait Host: Send + Sync + 'static {
    fn preferences(&self) -> Preferences;
    fn save(&self, change: Saved) -> Result<(), Fault>;
    fn hostname(&self) -> String;
    fn keeping_awake(&self) -> bool;
    fn hosted_running(&self) -> Vec<String>;
    fn allows_peer(&self, device: &str) -> bool;
    fn block(&self, block: Block) -> Result<(), Fault>;
    fn close_peer<'a>(&'a self, device: &'a str) -> Task<'a, Result<(), Fault>>;
    fn close_hosted<'a>(&'a self) -> Task<'a, Result<(), Fault>>;
    fn tailscale_action<'a>(&'a self, action: TailscaleAction) -> Task<'a, Result<(), Fault>>;
    fn offline_message(&self) -> String;
    fn unanswered_message(&self, host: &str) -> String;
    fn sign_in_failure(&self, host: &str) -> crate::remotebytes::native::Words;
    fn output(&self, event: Output);
}
struct Link {
    serial: u64,
    client: Arc<Client>,
    change: Option<Change>,
    requests: Option<RemoteRequests>,
    tabs: HashMap<String, RemoteTab>,
    closes: Arc<PendingTabCloses>,
    sessions: Arc<HostSessionList>,
    summaries: Option<Value>,
    remote_opened: Option<Vec<Value>>,
    web_url: Option<String>,
    reading_summaries: bool,
}
struct State {
    next: u64,
    links: HashMap<String, Link>,
    disposed: bool,
}
enum Input {
    Change(String, u64, Change),
    Event(String, u64, RemoteRequests, RemoteEvent),
    Read(
        String,
        u64,
        RemoteRequests,
        &'static str,
        Result<Value, RemoteError>,
    ),
    Output(Output),
    Rename(String),
    DevicesChanged,
    QuotaChanged,
    QuotaBroadcast,
}
pub struct Service<H: Host> {
    devices: Arc<Devices>,
    host: Arc<H>,
    quota: Arc<PeerQuota>,
    cache: Arc<ContentCache>,
    state: Mutex<State>,
    input: mpsc::UnboundedSender<Input>,
    quota_timer: AtomicBool,
    _quota_listener: super::quota::QuotaListener,
}
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|p| p.into_inner())
}
fn unknown() -> Fault {
    Fault::new("remote_unknown_device", "The device is not paired")
}
fn name(value: &str) -> Result<String, Fault> {
    let value = crate::fs::order::js_trim(value);
    if value.is_empty() || value.encode_utf16().count() > 64 {
        Err(Fault::new("invalid_name", "Invalid device name"))
    } else {
        Ok(value.to_owned())
    }
}
fn capabilities() -> Map<String, Value> {
    [
        "slimEvents",
        "slimProgress",
        "slimAutopilot",
        "slimEnds",
        "slimReadGroups",
        "slimToolResults",
        "slimEndFields",
        "slimAutopilotReads",
        "slimListReads",
        "slimShiftedReads",
        "slimSettingsReads",
        "slimRosterReads",
        "slimJobsReads",
        "slimToolOutputs",
        "slimToolArgs",
        "deflate",
        "deflateContext",
        "slimSessionLists",
    ]
    .into_iter()
    .map(|key| (key.into(), true.into()))
    .collect()
}
impl<H: Host> Service<H> {
    pub fn new(
        devices: Arc<Devices>,
        host: Arc<H>,
        quota: Arc<PeerQuota>,
        cache: Arc<ContentCache>,
    ) -> Arc<Self> {
        let (input, mut incoming) = mpsc::unbounded_channel();
        let notify = input.clone();
        let listener: super::quota::QuotaListener = Arc::new(move || {
            let _ = notify.send(Input::QuotaChanged);
        });
        quota.observe(&listener);
        let service = Arc::new(Self {
            devices,
            host,
            quota,
            cache,
            state: Mutex::new(State {
                next: 0,
                links: HashMap::new(),
                disposed: false,
            }),
            input,
            quota_timer: AtomicBool::new(false),
            _quota_listener: listener,
        });
        let weak = Arc::downgrade(&service);
        tokio::spawn(async move {
            while let Some(input) = incoming.recv().await {
                let Some(service) = weak.upgrade() else {
                    break;
                };
                service.receive(input);
            }
        });
        service
    }
    pub async fn start(self: &Arc<Self>) -> Result<(), Fault> {
        self.devices
            .set_host(self.host.preferences().host_enabled)
            .await;
        for record in self.devices.records(Kind::Hosts) {
            if let Some(id) = record["deviceId"].as_str() {
                let linked = lock(&self.state).links.contains_key(id);
                if !linked {
                    self.link(id)?;
                }
            }
        }
        self.devices.launch();
        self.broadcast()?;
        Ok(())
    }
    pub fn device_name(&self) -> String {
        if let Some(name) = self
            .host
            .preferences()
            .device_name
            .filter(|name| !crate::fs::order::js_trim(name).is_empty())
        {
            return name;
        }
        self.devices.current()["tailnetName"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let mut host = self.host.hostname();
                if host
                    .get(host.len().saturating_sub(6)..)
                    .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".local"))
                {
                    host.truncate(host.len() - 6);
                }
                host
            })
    }
    pub fn state(&self) -> Result<Value, Fault> {
        let core = self.devices.current();
        let prefs = self.host.preferences();
        let connections = self.devices.connections();
        let versions: HashMap<_, _> = connections
            .into_iter()
            .map(|peer| (peer.device_id, peer.app_version))
            .collect();
        let mut using: HashSet<_> = self.host.hosted_running().into_iter().collect();
        using.extend(versions.keys().cloned());
        let mut peers = Vec::new();
        let mut used_by = Vec::new();
        for record in self.devices.records(Kind::Peers) {
            let id = record["deviceId"].as_str().unwrap_or_default();
            if using.contains(id) {
                used_by.push(record["name"].clone());
            }
            peers.push(json!({"deviceId":id,"name":record["name"],"login":record.get("login"),"online":versions.contains_key(id),"appVersion":versions.get(id).and_then(Option::as_ref),"lastSeenAt":record.get("lastSeenAt"),"limits":record.get("limits").cloned().unwrap_or_else(||json!({})),"usage":self.quota.usage(id)?}));
        }
        let state = lock(&self.state);
        let hosts: Vec<_> = self
            .devices
            .records(Kind::Hosts)
            .into_iter()
            .map(|record| {
                let id = record["deviceId"].as_str().unwrap_or_default();
                let mut view = json!({"deviceId":id,"name":record["name"],"state":"offline"});
                if let Some(link) = state.links.get(id) {
                    if let Some(change) = &link.change {
                        view["name"] = change
                            .host
                            .get("name")
                            .cloned()
                            .unwrap_or(record["name"].clone());
                        view["state"] = match change.state {
                            LinkState::Online => "online",
                            LinkState::Connecting => "connecting",
                            LinkState::Offline => "offline",
                        }
                        .into();
                        if let Some(hello) = &change.hello {
                            for key in ["platform", "home"] {
                                if let Some(value) = hello.get(key) {
                                    view[key] = value.clone();
                                }
                            }
                            if change.state == LinkState::Online {
                                view["appVersion"] = hello["appVersion"].clone();
                            }
                        }
                    }
                    if link
                        .requests
                        .as_ref()
                        .is_some_and(RemoteRequests::is_online)
                    {
                        if let Some(tabs) = &link.remote_opened {
                            view["remoteOpened"] = json!(tabs);
                        }
                        if let Some(url) = &link.web_url {
                            view["webUrl"] = url.clone().into();
                        }
                    }
                }
                view
            })
            .collect();
        Ok(
            json!({"tailnet":core["phase"],"host":{"enabled":prefs.host_enabled,"name":self.device_name(),"port":core["host"]["port"],"addresses":core["host"]["addresses"],"listenError":core["host"]["listenError"],"peers":peers,"keepAwake":prefs.keep_awake,"keepingAwake":self.host.keeping_awake(),"usedBy":used_by},"hosts":hosts,"forgotten":prefs.forgotten,"appVersion":self.devices.app_version()}),
        )
    }
    pub fn broadcast(&self) -> Result<Value, Fault> {
        let state = self.state()?;
        self.host.output(Output::State(state.clone()));
        Ok(state)
    }
    pub fn allows_peer(&self, device: &str) -> bool {
        self.devices
            .records(Kind::Peers)
            .iter()
            .any(|peer| peer["deviceId"] == device)
            && self.host.allows_peer(device)
    }
    pub fn online_hosts(&self) -> Vec<String> {
        lock(&self.state)
            .links
            .iter()
            .filter(|(_, link)| {
                link.requests
                    .as_ref()
                    .is_some_and(RemoteRequests::is_online)
            })
            .map(|(id, _)| id.clone())
            .collect()
    }
    pub fn wake(&self, trigger: &str) {
        self.devices.wake_hosts(trigger);
    }
    pub fn running_changed(&self) -> Result<Value, Fault> {
        self.devices
            .running_changed(!self.host.hosted_running().is_empty());
        self.broadcast()
    }
    pub fn keep_awake_changed(&self) -> Result<Value, Fault> {
        self.devices
            .keep_awake_changed(self.host.preferences().keep_awake);
        self.broadcast()
    }
    pub async fn set_host_enabled(&self, enabled: bool) -> Result<Value, Fault> {
        self.host.save(Saved::HostEnabled(enabled))?;
        if !enabled {
            self.host.close_hosted().await?;
        }
        self.devices.set_host(enabled).await;
        self.broadcast()
    }
    pub fn set_device_name(&self, wanted: &str) -> Result<Value, Fault> {
        let wanted = name(wanted)?;
        if wanted != self.device_name() {
            self.host.save(Saved::DeviceName(wanted.clone()))?;
            self.devices.set_name(&wanted);
            let requests: Vec<_> = lock(&self.state)
                .links
                .values()
                .filter_map(|link| link.requests.clone())
                .collect();
            for request in requests {
                let wanted = wanted.clone();
                tokio::spawn(async move {
                    let _ = request
                        .request("peer.name", json!({"name":wanted}), Duration::from_secs(30))
                        .await;
                });
            }
            self.devices.announce_name(&wanted);
        }
        self.broadcast()
    }
    pub async fn rename_host(&self, device: &str, wanted: &str) -> Result<Value, RemoteError> {
        let wanted = name(wanted)?;
        self.request(
            device,
            "host.rename",
            json!({"name":wanted}),
            Duration::from_secs(30),
        )
        .await?;
        if let Some(link) = lock(&self.state).links.get(device) {
            link.client.host_renamed(&wanted);
        }
        self.broadcast().map_err(RemoteError::from)
    }
    pub fn rename_peer(&self, device: &str, wanted: &str) -> Result<Value, Fault> {
        let wanted = name(wanted)?;
        if !self
            .devices
            .records(Kind::Peers)
            .iter()
            .any(|peer| peer["deviceId"] == device)
        {
            return Err(unknown());
        }
        if !self.devices.rename_peer(device, &wanted) {
            return Err(Fault::new(
                "remote_offline",
                "The device must be connected to rename it",
            ));
        }
        self.state()
    }
    pub async fn revoke_peer(&self, device: &str) -> Result<Value, Fault> {
        self.devices.revoke_peer(device)?;
        self.host.close_peer(device).await?;
        self.broadcast()
    }
    pub async fn block_peer(&self, device: &str) -> Result<Value, Fault> {
        let peer = self
            .devices
            .records(Kind::Peers)
            .into_iter()
            .find(|peer| peer["deviceId"] == device)
            .ok_or_else(unknown)?;
        self.host.block(Block {
            node_id: peer["nodeId"].as_str().map(str::to_owned),
            login: peer["login"].as_str().map(str::to_owned),
            name: peer["name"].as_str().unwrap_or_default().into(),
        })?;
        self.revoke_peer(device).await
    }
    pub fn set_limits(&self, device: &str, limits: Limits) -> Result<Value, Fault> {
        for value in [limits.requests_per_day, limits.tokens_per_day]
            .into_iter()
            .flatten()
        {
            if !value.is_finite()
                || value < 0.0
                || value.fract() != 0.0
                || value > 9_007_199_254_740_991.0
            {
                return Err(Fault::new("remote_unknown_device", "Invalid device limits"));
            }
        }
        if !self.quota.set_limits(device, limits)? {
            return Err(unknown());
        }
        self.broadcast()
    }
    pub fn reserve_model_request(&self, device: &str) -> Result<Reservation, Fault> {
        self.quota.reserve(device, 1.0)
    }
    pub fn dismiss_forgotten(&self) -> Result<Value, Fault> {
        self.host.save(Saved::Forgotten(Vec::new()))?;
        self.broadcast()
    }
    pub async fn tailscale_action(&self, action: TailscaleAction) -> Result<Value, Fault> {
        self.host.tailscale_action(action).await?;
        self.devices.poll_now().await;
        self.state()
    }
    pub fn devices_changed(&self) {
        let _ = self.input.send(Input::DevicesChanged);
    }
    pub fn migrated(
        &self,
        at: f64,
        forgotten: Vec<String>,
        removed: Vec<String>,
    ) -> Result<(), Fault> {
        let links = {
            let mut state = lock(&self.state);
            removed
                .iter()
                .filter_map(|id| state.links.remove(id))
                .collect::<Vec<_>>()
        };
        for link in links {
            link.client.close();
            link.sessions.relink(None);
        }
        self.host.save(Saved::Migrated(at))?;
        if !forgotten.is_empty() {
            self.host.save(Saved::Forgotten(forgotten))?;
        }
        self.broadcast()?;
        Ok(())
    }
    pub async fn connect(self: &Arc<Self>, node: &str) -> Result<Value, RemoteError> {
        if node.is_empty() {
            return Err(Fault::new("remote_unreachable", "Missing computer").into());
        }
        let host = self
            .devices
            .connect_host(node, &capabilities())
            .await
            .map_err(|failure| {
                RemoteError::from(Fault::new(remote_code(&failure.code), failure.message))
            })?;
        let id = host["deviceId"].as_str().ok_or_else(|| {
            RemoteError::from(Fault::new("protocol", "Connected host has no device id"))
        })?;
        self.link(id)?;
        self.broadcast()?;
        Ok(self.state()?["hosts"]
            .as_array()
            .and_then(|hosts| hosts.iter().find(|host| host["deviceId"] == id))
            .cloned()
            .unwrap_or_else(|| json!({"deviceId":id,"name":host["name"],"state":"offline"})))
    }
    fn link(self: &Arc<Self>, device: &str) -> Result<(), Fault> {
        let mut state = lock(&self.state);
        if state.disposed {
            return Err(Fault::new("closed", "Remote devices are closed"));
        }
        state.next += 1;
        let serial = state.next;
        let input = self.input.clone();
        let id = device.to_owned();
        let installed = Mutex::new(None::<super::requests::WeakRequests>);
        let observe = Arc::new(move |change: Change| {
            let _ = input.send(Input::Change(id.clone(), serial, change.clone()));
            let mut installed = lock(&installed);
            if let Some(requests) = &change.requests {
                if installed
                    .as_ref()
                    .and_then(|weak| weak.upgrade())
                    .is_some_and(|held| held.same_connection(requests))
                {
                    return;
                }
                *installed = Some(requests.downgrade());
                let input = input.clone();
                let id = id.clone();
                let connection = requests.downgrade();
                requests.on_event(move |event| {
                    if event.event == "tab.event" {
                        return true;
                    }
                    connection.upgrade().is_some_and(|connection| {
                        input
                            .send(Input::Event(id.clone(), serial, connection, event.clone()))
                            .is_ok()
                    })
                });
            } else {
                *installed = None;
            }
        });
        let client = self.devices.client(device, capabilities(), observe)?;
        let old = state.links.remove(device);
        let (tabs, closes, sessions) = old
            .map(|old| (old.tabs, old.closes, old.sessions))
            .unwrap_or_else(|| {
                let input = self.input.clone();
                let feed = HostSessionList::new(
                    device.to_owned(),
                    Arc::new(move |change| {
                        let _ = input.send(Input::Output(Output::Sessions(change)));
                    }),
                );
                (HashMap::new(), Arc::default(), feed)
            });
        state.links.insert(
            device.to_owned(),
            Link {
                serial,
                client: Arc::clone(&client),
                change: None,
                requests: None,
                tabs,
                closes,
                sessions,
                summaries: None,
                remote_opened: None,
                web_url: None,
                reading_summaries: false,
            },
        );
        drop(state);
        client.connect();
        Ok(())
    }
    pub fn create_tab(
        &self,
        device: &str,
        mut options: TabOptions,
    ) -> Result<(RemoteTab, mpsc::UnboundedReceiver<TabEvent>), Fault> {
        let mut state = lock(&self.state);
        let link = state.links.get_mut(device).ok_or_else(unknown)?;
        if link.tabs.contains_key(&options.rtab) {
            return Err(Fault::new(
                "session_open_in_tab",
                "This remote tab already exists",
            ));
        }
        options.execution_host = device.to_owned();
        let host = link
            .change
            .as_ref()
            .and_then(|change| change.host.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(device);
        options.offline_message = self.host.offline_message();
        options.unanswered_message = self.host.unanswered_message(host);
        options.sign_in_failure = self.host.sign_in_failure(host);
        let rtab = options.rtab.clone();
        let result = RemoteTab::new(
            options,
            link.requests
                .clone()
                .unwrap_or_else(RemoteRequests::disconnected),
            Arc::clone(&link.closes),
            Arc::clone(&self.cache),
        );
        link.tabs.insert(rtab, result.0.clone());
        Ok(result)
    }
    pub fn release_tab(&self, device: &str, rtab: &str, tab: &RemoteTab, keep: bool) {
        let current = {
            let mut state = lock(&self.state);
            state.links.get_mut(device).is_some_and(|link| {
                if link
                    .tabs
                    .get(rtab)
                    .is_some_and(|held| held.same_instance(tab))
                {
                    link.tabs.remove(rtab);
                    true
                } else {
                    false
                }
            })
        };
        tab.dispose(keep || !current);
    }
    pub fn remove_host(&self, device: &str) -> Result<Value, Fault> {
        if let Some(link) = lock(&self.state).links.remove(device) {
            link.client.close();
            link.sessions.relink(None);
        }
        self.devices.remove_host(device)?;
        self.host.output(Output::Sessions(json!({"device":device})));
        self.broadcast()
    }
    pub async fn request(
        &self,
        device: &str,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RemoteError> {
        let requests = lock(&self.state)
            .links
            .get(device)
            .ok_or_else(unknown)?
            .requests
            .clone()
            .ok_or_else(|| {
                RemoteError::from(Fault::new(
                    "remote_offline",
                    "The device running this tab is offline",
                ))
            })?;
        requests.request(method, params, timeout).await
    }
    pub async fn host_sessions(&self, device: &str) -> Result<Arc<SessionList>, RemoteError> {
        let feed = Arc::clone(
            &lock(&self.state)
                .links
                .get(device)
                .ok_or_else(unknown)?
                .sessions,
        );
        feed.current().await
    }
    pub fn sessions_stale(&self, device: &str) {
        if let Some(link) = lock(&self.state).links.get(device) {
            link.sessions.stale();
        }
    }
    pub async fn list_host_sessions(
        &self,
        device: &str,
        scope: Scope,
        cwd: Option<String>,
    ) -> Result<Vec<Row>, RemoteError> {
        match scope {
            Scope::Global => Ok(self.host_sessions(device).await?.sessions.clone()),
            Scope::Local => {
                let mut params = json!({"scope":"local"});
                if let Some(cwd) = cwd {
                    params["cwd"] = cwd.into();
                }
                let value = self
                    .request(device, "sessions.list", params, Duration::from_secs(30))
                    .await?;
                let rows: Vec<Row> = serde_json::from_value(value).map_err(|error| {
                    RemoteError::from(Fault::new("protocol", error.to_string()))
                })?;
                Ok(rows.into_iter().map(|row| row.own(device)).collect())
            }
        }
    }
    pub async fn list_dirs(
        &self,
        device: &str,
        path: Option<String>,
        query: Option<String>,
    ) -> Result<Value, RemoteError> {
        let mut params = json!({});
        if let Some(path) = path.filter(|path| !path.is_empty()) {
            params["path"] = path.into();
        }
        if let Some(query) = query.filter(|query| !crate::fs::order::js_trim(query).is_empty()) {
            params["query"] = query.into();
        }
        self.request(device, "fs.listDirs", params, Duration::from_secs(30))
            .await
    }
    pub async fn kept_tabs(&self, device: &str) -> Result<Option<Vec<KeptTab>>, RemoteError> {
        let reply = match self
            .request(device, "tabs.kept", json!({}), Duration::from_secs(30))
            .await
        {
            Err(error) if error.fault.code == "unsupported" => return Ok(None),
            other => other?,
        };
        let Some(tabs) = reply["tabs"].as_array() else {
            return Ok(None);
        };
        Ok(Some(
            tabs.iter().cloned().filter_map(KeptTab::parse).collect(),
        ))
    }
    pub async fn deleted_on_host(
        &self,
        device: &str,
        paths: &[String],
    ) -> Result<Option<Vec<String>>, RemoteError> {
        let mut deleted = Vec::new();
        for paths in paths.chunks(2000) {
            let reply = match self
                .request(
                    device,
                    "sessions.deleted",
                    json!({"paths":paths}),
                    Duration::from_secs(30),
                )
                .await
            {
                Err(error) if error.fault.code == "unsupported" => return Ok(None),
                other => other?,
            };
            let Some(paths) = reply["paths"].as_array() else {
                return Ok(None);
            };
            deleted.extend(paths.iter().filter_map(Value::as_str).map(str::to_owned));
        }
        Ok(Some(deleted))
    }
    pub fn summaries(&self, device: &str) -> Option<Value> {
        lock(&self.state)
            .links
            .get(device)
            .filter(|link| {
                link.requests
                    .as_ref()
                    .is_some_and(RemoteRequests::is_online)
            })
            .and_then(|link| link.summaries.clone())
    }
    pub async fn dispose(&self) -> Result<(), Fault> {
        let links = {
            let mut state = lock(&self.state);
            state.disposed = true;
            std::mem::take(&mut state.links)
        };
        let keep = self.host.preferences().keep_tabs_on_quit;
        for (_, link) in links {
            for tab in link.tabs.values() {
                tab.dispose(keep);
            }
            link.client.close();
            link.sessions.relink(None);
        }
        self.host.close_hosted().await?;
        self.devices.shutdown().await;
        Ok(())
    }
    fn read(&self, device: &str, link: &mut Link, method: &'static str) {
        if method == "sessions.summaries" {
            if link.reading_summaries {
                return;
            }
            link.reading_summaries = true;
        }
        let Some(requests) = link.requests.clone() else {
            return;
        };
        let input = self.input.clone();
        let id = device.to_owned();
        let serial = link.serial;
        tokio::spawn(async move {
            let result = requests
                .request(method, json!({}), Duration::from_secs(30))
                .await;
            let _ = input.send(Input::Read(id, serial, requests, method, result));
        });
    }
    fn receive(&self, input: Input) {
        let input = match input {
            Input::Output(output) => {
                self.host.output(output);
                return;
            }
            Input::Rename(wanted) => {
                if let Err(error) = self.set_device_name(&wanted) {
                    self.host.output(Output::Error(error));
                }
                return;
            }
            Input::DevicesChanged => {
                let name = self.device_name();
                if self.devices.name() != name {
                    self.devices.set_name(&name);
                }
                if let Err(error) = self.broadcast() {
                    self.host.output(Output::Error(error));
                }
                return;
            }
            Input::QuotaChanged => {
                if !self.quota_timer.swap(true, Ordering::AcqRel) {
                    let input = self.input.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        let _ = input.send(Input::QuotaBroadcast);
                    });
                }
                return;
            }
            Input::QuotaBroadcast => {
                self.quota_timer.store(false, Ordering::Release);
                let disposed = lock(&self.state).disposed;
                if !disposed && let Err(error) = self.broadcast() {
                    self.host.output(Output::Error(error));
                }
                return;
            }
            input => input,
        };
        let mut outputs = Vec::new();
        let mut state = lock(&self.state);
        let changed = match input {
            Input::Change(device, serial, change) => {
                let Some(link) = state
                    .links
                    .get_mut(&device)
                    .filter(|link| link.serial == serial)
                else {
                    return;
                };
                let same = link
                    .requests
                    .as_ref()
                    .zip(change.requests.as_ref())
                    .is_some_and(|(a, b)| a.same_connection(b));
                link.change = Some(change.clone());
                if same {
                    drop(state);
                    let _ = self.broadcast();
                    return;
                }
                link.requests = change.requests.clone();
                link.sessions.relink(change.requests.clone());
                link.reading_summaries = false;
                if let Some(requests) = change.requests {
                    for tab in link.tabs.values() {
                        tab.relink(requests.clone());
                    }
                    let closes = Arc::clone(&link.closes);
                    let connection = requests.clone();
                    tokio::spawn(async move {
                        closes.flush(&connection).await;
                    });
                    if let Some(mut incoming) = requests.take_requests() {
                        tokio::spawn(async move {
                            while let Some(request) = incoming.recv().await {
                                let _ = requests.answer(
                                    request.id,
                                    Err(Fault::new("unsupported", "No device request handler")
                                        .into()),
                                );
                            }
                        });
                    }
                    for method in [
                        "sessions.summaries",
                        "sessions.remoteOpened",
                        "host.mobileWeb.link",
                    ] {
                        self.read(&device, link, method);
                    }
                    outputs.push(Output::HostOnline(device));
                } else {
                    outputs.push(Output::ModelWait {
                        device: device.clone(),
                        counts: None,
                    });
                    if link.summaries.take().is_some() {
                        outputs.push(Output::Summaries {
                            device: device.clone(),
                            change: json!({"version":"offline","sessions":[]}),
                        });
                    }
                    link.remote_opened = None;
                    link.web_url = None;
                }
                true
            }
            Input::Event(device, serial, connection, event) => {
                let Some(link) = state.links.get_mut(&device).filter(|link| {
                    link.serial == serial
                        && link
                            .requests
                            .as_ref()
                            .is_some_and(|held| held.same_connection(&connection))
                }) else {
                    return;
                };
                self.event(&device, link, &event.event, event.data, &mut outputs)
            }
            Input::Read(device, serial, connection, method, result) => {
                let Some(link) = state.links.get_mut(&device).filter(|link| {
                    link.serial == serial
                        && link
                            .requests
                            .as_ref()
                            .is_some_and(|held| held.same_connection(&connection))
                }) else {
                    return;
                };
                if method == "sessions.summaries" {
                    link.reading_summaries = false;
                }
                if let Ok(value) = result {
                    if method == "sessions.summaries" && !value["sessions"].is_array() {
                        false
                    } else {
                        self.event(
                            &device,
                            link,
                            match method {
                                "sessions.summaries" => "host.summaries",
                                "sessions.remoteOpened" => "host.remoteOpened",
                                _ => "host.mobileWeb.changed",
                            },
                            value,
                            &mut outputs,
                        )
                    }
                } else {
                    false
                }
            }
            Input::Output(_)
            | Input::Rename(_)
            | Input::DevicesChanged
            | Input::QuotaChanged
            | Input::QuotaBroadcast => unreachable!("handled before locking"),
        };
        drop(state);
        for output in outputs {
            self.host.output(output);
        }
        if changed {
            let _ = self.broadcast();
        }
    }
    fn event(
        &self,
        device: &str,
        link: &mut Link,
        event: &str,
        data: Value,
        outputs: &mut Vec<Output>,
    ) -> bool {
        match event {
            "sessions.changed" => link.sessions.host_changed(data),
            "host.summaries" => {
                if let Some(next) = apply_summary_change(link.summaries.as_ref(), data.clone()) {
                    if link.summaries.as_ref() != Some(&next) {
                        link.summaries = Some(next);
                        outputs.push(Output::Summaries {
                            device: device.into(),
                            change: data,
                        });
                    }
                } else if valid_summary_delta(&data) {
                    self.read(device, link, "sessions.summaries");
                }
            }
            "host.remoteOpened" => {
                let Some(tabs) = data["tabs"].as_array() else {
                    return false;
                };
                link.remote_opened = Some(
                    tabs.iter()
                        .filter(|tab| {
                            ["tabId", "device", "sessionPath", "openedBySession"]
                                .iter()
                                .all(|key| tab[key].as_str().is_some_and(|text| !text.is_empty()))
                                && tab["cwd"].is_string()
                                && matches!(tab["kind"].as_str(), Some("agent" | "chat"))
                                && tab["status"].is_string()
                        })
                        .map(|tab| {
                            let mut tab = tab.clone();
                            tab.as_object_mut().unwrap().remove("here");
                            if tab["device"] == self.devices.device_id() {
                                tab["here"] = true.into();
                            }
                            tab
                        })
                        .collect(),
                );
                return true;
            }
            "host.mobileWeb.changed" => {
                match data.get("url") {
                    Some(Value::Null) => link.web_url = None,
                    Some(Value::String(url))
                        if url::Url::parse(url).is_ok_and(|url| url.scheme() == "https") =>
                    {
                        link.web_url = Some(url.clone())
                    }
                    _ => return false,
                }
                return true;
            }
            "host.sessionsDeleted" => {
                if let Some(paths) = data["paths"].as_array() {
                    let paths: Vec<_> = paths
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|path| !path.is_empty())
                        .map(str::to_owned)
                        .collect();
                    if !paths.is_empty() {
                        outputs.push(Output::Deleted {
                            device: device.into(),
                            paths,
                        });
                    }
                }
            }
            "host.modelWait.changed" => {
                if let Some(counts) = data["counts"].as_object().filter(|counts| {
                    counts.values().all(|count| {
                        count
                            .as_f64()
                            .is_some_and(|n| n.is_finite() && n >= 0.0 && n.fract() == 0.0)
                    })
                }) {
                    outputs.push(Output::ModelWait {
                        device: device.into(),
                        counts: Some(counts.clone()),
                    });
                }
            }
            "host.name" => {
                if let Some(wanted) = data["name"].as_str().and_then(|value| name(value).ok()) {
                    link.client.host_renamed(&wanted);
                }
            }
            "device.rename" => {
                if let Some(wanted) = data["name"].as_str().and_then(|value| name(value).ok()) {
                    let _ = self.input.send(Input::Rename(wanted));
                }
            }
            "host.ompUpdate.changed"
            | "host.schedules.changed"
            | "host.projects.changed"
            | "host.autopilotNotice"
            | "host.models.changed" => outputs.push(Output::HostEvent {
                device: device.into(),
                event: event.into(),
                data,
            }),
            _ => {}
        }
        false
    }
}
fn remote_code(code: &str) -> &'static str {
    match code {
        "tailscale_off" => "remote_tailscale_off",
        "not_tailnet" => "remote_not_tailnet",
        "no_identity" => "remote_no_identity",
        "not_allowed" => "remote_not_allowed",
        "blocked" => "remote_blocked",
        "declined" => "remote_declined",
        "key_mismatch" => "remote_key_mismatch",
        "unreachable" => "remote_unreachable",
        _ => "remote_protocol",
    }
}

#[cfg(test)]
mod tests;
