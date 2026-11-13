//! Who may use this computer, per connection (was `RemoteDevices.#gate` and `#admit` in `src/main/remote/devices.ts`
//! and `RemoteHost.#bindDevice` in `host-server.ts`). The gate: a tailnet address (loopback too in a test build),
//! a node `tailscale whois` names with a login, that login on Mobile web's allowed list (this computer's own login
//! when the list is unset), and its node not blocked; the list and the blocks are main's (`policy`). The record: a
//! node holds one device and one key (TOFU), a code-paired record binds to the first node it connects from with its
//! old key, and a new device is recorded only once the person approved it when they asked to be asked (`admit`).

use serde_json::{Map, Value, json};

use super::super::tailnet;
use super::{Devices, instance, locked, text};
use crate::clock;
use crate::fs::order::js_trim;

/// The visitor's facts for the record and the approval question, or the refusal code.
pub(crate) async fn gate(devices: u64, ip: &str) -> Result<(Value, String), String> {
    let Some(devices) = instance(devices) else {
        return Err("protocol".into());
    };
    let visitor = devices.gate(ip).await?;
    Ok((visitor, devices.name()))
}

/// The device record this connection is pinned to: its key and this computer's name, or the refusal code.
pub(crate) async fn bind(
    devices: u64,
    link: u64,
    init: &Value,
    visitor: &Value,
) -> Result<(String, String), String> {
    let Some(devices) = instance(devices) else {
        return Err("protocol".into());
    };
    let bound = match devices.bind(init, visitor).await {
        Ok(bound) => bound,
        Err(code) => {
            devices.refused(link, &code, visitor.get("ip").and_then(Value::as_str));
            return Err(code);
        }
    };
    let static_pub = text(&bound, "staticPub").unwrap_or_default();
    if let Some(arriving) = devices.inner().host.arriving.get_mut(&link) {
        arriving.1 = Some(bound);
    }
    Ok((static_pub, devices.name()))
}

/// A refusal at the gate, for the runtime log; the connection is no longer arriving.
pub(crate) fn refused_at_gate(devices: u64, link: u64, code: &str, ip: &str) {
    if let Some(devices) = instance(devices) {
        devices.refused(link, code, Some(ip));
    }
}

impl Devices {
    fn refused(&self, link: u64, code: &str, ip: Option<&str>) {
        self.inner().host.arriving.remove(&link);
        self.log(
            "refused",
            json!({"code": code, "ip": ip.unwrap_or_default()}),
        );
    }

    async fn gate(&self, ip: &str) -> Result<Value, String> {
        let loopback = self.inner().loopback && (ip == "127.0.0.1" || ip == "::1");
        if !tailnet::is_tailnet_address(ip) && !loopback {
            return Err("not_tailnet".into());
        }
        let peer = self.whois(ip).await;
        let field = |key: &str| {
            peer.as_ref()
                .and_then(|peer| peer.get(key))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let (Some(node_id), Some(login)) = (field("nodeId"), field("login")) else {
            return Err("no_identity".into());
        };
        // Main's answer, or a refusal: no answer, or one that is not a list and a verdict, is a gate that failed
        // (`protocol`, as a gate that threw in main was), never an unset list or an unblocked node.
        let policy = super::super::ask(
            &self.events,
            "policy",
            json!({"devices": self.id, "nodeId": node_id, "login": login}),
        )
        .await
        .unwrap_or(Value::Null);
        let (Some(users), Some(blocked)) = (
            policy.get("allowedUsers").and_then(Value::as_array),
            policy.get("blocked").and_then(Value::as_bool),
        ) else {
            return Err("protocol".into());
        };
        let listed: Vec<String> = users
            .iter()
            .filter_map(|user| user.as_str().map(str::to_owned))
            .collect();
        // Unset list: this computer's own account, as Mobile web reads it (its poll may not have stored it yet).
        let users = if listed.is_empty() {
            vec![
                self.status()
                    .await
                    .and_then(|status| {
                        status
                            .get("login")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_default(),
            ]
        } else {
            listed
        };
        let lower = |text: &str| js_trim(text).to_lowercase();
        let wanted = lower(&login);
        if !users
            .iter()
            .map(|user| lower(user))
            .any(|user| !user.is_empty() && user == wanted)
        {
            return Err("not_allowed".into());
        }
        if blocked {
            return Err("blocked".into());
        }
        Ok(json!({
            "nodeId": node_id,
            "login": login,
            "nodeName": peer.as_ref().and_then(|peer| peer.get("nodeName")).cloned().unwrap_or(Value::Null),
            "ip": ip,
        }))
    }

    /// Pinned per node: a node already holding another device or key is refused until that record is removed, so
    /// nobody gets a fresh record (and quota) by changing keys.
    async fn bind(&self, init: &Value, visitor: &Value) -> Result<Map<String, Value>, String> {
        let get = |value: &Value, key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let (device, name, static_pub) = (
            get(init, "deviceId"),
            get(init, "name"),
            get(init, "staticPub"),
        );
        let (node, login) = (get(visitor, "nodeId"), get(visitor, "login"));
        let conflict = |devices: &Devices| {
            locked(&devices.peers).by_node(&node).is_some_and(|held| {
                text(&held, "deviceId").as_deref() != Some(device.as_str())
                    || text(&held, "staticPub").as_deref() != Some(static_pub.as_str())
            })
        };
        if conflict(self) {
            return Err("key_mismatch".into());
        }
        let known = locked(&self.peers).get(&device);
        if let Some(known) = known {
            if text(&known, "staticPub").as_deref() != Some(static_pub.as_str()) {
                return Err("key_mismatch".into());
            }
            match text(&known, "nodeId") {
                Some(held) if held != node => return Err("key_mismatch".into()),
                Some(_) => return Ok(known),
                None => {
                    let bound = locked(&self.peers)
                        .update(
                            &device,
                            vec![
                                ("nodeId".into(), Some(Value::from(node.clone()))),
                                ("login".into(), Some(Value::from(login.clone()))),
                            ],
                        )
                        .map_err(|_| "protocol".to_owned())?;
                    self.tell();
                    return Ok(bound.unwrap_or(known));
                }
            }
        }
        let approved = super::super::ask(
            &self.events,
            "admit",
            json!({"devices": self.id, "visitor": visitor, "name": name}),
        )
        .await
            == Some(Value::Bool(true));
        if !approved {
            return Err("declined".into());
        }
        // Another connection of this node may have been recorded while the person was asked.
        if conflict(self) || locked(&self.peers).get(&device).is_some() {
            return Err("key_mismatch".into());
        }
        let mut peer = Map::new();
        peer.insert("deviceId".into(), device.into());
        peer.insert("name".into(), name.into());
        peer.insert("staticPub".into(), static_pub.into());
        peer.insert("nodeId".into(), node.into());
        peer.insert("login".into(), login.into());
        peer.insert("pairedAt".into(), clock::now_ms().into());
        locked(&self.peers)
            .put(peer.clone())
            .map_err(|_| "protocol".to_owned())?;
        self.tell();
        Ok(peer)
    }
}
