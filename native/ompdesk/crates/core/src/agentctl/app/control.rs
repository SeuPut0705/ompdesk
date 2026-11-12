//! `ompdesk_app_list` and `ompdesk_app`: the one place an agent's call to change OMPdesk is checked and run (was
//! `app-control.ts`).
//!
//!   1. the action must be in the registry (`catalog.rs`); anything else is unknown, nothing falls through;
//!   2. `never` refuses; arguments are validated against the action's schema;
//!   3. `sensitive` raises the `[OMPdesk]` confirmation card unless the person gave agents full control
//!      (`agentControlFull`, default on: no card at all) or turned `agentControlManage` on (default on); with only
//!      the latter, an action whose `manage` rule is `always` (erases data, runs code, credentials, network exposure,
//!      ends running work) still asks; an action marked `full_only` runs only under full control;
//!   4. the action runs with a `Ctx` whose every primitive re-checks the tier the preference, setting, command or
//!      channel needs (`guard.rs`, `channels.rs`), so a nested route is refused like a direct one;
//!   5. a change is journaled in the caller's session, shown as a quiet toast and, with a previous value, undoable.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::channels::{CHANNELS, Risk};
use super::guard::{
    FULL_CONTROL_SETTINGS, Tier, covers, omp_setting_tier, power_setting, pref_tier, rpc_tier,
    setting_tier, setting_value_problem,
};
use super::ports::{AppPorts, RpcResponse, SidebarView};
use super::schema::{Args, validate_args};
use super::settings::{self, Manage, SETTINGS, Setting, setting_action_id};
use super::text::{js_string, json, slice_units};
use crate::ports::PortError;
use crate::server::Fault;

/// The code a refusal travels under: main throws `AppRefusal` again for it.
pub const REFUSAL: &str = "app_refusal";

/// A refusal the agent reads: not a failure of the app.
pub fn refusal(message: impl Into<String>) -> Fault {
    Fault::new(REFUSAL, message)
}

pub fn is_refusal(fault: &Fault) -> bool {
    fault.code == REFUSAL
}

/// Past this many matches `ompdesk_app_list` lists names only; narrow with `area` or `query` for schemas.
const SCHEMA_LIST_MAX: usize = 12;

pub fn refuse(what: &str, tier: Tier) -> Fault {
    refusal(if tier == Tier::Never {
        format!("{what} is never available to an agent. Tell the person to do it in Settings.")
    } else {
        format!(
            "{what} needs the {} level, which this action does not have.",
            tier.as_str()
        )
    })
}

/// One step back: a stored preference or a stock setting, as the person's own Settings control writes it. A setting
/// written on another computer (`omp_settings.set` with a `device`) names it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Undo {
    Pref {
        key: String,
        value: Value,
    },
    Setting {
        path: String,
        value: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device: Option<String>,
    },
}

impl Undo {
    fn value(&self) -> &Value {
        match self {
            Undo::Pref { value, .. } | Undo::Setting { value, .. } => value,
        }
    }
}

/// What an action did that is worth a journal line and a toast.
pub struct Change {
    pub en: String,
    pub ko: String,
    /// The new value as shown to the person.
    pub value: String,
    /// One step back, present only when there was a previous value to restore.
    pub undo: Option<Undo>,
}

/// What an action returns: text for the agent, and, when it changed something, what to journal and toast.
pub struct ActionResult {
    pub text: String,
    pub change: Option<Change>,
}

impl ActionResult {
    pub fn text(text: impl Into<String>) -> ActionResult {
        ActionResult {
            text: text.into(),
            change: None,
        }
    }

    pub fn changed(
        text: impl Into<String>,
        en: impl Into<String>,
        ko: impl Into<String>,
        value: impl Into<String>,
    ) -> ActionResult {
        ActionResult {
            text: text.into(),
            change: Some(Change {
                en: en.into(),
                ko: ko.into(),
                value: value.into(),
                undo: None,
            }),
        }
    }

    pub fn with_undo(mut self, undo: Option<Undo>) -> ActionResult {
        if let Some(change) = &mut self.change {
            change.undo = undo;
        }
        self
    }
}

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Handler<P> = fn(Ctx<P>, Args) -> BoxFut<Result<ActionResult, Fault>>;

/// One primitive of a scripted action: what a test action does through its context.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Step {
    GetPref {
        key: String,
    },
    SetPref {
        key: String,
        value: Value,
    },
    Rpc {
        command: Value,
        #[serde(default)]
        device: Option<String>,
    },
    Invoke {
        channel: String,
        #[serde(default)]
        args: Vec<Value>,
    },
}

pub enum Run<P> {
    Handler(Handler<P>),
    /// The setting row `settings.<id>` writes.
    Setting(&'static Setting),
    /// A test action: its steps run through the context one after the other.
    Script(Vec<Step>),
}

pub struct Action<P> {
    pub id: String,
    pub area: String,
    pub description: String,
    pub args: Value,
    pub tier: Tier,
    /// Why a `never` action exists: shown to the agent so it does not try another route.
    pub never_reason: Option<&'static str>,
    /// Required on a `Sensitive` action: whether `agentControlManage` lifts its card, or it always asks, and why.
    pub manage: Option<Manage>,
    /// Present on an action that runs only while the person gave agents full control; why it is refused otherwise.
    pub full_only: Option<&'static str>,
    /// What the confirmation card says is about to happen, in full (exact command, url, arguments).
    pub describe: Option<fn(&Args) -> String>,
    /// Absent for a `never` action.
    pub run: Option<Run<P>>,
}

pub struct Registry<P> {
    actions: Vec<Action<P>>,
    index: HashMap<String, usize>,
}

impl<P> Registry<P> {
    pub fn new(actions: Vec<Action<P>>) -> Registry<P> {
        let index = actions
            .iter()
            .enumerate()
            .map(|(at, action)| (action.id.clone(), at))
            .collect();
        Registry { actions, index }
    }

    pub fn get(&self, id: &str) -> Option<&Action<P>> {
        self.index.get(id).map(|at| &self.actions[*at])
    }

    pub fn actions(&self) -> &[Action<P>] {
        &self.actions
    }
}

#[derive(Clone)]
struct LastChange {
    undo: Undo,
    en: String,
    ko: String,
}

struct Inner<P> {
    ports: P,
    registry: Registry<P>,
    last: Mutex<HashMap<String, LastChange>>,
    sign_ins: Mutex<HashSet<String>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

static CHANNEL_RISK: LazyLock<HashMap<&'static str, &'static Risk>> =
    LazyLock::new(|| CHANNELS.iter().map(|(name, risk)| (*name, risk)).collect());

pub struct AppControl<P> {
    inner: Arc<Inner<P>>,
}

impl<P: AppPorts> AppControl<P> {
    pub fn new(ports: P, registry: Registry<P>) -> AppControl<P> {
        AppControl {
            inner: Arc::new(Inner {
                ports,
                registry,
                last: Mutex::new(HashMap::new()),
                sign_ins: Mutex::new(HashSet::new()),
            }),
        }
    }

    pub fn ports(&self) -> &P {
        &self.inner.ports
    }

    /// `ompdesk_app_list`: the actions, filtered by `area` and `query` of `raw`.
    pub async fn list(&self, raw: &Value) -> Result<String, Fault> {
        let ports = &self.inner.ports;
        ports.refresh().await?;
        let filter = |key: &str| {
            raw.get(key)
                .and_then(Value::as_str)
                .map(str::to_lowercase)
                .unwrap_or_default()
        };
        let area = filter("area");
        let query = filter("query");
        let found: Vec<&Action<P>> = self
            .inner
            .registry
            .actions()
            .iter()
            .filter(|action| {
                let own = action.area.to_lowercase();
                if !area.is_empty() && !(own == area || own.starts_with(&format!("{area}/"))) {
                    return false;
                }
                query.is_empty()
                    || format!("{} {} {}", action.id, action.area, action.description)
                        .to_lowercase()
                        .contains(&query)
            })
            .collect();
        if found.is_empty() {
            return Ok(
                "No action matches. Call ompdesk_app_list with no filter to see every area.".into(),
            );
        }
        let with_schema = found.len() <= SCHEMA_LIST_MAX;
        let full = ports.full_enabled();
        let rows: Vec<String> = found
            .iter()
            .map(|action| {
                let card = match action.manage {
                    None => "",
                    Some(_) if full => "",
                    Some(Manage::Lifts(_)) => ", card unless the user lets agents manage",
                    Some(Manage::Always { when: Some(_), .. }) => {
                        ", always a card for some arguments"
                    }
                    Some(Manage::Always { when: None, .. }) => ", always a card",
                };
                let head = format!(
                    "- {} [{}{card}] {}",
                    action.id,
                    action.tier.as_str(),
                    action.description
                );
                if action.tier == Tier::Never {
                    return format!(
                        "{head} Refused: {}",
                        action.never_reason.unwrap_or("undefined")
                    );
                }
                if let Some(reason) = action.full_only
                    && !full
                {
                    return format!("{head} Refused: {reason}");
                }
                if with_schema {
                    format!("{head}\n  args: {}", json(&action.args))
                } else {
                    head
                }
            })
            .collect();
        let note = if with_schema {
            String::new()
        } else {
            format!(
                "\n({} actions; narrow with area or query to see argument schemas.)",
                found.len()
            )
        };
        Ok(format!("{}{note}", rows.join("\n")))
    }

    /// `ompdesk_app`: runs action `action_id` for `caller` with `raw` as its arguments. A refusal is a `Fault` of
    /// code `REFUSAL`.
    pub async fn run(
        &self,
        caller: &str,
        action_id: Option<&Value>,
        raw: Option<&Value>,
    ) -> Result<String, Fault> {
        let inner = &self.inner;
        inner.ports.refresh().await?;
        let action = action_id
            .and_then(Value::as_str)
            .and_then(|id| inner.registry.get(id));
        let Some(action) = action else {
            let named = action_id.map_or_else(|| "undefined".to_string(), json);
            return Err(refusal(format!(
                "Unknown action {named}. Call ompdesk_app_list to see the actions."
            )));
        };
        let Some(run) = action.run.as_ref().filter(|_| action.tier != Tier::Never) else {
            return Err(refuse(&format!("\"{}\"", action.id), Tier::Never));
        };
        if let Some(reason) = action.full_only
            && !inner.ports.full_enabled()
        {
            return Err(refusal(format!(
                "\"{}\" is never available to an agent: {reason}",
                action.id
            )));
        }
        let args = validate_args(&action.args, raw)
            .map_err(|problem| refusal(format!("Invalid args for {}: {problem}", action.id)))?;
        inner
            .confirmed(caller, action.tier, Some(action), Some(&args), None)
            .await?;
        let ctx = inner.context(caller, &action.id, action.tier).await?;
        let result = match run {
            Run::Handler(handler) => handler(ctx, args).await?,
            Run::Setting(row) => {
                super::catalog::write_setting(&ctx, row, args.get("value").unwrap_or(&Value::Null))
                    .await?
            }
            Run::Script(steps) => run_script(&ctx, steps).await?,
        };
        if let Some(change) = &result.change {
            inner.record(caller, change).await?;
        }
        Ok(result.text)
    }

    /// A session closed: its undo is gone.
    pub fn released(&self, caller: &str) {
        locked(&self.inner.last).remove(caller);
    }
}

async fn run_script<P: AppPorts>(ctx: &Ctx<P>, steps: &[Step]) -> Result<ActionResult, Fault> {
    for step in steps {
        match step {
            Step::GetPref { key } => {
                ctx.get_pref(key).await?;
            }
            Step::SetPref { key, value } => ctx.set_pref(key, value).await?,
            Step::Rpc { command, device } => {
                ctx.rpc(command.clone(), device.as_deref()).await?;
            }
            Step::Invoke { channel, args } => {
                ctx.invoke(channel, args.clone()).await?;
            }
        }
    }
    Ok(ActionResult::text(""))
}

impl<P: AppPorts> Inner<P> {
    async fn confirmed(
        self: &Arc<Self>,
        caller: &str,
        tier: Tier,
        action: Option<&Action<P>>,
        args: Option<&Args>,
        what: Option<&str>,
    ) -> Result<(), Fault> {
        let forced = match action.and_then(|action| action.manage) {
            Some(Manage::Always { when, .. }) => {
                when.is_none_or(|when| when(args.unwrap_or(&Map::new())))
            }
            _ => false,
        };
        let ports = &self.ports;
        if tier != Tier::Sensitive || ports.full_enabled() || (ports.manage_enabled() && !forced) {
            return Ok(());
        }
        let summary = match what {
            Some(what) => what.to_string(),
            None => self.summary(action, args),
        };
        let title = ports.text("appTitle", &[]).await?;
        let by = ports.caller_title(caller).await?;
        let message = ports
            .text("appMessage", &[("caller", &by), ("what", &summary)])
            .await?;
        if !ports.confirm(caller, &title, &message).await? {
            return Err(refusal(
                "The user declined. Do not try again or look for another route; tell them what you wanted and why.",
            ));
        }
        Ok(())
    }

    fn summary(&self, action: Option<&Action<P>>, args: Option<&Args>) -> String {
        let Some(action) = action else {
            return String::new();
        };
        if let (Some(describe), Some(args)) = (action.describe, args) {
            return describe(args);
        }
        let row = action
            .id
            .strip_prefix("settings.")
            .and_then(settings::by_id);
        let masked: Option<Args> = args.map(|args| {
            let mut args = args.clone();
            if row.is_some_and(Setting::redact) {
                args.insert("value".into(), json!("…"));
            }
            args
        });
        let shown_args = match &masked {
            Some(args) if !args.is_empty() => format!(" {}", json(&Value::Object(args.clone()))),
            _ => String::new(),
        };
        let head = action.description.split(". ").next().unwrap_or("");
        slice_units(&format!("{head}{shown_args}"), 400).to_string()
    }

    /// The primitives one call may use; each checks the tier it needs against `granted`.
    async fn context(
        self: &Arc<Self>,
        caller: &str,
        action_id: &str,
        granted: Tier,
    ) -> Result<Ctx<P>, Fault> {
        let device = self.ports.device(caller).await?;
        Ok(Ctx {
            app: self.clone(),
            caller: caller.to_string(),
            device,
            action_id: action_id.to_string(),
            granted,
        })
    }

    async fn record(self: &Arc<Self>, caller: &str, change: &Change) -> Result<(), Fault> {
        let ports = &self.ports;
        let what = ports.localize(&change.en, &change.ko);
        let message = ports
            .text("appChanged", &[("what", &what), ("value", &change.value)])
            .await?;
        match &change.undo {
            Some(undo) => {
                locked(&self.last).insert(
                    caller.to_string(),
                    LastChange {
                        undo: undo.clone(),
                        en: change.en.clone(),
                        ko: change.ko.clone(),
                    },
                );
            }
            None => {
                locked(&self.last).remove(caller);
            }
        }
        // The window's Undo button writes through its focused tab, which may run on another computer than the one a
        // setting was written on: such a toast carries no step, and `app.undo` restores it on its own computer.
        let step = change.undo.as_ref().filter(|undo| {
            !matches!(
                undo,
                Undo::Setting {
                    device: Some(_),
                    ..
                }
            )
        });
        let mut toast = json!({"kind": "toast", "message": message});
        if let Some(step) = step {
            toast["undo"] = serde_json::to_value(step).unwrap_or(Value::Null);
        }
        ports.send(caller, &toast);
        let _ = ports.note(caller, &message).await;
        Ok(())
    }

    async fn undo(self: &Arc<Self>, caller: &str) -> Result<ActionResult, Fault> {
        let last = locked(&self.last).get(caller).cloned();
        let Some(last) = last else {
            return Err(refusal(
                "Nothing to undo: your last change had no previous value, or you made none.",
            ));
        };
        let full = self.ports.full_enabled();
        let undo = &last.undo;
        let own = match undo {
            Undo::Pref { key, .. } => pref_tier(key, full),
            Undo::Setting { path, .. } => setting_tier(path, full),
        };
        // A setting no Settings row or power switch lists was written by `omp_settings.set`: the primitive checks it
        // against the omp's schema again when it restores it.
        let schema_route = matches!(undo, Undo::Setting { path, .. } if own == Tier::Never && !power_setting(path));
        let needed = if schema_route { Tier::Change } else { own };
        if needed == Tier::Never {
            return Err(refuse("Undoing that change", Tier::Never));
        }
        let row = match undo {
            Undo::Pref { key, .. } => SETTINGS
                .iter()
                .find(|setting| setting.pref_key() == Some(key.as_str())),
            Undo::Setting { path, .. } => settings::by_id(path),
        };
        let undone = row.and_then(|row| self.registry.get(&setting_action_id(row.id)));
        self.confirmed(
            caller,
            needed,
            undone,
            None,
            Some(&format!("undo \"{}\"", last.en)),
        )
        .await?;
        let granted = if needed == Tier::Sensitive {
            Tier::Sensitive
        } else {
            Tier::Change
        };
        let ctx = self.context(caller, "app.undo", granted).await?;
        match undo {
            Undo::Pref { key, value } => {
                ctx.set_pref(key, value).await?;
                let row = SETTINGS
                    .iter()
                    .find(|setting| setting.pref_key() == Some(key.as_str()));
                if let Some(row) = row {
                    for mirrored in row.mirror_keys() {
                        ctx.set_pref(mirrored, &row.mirrored(value)).await?;
                    }
                }
            }
            Undo::Setting {
                path,
                value,
                device,
            } if schema_route => {
                ctx.omp_write(path, value, device.as_deref()).await?;
            }
            Undo::Setting {
                path,
                value,
                device,
            } => {
                ctx.rpc(
                    json!({"type": "set_setting", "path": path, "value": value}),
                    device.as_deref(),
                )
                .await?;
            }
        }
        locked(&self.last).remove(caller);
        let value = match undo.value() {
            Value::String(text) => text.clone(),
            other => json(other),
        };
        Ok(ActionResult::changed(
            format!("Restored {} to {value}.", last.en),
            last.en.clone(),
            last.ko.clone(),
            value,
        ))
    }
}

/// The only things an action can do. Each method runs the central checks first (the action's granted tier against
/// the tier the preference, setting, command or channel needs; `Never` always refuses), so a route through another
/// command meets the same rule as a direct call.
pub struct Ctx<P> {
    app: Arc<Inner<P>>,
    caller: String,
    device: Option<String>,
    action_id: String,
    granted: Tier,
}

impl<P> Clone for Ctx<P> {
    fn clone(&self) -> Self {
        Ctx {
            app: self.app.clone(),
            caller: self.caller.clone(),
            device: self.device.clone(),
            action_id: self.action_id.clone(),
            granted: self.granted,
        }
    }
}

/// One stock setting as the omp's schema lists it, with its current value.
pub struct OmpSettingRead {
    pub entry: Map<String, Value>,
    pub value: Option<Value>,
}

fn is_setting_entry(value: &Value) -> bool {
    value.as_object().is_some_and(|entry| {
        entry.get("path").is_some_and(Value::is_string)
            && entry.get("type").is_some_and(Value::is_string)
    })
}

fn values_of(data: &Value) -> &Map<String, Value> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    data.get("values")
        .and_then(Value::as_object)
        .unwrap_or(&EMPTY)
}

impl<P: AppPorts> Ctx<P> {
    /// The paired host the calling session's tab runs on; `None` = this computer.
    pub fn device(&self) -> Option<&str> {
        self.device.as_deref()
    }

    pub fn caller(&self) -> &str {
        &self.caller
    }

    fn full(&self) -> bool {
        self.app.ports.full_enabled()
    }

    /// A preference's value: this computer's, or the paired host's for a row its Settings control sends there.
    pub async fn get_pref(&self, key: &str) -> Result<Option<Value>, Fault> {
        if pref_tier(key, self.full()) == Tier::Never {
            return Err(refuse(&format!("Reading \"{key}\""), Tier::Never));
        }
        let route = self.device.as_ref().and_then(|_| settings::host_pref(key));
        let (Some(device), Some(route)) = (&self.device, route) else {
            return Ok(self.app.ports.get_pref(key).await?);
        };
        let channel = self.channel(route.get)?;
        let state = self
            .app
            .ports
            .invoke(&self.caller, &channel, &[json!(device)])
            .await?;
        Ok(state.get(route.field).cloned())
    }

    /// Writes a stored preference through the same handler Settings uses (the host's own for a host row), then tells
    /// the window to apply it.
    pub async fn set_pref(&self, key: &str, value: &Value) -> Result<(), Fault> {
        let needed = pref_tier(key, self.full());
        if !covers(self.granted, needed) {
            return Err(refuse(&format!("Writing the preference \"{key}\""), needed));
        }
        let ports = &self.app.ports;
        if let (Some(device), Some(route)) = (&self.device, settings::host_pref(key)) {
            let channel = self.channel(route.set)?;
            ports
                .invoke(&self.caller, &channel, &[value.clone(), json!(device)])
                .await?;
            return Ok(());
        }
        ports.set_pref(&self.caller, key, value).await?;
        ports.send(
            &self.caller,
            &json!({"kind": "pref", "key": key, "value": value}),
        );
        Ok(())
    }

    /// The command goes to the caller's own omp, or, with `target`, to an omp on that computer (`rpc_on`).
    async fn send_command(&self, command: &Value, target: Option<&str>) -> Result<Value, Fault> {
        let response: RpcResponse = match target {
            None => self.app.ports.rpc(&self.caller, command).await?,
            Some(device) => self.app.ports.rpc_on(&self.caller, device, command).await?,
        };
        if !response.success {
            return Err(refusal(response.error.unwrap_or_else(|| {
                format!("{} failed.", js_string(command.get("type")))
            })));
        }
        Ok(response.data.unwrap_or(Value::Null))
    }

    /// Sends an omp command to the calling session, or, with `device`, to an omp on that computer (a paired device's
    /// name or id, or "local"); answers with the response data and fails on failure. The tier check runs first
    /// either way.
    pub async fn rpc(&self, command: Value, device: Option<&str>) -> Result<Value, Fault> {
        let needed = rpc_tier(&command, self.full());
        if !covers(self.granted, needed) {
            return Err(refuse(
                &format!("The command \"{}\"", js_string(command.get("type"))),
                needed,
            ));
        }
        self.send_command(&command, device).await
    }

    /// Starts a provider's sign-in flow in the background: the window is told at once, the omp's login runs on, and
    /// a failure comes back as a toast. One login per session at a time.
    pub async fn start_provider_login(&self, provider_id: &str) -> Result<(), Fault> {
        let login = json!({"type": "login", "providerId": provider_id});
        let needed = rpc_tier(&login, self.full());
        if !covers(self.granted, needed) {
            return Err(refuse("Provider sign-in", needed));
        }
        let ports = &self.app.ports;
        ports.send(
            &self.caller,
            &json!({"kind": "provider-sign-in", "tabId": self.caller, "providerId": provider_id}),
        );
        if !locked(&self.app.sign_ins).insert(self.caller.clone()) {
            return Ok(());
        }
        let ctx = self.clone();
        let task = start(async move { ctx.rpc(login, None).await });
        let ctx = self.clone();
        tokio::spawn(async move {
            let failed = match task.await {
                Ok(Ok(_)) => None,
                Ok(Err(error)) => Some(error.message),
                Err(error) => Some(error.to_string()),
            };
            if let Some(failed) = failed {
                let message = format!(
                    "{}Error: {failed}",
                    ctx.app.ports.localize("Sign-in failed: ", "로그인 실패: ")
                );
                ctx.app
                    .ports
                    .send(&ctx.caller, &json!({"kind": "toast", "message": message}));
            }
            locked(&ctx.app.sign_ins).remove(&ctx.caller);
        });
        Ok(())
    }

    /// Calls an invoke channel's handler (`channel` must list the running action in the channel table).
    pub async fn invoke(&self, channel: &str, args: Vec<Value>) -> Result<Value, Fault> {
        let channel = self.channel(channel)?;
        Ok(self.app.ports.invoke(&self.caller, &channel, &args).await?)
    }

    /// Calls a fire-and-forget channel's handler.
    pub fn fire(&self, channel: &str, args: Vec<Value>) -> Result<(), Fault> {
        let channel = self.channel(channel)?;
        self.app.ports.fire(&self.caller, &channel, &args);
        Ok(())
    }

    pub fn ui(&self, event: Value) {
        self.app.ports.send(&self.caller, &event);
    }

    /// What the person's sidebar holds of pins, aliases and project order (this computer's).
    pub fn sidebar_view(&self) -> SidebarView {
        self.app.ports.sidebar_view()
    }

    /// Opens a macOS Privacy & Security pane; the person toggles the switch.
    pub async fn open_privacy_pane(&self, pane: &str) -> Result<(), PortError> {
        self.app.ports.open_privacy_pane(pane).await
    }

    /// Runs `ompdesk_autopilot` with these arguments: its confirmation card and folder rules apply.
    pub async fn autopilot(&self, args: Value) -> Result<String, Fault> {
        Ok(self.app.ports.autopilot(&self.caller, &args).await?)
    }

    /// Restores the last change this session's agent made (asks again when that change needed a card).
    pub async fn undo_last(&self) -> Result<ActionResult, Fault> {
        self.app.undo(&self.caller).await
    }

    fn channel(&self, channel: &str) -> Result<String, Fault> {
        let quoted = format!("The channel \"{channel}\"");
        let Some(risk) = CHANNEL_RISK.get(channel) else {
            return Err(refuse(&quoted, Tier::Never));
        };
        let (tier, listed) = match risk {
            Risk::Never(_) => return Err(refuse(&quoted, Tier::Never)),
            Risk::Tier(tier, actions) => (*tier, actions.contains(&self.action_id.as_str())),
            Risk::SettingsWrite => (
                Tier::Change,
                self.action_id
                    .strip_prefix("settings.")
                    .is_some_and(|id| settings::by_id(id).is_some()),
            ),
        };
        if !listed {
            return Err(refuse(
                &format!("{quoted} for {}", self.action_id),
                Tier::Never,
            ));
        }
        if !covers(self.granted, tier) {
            return Err(refuse(&quoted, tier));
        }
        Ok(channel.to_string())
    }

    /// The one route to a stock setting of any path (`omp_settings`). It reads the omp's own schema first and decides
    /// from the entry that lists the path (`omp_setting_tier`), so an unlisted path, a credential and the power
    /// switches are refused here for whichever action asks. `rpc_tier` still refuses `get_settings_schema`,
    /// `get_settings` and `set_setting` for every other route: the schema answer carries each setting's value, a
    /// credential's included.
    async fn listed_by(&self, target: Option<&str>) -> Result<Map<String, Value>, Fault> {
        let data = self
            .send_command(&json!({"type": "get_settings_schema"}), target)
            .await?;
        let mut listed = Map::new();
        for entry in data
            .get("entries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if is_setting_entry(entry)
                && let Some(path) = entry.get("path").and_then(Value::as_str)
            {
                listed.insert(path.to_string(), entry.clone());
            }
        }
        Ok(listed)
    }

    fn permitted<'a>(
        &self,
        listed: &'a Map<String, Value>,
        path: &str,
        write: bool,
    ) -> Result<&'a Value, Fault> {
        let Some(entry) = listed.get(path) else {
            return Err(refusal(format!(
                "\"{path}\" is not a setting this omp lists. omp_settings.get with query finds the exact path."
            )));
        };
        let needed = omp_setting_tier(path, Some(entry), write, self.full());
        if covers(self.granted, needed) {
            return Ok(entry);
        }
        let what = format!("{} \"{path}\"", if write { "Writing" } else { "Reading" });
        if needed == Tier::Never {
            let credential = if entry.get("secret") == Some(&Value::Bool(true)) {
                " (it holds a credential)"
            } else {
                ""
            };
            return Err(refusal(format!(
                "{what} is never available to an agent{credential}. Tell the person to do it in Settings."
            )));
        }
        let route = if FULL_CONTROL_SETTINGS.contains(&path) {
            "agent_power.set switches it, only under full control.".to_string()
        } else if settings::by_id(path).is_some() {
            format!("Use {}, which asks the person.", setting_action_id(path))
        } else {
            String::new()
        };
        Err(refusal(
            format!(
                "{what} needs the {} level, which omp_settings does not have. {route}",
                needed.as_str()
            )
            .trim()
            .to_string(),
        ))
    }

    /// The readable settings whose path, label or description holds every word of `query` (credentials and power
    /// switches never listed).
    pub async fn omp_find(
        &self,
        query: &str,
        device: Option<&str>,
    ) -> Result<Vec<OmpSettingRead>, Fault> {
        let words: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let full = self.full();
        let listed = self.listed_by(device).await?;
        Ok(listed
            .values()
            .filter_map(|entry| {
                let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
                if omp_setting_tier(path, Some(entry), false, full) == Tier::Never {
                    return None;
                }
                let part = |name: &str| {
                    entry
                        .get(name)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                let text =
                    format!("{path} {} {}", part("label"), part("description")).to_lowercase();
                words
                    .iter()
                    .all(|word| text.contains(word))
                    .then(|| OmpSettingRead {
                        entry: entry.as_object().cloned().unwrap_or_default(),
                        value: entry.get("value").cloned(),
                    })
            })
            .collect())
    }

    /// These exact paths; refuses the whole call when one is not readable.
    pub async fn omp_read(
        &self,
        paths: &[String],
        device: Option<&str>,
    ) -> Result<Vec<OmpSettingRead>, Fault> {
        let listed = self.listed_by(device).await?;
        let entries = paths
            .iter()
            .map(|path| self.permitted(&listed, path, false))
            .collect::<Result<Vec<_>, _>>()?;
        let data = self
            .send_command(&json!({"type": "get_settings", "paths": paths}), device)
            .await?;
        let values = values_of(&data);
        Ok(entries
            .into_iter()
            .map(|entry| OmpSettingRead {
                entry: entry.as_object().cloned().unwrap_or_default(),
                value: entry
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|path| values.get(path))
                    .cloned(),
            })
            .collect())
    }

    /// Writes one value; answers with the value it replaced.
    pub async fn omp_write(
        &self,
        path: &str,
        value: &Value,
        device: Option<&str>,
    ) -> Result<Option<Value>, Fault> {
        let listed = self.listed_by(device).await?;
        let entry = self.permitted(&listed, path, true)?;
        if let Some(problem) = setting_value_problem(entry, value) {
            return Err(refusal(format!("Invalid value: {problem}.")));
        }
        let data = self
            .send_command(&json!({"type": "get_settings", "paths": [path]}), device)
            .await?;
        let previous = values_of(&data).get(path).cloned();
        self.send_command(
            &json!({"type": "set_setting", "path": path, "value": value}),
            device,
        )
        .await?;
        Ok(previous)
    }
}

/// Polls `future` once at once, as a function that starts its work before its first `await` does in JavaScript (the
/// command is on its way when this returns), then runs it on.
pub fn start<T: Send + 'static>(
    future: impl Future<Output = T> + Send + 'static,
) -> tokio::task::JoinHandle<T> {
    let mut future = Box::pin(future);
    let mut context = Context::from_waker(Waker::noop());
    let first = match future.as_mut().poll(&mut context) {
        Poll::Ready(done) => Some(done),
        Poll::Pending => None,
    };
    tokio::spawn(async move {
        match first {
            Some(done) => done,
            None => future.await,
        }
    })
}
