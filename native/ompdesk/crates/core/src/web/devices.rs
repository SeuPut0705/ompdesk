//! What the edge needs of the paired devices and the blocks (`web/devices-store.ts`, `blocks-store.ts`): the records
//! as plain structs, the cookie check (`authenticate`: only the SHA-256 of `<secret>` is kept, compared in constant
//! time; 14 days sliding, 90 absolute), and the block verdict. The state lives in memory here; persistence (the 0600
//! files) and the settings page's changes come with the cut-over (8b) behind the same traits.

use std::collections::HashMap;
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq as _;

use super::auth::{PublicKey, base64url, parse_public_key_jwk};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub user_agent: String,
    pub tailscale_login: Option<String>,
    pub node_id: Option<String>,
    /// SHA-256 hex of the cookie secret.
    pub secret_sha256: String,
    pub public_key: Option<PublicKey>,
    pub grants: Vec<String>,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
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

/// The devices of `web-devices.json`, held in memory.
#[derive(Default)]
pub struct MemoryDevices {
    devices: Mutex<HashMap<String, Device>>,
}

impl MemoryDevices {
    /// A list from the document `web-devices.json` holds (`{ v: 1, devices: [...] }`); an entry that does not read is
    /// dropped alone, as the store does.
    pub fn from_json(document: &serde_json::Value) -> Self {
        let mut devices = HashMap::new();
        for raw in document
            .get("devices")
            .and_then(|d| d.as_array())
            .into_iter()
            .flatten()
        {
            if let Some(device) = Self::read(raw) {
                devices.insert(device.device_id.clone(), device);
            }
        }
        Self {
            devices: Mutex::new(devices),
        }
    }

    fn read(raw: &serde_json::Value) -> Option<Device> {
        let text = |key: &str| raw.get(key).and_then(|v| v.as_str()).map(str::to_owned);
        let device_id = text("deviceId").filter(|id| !id.is_empty())?;
        let secret_sha256 = text("secretSha256").filter(|h| {
            h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })?;
        let grants = raw
            .get("grants")?
            .as_array()?
            .iter()
            .filter_map(|g| g.as_str().map(str::to_owned))
            .collect();
        Some(Device {
            device_id,
            name: text("name")?,
            user_agent: text("userAgent")?,
            tailscale_login: text("tailscaleLogin"),
            node_id: text("nodeId"),
            secret_sha256,
            public_key: raw.get("publicKeyJwk").and_then(parse_public_key_jwk),
            grants,
            created_at: raw.get("createdAt")?.as_f64()? as i64,
            last_seen_at: raw
                .get("lastSeenAt")
                .and_then(|v| v.as_f64())
                .map(|v| v as i64),
            push: None,
        })
    }

    pub fn get(&self, device_id: &str) -> Option<Device> {
        self.lock().get(device_id).cloned()
    }

    pub fn revoke(&self, device_id: &str) -> bool {
        self.lock().remove(device_id).is_some()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Device>> {
        self.devices.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Devices for MemoryDevices {
    fn authenticate(&self, cookie: &str, now: i64) -> AuthResult {
        let Some(separator) = cookie
            .find('.')
            .filter(|&at| at > 0 && at < cookie.len() - 1)
        else {
            return AuthResult::Malformed;
        };
        let mut devices = self.lock();
        let Some(device) = devices.get_mut(&cookie[..separator]) else {
            return AuthResult::Unknown;
        };
        let given = Sha256::digest(&cookie.as_bytes()[separator + 1..]);
        let kept = device.secret_sha256.as_bytes();
        if !bool::from(hex(&given).as_bytes().ct_eq(kept)) {
            return AuthResult::Mismatch;
        }
        let last_seen = device.last_seen_at.unwrap_or(device.created_at);
        if now - device.created_at > ABSOLUTE_EXPIRY_MS || now - last_seen > SLIDING_EXPIRY_MS {
            let id = device.device_id.clone();
            devices.remove(&id);
            return AuthResult::Expired;
        }
        if now - last_seen >= TOUCH_INTERVAL_MS {
            device.last_seen_at = Some(now);
        }
        AuthResult::Ok(Box::new(device.clone()))
    }

    fn create(&self, init: NewDevice, now: i64) -> (Device, String) {
        let mut secret = [0u8; 32];
        sys::random(&mut secret).expect("the system's random generator");
        let secret = base64url(&secret);
        let name = take_units(init.name.trim_matches(super::auth::js_space), NAME_MAX);
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
            public_key: init.public_key,
            // A web device never holds `pairing-admin`, whatever a caller asks for.
            grants: [
                "workspace",
                "settings-write",
                "accounts-admin",
                "extensions-admin",
                "host-admin",
                "desktop-control",
                "device-self",
            ]
            .iter()
            .filter(|g| init.grants.iter().any(|wanted| wanted == *g))
            .map(|g| (*g).to_owned())
            .collect(),
            created_at: now,
            last_seen_at: Some(now),
            push: None,
        };
        let cookie = format!("{}.{secret}", device.device_id);
        self.lock().insert(device.device_id.clone(), device.clone());
        (device, cookie)
    }

    fn set_push(&self, device_id: &str, push: PushSettings) -> bool {
        self.lock()
            .get_mut(device_id)
            .map(|device| device.push = Some(push))
            .is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockScope {
    Node,
    Login,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockEntry {
    pub id: String,
    pub scope: BlockScope,
    pub tailscale_login: Option<String>,
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

/// The entries of `web-blocked.json`.
#[derive(Default)]
pub struct MemoryBlocks {
    entries: Vec<BlockEntry>,
}

impl MemoryBlocks {
    /// From `{ v: 1, blocked: [...] }`.
    pub fn from_json(document: &serde_json::Value) -> Self {
        let entries = document
            .get("blocked")
            .and_then(|b| b.as_array())
            .into_iter()
            .flatten()
            .filter_map(|raw| {
                let scope = match raw.get("scope")?.as_str()? {
                    "node" => BlockScope::Node,
                    "login" => BlockScope::Login,
                    _ => return None,
                };
                Some(BlockEntry {
                    id: raw
                        .get("id")?
                        .as_str()
                        .filter(|id| !id.is_empty())?
                        .to_owned(),
                    scope,
                    tailscale_login: raw
                        .get("tailscaleLogin")
                        .and_then(|l| l.as_str())
                        .map(str::to_owned),
                })
            })
            .collect();
        Self { entries }
    }
}

impl Blocks for MemoryBlocks {
    fn active(&self) -> bool {
        !self.entries.is_empty()
    }

    fn check(&self, node_id: Option<&str>, login: Option<&str>) -> Option<Verdict> {
        let login = login.map(|l| l.trim_matches(super::auth::js_space).to_lowercase());
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
                    && e.tailscale_login.as_deref().is_some_and(|l| {
                        l.trim_matches(super::auth::js_space).to_lowercase() == *login
                    })
            })
        {
            return Some(Verdict::Unidentified);
        }
        None
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
