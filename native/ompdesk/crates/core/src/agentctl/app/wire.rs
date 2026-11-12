//! The `app.*` requests: `app.open` makes an instance over a port to main, `app.list` and `app.run` are
//! `ompdesk_app_list` and `ompdesk_app` on it, `app.released` drops a closed session's undo, and `app.catalog` and
//! `app.tier` read the tables the page-side tests check against the renderer.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use super::catalog::{PANEL_TABS, SETTINGS_SECTIONS, VIEW_SHEETS, shipped};
use super::channels::{CHANNELS, Risk};
use super::control::{Action, AppControl, Registry as Actions, Run, Step};
use super::guard::{Tier, pref_tier, rpc_tier, setting_tier};
use super::ports::{AppPorts, PortPorts};
use super::schema::no_args;
use super::settings::{Decision, Kind, Manage, ROW_NOT_WRITTEN, SETTINGS, setting_action_id};
use crate::ports::Port;
use crate::server::{Call, Fault, Registry, Reply};

type Instance = Arc<AppControl<PortPorts>>;

static APPS: LazyLock<Mutex<HashMap<u64, Instance>>> = LazyLock::new(Default::default);

fn apps() -> MutexGuard<'static, HashMap<u64, Instance>> {
    APPS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn register(registry: &mut Registry) {
    registry.add("app.open", |call| Box::pin(open(call)));
    registry.add("app.list", |call| Box::pin(list(call)));
    registry.add("app.run", |call| Box::pin(run(call)));
    registry.add("app.released", |call| Box::pin(released(call)));
    registry.add("app.catalog", |call| Box::pin(catalog(call)));
    registry.add("app.tier", |call| Box::pin(tier(call)));
}

/// An action a test defines instead of the shipped catalog: what it does is a list of context primitives.
#[derive(Deserialize)]
struct Script {
    id: String,
    tier: String,
    steps: Vec<Step>,
}

fn scripted<P: AppPorts>(scripts: Vec<Script>) -> Result<Actions<P>, Fault> {
    let mut actions = Vec::new();
    for script in scripts {
        let tier = match script.tier.as_str() {
            "read" => Tier::Read,
            "change" => Tier::Change,
            "sensitive" => Tier::Sensitive,
            other => return Err(Fault::new("invalid_params", format!("script tier {other}"))),
        };
        actions.push(Action {
            id: script.id,
            area: "test".into(),
            description: "A test attempt that must be refused.".into(),
            args: no_args(),
            tier,
            never_reason: None,
            manage: None,
            full_only: None,
            describe: None,
            run: Some(Run::Script(script.steps)),
        });
    }
    Ok(Actions::new(actions))
}

#[derive(Deserialize)]
struct OpenParams {
    port: u64,
    state: Box<RawValue>,
    /// Test actions that replace the catalog (what the tests of what a context refuses define).
    #[serde(default)]
    scripts: Option<Vec<Script>>,
}

async fn open(call: Call) -> Result<Reply, Fault> {
    let params: OpenParams = call.params()?;
    let port = Port::open_raw(&call.events, params.port, &params.state)?;
    let actions = match params.scripts {
        Some(scripts) => match scripted(scripts) {
            Ok(actions) => actions,
            Err(fault) => {
                port.close();
                return Err(fault);
            }
        },
        None => shipped(),
    };
    let control = Arc::new(AppControl::new(PortPorts::new(port.clone()), actions));
    apps().insert(params.port, control);
    let id = params.port;
    tokio::spawn(async move {
        port.until_closed().await;
        apps().remove(&id);
    });
    Reply::json(&())
}

fn instance(params: &Value) -> Result<Instance, Fault> {
    let port = params
        .get("port")
        .and_then(Value::as_u64)
        .ok_or_else(|| Fault::new("invalid_params", "port is required"))?;
    apps()
        .get(&port)
        .cloned()
        .ok_or_else(|| Fault::new("no_app", format!("app port {port} is not open")))
}

async fn list(call: Call) -> Result<Reply, Fault> {
    let params: Value = call.params()?;
    let text = instance(&params)?
        .list(params.get("args").unwrap_or(&Value::Null))
        .await?;
    Reply::json(&text)
}

async fn run(call: Call) -> Result<Reply, Fault> {
    let params: Value = call.params()?;
    let caller = params
        .get("caller")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let text = instance(&params)?
        .run(&caller, params.get("action"), params.get("args"))
        .await?;
    Reply::json(&text)
}

async fn released(call: Call) -> Result<Reply, Fault> {
    let params: Value = call.params()?;
    if let Ok(app) = instance(&params) {
        app.released(
            params
                .get("caller")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
    }
    Reply::json(&())
}

fn manage_json(manage: Manage) -> Value {
    match manage {
        Manage::Always { reason, when } => json!({"always": reason, "conditional": when.is_some()}),
        Manage::Lifts(reason) => json!({"lifts": reason}),
    }
}

/// The tables the renderer-side tests hold against their own lists: the shipped actions, the channel table, the
/// Settings rows and the rows not written.
async fn catalog(_call: Call) -> Result<Reply, Fault> {
    let registry = shipped::<PortPorts>();
    let actions: Vec<Value> = registry
        .actions()
        .iter()
        .map(|action| {
            let mut entry = Map::new();
            entry.insert("id".into(), json!(action.id));
            entry.insert("area".into(), json!(action.area));
            entry.insert("description".into(), json!(action.description));
            entry.insert("args".into(), action.args.clone());
            entry.insert("tier".into(), json!(action.tier.as_str()));
            if let Some(reason) = action.never_reason {
                entry.insert("neverReason".into(), json!(reason));
            }
            if let Some(manage) = action.manage {
                entry.insert("manage".into(), manage_json(manage));
            }
            if let Some(reason) = action.full_only {
                entry.insert("fullOnly".into(), json!(reason));
            }
            entry.insert("hasRun".into(), json!(action.run.is_some()));
            Value::Object(entry)
        })
        .collect();
    let channels: Map<String, Value> = CHANNELS
        .iter()
        .map(|(name, risk)| {
            let value = match risk {
                Risk::Never(reason) => json!({"never": reason}),
                Risk::Tier(tier, actions) => json!({"tier": tier.as_str(), "actions": actions}),
                Risk::SettingsWrite => {
                    let ids: Vec<String> = SETTINGS
                        .iter()
                        .map(|row| setting_action_id(row.id))
                        .collect();
                    json!({"tier": "change", "actions": ids})
                }
            };
            ((*name).to_string(), value)
        })
        .collect();
    let settings: Vec<Value> = SETTINGS
        .iter()
        .map(|row| match row.kind {
            Kind::Pref { key, .. } => {
                json!({"id": row.id, "kind": "pref", "key": key, "tier": row.tier.as_str()})
            }
            Kind::Stock { path } => {
                json!({"id": row.id, "kind": "stock", "path": path, "tier": row.tier.as_str()})
            }
        })
        .collect();
    let not_written: Map<String, Value> = ROW_NOT_WRITTEN
        .iter()
        .map(|(id, decision)| {
            let value = match decision {
                Decision::Covered(action) => json!({"covered": action}),
                Decision::Never(reason) => json!({"never": reason}),
            };
            ((*id).to_string(), value)
        })
        .collect();
    Reply::json(&json!({
        "actions": actions,
        "channels": channels,
        "settings": settings,
        "rowNotWritten": not_written,
        "panelTabs": PANEL_TABS,
        "viewSheets": VIEW_SHEETS,
        "settingsSections": SETTINGS_SECTIONS,
    }))
}

/// What the guard says a preference, a stock setting or an omp command needs.
async fn tier(call: Call) -> Result<Reply, Fault> {
    let params: Value = call.params()?;
    let full = params.get("full") == Some(&Value::Bool(true));
    let text = |name: &str| {
        params
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let tier = match params.get("kind").and_then(Value::as_str) {
        Some("pref") => pref_tier(&text("key"), full),
        Some("setting") => setting_tier(&text("path"), full),
        Some("rpc") => rpc_tier(params.get("command").unwrap_or(&Value::Null), full),
        _ => return Err(Fault::new("invalid_params", "kind is pref, setting or rpc")),
    };
    Reply::json(&tier.as_str())
}
