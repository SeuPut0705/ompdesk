//! What the edge asks of main while main still owns it (native-rust ledger 8b): the desktop's say over a new device
//! (`pairing.ts`, which computer sharing's gate shares), `tailscale whois` through main's located CLI, the schedule
//! service's webhook, and Settings' allowed logins. Each is an event main answers with `web.answer`, or an event main
//! only hears. The page sockets are the core's router's (`router.rs`, 8c).
//!
//! Events: `web.ask {call, host, kind, ...}` with `kind` one of `policy` → `{host, publicPort, secure, servePrefix,
//! pendingPrefix, allowedUsers}`, `confirmNew` → `bool`,
//! `confirm {name, userAgent, tailscaleLogin, ip}` → `{approved: true, grants} | {approved: false, reason}`,
//! `whois {address}` → `TailnetPeer | null`, `hook {id, bearer, detail}` → `"fired"|"unknown"|"denied"|"off"|
//! "unavailable"`. `web.deviceConnected {host, device: {id, name, tailscaleLogin}}`, `web.unpairedAuth {host,
//! address}`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::auth::Policy;
use super::deps::{
    BoxFuture, Desktop, HookOutcome, Hooks, PairingDetails, PairingOutcome, Peer, Whois,
};
use super::devices::{DEFAULT_GRANTS, Device};
use crate::server::{Call, Events, Fault, Registry, Reply};

#[derive(Default)]
struct State {
    next: u64,
    asks: HashMap<u64, oneshot::Sender<Value>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

fn state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One started host's way to main: its events and main's number for it.
#[derive(Clone)]
pub struct Relay {
    events: Events,
    host: u64,
}

impl Relay {
    pub fn new(events: Events, host: u64) -> Arc<Self> {
        Arc::new(Self { events, host })
    }

    /// Asks main and waits for its `web.answer`; `None` when main never answers (it went).
    async fn ask(&self, kind: &str, data: Value) -> Option<Value> {
        let (answer, answered) = oneshot::channel();
        let call = {
            let mut state = state();
            state.next += 1;
            let call = state.next;
            state.asks.insert(call, answer);
            call
        };
        let mut message = Map::new();
        message.insert("call".into(), call.into());
        message.insert("host".into(), self.host.into());
        message.insert("kind".into(), kind.into());
        if let Value::Object(fields) = data {
            message.extend(fields);
        }
        self.events.send("web.ask", &message);
        let answer = answered.await.ok();
        state().asks.remove(&call);
        answer
    }

    fn tell(&self, event: &str, data: Value) {
        let mut message = Map::new();
        message.insert("host".into(), self.host.into());
        if let Value::Object(fields) = data {
            message.extend(fields);
        }
        self.events.send(event, &message);
    }
}

fn text_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

impl Desktop for Relay {
    fn confirm_new_devices(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            self.ask("confirmNew", json!({}))
                .await
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
    }

    fn confirm(&self, details: PairingDetails) -> BoxFuture<'_, PairingOutcome> {
        Box::pin(async move {
            let answer = self
                .ask(
                    "confirm",
                    json!({
                        "name": details.name,
                        "userAgent": details.user_agent,
                        "tailscaleLogin": details.tailscale_login,
                        "ip": details.ip,
                    }),
                )
                .await
                .unwrap_or(Value::Null);
            if answer.get("approved").and_then(Value::as_bool) == Some(true) {
                let grants = answer
                    .get("grants")
                    .and_then(Value::as_array)
                    .map(|grants| grants.iter().filter_map(|g| text_of(Some(g))).collect())
                    .unwrap_or_else(|| DEFAULT_GRANTS.iter().map(|g| (*g).to_owned()).collect());
                return PairingOutcome::Approved { grants };
            }
            let reason = match answer.get("reason").and_then(Value::as_str) {
                Some("timeout") => "timeout",
                _ => "declined",
            };
            PairingOutcome::Refused(reason)
        })
    }

    fn device_connected(&self, device: &Device) {
        self.tell(
            "web.deviceConnected",
            json!({"device": {"id": device.device_id, "name": device.name, "tailscaleLogin": device.tailscale_login}}),
        );
    }

    fn unpaired_auth(&self, address: &str) {
        self.tell("web.unpairedAuth", json!({ "address": address }));
    }

    /// Main declines what still waits before it stops the edge (`WebHost.stop`).
    fn decline_all(&self) {}

    fn policy(&self) -> BoxFuture<'_, Option<Policy>> {
        Box::pin(async move {
            let policy = self.ask("policy", json!({})).await?;
            let text = |key: &str| text_of(policy.get(key));
            Some(Policy {
                host: text("host")?,
                public_port: policy
                    .get("publicPort")
                    .and_then(Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .unwrap_or(0),
                secure: policy
                    .get("secure")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                serve_prefix: text("servePrefix"),
                pending_prefix: text("pendingPrefix"),
                allowed_users: policy
                    .get("allowedUsers")
                    .and_then(Value::as_array)
                    .map(|users| users.iter().filter_map(|u| text_of(Some(u))).collect())
                    .unwrap_or_default(),
            })
        })
    }
}

impl Whois for Relay {
    fn peer(&self, address: &str) -> BoxFuture<'_, Option<Peer>> {
        let address = address.to_owned();
        Box::pin(async move {
            let peer = self.ask("whois", json!({ "address": address })).await?;
            peer.is_object().then(|| Peer {
                node_id: text_of(peer.get("nodeId")),
                node_name: text_of(peer.get("nodeName")),
                login: text_of(peer.get("login")),
            })
        })
    }
}

impl Hooks for Relay {
    fn webhook(&self, id: &str, bearer: &str, detail: &str) -> BoxFuture<'_, HookOutcome> {
        let data = json!({ "id": id, "bearer": bearer, "detail": detail });
        Box::pin(async move {
            match self
                .ask("hook", data)
                .await
                .as_ref()
                .and_then(Value::as_str)
            {
                Some("fired") => HookOutcome::Fired,
                Some("denied") => HookOutcome::Denied,
                Some("off") => HookOutcome::Off,
                Some("unknown") => HookOutcome::Unknown,
                _ => HookOutcome::Unavailable,
            }
        })
    }
}

#[derive(Deserialize)]
struct AnswerParams {
    call: u64,
    result: Box<serde_json::value::RawValue>,
}

async fn answer(call: Call) -> Result<Reply, Fault> {
    let params: AnswerParams = call.params()?;
    let waiting = state().asks.remove(&params.call);
    if let Some(waiting) = waiting {
        let value = serde_json::from_str(params.result.get()).unwrap_or(Value::Null);
        let _ = waiting.send(value);
    }
    Reply::json(&Value::Null)
}

pub fn register(registry: &mut Registry) {
    registry.add("web.answer", |call| Box::pin(answer(call)));
}
