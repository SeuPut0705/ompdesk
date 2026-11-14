//! Direct application dependencies of the existing device transport. The accepted peer can only be made after
//! the existing tailnet gate and pinned-key handshake; it is not page endpoint authority.
use super::{Devices, Kind, Source, Store, locked};
use crate::remote::{identity::Identity, link::Liveness, requests::RemoteRequests};
use crate::server::{Events, Fault};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

pub type Task<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub struct AccessPolicy {
    pub allowed_users: Vec<String>,
    pub blocked: bool,
}
#[derive(Clone)]
pub struct Visitor {
    pub node_id: String,
    pub login: String,
    pub node_name: Option<String>,
    pub ip: String,
}
pub struct AuthenticatedPeer {
    record: Map<String, Value>,
}
impl AuthenticatedPeer {
    pub fn device_id(&self) -> &str {
        self.record
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }
    pub fn record(&self) -> &Map<String, Value> {
        &self.record
    }
}
pub struct Accepted {
    pub hello: Map<String, Value>,
    pub device_name: Option<String>,
    pub deflate: bool,
    pub context: bool,
}
pub trait Effects: Send + Sync + 'static {
    fn policy<'a>(
        &'a self,
        node_id: &'a str,
        login: &'a str,
    ) -> Task<'a, Result<AccessPolicy, Fault>>;
    fn approve<'a>(&'a self, visitor: Visitor, name: String) -> Task<'a, Result<bool, Fault>>;
    fn accept<'a>(
        &'a self,
        peer: AuthenticatedPeer,
        hello: Value,
        requests: RemoteRequests,
        waited_ms: u64,
    ) -> Task<'a, Result<Accepted, Fault>>;
    fn changed(&self, snapshot: Value);
    fn computers(&self, computers: Vec<Map<String, Value>>);
    fn adopt_login(&self, login: &str);
    fn migrated(&self, at: f64, forgotten: Vec<String>, removed: Vec<String>);
}
pub struct Config {
    pub events: Events,
    pub identity: Arc<Identity>,
    pub user_data: PathBuf,
    pub app_version: String,
    pub name: String,
    pub loopback: bool,
    pub port: Option<u32>,
    pub port_setting: Option<String>,
    pub refuse: HashMap<String, String>,
    pub liveness: Option<Liveness>,
    pub traffic: bool,
    pub traffic_ms: Option<u64>,
    pub keep_awake: Option<u64>,
    pub keep_awake_enabled: bool,
    pub migrated_at: Option<f64>,
}
impl Devices {
    /// The tailnet handle is the core's existing native instance, supplied by application assembly.
    pub fn new(config: Config, tailnet: u64, effects: Arc<dyn Effects>) -> Arc<Self> {
        Self::construct(config, Source::Core(tailnet), Some(effects))
    }
    pub fn peer_store(&self) -> Arc<Mutex<Store>> {
        Arc::clone(&self.peers)
    }
    pub fn device_id(&self) -> &str {
        &self.identity.device_id
    }
    pub fn records(&self, kind: Kind) -> Vec<Map<String, Value>> {
        locked(match kind {
            Kind::Peers => &self.peers,
            Kind::Hosts => &self.hosts,
        })
        .list()
    }
    pub fn current(&self) -> Value {
        self.snapshot()
    }
    pub async fn set_host(&self, enabled: bool) {
        if enabled {
            self.start_host().await;
        } else {
            self.stop_host().await;
        }
    }
    pub async fn poll_now(&self) {
        self.poll().await;
    }
    pub async fn shutdown(&self) {
        self.dispose().await;
    }
    pub fn wake_hosts(&self, trigger: &str) {
        self.wake(trigger);
    }
    pub async fn connect_host(
        &self,
        node: &str,
        capabilities: &Map<String, Value>,
    ) -> Result<Map<String, Value>, crate::remote::handshake::Failure> {
        self.connect(node, capabilities).await
    }
}
pub(crate) async fn accept(
    devices: u64,
    link: u64,
    peer: Map<String, Value>,
    hello: &Value,
    waited: u64,
) -> Option<Result<Accepted, Fault>> {
    let Some(devices) = super::instance(devices) else {
        return Some(Err(Fault::new("no_devices", "The device service ended")));
    };
    let effects = devices.effects.as_ref()?;
    let requests = match RemoteRequests::bind(link) {
        Ok(requests) => requests,
        Err(error) => return Some(Err(error)),
    };
    Some(
        effects
            .accept(
                AuthenticatedPeer { record: peer },
                hello.clone(),
                requests,
                waited,
            )
            .await,
    )
}

impl Devices {
    pub fn launch(self: &Arc<Self>) {
        self.forget_stale_legacy_peers();
        let weak = Arc::downgrade(self);
        let timer = tokio::spawn(async move {
            loop {
                crate::clock::sleep(std::time::Duration::from_millis(super::TAILNET_POLL_MS)).await;
                let Some(devices) = weak.upgrade() else {
                    return;
                };
                devices.poll().await;
            }
        });
        if let Some(old) = self.inner().poll_timer.replace(timer.abort_handle()) {
            old.abort();
        }
        let polling = Arc::clone(self);
        tokio::spawn(async move {
            polling.poll().await;
        });
        self.tell();
    }
    pub async fn watch(self: &Arc<Self>, watcher: u64, on: bool) -> Vec<Map<String, Value>> {
        if on {
            {
                let mut inner = self.inner();
                inner.watchers.insert(watcher);
                if inner.scan_timer.is_none() {
                    let weak = Arc::downgrade(self);
                    let timer = tokio::spawn(async move {
                        loop {
                            crate::clock::sleep(std::time::Duration::from_millis(
                                super::TAILNET_SCAN_MS,
                            ))
                            .await;
                            let Some(devices) = weak.upgrade() else {
                                return;
                            };
                            devices.scan().await;
                        }
                    });
                    inner.scan_timer = Some(timer.abort_handle());
                }
            }
            return self.scan().await;
        }
        let mut inner = self.inner();
        inner.watchers.remove(&watcher);
        if inner.watchers.is_empty()
            && let Some(timer) = inner.scan_timer.take()
        {
            timer.abort();
        }
        inner.computers.clone()
    }
    pub fn remove_host(&self, device: &str) -> Result<(), Fault> {
        self.unlink(device);
        locked(&self.hosts)
            .remove(device)
            .map_err(|error| Fault::new("io", error.to_string()))?;
        self.mark_computers();
        self.tell();
        Ok(())
    }
    pub fn revoke_peer(&self, device: &str) -> Result<bool, Fault> {
        let removed = locked(&self.peers)
            .remove(device)
            .map_err(|error| Fault::new("io", error.to_string()))?;
        let links: Vec<_> = self
            .inner()
            .host
            .links
            .iter()
            .filter(|(_, peer)| peer.as_str() == device)
            .map(|(link, _)| *link)
            .collect();
        for link in links {
            if let Some(handle) = crate::remote::state().links.get(&link) {
                handle.command(crate::remote::link::Command::Destroy(
                    crate::remote::link::Reason::Local,
                ));
            }
        }
        self.tell();
        Ok(removed)
    }
    pub fn set_name(&self, name: &str) {
        let clients: Vec<_> = {
            let mut inner = self.inner();
            inner.name = name.to_owned();
            inner.clients.values().cloned().collect()
        };
        for client in clients {
            client.set_name(name);
        }
        self.tell();
    }
    pub fn running_changed(&self, running: bool) {
        self.inner().running_tabs = running;
        self.keep_awake();
    }
    pub fn keep_awake_changed(&self, enabled: bool) {
        self.inner().keep_awake_enabled = enabled;
        self.keep_awake();
    }
    pub fn client(
        &self,
        device: &str,
        capabilities: Map<String, Value>,
        observe: super::client::Observer,
    ) -> Result<Arc<super::client::Client>, Fault> {
        let host = locked(&self.hosts)
            .get(device)
            .ok_or_else(|| Fault::new("remote_unknown_device", "The device is not paired"))?;
        self.unlink(device);
        let client = super::client::Client::new(super::client::ClientOptions {
            events: self.events.clone(),
            identity: Arc::clone(&self.identity),
            host,
            name: self.name(),
            app_version: self.app_version.clone(),
            capabilities,
            liveness: self.liveness.unwrap_or_default(),
            store: Some(Arc::clone(&self.hosts)),
            addresses: Box::new(super::AtNode(self.me.clone())),
        });
        client.observe(observe);
        self.inner()
            .clients
            .insert(device.to_owned(), Arc::clone(&client));
        locked(&super::CLIENTS).insert(client.id, Arc::clone(&client));
        Ok(client)
    }
}

pub struct ConnectionInfo {
    pub device_id: String,
    pub app_version: Option<String>,
}
impl Devices {
    pub fn connections(&self) -> Vec<ConnectionInfo> {
        let inner = self.inner();
        inner
            .host
            .links
            .iter()
            .map(|(link, device)| ConnectionInfo {
                device_id: device.clone(),
                app_version: inner.host.versions.get(link).cloned(),
            })
            .collect()
    }
}

impl Devices {
    pub fn app_version(&self) -> &str {
        &self.app_version
    }
    pub fn announce_name(&self, name: &str) {
        let links: Vec<_> = self.inner().host.links.keys().copied().collect();
        for link in links {
            if let Ok(requests) = RemoteRequests::bind(link) {
                let _ = requests.emit("host.name", &serde_json::json!({"name":name}));
            }
        }
    }
    pub fn rename_peer(&self, device: &str, name: &str) -> bool {
        let links: Vec<_> = self
            .inner()
            .host
            .links
            .iter()
            .filter(|(_, peer)| peer.as_str() == device)
            .map(|(link, _)| *link)
            .collect();
        let mut sent = false;
        for link in links {
            if let Ok(requests) = RemoteRequests::bind(link) {
                sent |= requests
                    .emit("device.rename", &serde_json::json!({"name":name}))
                    .is_ok();
            }
        }
        sent
    }
}
