//! Mobile web application effects around the existing Edge/router/stores. Base owns the global
//! NativeApp and caller registry; this service never reconstructs authority from page JSON.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ompdesk_app_contract::NativeCaller;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::assets::Assets;
use super::auth::Policy;
use super::blobs::{self, MediaOpener};
use super::deps::{BoxFuture, Clock, Hooks, Whois};
use super::desktop::NativeDesktop;
use super::devices::{BlockScope, DEFAULT_GRANTS, Device};
use super::effects::{self, ModelImages, Payloads};
use super::native::{Invocation, NativeEvent};
use super::notification_batch::{Kind, Text};
use super::notifier::{self, Activity, Context, NativeSender, TabFacts};
use super::router::{self, Host as Router, Pushed};
use super::server::{Change, Deps as EdgeDeps, Edge, Running, SERVER_HOST};
use super::store::{self, Stores};
use super::uploads;
use crate::remote::quota::{PeerQuota, Reservation, assistant_tokens, command_uses_model};
use crate::server::{Events, Fault, Reply};

/// Direct native state/effects. Implemented against the existing pool and desktop services, not a
/// second pool mirror or a Node callback. `active_tab` reads the authenticated device's window.
pub trait Host: Text {
    fn active_tab(&self, call: &Invocation) -> Option<String>;
    fn tab_facts(&self, tab: &str) -> Option<TabFacts>;
    fn release_device<'a>(&'a self, device: &'a str) -> BoxFuture<'a, Result<(), Fault>>;
}

pub struct Config {
    pub user_data: PathBuf,
    pub static_root: Option<PathBuf>,
    pub router: router::Config,
}
pub struct Deps {
    pub events: Events,
    pub clock: Clock,
    pub desktop: Arc<NativeDesktop>,
    pub whois: Arc<dyn Whois>,
    pub hooks: Option<Arc<dyn Hooks>>,
    pub assets: Arc<dyn Assets>,
    pub images: Arc<dyn ModelImages>,
    pub media: Arc<dyn MediaOpener>,
    pub host: Arc<dyn Host>,
}

struct Notifications {
    devices: Arc<super::store::FileDevices>,
    router: Arc<Router>,
    host: Arc<dyn Host>,
}
impl Text for Notifications {
    fn text(&self, key: &str, params: &[(&str, String)]) -> String {
        self.host.text(key, params)
    }
}
impl Context for Notifications {
    fn devices(&self) -> Vec<Device> {
        self.devices.list()
    }
    fn device(&self, id: &str) -> Option<Device> {
        self.devices.get(id)
    }
    fn visible(&self, id: &str) -> bool {
        self.router.is_device_visible(id)
    }
    fn tab(&self, id: &str) -> Option<TabFacts> {
        self.host.tab_facts(id)
    }
}

struct Sweeper {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
struct Life {
    running: Option<Running>,
    archiving: Option<JoinHandle<std::io::Result<Vec<PathBuf>>>>,
}

pub struct Application {
    user_data: PathBuf,
    static_root: Option<PathBuf>,
    pub stores: Arc<Stores>,
    pub router: Arc<Router>,
    pub payloads: Payloads,
    pub quota: PeerQuota,
    edge: Edge,
    desktop: Arc<NativeDesktop>,
    host: Arc<dyn Host>,
    clock: Clock,
    secret: String,
    drivers: Mutex<HashMap<String, String>>,
    notifier: Mutex<Option<notifier::Service>>,
    sweeper: Mutex<Option<Sweeper>>,
    life: tokio::sync::Mutex<Life>,
}

/// An admitted call and its quota receipt. Base moves args/bin into the one NativeApp invocation,
/// then passes the result to `finish`; no alternate caller or permission is stored in page args.
pub struct Pending {
    call: Invocation,
    pub args: Vec<Value>,
    pub bin: Option<Vec<u8>>,
    keyed_prefs: bool,
    reservation: Option<Reservation>,
}
impl Pending {
    pub fn invocation(&self) -> &Invocation {
        &self.call
    }
}

impl Application {
    pub fn new(
        mut config: Config,
        deps: Deps,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<NativeEvent>), Fault> {
        let stores = store::stores(&config.user_data);
        stores.attach_events(&config.user_data.to_string_lossy(), &deps.events);
        let secret = store::serve_secret(&config.user_data)?;
        if let Some(root) = &config.static_root {
            config.router.set_build(served_build(root));
        }
        let blobs = blobs::open(&config.user_data);
        blobs.set_media_opener(deps.media);
        blobs.attach_events(deps.events.clone());
        let (router, events) = Router::native(
            deps.events,
            config.router,
            stores.devices.clone(),
            deps.clock.clone(),
        );
        let uploads = uploads::open(&config.user_data);
        let key_dir = config.user_data.clone();
        let edge = Edge::new(EdgeDeps {
            policy: Policy {
                host: SERVER_HOST.into(),
                public_port: 0,
                secure: false,
                serve_prefix: None,
                pending_prefix: Some(secret.clone()),
                allowed_users: Vec::new(),
            },
            devices: stores.devices.clone(),
            blocks: stores.blocks.clone(),
            whois: deps.whois,
            desktop: deps.desktop.clone(),
            router: router.clone(),
            uploads: uploads.clone(),
            blobs: blobs.clone(),
            hooks: deps.hooks,
            assets: deps.assets,
            push_public_key: Arc::new(move || {
                super::push::loaded(&key_dir)
                    .map_or_else(String::new, |key| key.public_key().to_owned())
            }),
            clock: deps.clock.clone(),
        });
        let app = Arc::new(Self {
            quota: PeerQuota::new(stores.devices.clone()),
            user_data: config.user_data,
            static_root: config.static_root,
            stores,
            router,
            payloads: Payloads {
                uploads,
                blobs,
                images: deps.images,
            },
            edge,
            desktop: deps.desktop,
            host: deps.host,
            clock: deps.clock,
            secret,
            drivers: Mutex::default(),
            notifier: Mutex::default(),
            sweeper: Mutex::default(),
            life: tokio::sync::Mutex::new(Life {
                running: None,
                archiving: None,
            }),
        });
        Ok((app, events))
    }

    pub fn configure(&self, policy: Change) {
        self.edge.configure(policy);
    }
    pub fn serve_secret(&self) -> &str {
        &self.secret
    }

    pub async fn start(&self, port: u16) -> Result<u16, Fault> {
        let mut life = self.life.lock().await;
        if let Some(running) = &life.running {
            return Ok(running.port);
        }
        let user_data = self.user_data.clone();
        let (_, created) = tokio::task::spawn_blocking(move || super::push::load_vapid(&user_data))
            .await
            .map_err(|e| Fault::new("internal", e.to_string()))?
            .map_err(|e| Fault::new("io", e.to_string()))?;
        // Before the listener can hand out this VAPID key, old subscriptions must be gone.
        if created {
            self.stores.devices.apply(None, |book| book.drop_all_push());
        }
        let running = self.edge.start(port).await.map_err(|e| {
            Fault::new(
                if e.kind() == std::io::ErrorKind::AddrInUse {
                    "EADDRINUSE"
                } else {
                    "web_listen"
                },
                format!("listen {SERVER_HOST}:{port}: {e}"),
            )
        })?;
        let port = running.port;
        self.edge.configure(Change {
            public_port: Some(port),
            pending_prefix: Some(Some(self.secret.clone())),
            ..Change::default()
        });
        life.running = Some(running);
        let context = Arc::new(Notifications {
            devices: self.stores.devices.clone(),
            router: self.router.clone(),
            host: self.host.clone(),
        });
        let sender = Arc::new(NativeSender {
            user_data: self.user_data.clone(),
            devices: self.stores.devices.clone(),
        });
        *self.notifier.lock().unwrap_or_else(|e| e.into_inner()) = Some(notifier::Service::start(
            context,
            sender,
            self.clock.clone(),
        ));
        self.keep_uploads_swept();
        if let Some(root) = &self.static_root {
            let archive = super::archive::open(&self.user_data);
            let root = root.clone();
            let now = (self.clock)();
            life.archiving = Some(tokio::spawn(
                async move { archive.retain(&root, now).await },
            ));
        }
        Ok(port)
    }

    pub async fn stop(&self) -> Result<(), Fault> {
        let mut life = self.life.lock().await;
        let notifier = self
            .notifier
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(notifier) = notifier {
            notifier.stop().await;
        }
        if let Some(running) = life.running.take() {
            running.stop().await;
        }
        if let Some(task) = life.archiving.take() {
            match task.await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    eprintln!("web assets: keeping this build's assets failed: {error}")
                }
                Err(error) => eprintln!("web assets: keeping this build's assets failed: {error}"),
            }
        }
        self.stores.devices.flush().await?;
        self.stores.blocks.flush().await
    }

    /// Also used while Mobile web is off, for a paired computer's uploaded attachments.
    pub fn keep_uploads_swept(&self) {
        let mut sweeper = self.sweeper.lock().unwrap_or_else(|e| e.into_inner());
        if sweeper.is_some() {
            return;
        }
        let (stop, mut stopped) = watch::channel(false);
        let uploads = self.payloads.uploads.clone();
        let now = self.clock.clone();
        let task = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_secs(3600));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { _ = stopped.changed() => break, _ = ticks.tick() => {} }
                uploads.sweep(now(), uploads::TTL_MS).await;
            }
        });
        *sweeper = Some(Sweeper { stop, task });
    }

    pub async fn shutdown(&self) -> Result<(), Fault> {
        let result = self.stop().await;
        let sweeper = self
            .sweeper
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(sweeper) = sweeper {
            let _ = sweeper.stop.send(true);
            let _ = sweeper.task.await;
        }
        result
    }

    pub fn activity(&self, activity: Activity) {
        if let Activity::Released { tab } = &activity {
            self.drivers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(tab);
        }
        if let Some(notifier) = &*self.notifier.lock().unwrap_or_else(|e| e.into_inner()) {
            notifier.activity(activity);
        }
    }
    pub fn notice(&self, tab: &str, kind: Kind, title: &str, body: &str) {
        if let Some(notifier) = &*self.notifier.lock().unwrap_or_else(|e| e.into_inner()) {
            notifier.notice(tab, kind, title, body);
        }
    }

    pub fn list(&self) -> Result<Vec<Value>, Fault> {
        self.stores.devices.list().into_iter().map(|device| {
            let usage = self.quota.usage(&device.device_id)?;
            Ok(json!({"id":device.device_id,"name":device.name,"userAgent":device.user_agent,"tailscaleLogin":device.tailscale_login,
                "createdAt":device.created_at,"lastSeenAt":device.last_seen_at,"connected":self.router.is_connected(&device.device_id),
                "tier":tier(&device.grants),"grants":device.grants,"limits":device.limits.unwrap_or_else(|| json!({})),
                "usage":{"requests":usage.requests,"tokens":usage.tokens},"blockScope":if device.node_id.is_some() {"node"} else {"login"}}))
        }).collect()
    }

    /// Called only with Base's authenticated native caller, never a value deserialized from a page.
    pub async fn admin(
        &self,
        caller: &NativeCaller,
        channel: &str,
        args: &[Value],
    ) -> Result<Value, Fault> {
        if !matches!(caller, NativeCaller::Desktop { .. }) {
            return Err(Fault::new(
                "web_forbidden",
                "Pairing administration is only available on the computer",
            ));
        }
        let string = |index: usize, max: usize| -> Result<&str, Fault> {
            args.get(index)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.encode_utf16().count() <= max)
                .ok_or_else(|| Fault::new("invalid_params", "Invalid request"))
        };
        let invalid = || Fault::new("invalid_params", "Invalid request");
        match channel {
            "mobile-web:devices-list" => serde_json::to_value(self.list()?)
                .map_err(|e| Fault::new("internal", e.to_string())),
            "mobile-web:devices-revoke" => {
                self.block(string(0, 128)?).await?;
                Ok(json!(self.list()?))
            }
            "mobile-web:devices-rename" => {
                let id = string(0, 128)?;
                let name = string(1, 200)?;
                self.stores
                    .devices
                    .apply(None, |book| book.rename(id, name));
                Ok(json!(self.list()?))
            }
            "mobile-web:devices-set-grants" => {
                let id = string(0, 128)?;
                let grants = parse_grants(args.get(1).ok_or_else(invalid)?)?;
                self.stores
                    .devices
                    .apply(None, |book| book.set_grants(id, &grants));
                Ok(json!(self.list()?))
            }
            "mobile-web:devices-set-limits" => {
                let id = string(0, 128)?;
                let limits = super::devices::clean_limits(args.get(1).ok_or_else(invalid)?)
                    .ok_or_else(invalid)?;
                self.quota
                    .set_limits(id, serde_json::from_value(limits).map_err(|_| invalid())?)?;
                Ok(json!(self.list()?))
            }
            "mobile-web:blocks-list" => Ok(json!(self.stores.blocks.list())),
            "mobile-web:blocks-remove" => {
                let id = string(0, 400)?;
                self.stores.blocks.apply(0, |book| {
                    let removed = book.remove(id);
                    (removed, removed)
                });
                Ok(json!(self.stores.blocks.list()))
            }
            "mobile-web:pairing-respond" => {
                let response = args
                    .first()
                    .and_then(Value::as_object)
                    .ok_or_else(invalid)?;
                let id = response
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(invalid)?;
                let approve = response
                    .get("approve")
                    .and_then(Value::as_bool)
                    .ok_or_else(invalid)?;
                let grants = response.get("grants").map(parse_grants).transpose()?;
                self.desktop
                    .confirmations
                    .respond(id, approve, grants.as_deref());
                Ok(Value::Null)
            }
            _ => Err(Fault::new(
                "unknown_channel",
                "Unknown mobile web administration channel",
            )),
        }
    }

    pub fn confirmations(&self) -> &Arc<super::pairing::Confirmations> {
        &self.desktop.confirmations
    }

    pub async fn block(&self, id: &str) -> Result<bool, Fault> {
        let Some(device) = self.stores.devices.get(id) else {
            return Ok(false);
        };
        let scope = if device.node_id.is_some() {
            BlockScope::Node
        } else {
            BlockScope::Login
        };
        let key = device
            .node_id
            .as_deref()
            .or(device.tailscale_login.as_deref());
        if let Some(key) = key {
            self.stores.blocks.apply(0, |book| {
                (
                    book.add(
                        scope,
                        key,
                        &device.name,
                        device.tailscale_login.clone(),
                        (self.clock)().into(),
                    ),
                    true,
                )
            });
        }
        // Enrollment checks the block under the device-book lock. A create that won before the
        // block is included here; a later create cannot pass it, even on another Tokio worker.
        let ids: Vec<_> = self
            .stores
            .devices
            .list()
            .into_iter()
            .filter(|other| {
                if let Some(node) = &device.node_id {
                    other.node_id.as_ref() == Some(node)
                } else if let Some(login) = &device.tailscale_login {
                    other
                        .tailscale_login
                        .as_ref()
                        .is_some_and(|l| l.to_lowercase() == login.to_lowercase())
                } else {
                    other.device_id == id
                }
            })
            .map(|d| d.device_id)
            .collect();
        for id in &ids {
            self.stores.devices.apply(None, |book| book.revoke(id));
            self.release_now(id);
        }
        for id in ids {
            self.payloads.uploads.remove_device(&id).await;
            self.host.release_device(&id).await?;
        }
        Ok(true)
    }

    /// Also called by Base for an expiry event from the existing store.
    pub async fn revoked(&self, id: &str) -> Result<(), Fault> {
        self.release_now(id);
        self.payloads.uploads.remove_device(id).await;
        self.host.release_device(id).await
    }

    fn release_now(&self, id: &str) {
        self.router.close_device(id, 4401, "revoked");
        self.payloads.blobs.release_device(id);
        if let Some(notifier) = &*self.notifier.lock().unwrap_or_else(|e| e.into_inner()) {
            notifier.drop_device(id);
        }
    }

    /// Called synchronously in admission order, before any upload/image await.
    pub fn begin(&self, call: Invocation) -> Option<Pending> {
        let prepared = (|| {
            if !self.router.authenticates(&call) {
                return Err(Fault::new(
                    "web_forbidden",
                    "This device is no longer paired",
                ));
            }
            let args: Vec<Value> = serde_json::from_str(call.args().get())
                .map_err(|e| Fault::new("invalid_params", e.to_string()))?;
            let keyed_prefs = args
                .first()
                .and_then(|v| v.get("key"))
                .is_some_and(effects::js_truthy);
            let weight = if call.is_invoke() {
                self.model_requests(&call, &args)
            } else {
                0.0
            };
            let reservation = if weight > 0.0 {
                Some(self.quota.reserve(call.device(), weight)?)
            } else {
                None
            };
            Ok((args, keyed_prefs, reservation))
        })();
        match prepared {
            Ok((args, keyed_prefs, reservation)) => Some(Pending {
                call,
                args,
                bin: None,
                keyed_prefs,
                reservation,
            }),
            Err(error) => {
                self.router.complete(call, Err(error));
                None
            }
        }
    }

    pub async fn land(&self, pending: &mut Pending) -> Result<(), Fault> {
        let id = pending.call.device();
        if pending.call.channel() == "fs:upload-to-host" {
            pending.bin = self
                .payloads
                .land_host_upload(id, &mut pending.args)
                .await?;
        } else {
            let mut args = Value::Array(std::mem::take(&mut pending.args));
            let landed = if self.payloads.needs_landing(&args) {
                self.payloads.land_images(id, &mut args).await
            } else {
                Ok(())
            };
            if let Value::Array(args) = args {
                pending.args = args;
            }
            landed?;
        }
        if pending.call.channel() == "fs:media-release" {
            self.payloads
                .translate_media_release((self.clock)(), id, &mut pending.args);
        }
        if !self.router.authenticates(&pending.call) {
            return Err(Fault::new(
                "web_forbidden",
                "This device is no longer paired",
            ));
        }
        Ok(())
    }

    pub fn finish(&self, mut pending: Pending, result: Result<Reply, Fault>) {
        let result = result.and_then(|reply| {
            let value: Value = serde_json::from_str(reply.result.get())
                .map_err(|e| Fault::new("internal", e.to_string()))?;
            let refused = effects::refused(&value);
            let value = self.payloads.shape_result(
                (self.clock)(),
                pending.call.device(),
                pending.call.channel(),
                pending.keyed_prefs,
                value,
                reply.bin,
            )?;
            if refused && let Some(reservation) = pending.reservation.take() {
                reservation.refund()?;
            }
            Reply::json(&value)
        });
        let result = if result.is_err() {
            match pending
                .reservation
                .take()
                .map(Reservation::refund)
                .transpose()
            {
                Ok(_) => result,
                Err(error) => Err(error),
            }
        } else {
            result
        };
        self.router.complete(pending.call, result);
    }

    fn model_requests(&self, call: &Invocation, args: &[Value]) -> f64 {
        match call.channel() {
            "rpc:command" | "rpc:command-for-tab" => {
                let Some(command) = args
                    .first()
                    .and_then(|v| v.get("command"))
                    .filter(|v| v.get("type").and_then(Value::as_str).is_some())
                else {
                    return 0.0;
                };
                if !command_uses_model(command) {
                    return 0.0;
                }
                let tab = args[0]
                    .get("tabId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| self.host.active_tab(call));
                if let Some(tab) = tab {
                    self.drivers
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(tab, call.device().to_owned());
                }
                1.0
            }
            "bench:run" => {
                let count = args
                    .first()
                    .and_then(|v| {
                        Some(v.get("models")?.as_array()?.len() as f64 * v.get("runs")?.as_f64()?)
                    })
                    .unwrap_or(1.0);
                if count.is_finite() {
                    count.floor().max(1.0)
                } else {
                    1.0
                }
            }
            "model-setup:run" => 1.0,
            _ => 0.0,
        }
    }

    pub fn deliver(&self, device: &str, channel: &str, value: Value) -> Result<(), Fault> {
        self.deliver_many(&[device], channel, value)
    }

    /// One serialization per producer push, shared by every device's socket fanout.
    pub fn deliver_many(&self, devices: &[&str], channel: &str, value: Value) -> Result<(), Fault> {
        if channel == "rpc:events"
            && let (Some(tab), Some(events)) = (
                value.get("tabId").and_then(Value::as_str),
                value.get("payload").and_then(Value::as_array),
            )
        {
            let driver = self
                .drivers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(tab)
                .cloned();
            if let Some(driver) = driver.filter(|id| devices.contains(&id.as_str())) {
                let tokens: f64 = events.iter().map(assistant_tokens).sum();
                if tokens > 0.0 {
                    self.quota.record(&driver, 0.0, tokens)?;
                }
            }
        }
        if !self.router.accepts_push(channel)
            || matches!(
                channel,
                "mobile-web:devices-changed"
                    | "mobile-web:device-connected"
                    | "mobile-web:pairing-request"
            )
        {
            return Ok(());
        }
        let mut pushed = None;
        for device in devices {
            if !self.router.is_connected(device) {
                self.router.deliver(device, None);
                continue;
            }
            if pushed.is_none() {
                pushed = Some(Pushed::new(
                    channel.to_owned(),
                    Some(
                        serde_json::value::to_raw_value(&value)
                            .map_err(|e| Fault::new("internal", e.to_string()))?,
                    ),
                ));
            }
            self.router.deliver(device, pushed.clone());
        }
        Ok(())
    }
}

fn served_build(root: &std::path::Path) -> Option<String> {
    let page = std::fs::read_to_string(root.join("web.html")).ok()?;
    let marker = "<meta name=\"omp-build\" content=\"";
    let rest = page.split_once(marker)?.1;
    let build = rest.split_once('"')?.0;
    (!build.is_empty()).then(|| build.to_owned())
}

fn tier(grants: &[String]) -> &'static str {
    let held: HashSet<_> = grants.iter().map(String::as_str).collect();
    if held.len() == DEFAULT_GRANTS.len() && DEFAULT_GRANTS.iter().all(|g| held.contains(g)) {
        return "full";
    }
    if held.len() + 1 == DEFAULT_GRANTS.len()
        && !held.contains("desktop-control")
        && DEFAULT_GRANTS
            .iter()
            .filter(|g| **g != "desktop-control")
            .all(|g| held.contains(g))
    {
        return "no-desktop";
    }
    if held.len() == 2 && held.contains("workspace") && held.contains("device-self") {
        return "chat-view";
    }
    "custom"
}

fn parse_grants(value: &Value) -> Result<Vec<String>, Fault> {
    let invalid = || Fault::new("invalid_params", "Invalid request");
    let grants = value
        .as_array()
        .filter(|g| g.len() <= DEFAULT_GRANTS.len() + 1)
        .ok_or_else(invalid)?;
    grants
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|g| *g == "pairing-admin" || DEFAULT_GRANTS.contains(g))
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect()
}

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;
