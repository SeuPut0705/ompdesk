//! Host effects of the existing pool. The pool's owner/view/claim state remains in its existing engine.
//! Window ids here are supplied by the native host, never deserialized as caller authority.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use ompdesk_app_contract::Owner;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

use crate::remote::events::slim::{SharedBatch, Slimmer, slim_subagent_frame};
use crate::sidecar::application::EffectFuture;

pub enum Payload {
    Batch(Arc<[Value]>),
    Value(Arc<Value>),
}

impl Serialize for Payload {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Batch(batch) => batch.as_ref().serialize(serializer),
            Self::Value(value) => value.as_ref().serialize(serializer),
        }
    }
}

pub struct Data {
    pub tab: Arc<str>,
    pub payload: Payload,
}

impl Serialize for Data {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut data = serializer.serialize_struct("TabPush", 2)?;
        data.serialize_field("tabId", &self.tab.as_ref())?;
        data.serialize_field("payload", &self.payload)?;
        data.end()
    }
}

pub struct Delivery {
    pub windows: Vec<i64>,
    /// Existing IPC_EVENTS key; the native transport owns the key-to-channel mapping.
    pub channel: &'static str,
    pub data: Data,
}

/// A tab's full channel. One slimmer per receiver and one subagent queue, as in SidecarPool.#wireFull.
/// The native host arms its existing 32 ms presentation timer when `subagent` returns true.
pub struct FullChannel {
    tab: Arc<str>,
    windows: BTreeMap<i64, Slimmer>,
    pending: Vec<Value>,
}

impl FullChannel {
    pub fn new(tab: impl Into<Arc<str>>) -> Self {
        Self {
            tab: tab.into(),
            windows: BTreeMap::new(),
            pending: Vec::new(),
        }
    }

    pub fn attach(&mut self, window: i64) {
        self.windows.entry(window).or_default();
    }

    /// Flush while the departing receiver is still attached. Detaching never closes or disposes an owner.
    pub fn detach(&mut self, window: i64, send: &mut impl FnMut(Delivery)) {
        if !self.windows.contains_key(&window) {
            return;
        }
        self.flush(send);
        self.windows.remove(&window);
    }

    pub fn resnapshot(&mut self, window: i64) {
        if let Some(slimmer) = self.windows.get_mut(&window) {
            slimmer.reset();
        }
    }

    pub fn subagent(&mut self, frame: Value) -> bool {
        if self.windows.is_empty() {
            return false;
        }
        let arm = self.pending.is_empty();
        self.pending
            .push(slim_subagent_frame(&frame).unwrap_or(frame));
        arm
    }

    /// Called by the timer, before a transcript/RPC answer, before agent events, and on detach.
    pub fn flush(&mut self, send: &mut impl FnMut(Delivery)) {
        if self.pending.is_empty() {
            return;
        }
        let batch = Arc::from(std::mem::take(&mut self.pending));
        send(Delivery {
            windows: self.windows.keys().copied().collect(),
            channel: "SUBAGENT_FRAMES",
            data: Data {
                tab: Arc::clone(&self.tab),
                payload: Payload::Batch(batch),
            },
        });
    }

    pub fn events(&mut self, events: Arc<[Value]>, send: &mut impl FnMut(Delivery)) {
        self.flush(send);
        let mut shared = SharedBatch::default();
        let mut groups: Vec<(Arc<[Value]>, Vec<i64>)> = Vec::new();
        for (window, slimmer) in &mut self.windows {
            let batch = slimmer
                .slim_shared(&events, &mut shared)
                .unwrap_or_else(|| Arc::clone(&events));
            if let Some((_, windows)) = groups
                .iter_mut()
                .find(|(known, _)| Arc::ptr_eq(known, &batch))
            {
                windows.push(*window);
            } else {
                groups.push((batch, vec![*window]));
            }
        }
        for (batch, windows) in groups {
            send(Delivery {
                windows,
                channel: "EVENTS_BATCH",
                data: Data {
                    tab: Arc::clone(&self.tab),
                    payload: Payload::Batch(batch),
                },
            });
        }
    }

    pub fn forward(&self, channel: &'static str, payload: Value, send: &mut impl FnMut(Delivery)) {
        if self.windows.is_empty() {
            return;
        }
        send(Delivery {
            windows: self.windows.keys().copied().collect(),
            channel,
            data: Data {
                tab: Arc::clone(&self.tab),
                payload: Payload::Value(Arc::new(payload)),
            },
        });
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Restart,
    Now,
    Wait,
    Skip,
}

pub fn restart_decision(status: Option<&str>, busy: bool, extension: bool) -> Decision {
    let Some(status) = status else {
        return Decision::Skip;
    };
    if status == "asleep" {
        return Decision::Skip;
    }
    if !extension {
        return if busy {
            Decision::Wait
        } else {
            Decision::Restart
        };
    }
    if busy {
        if matches!(status, "starting" | "error") {
            Decision::Skip
        } else {
            Decision::Wait
        }
    } else if status == "ready" {
        Decision::Now
    } else {
        Decision::Skip
    }
}

pub fn merge_plans(a: &Value, b: &Value) -> Value {
    fn names(a: &Value, b: &Value) -> Vec<String> {
        let mut out = Vec::new();
        for name in a
            .as_array()
            .into_iter()
            .flatten()
            .chain(b.as_array().into_iter().flatten())
            .filter_map(Value::as_str)
        {
            if !out.iter().any(|known| known == name) {
                out.push(name.to_owned());
            }
        }
        out
    }
    let mut plan = json!({"reload": a["reload"] == true || b["reload"] == true, "restart": a["restart"] == true || b["restart"] == true, "reconnect": names(&a["reconnect"], &b["reconnect"])});
    if a.get("mcp").is_some_and(|value| !value.is_null())
        || b.get("mcp").is_some_and(|value| !value.is_null())
    {
        plan["mcp"] = if a["mcp"]["all"] == true || b["mcp"]["all"] == true {
            json!({"names": [], "all": true})
        } else {
            json!({"names": names(&a["mcp"]["names"], &b["mcp"]["names"])})
        };
    }
    plan
}

/// A native sidecar handle, local or remote. Its lifecycle is always the existing Lane or link service's.
pub trait Sidecar: Send + Sync {
    type Error: Send + 'static;
    fn facts(&self) -> Value;
    fn start(&self);
    fn restart(&self, session: Option<&str>);
    fn sleep(&self);
    fn adopt_cwd(&self, cwd: &str) -> bool;
    fn send_now(&self, frame: Value) -> Result<(), Self::Error>;
    fn send(&self, frame: Value) -> EffectFuture<'_, Result<(), Self::Error>>;
    fn stock(&self, command: Value) -> EffectFuture<'static, Result<Value, Self::Error>>;
    fn bridge(
        &self,
        method: String,
        params: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> EffectFuture<'static, Result<Value, Self::Error>>;
    /// Must capture the currently exiting generation before dispose forgets it, not when first polled.
    fn exit_waiter(&self) -> EffectFuture<'static, ()>;
    fn remove_listeners(&self);
    fn dispose(&self);
    fn sync_settings(&self) -> EffectFuture<'_, ()>;
}

/// The authenticated native host constructs this after resolving its owner. Not Deserialize.
pub struct Spawn {
    pub owner: Owner,
    pub tab: String,
    pub window: i64,
    pub cwd: String,
    pub kind: String,
    pub fresh: bool,
    pub device: Option<String>,
    pub session_path: Option<String>,
    pub worktree: Option<Value>,
    pub placeholder: bool,
    pub defer_start: bool,
}

pub struct Released {
    pub tab: String,
    pub owner_key: Option<String>,
    pub cwd: String,
    pub local: bool,
    pub exited: EffectFuture<'static, ()>,
}

/// Actual native collaborators, injected by Base. No second worker, raw page caller or Node request adapter.
pub trait Host: Send + Sync {
    type Sidecar: Sidecar + ?Sized + 'static;
    fn window(&self, id: i64) -> (bool, bool);
    fn unknown_window(&self) -> <Self::Sidecar as Sidecar>::Error;
    fn canonical_cwd(&self, cwd: &str) -> String;
    fn create(
        &self,
        spawn: &Spawn,
        web: bool,
    ) -> Result<Arc<Self::Sidecar>, <Self::Sidecar as Sidecar>::Error>;
    fn prepare_gate(&self, spawn: &Spawn, sidecar: &Arc<Self::Sidecar>);
    fn wire_light(&self, tab: &str, sidecar: &Arc<Self::Sidecar>);
    fn track_summary(&self, sidecar: &Arc<Self::Sidecar>);
    fn released(&self, release: Released);
}

struct Handle<S: Sidecar + ?Sized> {
    sidecar: Arc<S>,
    device: Option<String>,
}

pub struct Application<H: Host> {
    host: Arc<H>,
    handles: std::sync::Mutex<HashMap<String, Handle<H::Sidecar>>>,
}

impl<H: Host> Application<H> {
    pub fn new(host: Arc<H>) -> Self {
        Self {
            host,
            handles: Default::default(),
        }
    }

    fn handles(&self) -> std::sync::MutexGuard<'_, HashMap<String, Handle<H::Sidecar>>> {
        self.handles
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn sidecar(&self, tab: &str) -> Option<Arc<H::Sidecar>> {
        self.handles()
            .get(tab)
            .map(|handle| Arc::clone(&handle.sidecar))
    }

    pub fn spawn(&self, mut spawn: Spawn) -> Result<Value, <H::Sidecar as Sidecar>::Error> {
        let (destroyed, web) = self.host.window(spawn.window);
        if destroyed {
            return Err(self.host.unknown_window());
        }
        if spawn.device.is_none() {
            spawn.cwd = self.host.canonical_cwd(&spawn.cwd);
        }
        let sidecar = self.host.create(&spawn, web)?;
        let status = sidecar.facts()["status"].clone();
        self.host.prepare_gate(&spawn, &sidecar);
        self.handles().insert(
            spawn.tab.clone(),
            Handle {
                sidecar: Arc::clone(&sidecar),
                device: spawn.device.clone(),
            },
        );
        self.host.wire_light(&spawn.tab, &sidecar);
        if spawn.device.is_none() {
            self.host.track_summary(&sidecar);
        }
        Ok(json!({"status": status}))
    }

    pub fn facts(&self, tabs: &[String]) -> Value {
        let handles = self.handles();
        let mut facts = serde_json::Map::new();
        for tab in tabs {
            if let Some(handle) = handles.get(tab) {
                facts.insert(tab.clone(), handle.sidecar.facts());
            }
        }
        Value::Object(facts)
    }

    pub fn start(&self, tab: &str, session: Option<&str>) {
        if let Some(sidecar) = self.sidecar(tab) {
            if let Some(session) = session.filter(|session| !session.is_empty()) {
                sidecar.restart(Some(session));
            } else {
                sidecar.start();
            }
        }
    }

    pub fn restart(&self, tab: &str, session: Option<&str>) {
        if let Some(sidecar) = self.sidecar(tab) {
            sidecar.restart(session);
        }
    }

    pub fn sleep(&self, tab: &str) {
        if let Some(sidecar) = self.sidecar(tab) {
            sidecar.sleep();
        }
    }

    pub fn adopt_cwd(&self, tab: &str, cwd: &str) -> bool {
        self.sidecar(tab)
            .is_some_and(|sidecar| sidecar.adopt_cwd(cwd))
    }

    pub async fn stock(
        &self,
        tab: &str,
        command: Value,
    ) -> Result<Value, <H::Sidecar as Sidecar>::Error> {
        match self.sidecar(tab) {
            Some(sidecar) => sidecar.stock(command).await,
            None => Ok(Value::Null),
        }
    }

    pub async fn send(
        &self,
        tab: &str,
        frame: Value,
    ) -> Result<(), <H::Sidecar as Sidecar>::Error> {
        match self.sidecar(tab) {
            Some(sidecar) => sidecar.send(frame).await,
            None => Ok(()),
        }
    }

    pub async fn bridge(
        &self,
        tab: &str,
        method: String,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> Result<Value, <H::Sidecar as Sidecar>::Error> {
        match self.sidecar(tab) {
            Some(sidecar) => sidecar.bridge(method, Some(params), timeout_ms).await,
            None => Ok(Value::Null),
        }
    }

    pub fn dispose(&self, tab: &str, owner_key: Option<String>, hosted: bool) {
        let handle = self.handles().remove(tab);
        let Some(handle) = handle else {
            return;
        };
        handle.sidecar.remove_listeners();
        let exited = handle.sidecar.exit_waiter();
        let cwd = handle.sidecar.facts()["cwd"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        handle.sidecar.dispose();
        self.host.released(Released {
            tab: tab.into(),
            owner_key,
            cwd,
            local: handle.device.is_none() && !hosted,
            exited,
        });
    }

    pub async fn sync_settings(&self, tab: &str) {
        if let Some(sidecar) = self.sidecar(tab) {
            sidecar.sync_settings().await;
        }
    }
}

#[path = "asks.rs"]
pub mod asks;
#[path = "effects.rs"]
pub mod effects;
#[path = "native.rs"]
pub mod native;

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;
