//! The paired devices and the blocks (`web/devices-store.ts`, `blocks-store.ts`), as the rules over their records:
//! the file's records read as the TypeScript's validation read them (an entry that does not read is dropped alone),
//! the cookie check (`authenticate`: only the SHA-256 of `<secret>` is kept, compared in constant time; 14 days
//! sliding, 90 absolute), every change main makes (rename, grants, a device's own preferences, push, quota usage)
//! and the block verdict. `Book` and `BlockBook` hold these rules once; what is done with the effect of a change
//! (the 0600 file, the events to main) is `store.rs`'s. `MemoryDevices` and `MemoryBlocks` are the edge's
//! doubles over the same rules, for tests that need no file.

use std::sync::{Mutex, MutexGuard};

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq as _;

use super::auth::{PublicKey, base64url, js_space, parse_public_key_jwk};
use super::hex;
use crate::sys;

pub const SLIDING_EXPIRY_MS: i64 = 14 * 24 * 60 * 60 * 1000;
pub const ABSOLUTE_EXPIRY_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// `lastSeenAt` is written at most this often.
pub const TOUCH_INTERVAL_MS: i64 = 60_000;
const NAME_MAX: usize = 80;
const USER_AGENT_MAX: usize = 300;

/// A paired device's default grants: everything except `pairing-admin`.
pub const DEFAULT_GRANTS: [&str; 7] = [
    "workspace",
    "settings-write",
    "accounts-admin",
    "extensions-admin",
    "host-admin",
    "desktop-control",
    "device-self",
];
/// Every permission a record may name (`WEB_PERMISSIONS`).
const PERMISSIONS: [&str; 8] = [
    "workspace",
    "settings-write",
    "accounts-admin",
    "extensions-admin",
    "host-admin",
    "desktop-control",
    "device-self",
    "pairing-admin",
];
pub const PUSH_CATEGORIES: [&str; 3] = ["completion", "error", "ask"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSettings {
    pub subscription: Option<PushSubscription>,
    pub hide_content: bool,
    pub categories: Vec<String>,
}

impl Default for PushSettings {
    fn default() -> Self {
        Self {
            subscription: None,
            hide_content: false,
            categories: PUSH_CATEGORIES.iter().map(|c| (*c).to_owned()).collect(),
        }
    }
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    value?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

impl PushSettings {
    /// The stored `push` block; one that does not read costs the device its push settings, never its pairing.
    pub fn from_json(value: &Value) -> Option<PushSettings> {
        let object = value.as_object()?;
        let subscription = match object.get("subscription")? {
            Value::Null => None,
            Value::Object(subscription) => {
                let keys = subscription.get("keys")?.as_object()?;
                Some(PushSubscription {
                    endpoint: nonempty(subscription.get("endpoint"))?,
                    p256dh: nonempty(keys.get("p256dh"))?,
                    auth: nonempty(keys.get("auth"))?,
                })
            }
            _ => return None,
        };
        let categories = object
            .get("categories")?
            .as_array()?
            .iter()
            .map(|c| {
                c.as_str()
                    .filter(|c| PUSH_CATEGORIES.contains(c))
                    .map(str::to_owned)
            })
            .collect::<Option<Vec<_>>>()?;
        Some(PushSettings {
            subscription,
            hide_content: object.get("hideContent")?.as_bool()?,
            categories,
        })
    }

    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert(
            "subscription".into(),
            match &self.subscription {
                None => Value::Null,
                Some(s) => {
                    let mut keys = Map::new();
                    keys.insert("p256dh".into(), s.p256dh.clone().into());
                    keys.insert("auth".into(), s.auth.clone().into());
                    let mut subscription = Map::new();
                    subscription.insert("endpoint".into(), s.endpoint.clone().into());
                    subscription.insert("keys".into(), keys.into());
                    subscription.into()
                }
            },
        );
        object.insert("hideContent".into(), self.hide_content.into());
        object.insert(
            "categories".into(),
            Value::Array(self.categories.iter().map(|c| c.clone().into()).collect()),
        );
        object.into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub user_agent: String,
    pub tailscale_login: Option<String>,
    pub node_id: Option<String>,
    /// SHA-256 hex of the cookie secret.
    pub secret_sha256: String,
    /// The key the edge checks a proof against. A stored key that is no usable P-256 key is an empty one, which no
    /// signature matches (`verifyDeviceProof` was false for it), so a damaged record never reads as "no key".
    pub public_key: Option<PublicKey>,
    /// The stored `publicKeyJwk` as it was written (a record's extra members are kept).
    pub public_key_jwk: Option<Value>,
    pub grants: Vec<String>,
    /// This device's own interface preferences (an object).
    pub ui_prefs: Value,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    /// `{requestsPerDay?, tokensPerDay?}`.
    pub limits: Option<Value>,
    /// `{day, requests, tokens}`.
    pub usage: Option<Value>,
    pub push: Option<PushSettings>,
}

pub struct NewDevice {
    pub name: String,
    pub user_agent: String,
    pub tailscale_login: Option<String>,
    pub node_id: Option<String>,
    pub public_key: Option<PublicKey>,
    pub grants: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthResult {
    Ok(Box<Device>),
    Malformed,
    Unknown,
    Mismatch,
    Expired,
}

/// What the edge asks of the device list.
pub trait Devices: Send + Sync {
    /// Who a cookie value belongs to; an expired device is removed, a malformed or wrong one changes nothing.
    fn authenticate(&self, cookie: &str, now: i64) -> AuthResult;
    /// Pair a device; the cookie is the only time its secret exists in the clear.
    fn create(&self, device: NewDevice, now: i64) -> (Device, String);
    fn create_checked(&self, device: NewDevice, now: i64, blocks: &dyn Blocks) -> Option<(Device, String)> {
        if blocks.check(device.node_id.as_deref(), device.tailscale_login.as_deref()).is_some() {
            None
        } else {
            Some(self.create(device, now))
        }
    }
    fn set_push(&self, device_id: &str, push: PushSettings) -> bool;
}

fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// The first `max` UTF-16 units of `text`, never splitting a character.
fn take_units(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

/// `sanitizeGrants`: a web device never holds `pairing-admin`, whatever a caller asks for; the rest in the order
/// `WEB_PERMISSIONS` lists them.
pub fn sanitize_grants<S: AsRef<str>>(wanted: &[S]) -> Vec<String> {
    DEFAULT_GRANTS
        .iter()
        .filter(|grant| wanted.iter().any(|w| w.as_ref() == **grant))
        .map(|grant| (*grant).to_owned())
        .collect()
}

/// `z.number().int().nonnegative()`.
fn is_count(value: &Value) -> bool {
    match value {
        Value::Number(n) => {
            n.as_u64().is_some() || n.as_f64().is_some_and(|f| f >= 0.0 && f.fract() == 0.0)
        }
        _ => false,
    }
}

/// A device's daily limits: an object whose `requestsPerDay` and `tokensPerDay` are each absent or a count. Other
/// members are dropped. `None` where it does not read.
pub fn clean_limits(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut clean = Map::new();
    for key in ["requestsPerDay", "tokensPerDay"] {
        match object.get(key) {
            None => {}
            Some(count) if is_count(count) => {
                clean.insert(key.into(), count.clone());
            }
            Some(_) => return None,
        }
    }
    Some(clean.into())
}

/// A device's usage of the day: `{day: string, requests: count, tokens: count}`.
pub fn clean_usage(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut clean = Map::new();
    clean.insert("day".into(), object.get("day")?.as_str()?.into());
    for key in ["requests", "tokens"] {
        let count = object.get(key).filter(|count| is_count(count))?;
        clean.insert(key.into(), count.clone());
    }
    Some(clean.into())
}

fn unusable_key() -> PublicKey {
    PublicKey {
        x: String::new(),
        y: String::new(),
    }
}

impl Device {
    /// One entry of `web-devices.json` as `StoredDevice` (zod) read it: `None` where it fails. Members the record
    /// does not name are dropped; a damaged `push` block is dropped alone.
    pub fn from_record(raw: &Value) -> Option<Device> {
        let object = raw.as_object()?;
        let text = |key: &str| object.get(key)?.as_str().map(str::to_owned);
        // `z.string().nullable()` and `.nullable().optional()`: the first needs its key, the second may lack it.
        let nullable = |value: Option<&Value>| match value? {
            Value::Null => Some(None),
            Value::String(s) => Some(Some(s.clone())),
            _ => None,
        };
        let secret_sha256 = text("secretSha256").filter(|hash| {
            hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })?;
        let public_key_jwk = match object.get("publicKeyJwk")? {
            Value::Null => None,
            jwk @ Value::Object(_) => Some(jwk.clone()),
            _ => return None,
        };
        let grants = object
            .get("grants")?
            .as_array()?
            .iter()
            .map(|g| {
                g.as_str()
                    .filter(|g| PERMISSIONS.contains(g))
                    .map(str::to_owned)
            })
            .collect::<Option<Vec<_>>>()?;
        let optional = |key: &str, clean: fn(&Value) -> Option<Value>| match object.get(key) {
            None => Some(None),
            Some(value) => clean(value).map(Some),
        };
        Some(Device {
            device_id: nonempty(object.get("deviceId"))?,
            name: text("name")?,
            user_agent: text("userAgent")?,
            tailscale_login: nullable(object.get("tailscaleLogin"))?,
            node_id: match object.get("nodeId") {
                None => None,
                value => nullable(value)?,
            },
            secret_sha256,
            public_key: public_key_jwk
                .as_ref()
                .map(|jwk| parse_public_key_jwk(jwk).unwrap_or_else(unusable_key)),
            public_key_jwk,
            grants,
            ui_prefs: object.get("uiPrefs").filter(|p| p.is_object())?.clone(),
            created_at: object.get("createdAt")?.as_f64()? as i64,
            last_seen_at: match object.get("lastSeenAt") {
                None => None,
                Some(seen) => Some(seen.as_f64()? as i64),
            },
            limits: optional("limits", clean_limits)?,
            usage: optional("usage", clean_usage)?,
            push: object.get("push").and_then(PushSettings::from_json),
        })
    }

    /// The record as `web-devices.json` keeps it and main's mirror reads it, its members in the schema's order.
    pub fn to_record(&self) -> Value {
        let mut record = Map::new();
        let nullable = |text: &Option<String>| text.clone().map_or(Value::Null, Value::from);
        record.insert("deviceId".into(), self.device_id.clone().into());
        record.insert("name".into(), self.name.clone().into());
        record.insert("userAgent".into(), self.user_agent.clone().into());
        record.insert("tailscaleLogin".into(), nullable(&self.tailscale_login));
        record.insert("nodeId".into(), nullable(&self.node_id));
        record.insert("secretSha256".into(), self.secret_sha256.clone().into());
        record.insert(
            "publicKeyJwk".into(),
            self.public_key_jwk.clone().unwrap_or(Value::Null),
        );
        record.insert(
            "grants".into(),
            Value::Array(self.grants.iter().map(|g| g.clone().into()).collect()),
        );
        record.insert("uiPrefs".into(), self.ui_prefs.clone());
        record.insert("createdAt".into(), self.created_at.into());
        if let Some(seen) = self.last_seen_at {
            record.insert("lastSeenAt".into(), seen.into());
        }
        if let Some(limits) = &self.limits {
            record.insert("limits".into(), limits.clone());
        }
        if let Some(usage) = &self.usage {
            record.insert("usage".into(), usage.clone());
        }
        if let Some(push) = &self.push {
            record.insert("push".into(), push.to_json());
        }
        record.into()
    }
}

/// What a change did beyond the list: what the store writes and tells.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Effect {
    /// The file's content changed.
    pub saved: bool,
    /// The TypeScript's store called `onChanged` here (the settings page shows it).
    pub announce: bool,
    /// A device was removed (`onRevoked`): revoked or expired.
    pub revoked: Option<String>,
}

impl Effect {
    fn saved() -> Effect {
        Effect {
            saved: true,
            ..Effect::default()
        }
    }

    fn announced() -> Effect {
        Effect {
            saved: true,
            announce: true,
            revoked: None,
        }
    }
}

/// A change to a device's `limits` and `usage`: a member that is present replaces it, `null` removes it
/// (`PeerQuota`'s `update(id, {limits: undefined})`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Patch {
    pub limits: Option<Option<Value>>,
    pub usage: Option<Option<Value>>,
}

impl Patch {
    /// From the members of an `update` push; `None` where a present member does not read.
    pub fn from_json(object: &Map<String, Value>) -> Option<Patch> {
        let member = |key: &str, clean: fn(&Value) -> Option<Value>| match object.get(key) {
            None => Some(None),
            Some(Value::Null) => Some(Some(None)),
            Some(value) => clean(value).map(|clean| Some(Some(clean))),
        };
        Some(Patch {
            limits: member("limits", clean_limits)?,
            usage: member("usage", clean_usage)?,
        })
    }
}

/// The devices of `web-devices.json`, in the order they were paired (a re-pair keeps its place).
#[derive(Debug, Default, Clone)]
pub struct Book {
    devices: Vec<Device>,
}

impl Book {
    /// From the document `web-devices.json` holds (`{ v: 1, devices: [...] }`); a document of another shape reads
    /// as no devices, an entry that does not read is dropped alone.
    pub fn parse(document: &Value) -> Book {
        let mut book = Book::default();
        if document.get("v").and_then(Value::as_f64) != Some(1.0) {
            return book;
        }
        for raw in document
            .get("devices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(device) = Device::from_record(raw) {
                book.put(device);
            }
        }
        book
    }

    /// The file's content: `{ v: 1, devices: [...] }`.
    pub fn document(&self) -> Value {
        let mut document = Map::new();
        document.insert("v".into(), 1.into());
        document.insert("devices".into(), Value::Array(self.records()));
        document.into()
    }

    pub fn records(&self) -> Vec<Value> {
        self.devices.iter().map(Device::to_record).collect()
    }

    pub fn devices(&self) -> &[Device] {
        &self.devices
    }

    pub fn get(&self, device_id: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.device_id == device_id)
    }

    fn find(&mut self, device_id: &str) -> Option<&mut Device> {
        self.devices.iter_mut().find(|d| d.device_id == device_id)
    }

    fn put(&mut self, device: Device) {
        match self.find(&device.device_id) {
            Some(slot) => *slot = device,
            None => self.devices.push(device),
        }
    }

    fn remove(&mut self, device_id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|d| d.device_id != device_id);
        self.devices.len() != before
    }

    pub fn authenticate(&mut self, cookie: &str, now: i64) -> (AuthResult, Effect) {
        let Some(separator) = cookie
            .find('.')
            .filter(|&at| at > 0 && at < cookie.len() - 1)
        else {
            return (AuthResult::Malformed, Effect::default());
        };
        let Some(device) = self.find(&cookie[..separator]) else {
            return (AuthResult::Unknown, Effect::default());
        };
        let given = hex(&Sha256::digest(&cookie.as_bytes()[separator + 1..]));
        if !bool::from(given.as_bytes().ct_eq(device.secret_sha256.as_bytes())) {
            return (AuthResult::Mismatch, Effect::default());
        }
        let last_seen = device.last_seen_at.unwrap_or(device.created_at);
        if now - device.created_at > ABSOLUTE_EXPIRY_MS || now - last_seen > SLIDING_EXPIRY_MS {
            let id = device.device_id.clone();
            self.remove(&id);
            let effect = Effect {
                revoked: Some(id),
                ..Effect::announced()
            };
            return (AuthResult::Expired, effect);
        }
        if now - last_seen >= TOUCH_INTERVAL_MS {
            device.last_seen_at = Some(now);
            return (AuthResult::Ok(Box::new(device.clone())), Effect::saved());
        }
        (AuthResult::Ok(Box::new(device.clone())), Effect::default())
    }

    pub fn create(&mut self, init: NewDevice, now: i64) -> ((Device, String), Effect) {
        let mut secret = [0u8; 32];
        sys::random(&mut secret).expect("the system's random generator");
        let secret = base64url(&secret);
        let name = take_units(init.name.trim_matches(js_space), NAME_MAX);
        let device = Device {
            device_id: crate::remote::crypto::random_device_id(),
            name: if name.is_empty() {
                "Phone".to_owned()
            } else {
                name
            },
            user_agent: take_units(&init.user_agent, USER_AGENT_MAX),
            tailscale_login: init.tailscale_login,
            node_id: init.node_id,
            secret_sha256: sha256_hex(&secret),
            public_key_jwk: init.public_key.as_ref().map(|key| {
                let mut jwk = Map::new();
                jwk.insert("kty".into(), "EC".into());
                jwk.insert("crv".into(), "P-256".into());
                jwk.insert("x".into(), key.x.clone().into());
                jwk.insert("y".into(), key.y.clone().into());
                jwk.into()
            }),
            public_key: init.public_key,
            grants: sanitize_grants(&init.grants),
            ui_prefs: Value::Object(Map::new()),
            created_at: now,
            last_seen_at: Some(now),
            limits: None,
            usage: None,
            push: None,
        };
        let cookie = format!("{}.{secret}", device.device_id);
        self.put(device.clone());
        ((device, cookie), Effect::announced())
    }

    /// Delete a device: its credential stops working.
    pub fn revoke(&mut self, device_id: &str) -> (bool, Effect) {
        if !self.remove(device_id) {
            return (false, Effect::default());
        }
        let effect = Effect {
            revoked: Some(device_id.to_owned()),
            ..Effect::announced()
        };
        (true, effect)
    }

    pub fn rename(&mut self, device_id: &str, name: &str) -> (bool, Effect) {
        let name = take_units(name.trim_matches(js_space), NAME_MAX);
        if name.is_empty() {
            return (false, Effect::default());
        }
        match self.find(device_id) {
            Some(device) => {
                device.name = name;
                (true, Effect::announced())
            }
            None => (false, Effect::default()),
        }
    }

    pub fn set_grants(&mut self, device_id: &str, grants: &[String]) -> (bool, Effect) {
        match self.find(device_id) {
            Some(device) => {
                device.grants = sanitize_grants(grants);
                (true, Effect::announced())
            }
            None => (false, Effect::default()),
        }
    }

    /// `uiPrefs` must be an object, as the record's schema says.
    pub fn set_ui_prefs(&mut self, device_id: &str, prefs: Value) -> (bool, Effect) {
        match self.find(device_id) {
            Some(device) if prefs.is_object() => {
                device.ui_prefs = prefs;
                (true, Effect::saved())
            }
            _ => (false, Effect::default()),
        }
    }

    pub fn set_push(&mut self, device_id: &str, push: PushSettings) -> (bool, Effect) {
        match self.find(device_id) {
            Some(device) => {
                device.push = Some(push);
                (true, Effect::saved())
            }
            None => (false, Effect::default()),
        }
    }

    /// The push service said the subscription is gone (404/410): forget it, unless the device has since sent a new
    /// one.
    pub fn forget_push(&mut self, device_id: &str, endpoint: &str) -> (bool, Effect) {
        let Some(push) = self.find(device_id).and_then(|d| d.push.as_mut()) else {
            return (false, Effect::default());
        };
        if push.subscription.as_ref().map(|s| s.endpoint.as_str()) != Some(endpoint) {
            return (false, Effect::default());
        }
        push.subscription = None;
        (true, Effect::saved())
    }

    /// The VAPID keypair was made anew: every subscription was made against the old key and is dead.
    pub fn drop_all_push(&mut self) -> (usize, Effect) {
        let mut dropped = 0;
        for push in self.devices.iter_mut().filter_map(|d| d.push.as_mut()) {
            if push.subscription.take().is_some() {
                dropped += 1;
            }
        }
        let effect = if dropped > 0 {
            Effect::saved()
        } else {
            Effect::default()
        };
        (dropped, effect)
    }

    /// Quota's write path: limits and usage ride the device record.
    pub fn update(&mut self, device_id: &str, patch: Patch) -> (bool, Effect) {
        let Some(device) = self.find(device_id) else {
            return (false, Effect::default());
        };
        if let Some(limits) = patch.limits {
            device.limits = limits;
        }
        if let Some(usage) = patch.usage {
            device.usage = usage;
        }
        (true, Effect::saved())
    }
}

/// The devices held in memory, for the edge's tests.
#[derive(Default)]
pub struct MemoryDevices {
    book: Mutex<Book>,
}

impl MemoryDevices {
    pub fn from_json(document: &Value) -> Self {
        Self {
            book: Mutex::new(Book::parse(document)),
        }
    }

    pub fn get(&self, device_id: &str) -> Option<Device> {
        self.lock().get(device_id).cloned()
    }

    pub fn revoke(&self, device_id: &str) -> bool {
        self.lock().revoke(device_id).0
    }

    fn lock(&self) -> MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Devices for MemoryDevices {
    fn authenticate(&self, cookie: &str, now: i64) -> AuthResult {
        self.lock().authenticate(cookie, now).0
    }

    fn create(&self, init: NewDevice, now: i64) -> (Device, String) {
        self.lock().create(init, now).0
    }

    fn set_push(&self, device_id: &str, push: PushSettings) -> bool {
        self.lock().set_push(device_id, push).0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockScope {
    Node,
    Login,
}

impl BlockScope {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockScope::Node => "node",
            BlockScope::Login => "login",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockEntry {
    pub id: String,
    pub scope: BlockScope,
    /// The device's name when it was blocked.
    pub name: String,
    pub tailscale_login: Option<String>,
    pub blocked_at: Number,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Entry(BlockEntry),
    /// The node could not be told and this login has a blocked node, so it cannot be ruled out.
    Unidentified,
}

pub trait Blocks: Send + Sync {
    /// Whether any block exists: a page load then asks who the visitor is.
    fn active(&self) -> bool;
    fn check(&self, node_id: Option<&str>, login: Option<&str>) -> Option<Verdict>;
}

fn login_key(login: &str) -> String {
    login.trim_matches(js_space).to_lowercase()
}

impl BlockEntry {
    /// One entry of `web-blocked.json` as its schema reads it.
    fn from_record(raw: &Value) -> Option<BlockEntry> {
        let object = raw.as_object()?;
        Some(BlockEntry {
            id: nonempty(object.get("id"))?,
            scope: match object.get("scope")?.as_str()? {
                "node" => BlockScope::Node,
                "login" => BlockScope::Login,
                _ => return None,
            },
            name: object.get("name")?.as_str()?.to_owned(),
            tailscale_login: match object.get("tailscaleLogin")? {
                Value::Null => None,
                Value::String(login) => Some(login.clone()),
                _ => return None,
            },
            blocked_at: match object.get("blockedAt")? {
                Value::Number(at) => at.clone(),
                _ => return None,
            },
        })
    }

    /// The entry as `WebBlockedInfo` and the file spell it.
    pub fn to_record(&self) -> Value {
        let mut record = Map::new();
        record.insert("id".into(), self.id.clone().into());
        record.insert("scope".into(), self.scope.as_str().into());
        record.insert("name".into(), self.name.clone().into());
        record.insert(
            "tailscaleLogin".into(),
            self.tailscale_login
                .clone()
                .map_or(Value::Null, Value::from),
        );
        record.insert("blockedAt".into(), self.blocked_at.clone().into());
        record.into()
    }
}

/// The entries of `web-blocked.json`, oldest first.
#[derive(Debug, Default, Clone)]
pub struct BlockBook {
    entries: Vec<BlockEntry>,
}

impl BlockBook {
    /// From `{ v: 1, blocked: [...] }`. The whole list is read as one: one entry that does not read leaves the
    /// document unread, and no blocks (as the TypeScript's `z.array(Entry)` did).
    pub fn parse(document: &Value) -> BlockBook {
        let read = || -> Option<Vec<BlockEntry>> {
            if document.get("v")?.as_f64()? != 1.0 {
                return None;
            }
            document
                .get("blocked")?
                .as_array()?
                .iter()
                .map(BlockEntry::from_record)
                .collect()
        };
        BlockBook {
            entries: read().unwrap_or_default(),
        }
    }

    pub fn document(&self) -> Value {
        let mut document = Map::new();
        document.insert("v".into(), 1.into());
        document.insert("blocked".into(), Value::Array(self.records()));
        document.into()
    }

    pub fn records(&self) -> Vec<Value> {
        self.entries.iter().map(BlockEntry::to_record).collect()
    }

    /// Block a node (`key` is its stable ID) or, by login, every device of that login; a block of the same key is
    /// replaced (and becomes the newest).
    pub fn add(
        &mut self,
        scope: BlockScope,
        key: &str,
        name: &str,
        tailscale_login: Option<String>,
        blocked_at: Number,
    ) -> BlockEntry {
        let id = match scope {
            BlockScope::Node => format!("node:{key}"),
            BlockScope::Login => format!("login:{}", login_key(key)),
        };
        let entry = BlockEntry {
            id,
            scope,
            name: name.to_owned(),
            tailscale_login,
            blocked_at,
        };
        self.entries.retain(|other| other.id != entry.id);
        self.entries.push(entry.clone());
        entry
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.id != id);
        self.entries.len() != before
    }

    pub fn active(&self) -> bool {
        !self.entries.is_empty()
    }

    pub fn check(&self, node_id: Option<&str>, login: Option<&str>) -> Option<Verdict> {
        let login = login.map(login_key);
        for entry in &self.entries {
            let hit = match entry.scope {
                BlockScope::Login => login
                    .as_ref()
                    .is_some_and(|l| entry.id == format!("login:{l}")),
                BlockScope::Node => node_id.is_some_and(|n| entry.id == format!("node:{n}")),
            };
            if hit {
                return Some(Verdict::Entry(entry.clone()));
            }
        }
        if node_id.is_none()
            && let Some(login) = &login
            && self.entries.iter().any(|e| {
                e.scope == BlockScope::Node
                    && e.tailscale_login
                        .as_deref()
                        .is_some_and(|l| login_key(l) == *login)
            })
        {
            return Some(Verdict::Unidentified);
        }
        None
    }
}

/// The blocks held in memory, for the edge's tests.
#[derive(Default)]
pub struct MemoryBlocks {
    book: BlockBook,
}

impl MemoryBlocks {
    pub fn from_json(document: &Value) -> Self {
        Self {
            book: BlockBook::parse(document),
        }
    }
}

impl Blocks for MemoryBlocks {
    fn active(&self) -> bool {
        self.book.active()
    }

    fn check(&self, node_id: Option<&str>, login: Option<&str>) -> Option<Verdict> {
        self.book.check(node_id, login)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seeded(now: i64) -> (MemoryDevices, i64) {
        let doc = json!({"v": 1, "devices": [
            {"deviceId": "d1", "name": "n", "userAgent": "u", "tailscaleLogin": "me@example.com", "nodeId": "n1",
             "secretSha256": sha256_hex("sekret"), "publicKeyJwk": null, "grants": ["workspace"], "uiPrefs": {},
             "createdAt": now - 1000, "lastSeenAt": now - 1000},
            {"deviceId": "bad", "name": 1}
        ]});
        (MemoryDevices::from_json(&doc), now)
    }

    #[test]
    fn cookie_is_checked_against_the_hash_and_the_clock() {
        let (devices, now) = seeded(1_800_000_000_000);
        assert_eq!(devices.get("bad"), None, "an unreadable entry drops alone");
        for malformed in ["nodot", ".x", "x.", ""] {
            assert_eq!(
                devices.authenticate(malformed, now),
                AuthResult::Malformed,
                "{malformed}"
            );
        }
        assert_eq!(
            devices.authenticate("nobody.sekret", now),
            AuthResult::Unknown
        );
        assert_eq!(devices.authenticate("d1.wrong", now), AuthResult::Mismatch);
        assert!(matches!(
            devices.authenticate("d1.sekret", now),
            AuthResult::Ok(_)
        ));
        // A secret may itself contain dots: the first one splits.
        assert_eq!(
            devices.authenticate("d1.sek.ret", now),
            AuthResult::Mismatch
        );
        // Touched at most once a minute.
        let AuthResult::Ok(seen) = devices.authenticate("d1.sekret", now + 61_000) else {
            panic!()
        };
        assert_eq!(seen.last_seen_at, Some(now + 61_000));
        let AuthResult::Ok(seen) = devices.authenticate("d1.sekret", now + 100_000) else {
            panic!()
        };
        assert_eq!(seen.last_seen_at, Some(now + 61_000));
        // 14 days without a request, or 90 since pairing, remove the device.
        assert_eq!(
            devices.authenticate("d1.sekret", now + 61_000 + SLIDING_EXPIRY_MS + 1),
            AuthResult::Expired
        );
        assert_eq!(devices.authenticate("d1.sekret", now), AuthResult::Unknown);
    }

    #[test]
    fn absolute_expiry_holds_for_a_busy_device() {
        let (devices, now) = seeded(1_800_000_000_000);
        let created = now - 1000;
        let day = 24 * 60 * 60 * 1000;
        // A request every 13 days keeps the sliding window open for 78 days...
        for step in 1..=6 {
            assert!(
                matches!(
                    devices.authenticate("d1.sekret", created + step * 13 * day),
                    AuthResult::Ok(_)
                ),
                "step {step}"
            );
        }
        // ...and the 90 days since pairing end it anyway.
        assert_eq!(
            devices.authenticate("d1.sekret", created + 91 * day),
            AuthResult::Expired
        );
    }

    #[test]
    fn a_new_device_gets_a_cookie_and_never_pairing_admin() {
        let devices = MemoryDevices::default();
        let (device, cookie) = devices.create(
            NewDevice {
                name: "  ".into(),
                user_agent: "u".repeat(400),
                tailscale_login: None,
                node_id: None,
                public_key: None,
                grants: vec!["pairing-admin".into(), "workspace".into()],
            },
            5,
        );
        assert_eq!(device.name, "Phone");
        assert_eq!(device.user_agent.len(), 300);
        assert_eq!(device.grants, ["workspace"]);
        assert_eq!(device.device_id.len(), 26);
        assert!(matches!(
            devices.authenticate(&cookie, 6),
            AuthResult::Ok(_)
        ));
        assert_eq!(cookie.len(), 26 + 1 + 43);
    }

    #[test]
    fn blocks_key_on_node_then_login_then_the_unidentified_rule() {
        let blocks = MemoryBlocks::from_json(&json!({"v": 1, "blocked": [
            {"id": "node:nBAD", "scope": "node", "name": "x", "tailscaleLogin": "Me@Example.com", "blockedAt": 1},
            {"id": "login:gone@example.com", "scope": "login", "name": "x", "tailscaleLogin": "gone@example.com", "blockedAt": 1}]}));
        assert!(blocks.active());
        assert!(
            matches!(blocks.check(Some("nBAD"), Some("a@b")), Some(Verdict::Entry(e)) if e.scope == BlockScope::Node)
        );
        assert!(
            matches!(blocks.check(Some("nOK"), Some(" GONE@example.com ")), Some(Verdict::Entry(e)) if e.scope == BlockScope::Login)
        );
        assert_eq!(
            blocks.check(None, Some("me@example.com")),
            Some(Verdict::Unidentified)
        );
        assert_eq!(blocks.check(Some("nOK"), Some("me@example.com")), None);
        assert_eq!(blocks.check(None, None), None);
        assert!(!MemoryBlocks::default().active());
    }
}
