//! The page sockets' router (native-rust ledger 8c; was `src/main/web/ws-router.ts`'s `WsRouter` and
//! `WsConnection`): one connection per open page socket, up to four a device, each with its rate limit, its
//! numbered and batched pushes, its presence and its heartbeat, and the page's calls checked against `IPC_POLICY`, the
//! web-only channels and the device's grants before main runs them.
//!
//! Main hands the router what its windows push to a device (`web.deliver {host, device, ch}` with the data's JSON as
//! `bin`; with no `ch`, a push main did not send because the device had no connection then), answers a page's call
//! (`web.reply {host, call, ok, e}` with the value's JSON as `bin`), says a resync was prepared (`web.resynced {host,
//! conn}`) and closes a device's sockets (`web.closeDevice`). The router tells main which connections a device has and
//! which of them show their page (`web.conns`), asks it to prepare a page's resync (`web.resync`) and hands it each call
//! it let through (`web.call`, the arguments' JSON as `bin`). All of them are handled in the order they come, so a
//! call's answer leaves after every push main made before it, and a page's frames reach main in the order the page
//! sent them, before the event that says its connection ended.
//!
//! A host's router lives from its first `web.start` to the core's end: a page coming back after Mobile web was
//! turned off and on again can still resume.

use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::deps::{BoxFuture, Connection, Outbox, Outgoing, Router};
use super::native::{ConnectionInfo, Invocation, NativeEvent};
use crate::server::{Call, Events, Fault, PushCall, Registry, Reply};
use tokio::sync::mpsc;

pub const EVENT_BATCH_MS: u64 = 75;
pub const MAX_CONNECTIONS_PER_DEVICE: usize = 4;
/// Sustained and burst messages a second per socket.
const MESSAGE_RATE: f64 = 200.0;
const MESSAGE_BURST: f64 = 400.0;
/// Heavy calls (a search, a big read, a directory listing) one device may have running at once.
const HEAVY_CALLS_PER_DEVICE: usize = 4;
const HEARTBEAT_MS: i64 = 20_000;
const HEARTBEAT_MAX_MISSES: u32 = 3;
/// The most a page may send in one frame.
const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// How long an ended connection can be resumed by the page that held it (`resume.<connId>`).
const RESUME_WINDOW_MS: i64 = 10 * 60_000;
const RESUME_ENTRIES_MAX: usize = 64;
/// Joined data texts kept per first push: connections whose batch windows close apart join pushes differently.
const DATA_TEXTS_KEPT: usize = 4;

const CLOSE_GOING_AWAY: u16 = 1001;
const CLOSE_POLICY: u16 = 1008;
const CLOSE_TOO_BIG: u16 = 1009;
const CLOSE_REVOKED: u16 = 4401;
const CLOSE_RATE_LIMITED: u16 = 4429;

const DELTA_TYPES: &[&str] = &["text_delta", "thinking_delta", "toolcall_delta"];

// ---------------------------------------------------------------------------------------------------------------
// An object's members as written, for splicing JSON without reading its values.

/// An object's members in order, each value as written. A key written twice keeps its first place and its last
/// value, as `JSON.parse` keeps it.
struct Members {
    /// In the order the keys first appeared, as `JSON.parse` keeps them.
    members: Vec<(String, Box<RawValue>)>,
    /// Each key's place in `members`, so a frame of many keys is read in linear time.
    places: HashMap<String, usize>,
}

impl Members {
    fn get(&self, key: &str) -> Option<&RawValue> {
        self.places.get(key).map(|&place| &*self.members[place].1)
    }

    fn parse(raw: &RawValue) -> Option<Members> {
        serde_json::from_str(raw.get()).ok()
    }
}

impl<'de> Deserialize<'de> for Members {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Of;
        impl<'de> Visitor<'de> for Of {
            type Value = Members;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Members, A::Error> {
                let mut members: Vec<(String, Box<RawValue>)> = Vec::new();
                let mut places: HashMap<String, usize> = HashMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    // A repeated key keeps its first place and takes the last value, as `JSON.parse` does.
                    match places.get(&key) {
                        Some(&place) => members[place].1 = value,
                        None => {
                            places.insert(key.clone(), members.len());
                            members.push((key, value));
                        }
                    }
                }
                Ok(Members { members, places })
            }
        }
        deserializer.deserialize_map(Of)
    }
}

fn key_text(key: &str) -> String {
    serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned())
}

fn is_string(raw: &RawValue) -> bool {
    raw.get().starts_with('"')
}

fn string_of(raw: &RawValue) -> Option<String> {
    serde_json::from_str(raw.get()).ok()
}

/// `a === b` over two members that may be absent: absent equals absent, an object or array equals nothing.
fn same(a: Option<&RawValue>, b: Option<&RawValue>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            let (Ok(a), Ok(b)) = (
                serde_json::from_str::<Value>(a.get()),
                serde_json::from_str::<Value>(b.get()),
            ) else {
                return a.get() == b.get();
            };
            match (&a, &b) {
                (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
                (Value::Object(_) | Value::Array(_), _)
                | (_, Value::Object(_) | Value::Array(_)) => false,
                _ => a == b,
            }
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Batching: neighbouring batches of a tab joined, their streaming deltas merged (`coalesceEvents`).

/// A push as main handed it: its channel and its data's JSON (none for `undefined`).
pub struct Pushed {
    ch: String,
    data: Option<Box<RawValue>>,
    batch: OnceLock<Option<TabBatch>>,
    /// Joined texts made of this push first, by the pushes they were made of.
    texts: Mutex<Vec<(Vec<usize>, Arc<str>)>>,
}

impl Pushed {
    pub fn new(ch: String, data: Option<Box<RawValue>>) -> Arc<Pushed> {
        Arc::new(Pushed {
            ch,
            data,
            batch: OnceLock::new(),
            texts: Mutex::new(Vec::new()),
        })
    }

    /// An `EVENTS_BATCH` push's data when it is a tab's batch (`isTabBatch`).
    fn batch(&self, channel: &str) -> Option<&TabBatch> {
        self.batch
            .get_or_init(|| {
                if self.ch != channel {
                    return None;
                }
                let members = Members::parse(self.data.as_deref()?)?;
                let tab = members.get("tabId").filter(|raw| is_string(raw))?;
                let payload = members.get("payload")?;
                let events: Vec<Box<RawValue>> = serde_json::from_str(payload.get()).ok()?;
                Some(TabBatch {
                    tab: tab.to_owned(),
                    tab_id: string_of(tab),
                    members,
                    events,
                })
            })
            .as_ref()
    }

    fn id(self: &Arc<Self>) -> usize {
        Arc::as_ptr(self) as usize
    }
}

struct TabBatch {
    tab: Box<RawValue>,
    tab_id: Option<String>,
    members: Members,
    events: Vec<Box<RawValue>>,
}

impl TabBatch {
    fn same_tab(&self, other: &TabBatch) -> bool {
        match (&self.tab_id, &other.tab_id) {
            (Some(a), Some(b)) => a == b,
            _ => self.tab.get() == other.tab.get(),
        }
    }
}

/// A streamed update with no snapshot: its delta can be joined with its neighbour's.
struct Update {
    /// The event's members as the latest update joined into it has them.
    members: Members,
    /// Its `assistantMessageEvent`'s members (the latest's), and the joined delta's escaped text.
    increment: Members,
    delta: String,
}

enum Event<'a> {
    Raw(&'a RawValue),
    Update(Update, &'a RawValue, bool),
}

impl Update {
    /// `mergeableUpdate`: a `message_update` of a delta kind whose message carries no snapshot (`content`).
    fn of(raw: &RawValue) -> Option<Update> {
        let members = Members::parse(raw)?;
        if string_of(members.get("type")?).as_deref() != Some("message_update") {
            return None;
        }
        let increment = Members::parse(members.get("assistantMessageEvent")?)?;
        let kind = string_of(increment.get("type")?)?;
        if !DELTA_TYPES.contains(&kind.as_str()) {
            return None;
        }
        let message = Members::parse(members.get("message")?)?;
        if message.get("content").is_some() {
            return None;
        }
        let delta = match increment.get("delta") {
            Some(raw) if is_string(raw) => raw.get()[1..raw.get().len() - 1].to_owned(),
            _ => String::new(),
        };
        Some(Update {
            members,
            increment,
            delta,
        })
    }

    fn message_member(&self, key: &str) -> Option<Box<RawValue>> {
        Members::parse(self.members.get("message")?)?
            .get(key)
            .map(ToOwned::to_owned)
    }

    /// `joinUpdates`' test: one block of one message, both deltas strings.
    fn joins(&self, later: &Update) -> bool {
        let (a, b) = (&self.increment, &later.increment);
        same(a.get("type"), b.get("type"))
            && same(a.get("contentIndex"), b.get("contentIndex"))
            && a.get("delta").is_some_and(is_string)
            && b.get("delta").is_some_and(is_string)
            && same(
                self.members.get("messageId"),
                later.members.get("messageId"),
            )
            && same(
                self.message_member("timestamp").as_deref(),
                later.message_member("timestamp").as_deref(),
            )
    }

    fn write(&self, out: &mut String) {
        out.push('{');
        for (index, (key, value)) in self.members.members.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&key_text(key));
            out.push(':');
            if key == "assistantMessageEvent" {
                out.push('{');
                for (index, (key, value)) in self.increment.members.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&key_text(key));
                    out.push(':');
                    if key == "delta" {
                        let _ = write!(out, "\"{}\"", self.delta);
                    } else {
                        out.push_str(value.get());
                    }
                }
                out.push('}');
            } else {
                out.push_str(value.get());
            }
        }
        out.push('}');
    }
}

/// `mergeMessageUpdates`: neighbouring slim updates of one block joined; anything else keeps its place and count.
/// Whether anything was joined, and the events.
fn merge<'a>(events: impl Iterator<Item = &'a RawValue>) -> (bool, Vec<Event<'a>>) {
    let mut merged: Vec<Event<'a>> = Vec::new();
    let mut joined = false;
    for raw in events {
        let Some(update) = Update::of(raw) else {
            merged.push(Event::Raw(raw));
            continue;
        };
        if let Some(Event::Update(previous, _, was_joined)) = merged.last_mut()
            && previous.joins(&update)
        {
            // The later update's members, its delta appended to the earlier one's.
            let delta = std::mem::take(&mut previous.delta) + &update.delta;
            *previous = Update { delta, ..update };
            *was_joined = true;
            joined = true;
            continue;
        }
        merged.push(Event::Update(update, raw, false));
    }
    (joined, merged)
}

fn write_events(out: &mut String, events: &[Event<'_>]) {
    out.push('[');
    for (index, event) in events.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        match event {
            Event::Raw(raw) | Event::Update(_, raw, false) => out.push_str(raw.get()),
            Event::Update(update, _, true) => update.write(out),
        }
    }
    out.push(']');
}

/// One frame's worth: one push, or a tab's neighbouring batches joined.
pub struct Coalesced {
    pub from: Vec<Arc<Pushed>>,
}

/// `coalesceEvents`: neighbouring `EVENTS_BATCH` (`batch`) pushes of one tab become one.
pub fn coalesce(queue: &[Arc<Pushed>], batch: &str) -> Vec<Coalesced> {
    let channel = batch;
    let mut out: Vec<Coalesced> = Vec::new();
    for item in queue {
        if let (Some(previous), Some(batch)) = (out.last_mut(), item.batch(channel)) {
            let last = previous.from.last().and_then(|last| last.batch(channel));
            if last.is_some_and(|last| last.same_tab(batch)) {
                previous.from.push(Arc::clone(item));
                continue;
            }
        }
        out.push(Coalesced {
            from: vec![Arc::clone(item)],
        });
    }
    out
}

impl Coalesced {
    pub fn ch(&self) -> &str {
        &self.from[0].ch
    }

    /// The data's JSON as `JSON.stringify(item.d)` wrote it, made once for every connection that sends the same pushes
    /// joined the same way (`dataText`).
    pub fn data_text(&self, channel: &str) -> Option<Arc<str>> {
        let first = &self.from[0];
        let Some(batch) = first.batch(channel) else {
            return first.data.as_deref().map(|raw| Arc::from(raw.get()));
        };
        let ids: Vec<usize> = self.from.iter().map(Pushed::id).collect();
        let mut texts = first.texts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, text)) = texts.iter().find(|(from, _)| *from == ids) {
            return Some(Arc::clone(text));
        }
        let text: Arc<str> = if self.from.len() == 1 {
            let (joined, events) = merge(batch.events.iter().map(|raw| &**raw));
            if !joined {
                return first.data.as_deref().map(|raw| Arc::from(raw.get()));
            }
            let mut out = String::from("{");
            for (index, (key, value)) in batch.members.members.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&key_text(key));
                out.push(':');
                if key == "payload" {
                    write_events(&mut out, &events);
                } else {
                    out.push_str(value.get());
                }
            }
            out.push('}');
            Arc::from(out)
        } else {
            let all = self
                .from
                .iter()
                .filter_map(|item| item.batch(channel))
                .flat_map(|batch| batch.events.iter().map(|raw| &**raw));
            let (_, events) = merge(all);
            let tab = self
                .from
                .last()
                .and_then(|item| item.batch(channel))
                .map_or("null", |batch| batch.tab.get());
            let mut out = format!("{{\"tabId\":{tab},\"payload\":");
            write_events(&mut out, &events);
            out.push('}');
            Arc::from(out)
        };
        if texts.len() < DATA_TEXTS_KEPT {
            texts.push((ids, Arc::clone(&text)));
        }
        Some(text)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The router.

/// What the router needs of the device list: a paired device's grants, none once it is revoked.
pub trait Grants: Send + Sync {
    fn grants(&self, device_id: &str) -> Option<Vec<String>>;
}

impl Grants for super::store::FileDevices {
    fn grants(&self, device_id: &str) -> Option<Vec<String>> {
        self.get(device_id).map(|device| device.grants)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Dir {
    Invoke,
    Send,
    Push,
}

impl Dir {
    fn name(self) -> &'static str {
        match self {
            Dir::Invoke => "invoke",
            Dir::Send => "send",
            Dir::Push => "push",
        }
    }
}

#[derive(Deserialize)]
struct PolicyEntry {
    dir: Dir,
    #[serde(default)]
    permission: Option<String>,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Deserialize)]
struct WebChannel {
    dir: Dir,
    permission: String,
    #[serde(default)]
    heavy: bool,
}

/// The channels the router treats apart, by main's names (`ipc-types.ts`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Channels {
    /// `EVENTS_BATCH`: a tab's events, joined with its neighbours.
    batch: String,
    /// The pushes that carry a running reply or a log: dropped while the page is hidden (it reloads state on return).
    streams: Vec<String>,
    /// Calls that read or scan a lot: a device runs a few at once.
    heavy: Vec<String>,
    /// `PREFS_SET`, which may not write `mobileWeb.*`.
    prefs_set: String,
}

/// What main hands the router at the start: the page protocol it speaks, the host's features and build,
/// `IPC_POLICY`, the web-only channels and the channels it treats apart.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    channels: Channels,
    protocol: u32,
    features: Box<RawValue>,
    #[serde(default)]
    build: Option<String>,
    policy: HashMap<String, PolicyEntry>,
    #[serde(default)]
    web_channels: HashMap<String, WebChannel>,
}

impl Config {
    pub fn set_build(&mut self, build: Option<String>) {
        self.build = build;
    }
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Ended {
    conn_id: String,
    device: String,
    pushes: u64,
    clean: bool,
    at: i64,
}

/// A socket's message rate: refills `MESSAGE_RATE` tokens a second up to `MESSAGE_BURST`.
struct Bucket {
    tokens: f64,
    at: i64,
}

impl Bucket {
    fn new(now: i64) -> Bucket {
        Bucket {
            tokens: MESSAGE_BURST,
            at: now,
        }
    }

    fn take(&mut self, now: i64) -> bool {
        self.tokens =
            MESSAGE_BURST.min(self.tokens + ((now - self.at) as f64 / 1000.0) * MESSAGE_RATE);
        self.at = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

struct Conn {
    device: String,
    conn_id: String,
    outbox: Outbox,
    bucket: Bucket,
    queue: Vec<Arc<Pushed>>,
    /// The batch window open, by its number (a late timer of an earlier window does nothing).
    flush: Option<u64>,
    seq: u64,
    acked: u64,
    missed: bool,
    visible: bool,
    closed: bool,
    /// The hello goes out once main prepared the page's resync (`web.resynced`); pushes before it are dropped.
    awaiting_hello: bool,
    misses: u32,
    last_activity: i64,
    last_tick: i64,
}

impl Conn {
    /// The page had every event this connection was sent: none queued, none dropped, all acknowledged.
    fn clean(&self) -> bool {
        !self.missed && self.queue.is_empty() && self.acked >= self.seq
    }

    fn write(&self, text: String) {
        if !self.closed {
            self.outbox.send(Outgoing::Text(text));
        }
    }
}

/// A call let through to main and not yet answered: whose, and whether it holds one of the device's heavy slots.
struct Pending {
    conn: u64,
    /// An invoke's id; a send has no answer to give.
    id: Option<u64>,
    heavy: Option<String>,
}

#[derive(Default)]
struct State {
    next_conn: u64,
    next_call: u64,
    next_flush: u64,
    conns: HashMap<u64, Conn>,
    /// Each device's connections in the order they came.
    devices: HashMap<String, Vec<u64>>,
    ended: VecDeque<Ended>,
    pushes: HashMap<String, u64>,
    heavy: HashMap<String, usize>,
    calls: HashMap<u64, Pending>,
    /// Manual timers (a test's): the batch windows open, by connection.
    due: Vec<(u64, u64)>,
}

/// One host's router.
pub struct Host {
    host: u64,
    events: Mutex<Events>,
    config: Config,
    grants: Arc<dyn Grants>,
    clock: Clock,
    /// A test drives the batch and heartbeat timers (`web.router.test.*`).
    manual: bool,
    state: Mutex<State>,
    me: Weak<Host>,
    native: Mutex<Option<mpsc::UnboundedSender<NativeEvent>>>,
}

static HOSTS: LazyLock<Mutex<HashMap<u64, Arc<Host>>>> = LazyLock::new(Mutex::default);

fn hosts() -> MutexGuard<'static, HashMap<u64, Arc<Host>>> {
    HOSTS.lock().unwrap_or_else(|e| e.into_inner())
}

fn host_of(host: u64) -> Option<Arc<Host>> {
    hosts().get(&host).cloned()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `randomUUID()`.
pub(crate) fn uuid() -> String {
    let mut bytes = [0u8; 16];
    if crate::sys::random(&mut bytes).is_err() {
        bytes = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos())
            .to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = super::hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// The router of `host`, made at its first start; a later start keeps it (resume entries outlive a stop) and takes
/// the newer events and configuration's build.
pub fn open(host: u64, events: Events, config: Config, grants: Arc<dyn Grants>) -> Arc<Host> {
    let mut all = hosts();
    if let Some(existing) = all.get(&host) {
        *existing.events.lock().unwrap_or_else(|e| e.into_inner()) = events;
        return Arc::clone(existing);
    }
    let made = Host::new(host, events, config, grants, Arc::new(now_ms), false);
    all.insert(host, Arc::clone(&made));
    made
}

/// What main's reply carries.
enum Answer {
    Value(Option<Vec<u8>>),
    Error(Box<RawValue>),
}

impl Host {
    fn new(
        host: u64,
        events: Events,
        config: Config,
        grants: Arc<dyn Grants>,
        clock: Clock,
        manual: bool,
    ) -> Arc<Host> {
        Arc::new_cyclic(|me| Host {
            host,
            events: Mutex::new(events),
            config,
            grants,
            clock,
            manual,
            state: Mutex::new(State::default()),
            native: Mutex::new(None),
            me: me.clone(),
        })
    }

    /// A native application consumes the same router without a stdio round trip or a second router.
    pub fn native(
        events: Events,
        config: Config,
        grants: Arc<dyn Grants>,
        clock: Clock,
    ) -> (Arc<Host>, mpsc::UnboundedReceiver<NativeEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let host = Self::new(0, events, config, grants, clock, false);
        *host.native.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        (host, rx)
    }

    fn native_sink(&self) -> Option<mpsc::UnboundedSender<NativeEvent>> {
        self.native
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn is_connected(&self, device: &str) -> bool {
        self.state()
            .devices
            .get(device)
            .is_some_and(|list| !list.is_empty())
    }

    pub fn is_device_visible(&self, device: &str) -> bool {
        let state = self.state();
        state
            .devices
            .get(device)
            .into_iter()
            .flatten()
            .any(|id| state.conns.get(id).is_some_and(|c| !c.closed && c.visible))
    }

    pub fn accepts_push(&self, channel: &str) -> bool {
        self.config
            .policy
            .get(channel)
            .is_some_and(|p| p.dir == Dir::Push && p.mode.as_deref() != Some("client"))
    }

    /// Recheck a queued call immediately before its effects. A revoke or connection replacement
    /// between receipt and dispatch must not run a call with the old credential.
    pub fn authenticates(&self, call: &Invocation) -> bool {
        if !Weak::ptr_eq(&self.me, &call.host) {
            return false;
        }
        let state = self.state();
        if !state
            .conns
            .get(&call.conn)
            .is_some_and(|c| !c.closed && c.device == call.device && c.conn_id == call.conn_id)
        {
            return false;
        }
        let Some(grants) = self.grants.grants(&call.device) else {
            return false;
        };
        let asked = if call.invoke { Dir::Invoke } else { Dir::Send };
        if let Some(own) = self.config.web_channels.get(&call.channel) {
            return authorize(&grants, asked, own.dir, &own.permission, &call.channel).is_ok();
        }
        self.config.policy.get(&call.channel).is_some_and(|policy| {
            policy.mode.as_deref() != Some("boundary")
                && authorize(
                    &grants,
                    asked,
                    policy.dir,
                    policy.permission.as_deref().unwrap_or("pairing-admin"),
                    &call.channel,
                )
                .is_ok()
                && (call.channel != self.config.channels.prefs_set
                    || !writes_mobile_web(&call.args))
        })
    }

    pub fn complete(&self, call: Invocation, answer: Result<Reply, Fault>) {
        if !Weak::ptr_eq(&self.me, &call.host) || !call.answered {
            return;
        }
        let answer = match answer {
            Ok(reply) if reply.bin.is_none() => {
                Answer::Value(Some(reply.result.get().as_bytes().to_vec()))
            }
            Ok(_) => Answer::Error(raw(
                &json!({ "message": "The computer's binary answer has no page encoding", "code": "web_binary" }),
            )),
            Err(error) => Answer::Error(raw(
                &json!({ "message": error.message, "code": error.code }),
            )),
        };
        self.answered(call.call, answer);
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn tell(&self, event: &str, data: Value) {
        let events = self
            .events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        events.send(event, &data);
    }

    fn conns_of(state: &State, device: &str) -> Vec<Value> {
        state
            .devices
            .get(device)
            .into_iter()
            .flatten()
            .filter_map(|conn| state.conns.get(conn))
            .map(|conn| json!({ "connId": conn.conn_id, "visible": conn.visible }))
            .collect()
    }

    /// Main's copy of a device's connections (`web.conns`): after a connection came or went, or a page's presence.
    fn tell_conns(&self, state: &State, device: &str, change: &'static str, conn_id: &str) {
        if let Some(sink) = self.native_sink() {
            let connections = state
                .devices
                .get(device)
                .into_iter()
                .flatten()
                .filter_map(|id| state.conns.get(id))
                .map(|c| ConnectionInfo {
                    id: c.conn_id.clone(),
                    visible: c.visible,
                })
                .collect();
            let _ = sink.send(NativeEvent::Connections {
                device: device.to_owned(),
                connections,
                change,
                connection: conn_id.to_owned(),
            });
            return;
        }
        self.tell(
            "web.conns",
            json!({
                "host": self.host,
                "device": device,
                "conns": Self::conns_of(state, device),
                "change": change,
                "connId": conn_id,
            }),
        );
    }

    fn attach_conn(&self, device: &str, outbox: Outbox, resume_from: Option<&str>) -> Option<u64> {
        let now = self.now();
        let mut state = self.state();
        if state.devices.get(device).map_or(0, Vec::len) >= MAX_CONNECTIONS_PER_DEVICE {
            return None;
        }
        state.next_conn += 1;
        let conn = state.next_conn;
        let conn_id = uuid();
        state.conns.insert(
            conn,
            Conn {
                device: device.to_owned(),
                conn_id: conn_id.clone(),
                outbox,
                bucket: Bucket::new(now),
                queue: Vec::new(),
                flush: None,
                seq: 0,
                acked: 0,
                missed: false,
                visible: true,
                closed: false,
                awaiting_hello: false,
                misses: 0,
                last_activity: now,
                last_tick: now,
            },
        );
        state
            .devices
            .entry(device.to_owned())
            .or_default()
            .push(conn);
        self.tell_conns(&state, device, "attach", &conn_id);
        let resumed =
            resume_from.is_some_and(|from| Self::resumable(&mut state, device, from, now));
        self.send_hello(&mut state, conn, resumed);
        drop(state);
        self.start_heartbeat(conn);
        Some(conn)
    }

    fn resumable(state: &mut State, device: &str, conn_id: &str, now: i64) -> bool {
        let Some(index) = state.ended.iter().position(|e| e.conn_id == conn_id) else {
            return false;
        };
        let Some(ended) = state.ended.remove(index) else {
            return false;
        };
        ended.device == device
            && ended.clean
            && ended.pushes == state.pushes.get(device).copied().unwrap_or(0)
            && now - ended.at <= RESUME_WINDOW_MS
    }

    /// A resumed hello goes at once; any other first has main prepare the page's resync (whole stream snapshots).
    fn send_hello(&self, state: &mut State, conn: u64, resumed: bool) {
        let Some(c) = state.conns.get_mut(&conn) else {
            return;
        };
        if resumed {
            let hello = self.hello(&c.device, &c.conn_id, true);
            c.write(hello);
            return;
        }
        c.awaiting_hello = true;
        let device = c.device.clone();
        if let Some(sink) = self.native_sink() {
            let _ = sink.send(NativeEvent::Resync { conn, device });
            return;
        }
        self.tell(
            "web.resync",
            json!({ "host": self.host, "conn": conn, "device": device }),
        );
    }

    fn hello(&self, device: &str, conn_id: &str, resumed: bool) -> String {
        let grants = self.grants.grants(device).unwrap_or_default();
        let mut text = format!(
            "{{\"t\":\"hello\",\"protocol\":{0},\"minClient\":{0},\"connId\":{1},\"resumed\":{2},\"features\":{3},\"grants\":{4}",
            self.config.protocol,
            key_text(conn_id),
            resumed,
            self.config.features.get(),
            serde_json::to_string(&grants).unwrap_or_else(|_| "[]".to_owned()),
        );
        if let Some(build) = self.config.build.as_deref().filter(|b| !b.is_empty()) {
            let _ = write!(text, ",\"build\":{}", key_text(build));
        }
        text.push('}');
        text
    }

    pub fn resynced(&self, conn: u64) {
        let mut state = self.state();
        let Some(c) = state.conns.get_mut(&conn) else {
            return;
        };
        if c.closed || !c.awaiting_hello {
            return;
        }
        c.awaiting_hello = false;
        let hello = self.hello(&c.device, &c.conn_id, false);
        c.write(hello);
    }

    /// The connection ended: judged (`clean`) with its queue still there, then forgotten; main hears it.
    fn finish(&self, state: &mut State, conn: u64) -> bool {
        let now = self.now();
        let Some(c) = state.conns.get_mut(&conn) else {
            return false;
        };
        if c.closed {
            return false;
        }
        c.closed = true;
        c.flush = None;
        let (device, conn_id, clean) = (c.device.clone(), c.conn_id.clone(), c.clean());
        c.queue.clear();
        state.conns.remove(&conn);
        if let Some(list) = state.devices.get_mut(&device) {
            list.retain(|other| *other != conn);
            if list.is_empty() {
                state.devices.remove(&device);
            }
        }
        while state
            .ended
            .front()
            .is_some_and(|e| now - e.at > RESUME_WINDOW_MS)
            || state.ended.len() >= RESUME_ENTRIES_MAX
        {
            state.ended.pop_front();
        }
        let pushes = state.pushes.get(&device).copied().unwrap_or(0);
        state.ended.push_back(Ended {
            conn_id: conn_id.clone(),
            device: device.clone(),
            pushes,
            clean,
            at: now,
        });
        self.tell_conns(state, &device, "end", &conn_id);
        true
    }

    fn close_conn(&self, state: &mut State, conn: u64, code: u16, reason: &str) {
        let outbox = state.conns.get(&conn).map(|c| c.outbox.clone());
        if self.finish(state, conn)
            && let Some(outbox) = outbox
        {
            outbox.send(Outgoing::Close(code, reason.to_owned()));
        }
    }

    fn dispose(&self, conn: u64) {
        let mut state = self.state();
        self.finish(&mut state, conn);
    }

    fn close(&self, conn: u64, code: u16, reason: &str) {
        let mut state = self.state();
        self.close_conn(&mut state, conn, code, reason);
    }

    pub fn close_device(&self, device: &str, code: u16, reason: &str) {
        let mut state = self.state();
        for conn in state.devices.get(device).cloned().unwrap_or_default() {
            self.close_conn(&mut state, conn, code, reason);
        }
    }

    fn retire(&self, device: &str, conn_id: &str) {
        let mut state = self.state();
        let found = state.devices.get(device).and_then(|list| {
            list.iter()
                .copied()
                .find(|conn| state.conns.get(conn).is_some_and(|c| c.conn_id == conn_id))
        });
        if let Some(conn) = found {
            self.close_conn(&mut state, conn, CLOSE_GOING_AWAY, "resumed");
        }
    }

    fn close_all(&self, code: u16, reason: &str) {
        let mut state = self.state();
        let conns: Vec<u64> = state.conns.keys().copied().collect();
        for conn in conns {
            self.close_conn(&mut state, conn, code, reason);
        }
    }

    // --- pushes -------------------------------------------------------------------------------------------------

    /// A push main made to the device's window; `None` when main sent no data because the device had no connection.
    pub fn deliver(&self, device: &str, pushed: Option<Arc<Pushed>>) {
        let mut state = self.state();
        *state.pushes.entry(device.to_owned()).or_insert(0) += 1;
        let conns = state.devices.get(device).cloned().unwrap_or_default();
        for conn in conns {
            match &pushed {
                Some(pushed) => self.push(&mut state, conn, pushed),
                // Main thought the page gone; one that came meanwhile missed this push and loads its state again.
                None => self.resync_missed(&mut state, conn),
            }
        }
    }

    fn push(&self, state: &mut State, conn: u64, pushed: &Arc<Pushed>) {
        let Some(c) = state.conns.get_mut(&conn) else {
            return;
        };
        if c.closed || c.awaiting_hello {
            return;
        }
        if !c.visible && self.config.channels.streams.contains(&pushed.ch) {
            c.missed = true;
            return;
        }
        c.queue.push(Arc::clone(pushed));
        if c.flush.is_some() {
            return;
        }
        state.next_flush += 1;
        let window = state.next_flush;
        if let Some(c) = state.conns.get_mut(&conn) {
            c.flush = Some(window);
        }
        if self.manual {
            state.due.push((conn, window));
            return;
        }
        let me = self.me.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(EVENT_BATCH_MS)).await;
            if let Some(host) = me.upgrade() {
                let mut state = host.state();
                if state.conns.get(&conn).and_then(|c| c.flush) == Some(window) {
                    host.flush(&mut state, conn);
                }
                drop(state);
                host.drain_test();
            }
        });
    }

    fn resync_missed(&self, state: &mut State, conn: u64) {
        let Some(c) = state.conns.get_mut(&conn) else {
            return;
        };
        if c.closed || c.awaiting_hello {
            return;
        }
        c.missed = true;
        if c.visible {
            c.missed = false;
            c.queue.clear();
            c.flush = None;
            self.send_hello(state, conn, false);
        }
    }

    /// Send what is queued now.
    fn flush(&self, state: &mut State, conn: u64) {
        let Some(c) = state.conns.get_mut(&conn) else {
            return;
        };
        c.flush = None;
        if c.closed || c.queue.is_empty() {
            return;
        }
        let queue = std::mem::take(&mut c.queue);
        let batch = &self.config.channels.batch;
        for item in coalesce(&queue, batch) {
            c.seq += 1;
            let mut frame = format!(
                "{{\"t\":\"evt\",\"seq\":{},\"ch\":{}",
                c.seq,
                key_text(item.ch())
            );
            if let Some(data) = item.data_text(batch) {
                frame.push_str(",\"d\":");
                frame.push_str(&data);
            }
            frame.push('}');
            c.write(frame);
        }
    }

    // --- frames from the page -----------------------------------------------------------------------------------

    fn receive(&self, conn: u64, text: &str) {
        let now = self.now();
        let mut state = self.state();
        let refusal = {
            let Some(c) = state.conns.get_mut(&conn) else {
                return;
            };
            if c.closed {
                return;
            }
            c.last_activity = now;
            if text.len() > MAX_FRAME_BYTES {
                Some((CLOSE_TOO_BIG, "frame too large"))
            } else if !c.bucket.take(now) {
                Some((CLOSE_RATE_LIMITED, "too many messages"))
            } else {
                None
            }
        };
        if let Some((code, reason)) = refusal {
            return self.close_conn(&mut state, conn, code, reason);
        }
        let Some(frame) = Frame::parse(text) else {
            return self.close_conn(&mut state, conn, CLOSE_POLICY, "malformed frame");
        };
        match frame {
            Frame::Call { id, ch, args } => self.dispatch(&mut state, conn, id, &ch, args),
            Frame::Ping => {
                if let Some(c) = state.conns.get(&conn) {
                    c.write("{\"t\":\"pong\"}".to_owned());
                }
            }
            Frame::Presence(visible) => self.set_visible(&mut state, conn, visible),
            Frame::Ack(seq) => {
                if let Some(c) = state.conns.get_mut(&conn)
                    && seq <= c.seq
                {
                    c.acked = c.acked.max(seq);
                }
            }
            Frame::Pong => {}
        }
    }

    fn set_visible(&self, state: &mut State, conn: u64, visible: bool) {
        let Some(c) = state.conns.get_mut(&conn) else {
            return;
        };
        if visible == c.visible {
            return;
        }
        c.visible = visible;
        let (device, conn_id) = (c.device.clone(), c.conn_id.clone());
        if !visible {
            let before = c.queue.len();
            let streams = &self.config.channels.streams;
            c.queue.retain(|item| !streams.contains(&item.ch));
            if c.queue.len() < before {
                c.missed = true;
            }
        } else if c.missed {
            // Whatever streamed while hidden was dropped: the page reloads its state, as after a reconnect.
            c.missed = false;
            c.queue.clear();
            c.flush = None;
            self.send_hello(state, conn, false);
        }
        self.tell_conns(state, &device, "presence", &conn_id);
    }

    /// Every 20 s: a socket that said nothing for three ticks in a row is gone; a tick that ran late counts for
    /// nothing. False once the connection is gone.
    fn tick(&self, conn: u64) -> bool {
        let now = self.now();
        let mut state = self.state();
        let Some(c) = state.conns.get_mut(&conn) else {
            return false;
        };
        if c.closed {
            return false;
        }
        let late = now - c.last_tick > HEARTBEAT_MS * 3 / 2;
        let quiet = now - c.last_activity >= HEARTBEAT_MS;
        c.last_tick = now;
        if late || !quiet {
            c.misses = 0;
        } else {
            c.misses += 1;
            if c.misses >= HEARTBEAT_MAX_MISSES {
                let outbox = c.outbox.clone();
                self.finish(&mut state, conn);
                outbox.send(Outgoing::Terminate);
                return false;
            }
        }
        c.outbox.send(Outgoing::Ping);
        c.write("{\"t\":\"ping\"}".to_owned());
        true
    }

    fn start_heartbeat(&self, conn: u64) {
        if self.manual {
            return;
        }
        let me = self.me.clone();
        tokio::spawn(async move {
            let period = Duration::from_millis(HEARTBEAT_MS as u64);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                let Some(host) = me.upgrade() else { return };
                let alive = host.tick(conn);
                host.drain_test();
                if !alive {
                    return;
                }
            }
        });
    }

    // --- calls --------------------------------------------------------------------------------------------------

    /// A refusal the page reads as `web_forbidden`; an invoke is answered after what was pushed before it.
    fn refuse(&self, state: &mut State, conn: u64, id: Option<u64>, message: &str) {
        if let Some(id) = id {
            let e = json!({ "message": message, "code": "web_forbidden" });
            self.reply(state, conn, id, Answer::Error(raw(&e)));
        }
    }

    fn dispatch(
        &self,
        state: &mut State,
        conn: u64,
        id: Option<u64>,
        ch: &str,
        args: Box<RawValue>,
    ) {
        let Some(c) = state.conns.get(&conn) else {
            return;
        };
        let device = c.device.clone();
        let conn_id = c.conn_id.clone();
        let asked = if id.is_some() { Dir::Invoke } else { Dir::Send };
        let Some(grants) = self.grants.grants(&device) else {
            // Revoked while connected: the socket closes, and the refused call has nobody to tell.
            self.close_conn(state, conn, CLOSE_REVOKED, "revoked");
            return;
        };
        let heavy = if let Some(own) = self.config.web_channels.get(ch) {
            if let Err(message) = authorize(&grants, asked, own.dir, &own.permission, ch) {
                return self.refuse(state, conn, id, &message);
            }
            own.heavy
        } else {
            let policy = self.config.policy.get(ch).filter(|p| p.dir != Dir::Push);
            let Some(policy) = policy else {
                return self.refuse(state, conn, id, &format!("Unknown channel {ch}"));
            };
            if policy.mode.as_deref() == Some("boundary") {
                let message = format!("{ch} is not available to a paired web device");
                return self.refuse(state, conn, id, &message);
            }
            let permission = policy.permission.as_deref().unwrap_or("pairing-admin");
            if let Err(message) = authorize(&grants, asked, policy.dir, permission, ch) {
                return self.refuse(state, conn, id, &message);
            }
            if ch == self.config.channels.prefs_set && writes_mobile_web(&args) {
                let message = "Mobile web settings can only be changed on the computer";
                return self.refuse(state, conn, id, message);
            }
            self.config.channels.heavy.iter().any(|heavy| heavy == ch)
        };
        if heavy {
            let held = state.heavy.entry(device.clone()).or_insert(0);
            if *held >= HEAVY_CALLS_PER_DEVICE {
                return self.refuse(state, conn, id, "Too many heavy requests at once");
            }
            *held += 1;
        }
        let answered = id.is_some() || heavy;
        state.next_call += 1;
        let call = state.next_call;
        if answered {
            state.calls.insert(
                call,
                Pending {
                    conn,
                    id,
                    heavy: heavy.then(|| device.clone()),
                },
            );
        }
        if let Some(sink) = self.native_sink() {
            let invocation = Invocation {
                host: self.me.clone(),
                call,
                conn,
                device,
                conn_id,
                channel: ch.to_owned(),
                args,
                invoke: id.is_some(),
                answered,
            };
            if sink.send(NativeEvent::Call(invocation)).is_err() {
                self.close_conn(state, conn, CLOSE_GOING_AWAY, "application stopped");
            }
            return;
        }
        let events = self
            .events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        events.send_bin(
            "web.call",
            &json!({
                "host": self.host,
                "call": call,
                "answer": answered,
                "device": device,
                "connId": conn_id,
                "dir": asked.name(),
                "ch": ch,
            }),
            args.get().as_bytes().to_vec(),
        );
    }

    /// Main ran a call: its heavy slot is free, and an invoke's answer leaves after everything pushed before it.
    fn answered(&self, call: u64, answer: Answer) {
        let mut state = self.state();
        let Some(pending) = state.calls.remove(&call) else {
            return;
        };
        if let Some(device) = &pending.heavy {
            let left = state
                .heavy
                .get(device)
                .copied()
                .unwrap_or(1)
                .saturating_sub(1);
            if left == 0 {
                state.heavy.remove(device);
            } else {
                state.heavy.insert(device.clone(), left);
            }
        }
        if let Some(id) = pending.id {
            self.reply(&mut state, pending.conn, id, answer);
        }
    }

    fn reply(&self, state: &mut State, conn: u64, id: u64, answer: Answer) {
        self.flush(state, conn);
        let Some(c) = state.conns.get(&conn) else {
            return;
        };
        let text = match answer {
            Answer::Value(Some(value)) => format!(
                "{{\"t\":\"res\",\"id\":{id},\"ok\":true,\"v\":{}}}",
                String::from_utf8_lossy(&value)
            ),
            Answer::Value(None) => format!("{{\"t\":\"res\",\"id\":{id},\"ok\":true}}"),
            Answer::Error(e) => format!(
                "{{\"t\":\"res\",\"id\":{id},\"ok\":false,\"e\":{}}}",
                e.get()
            ),
        };
        c.write(text);
    }
}

fn raw(value: &Value) -> Box<RawValue> {
    serde_json::value::to_raw_value(value)
        .unwrap_or_else(|_| serde_json::value::to_raw_value(&Value::Null).expect("null is JSON"))
}

fn authorize(
    grants: &[String],
    asked: Dir,
    declared: Dir,
    permission: &str,
    ch: &str,
) -> Result<(), String> {
    if asked != declared {
        return Err(format!("{ch} is not a {} channel", asked.name()));
    }
    if permission == "pairing-admin" || !grants.iter().any(|g| g == permission) {
        return Err(format!("This device may not use {ch} ({permission})"));
    }
    Ok(())
}

/// `mobileWeb.*` preferences decide who may pair and reach the page: only the desktop writes them.
fn writes_mobile_web(args: &RawValue) -> bool {
    let Ok(args) = serde_json::from_str::<Vec<Box<RawValue>>>(args.get()) else {
        return false;
    };
    let key = args
        .first()
        .and_then(|payload| Members::parse(payload))
        .and_then(|payload| payload.get("key").and_then(string_of));
    key.is_some_and(|key| key.to_lowercase().starts_with("mobileweb"))
}

/// A page's frame (`FrameSchema`): a call (`inv` with its id, `snd` without), an acknowledgement, its presence, a
/// ping or a pong. Anything else, or a frame missing what its kind needs, is malformed.
enum Frame {
    Call {
        id: Option<u64>,
        ch: String,
        args: Box<RawValue>,
    },
    Ack(u64),
    Presence(bool),
    Ping,
    Pong,
}

/// `z.number().int().nonnegative()` for what fits a u64.
fn whole(raw: &RawValue) -> Option<u64> {
    let Value::Number(number) = serde_json::from_str::<Value>(raw.get()).ok()? else {
        return None;
    };
    if let Some(n) = number.as_u64() {
        return Some(n);
    }
    let n = number.as_f64()?;
    (n >= 0.0 && n.fract() == 0.0 && n < u64::MAX as f64).then_some(n as u64)
}

impl Frame {
    fn parse(text: &str) -> Option<Frame> {
        let members: Members = serde_json::from_str(text).ok()?;
        let kind = string_of(members.get("t")?)?;
        match kind.as_str() {
            "inv" | "snd" => {
                let id = if kind == "inv" {
                    Some(whole(members.get("id")?)?)
                } else {
                    None
                };
                let ch = string_of(members.get("ch")?)?;
                let units = ch.encode_utf16().count();
                if !(1..=128).contains(&units) {
                    return None;
                }
                let args = members.get("a")?;
                let items: Vec<&RawValue> = serde_json::from_str(args.get()).ok()?;
                if items.len() > 16 {
                    return None;
                }
                Some(Frame::Call {
                    id,
                    ch,
                    args: args.to_owned(),
                })
            }
            "ack" => Some(Frame::Ack(whole(members.get("seq")?)?)),
            "presence" => match members.get("visible")?.get() {
                "true" => Some(Frame::Presence(true)),
                "false" => Some(Frame::Presence(false)),
                _ => None,
            },
            "ping" => Some(Frame::Ping),
            "pong" => Some(Frame::Pong),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The edge's side.

/// One page connection, as the edge holds it.
struct PageConnection {
    host: Arc<Host>,
    conn: u64,
}

impl Connection for PageConnection {
    fn receive(&self, text: String) {
        self.host.receive(self.conn, &text);
        self.host.drain_test();
    }

    fn close(&self, code: u16, reason: &str) {
        self.host.close(self.conn, code, reason);
        self.host.drain_test();
    }

    fn dispose(&self) {
        self.host.dispose(self.conn);
        self.host.drain_test();
    }
}

impl Router for Host {
    fn connection_count<'a>(&'a self, device_id: &'a str) -> BoxFuture<'a, usize> {
        let count = self.state().devices.get(device_id).map_or(0, Vec::len);
        Box::pin(async move { count })
    }

    fn retire<'a>(&'a self, device_id: &'a str, connection_id: &'a str) -> BoxFuture<'a, ()> {
        Host::retire(self, device_id, connection_id);
        Box::pin(async {})
    }

    fn attach<'a>(
        &'a self,
        device_id: &'a str,
        outbox: Outbox,
        resume_from: Option<&'a str>,
    ) -> BoxFuture<'a, Option<Box<dyn Connection>>> {
        let attached = self
            .attach_conn(device_id, outbox, resume_from)
            .and_then(|conn| {
                let host = self.me.upgrade()?;
                let connection: Box<dyn Connection> = Box::new(PageConnection { host, conn });
                Some(connection)
            });
        Box::pin(async move { attached })
    }

    fn close_all(&self, code: u16, reason: &str) {
        Host::close_all(self, code, reason);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// What main sends.

#[derive(Deserialize)]
struct DeliverParams {
    host: u64,
    device: String,
    #[serde(default)]
    ch: Option<String>,
}

#[derive(Deserialize)]
struct ReplyParams {
    host: u64,
    call: u64,
    ok: bool,
    #[serde(default)]
    e: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct ConnParams {
    host: u64,
    conn: u64,
}

#[derive(Deserialize)]
struct CloseDeviceParams {
    host: u64,
    device: String,
    code: u16,
    reason: String,
}

fn deliver(push: PushCall) {
    let Ok(params) = serde_json::from_str::<DeliverParams>(push.params.get()) else {
        return;
    };
    let Some(host) = host_of(params.host) else {
        return;
    };
    let pushed = params.ch.map(|ch| {
        let data = push
            .bin
            .and_then(|bin| String::from_utf8(bin).ok())
            .and_then(|text| RawValue::from_string(text).ok());
        Pushed::new(ch, data)
    });
    host.deliver(&params.device, pushed);
    host.drain_test();
}

fn reply(push: PushCall) {
    let Ok(params) = serde_json::from_str::<ReplyParams>(push.params.get()) else {
        return;
    };
    let Some(host) = host_of(params.host) else {
        return;
    };
    let answer = if params.ok {
        Answer::Value(push.bin)
    } else {
        Answer::Error(
            params
                .e
                .unwrap_or_else(|| raw(&json!({ "message": "failed" }))),
        )
    };
    host.answered(params.call, answer);
    host.drain_test();
}

fn resynced(push: PushCall) {
    let Ok(params) = serde_json::from_str::<ConnParams>(push.params.get()) else {
        return;
    };
    if let Some(host) = host_of(params.host) {
        host.resynced(params.conn);
        host.drain_test();
    }
}

fn close_device(push: PushCall) {
    let Ok(params) = serde_json::from_str::<CloseDeviceParams>(push.params.get()) else {
        return;
    };
    if let Some(host) = host_of(params.host) {
        host.close_device(&params.device, params.code, &params.reason);
        host.drain_test();
    }
}

pub fn register(registry: &mut Registry) {
    registry.add_push("web.deliver", deliver);
    registry.add_push("web.reply", reply);
    registry.add_push("web.resynced", resynced);
    registry.add_push("web.closeDevice", close_device);
    test_hooks::register(registry);
}

// ---------------------------------------------------------------------------------------------------------------
// Main's parity suite (`ws-router.test.ts`): a router with no edge, its timers and clock driven by the test, its
// sockets read back as events. Served only on a host a test opened.

mod test_hooks {
    use super::*;
    use tokio::sync::mpsc;

    struct TestDevices(Mutex<HashMap<String, Vec<String>>>);

    impl Grants for TestDevices {
        fn grants(&self, device_id: &str) -> Option<Vec<String>> {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(device_id)
                .cloned()
        }
    }

    pub(super) struct Rig {
        now: Mutex<i64>,
        devices: Arc<TestDevices>,
        sockets: Mutex<Vec<(u64, mpsc::UnboundedReceiver<Outgoing>)>>,
    }

    static RIGS: LazyLock<Mutex<HashMap<u64, Arc<Rig>>>> = LazyLock::new(Mutex::default);

    fn rig(host: u64) -> Option<Arc<Rig>> {
        RIGS.lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&host)
            .cloned()
    }

    impl Host {
        /// What the test's sockets were sent, as `web.router.test.sent` events, before the call or push answers.
        pub(super) fn drain_test(&self) {
            let Some(rig) = rig(self.host) else { return };
            let mut sockets = rig.sockets.lock().unwrap_or_else(|e| e.into_inner());
            for (socket, inbox) in sockets.iter_mut() {
                while let Ok(outgoing) = inbox.try_recv() {
                    let sent = match outgoing {
                        Outgoing::Text(text) => json!({ "kind": "text", "text": text }),
                        Outgoing::Ping => json!({ "kind": "ping" }),
                        Outgoing::Close(code, reason) => {
                            json!({ "kind": "close", "code": code, "reason": reason })
                        }
                        Outgoing::Terminate => json!({ "kind": "terminate" }),
                    };
                    let mut sent = sent;
                    sent["host"] = self.host.into();
                    sent["socket"] = (*socket).into();
                    self.tell("web.router.test.sent", sent);
                }
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OpenParams {
        host: u64,
        now: i64,
        manual_timers: bool,
        config: Config,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Params {
        host: u64,
        #[serde(default)]
        socket: u64,
        #[serde(default)]
        device: String,
        #[serde(default)]
        grants: Option<Vec<String>>,
        #[serde(default)]
        resume_from: Option<String>,
        #[serde(default)]
        text: String,
        #[serde(default)]
        code: u16,
        #[serde(default)]
        now: Option<i64>,
        op: String,
    }

    async fn open(call: Call) -> Result<Reply, Fault> {
        let params: OpenParams = call.params()?;
        let devices = Arc::new(TestDevices(Mutex::default()));
        let rig = Arc::new(Rig {
            now: Mutex::new(params.now),
            devices: Arc::clone(&devices),
            sockets: Mutex::default(),
        });
        let clock_rig = Arc::clone(&rig);
        let clock: Clock =
            Arc::new(move || *clock_rig.now.lock().unwrap_or_else(|e| e.into_inner()));
        let host = Host::new(
            params.host,
            call.events.clone(),
            params.config,
            devices,
            clock,
            params.manual_timers,
        );
        RIGS.lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(params.host, rig);
        hosts().insert(params.host, host);
        Reply::json(&Value::Null)
    }

    async fn op(call: Call) -> Result<Reply, Fault> {
        let params: Params = call.params()?;
        let (Some(host), Some(rig)) = (host_of(params.host), rig(params.host)) else {
            return Err(Fault::new("invalid_params", "no router test host"));
        };
        if let Some(now) = params.now {
            *rig.now.lock().unwrap_or_else(|e| e.into_inner()) = now;
        }
        let result = match params.op.as_str() {
            "device" => {
                let mut table = rig.devices.0.lock().unwrap_or_else(|e| e.into_inner());
                match params.grants {
                    Some(grants) => table.insert(params.device.clone(), grants),
                    None => table.remove(&params.device),
                };
                Value::Null
            }
            "attach" => {
                let (sender, inbox) = mpsc::unbounded_channel();
                match host.attach_conn(
                    &params.device,
                    Outbox::new(sender),
                    params.resume_from.as_deref(),
                ) {
                    Some(conn) => {
                        rig.sockets
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push((conn, inbox));
                        json!({ "socket": conn })
                    }
                    None => Value::Null,
                }
            }
            "receive" => {
                host.receive(params.socket, &params.text);
                Value::Null
            }
            "dispose" => {
                host.dispose(params.socket);
                Value::Null
            }
            "close" => {
                host.close(params.socket, params.code, &params.text);
                Value::Null
            }
            "sync" => Value::Null,
            "retire" => {
                Host::retire(&host, &params.device, &params.text);
                Value::Null
            }
            "timers" => {
                let state = host.state();
                let due: Vec<u64> = state
                    .due
                    .iter()
                    .filter(|(conn, window)| {
                        state.conns.get(conn).and_then(|c| c.flush) == Some(*window)
                    })
                    .map(|_| EVENT_BATCH_MS)
                    .collect();
                json!(due)
            }
            "flush" => {
                let mut state = host.state();
                let due = std::mem::take(&mut state.due);
                for (conn, window) in due {
                    if state.conns.get(&conn).and_then(|c| c.flush) == Some(window) {
                        host.flush(&mut state, conn);
                    }
                }
                Value::Null
            }
            "tick" => {
                let conns: Vec<u64> = {
                    let state = host.state();
                    let mut conns: Vec<u64> = state.conns.keys().copied().collect();
                    conns.sort_unstable();
                    conns
                };
                for conn in conns {
                    host.tick(conn);
                }
                Value::Null
            }
            "count" => json!(host.state().devices.get(&params.device).map_or(0, Vec::len)),
            _ => return Err(Fault::new("invalid_params", "unknown router test op")),
        };
        host.drain_test();
        Reply::json(&result)
    }

    pub(super) fn register(registry: &mut Registry) {
        registry.add("web.router.test.open", |call| Box::pin(open(call)));
        registry.add("web.router.test", |call| Box::pin(op(call)));
    }
}

#[cfg(test)]
#[path = "router_tests.rs"]
mod tests;
