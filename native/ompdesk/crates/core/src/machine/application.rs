//! Machine-service policy, previously LocalMachine/RemoteMachine. The native app supplies an authenticated target
//! and opaque owner handle. Neither a page payload nor a deserialized caller can name another caller's runners.

use std::collections::HashMap;
use std::hash::Hash;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ompdesk_app_contract::NativeCaller;
use serde_json::{Value, json};

use super::{Boxed, Service};
use crate::models::{application::SetupRunner, benchmark::BenchmarkRunner, plan};
use crate::server::Fault;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preference {
    ResearchPick,
    AccountRotation,
    CreditSpend,
    BuiltinRea,
    LocalEngineDetect,
    Theme,
    Language,
}
impl Preference {
    pub fn key(self) -> &'static str {
        match self {
            Self::ResearchPick => "modelSetupResearchPick",
            Self::AccountRotation => "accountRotation",
            Self::CreditSpend => "creditSpend",
            Self::BuiltinRea => "builtinMcp.rea",
            Self::LocalEngineDetect => "localEngineDetect",
            Self::Theme => "themeName",
            Self::Language => "language",
        }
    }
}

#[derive(Clone, Debug)]
pub enum Changed {
    AccountRotation(String),
    CreditSpend(bool),
}

/// Constructed only by the authenticated native registry, after resolving the focused tab on its own host.
pub enum Target<O> {
    Local {
        owner: O,
        cwd: Option<PathBuf>,
    },
    Remote {
        owner: O,
        device: String,
        tab: Option<RemoteTab>,
    },
}

pub struct RemoteTab {
    pub rtab: String,
    pub cwd: PathBuf,
}

/// The updater's existing native state, not a page request and not a second updater implementation.
pub struct Update {
    pub status: Value,
    pub restartable: bool,
    pub countdown: bool,
}

pub trait Desktop: Send + Sync + 'static {
    fn version(&self) -> String;
    fn update(&self) -> Update;
    fn check(&self) -> Boxed<'_, Result<(), Fault>>;
    fn download(&self) -> Boxed<'_, Result<(), Fault>>;
    fn postpone(&self);
    fn restart(&self);
}

pub trait Host: Send + Sync + 'static {
    type Owner: Clone + Eq + Hash + Send + Sync + 'static;
    fn target<'a>(
        &'a self,
        caller: &'a NativeCaller,
        device: Option<&'a str>,
    ) -> Boxed<'a, Result<Target<Self::Owner>, Fault>>;
    fn remote<'a>(
        &'a self,
        owner: &'a Self::Owner,
        device: &'a str,
        method: &'static str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> Boxed<'a, Result<Value, Fault>>;
    fn preference(&self, key: Preference) -> Value;
    /// A persisted null research pick removes the preference. The native store owns safe disk-full retries.
    fn write_preference(&self, key: Preference, value: Value) -> Result<(), Fault>;
    /// Native pool/host fanout only, following the successful store write, as in index.ts's setters.
    fn changed(&self, change: Changed);
    fn even_supported(&self) -> Boxed<'_, Result<Option<bool>, Fault>>;
    fn set_local_engines(&self, enabled: bool) -> Boxed<'_, Result<(), Fault>>;
    fn install_node(&self);
    fn desktop(&self) -> Arc<dyn Desktop>;
    fn busy(&self) -> bool;
}

pub enum Command {
    Benchmark(Value),
    AbortBenchmark,
    ModelSetup(Value),
    ModelSetupStatus,
    AbortModelSetup,
    ResearchPick,
    SetResearchPick(Value),
    AccountRotation,
    SetAccountRotation(Value),
    CreditSpend,
    SetCreditSpend(Value),
    BuiltinRea,
    SetBuiltinRea(Value),
    LocalEngineDetect,
    SetLocalEngineDetect(Value),
    Desktop,
    DesktopUpdate(Value),
}

pub struct Application<H: Host> {
    runtime: Arc<Service>,
    host: Arc<H>,
    benchmarks: Mutex<HashMap<H::Owner, BenchmarkRunner>>,
    setups: Mutex<HashMap<H::Owner, SetupRunner>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}
fn invalid(message: &str) -> Fault {
    Fault::new(
        "invalid_preference_key",
        format!("[invalid_preference_key] {message}"),
    )
}
fn boolean(value: &Value, message: &str) -> Result<bool, Fault> {
    value.as_bool().ok_or_else(|| invalid(message))
}
fn research_pick(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| plan::is_selector(s))
}

impl<H: Host> Application<H> {
    pub fn new(runtime: Arc<Service>, host: Arc<H>) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            host,
            benchmarks: Mutex::new(HashMap::new()),
            setups: Mutex::new(HashMap::new()),
        })
    }

    pub async fn call(
        &self,
        caller: &NativeCaller,
        device: Option<&str>,
        command: Command,
    ) -> Result<Value, Fault> {
        match self.host.target(caller, device).await? {
            Target::Local { owner, cwd } => self.local(owner, cwd, command).await,
            Target::Remote { owner, device, tab } => {
                self.remote(&owner, &device, tab, command).await
            }
        }
    }

    pub fn close_owner(&self, owner: &H::Owner) {
        if let Some(runner) = lock(&self.benchmarks).remove(owner) {
            runner.abort();
        }
        if let Some(runner) = lock(&self.setups).remove(owner) {
            runner.abort();
        }
    }

    fn desktop_state(&self, desktop: &dyn Desktop) -> Value {
        let pref = |key| self.host.preference(key).as_str().map(str::to_owned);
        json!({"version":desktop.version(),"update":desktop.update().status,"appearance":{"themeName":pref(Preference::Theme),"language":pref(Preference::Language)}})
    }

    async fn local(
        &self,
        owner: H::Owner,
        cwd: Option<PathBuf>,
        command: Command,
    ) -> Result<Value, Fault> {
        match command {
            Command::Benchmark(options) => {
                let Some(cwd) = cwd else {
                    return Ok(
                        json!({"success":false,"error":"No active workspace","code":"no_workspace"}),
                    );
                };
                let runtime = match self.runtime.runtime().await {
                    Ok(runtime) => runtime,
                    Err(error) => return Ok(json!({"success":false,"error":error.message})),
                };
                let runner = lock(&self.benchmarks)
                    .entry(owner.clone())
                    .or_default()
                    .clone();
                let result = runner.run(runtime, &cwd.to_string_lossy(), &options).await;
                // Entries stay until the owner closes: removing one while a concurrent call reuses it could allow two children.
                Ok(result)
            }
            Command::AbortBenchmark => Ok(Value::Bool(
                lock(&self.benchmarks)
                    .get(&owner)
                    .is_some_and(BenchmarkRunner::abort),
            )),
            Command::ModelSetup(request) => {
                let runtime = match self.runtime.runtime().await {
                    Ok(runtime) => runtime,
                    Err(error) => return Ok(json!({"success":false,"error":error.message})),
                };
                let runner = lock(&self.setups).entry(owner).or_default().clone();
                let cwd = std::env::temp_dir().to_string_lossy().into_owned();
                Ok(runner.run(runtime, request, cwd).await)
            }
            Command::ModelSetupStatus => Ok(lock(&self.setups)
                .get(&owner)
                .map_or_else(|| json!({"running":false}), SetupRunner::status)),
            Command::AbortModelSetup => Ok(Value::Bool(
                lock(&self.setups)
                    .get(&owner)
                    .is_some_and(SetupRunner::abort),
            )),
            Command::ResearchPick => {
                Ok(json!({"pick":research_pick(&self.host.preference(Preference::ResearchPick))}))
            }
            Command::SetResearchPick(pick) => {
                if !pick.is_null() && research_pick(&pick).is_none() {
                    return Err(invalid("Invalid research model"));
                }
                self.host
                    .write_preference(Preference::ResearchPick, pick.clone())?;
                Ok(json!({"pick":research_pick(&self.host.preference(Preference::ResearchPick))}))
            }
            Command::AccountRotation => self.rotation().await,
            Command::SetAccountRotation(mode) => {
                if !mode.as_str().is_some_and(|m| matches!(m, "quota" | "even")) {
                    return Err(invalid("Invalid account rotation"));
                }
                self.host
                    .write_preference(Preference::AccountRotation, mode.clone())?;
                self.host.changed(Changed::AccountRotation(
                    mode.as_str().unwrap_or_default().to_owned(),
                ));
                self.rotation().await
            }
            Command::CreditSpend => {
                Ok(json!({"enabled":self.host.preference(Preference::CreditSpend) == true}))
            }
            Command::SetCreditSpend(value) => {
                let enabled = boolean(&value, "Invalid credit use preference")?;
                self.host.write_preference(Preference::CreditSpend, value)?;
                self.host.changed(Changed::CreditSpend(enabled));
                Ok(json!({"enabled":self.host.preference(Preference::CreditSpend) == true}))
            }
            Command::BuiltinRea => Ok(serde_json::to_value(
                self.runtime
                    .builtin_rea(self.host.preference(Preference::BuiltinRea) != false)
                    .await,
            )
            .map_err(|e| Fault::new("internal", e.to_string()))?),
            Command::SetBuiltinRea(value) => {
                let enabled = boolean(&value, "Invalid built-in REA preference")?;
                self.host.write_preference(Preference::BuiltinRea, value)?;
                let state = self
                    .runtime
                    .builtin_rea(self.host.preference(Preference::BuiltinRea) != false)
                    .await;
                if enabled && matches!(state.reason, Some("node-missing" | "node-version")) {
                    self.host.install_node();
                }
                serde_json::to_value(state).map_err(|e| Fault::new("internal", e.to_string()))
            }
            Command::LocalEngineDetect => {
                Ok(json!({"enabled":self.host.preference(Preference::LocalEngineDetect) != false}))
            }
            Command::SetLocalEngineDetect(value) => {
                let enabled = boolean(&value, "Invalid local engine detection preference")?;
                self.host.set_local_engines(enabled).await?;
                Ok(json!({"enabled":self.host.preference(Preference::LocalEngineDetect) != false}))
            }
            Command::Desktop => Ok(self.desktop_state(self.host.desktop().as_ref())),
            Command::DesktopUpdate(action) => {
                let desktop = self.host.desktop();
                match action.as_str() {
                    Some("check") => desktop.check().await?,
                    Some("download") => desktop.download().await?,
                    Some("postpone") => desktop.postpone(),
                    Some(action @ ("install" | "restart-now")) => {
                        let update = desktop.update();
                        if !update.restartable {
                            return Err(Fault::new(
                                "update_not_ready",
                                "[update_not_ready] No update is ready to install on this computer",
                            ));
                        }
                        if !(action == "restart-now" && update.countdown) && self.host.busy() {
                            return Err(Fault::new(
                                "host_busy",
                                "[host_busy] Work is running on this computer",
                            ));
                        }
                        let restart = Arc::clone(&desktop);
                        tokio::spawn(async move {
                            crate::clock::sleep(Duration::from_millis(500)).await;
                            restart.restart();
                        });
                    }
                    _ => return Err(invalid("Invalid update action")),
                }
                Ok(self.desktop_state(desktop.as_ref()))
            }
        }
    }

    async fn rotation(&self) -> Result<Value, Fault> {
        let stored = self.host.preference(Preference::AccountRotation);
        let mode = if stored == "even" { "even" } else { "quota" };
        Ok(json!({"mode":mode,"evenSupported":self.host.even_supported().await?}))
    }

    async fn remote(
        &self,
        owner: &H::Owner,
        device: &str,
        tab: Option<RemoteTab>,
        command: Command,
    ) -> Result<Value, Fault> {
        let (method, params, timeout) = match command {
            Command::Benchmark(options) => (
                "host.bench.run",
                match tab {
                    Some(tab) => json!({"options":options,"rtab":tab.rtab,"cwd":tab.cwd}),
                    None => json!({"options":options}),
                },
                Some(crate::models::benchmark::TIMEOUT_MS + 5_000),
            ),
            Command::AbortBenchmark => ("host.bench.abort", json!({}), None),
            Command::ModelSetup(request) => (
                "host.modelSetup.run",
                json!({"request":request}),
                Some(plan::TIMEOUT_MS + 5_000),
            ),
            Command::ModelSetupStatus => ("host.modelSetup.status", json!({}), None),
            Command::AbortModelSetup => ("host.modelSetup.abort", json!({}), None),
            Command::ResearchPick => ("host.modelSetup.pick.get", json!({}), None),
            Command::SetResearchPick(pick) => {
                ("host.modelSetup.pick.set", json!({"pick":pick}), None)
            }
            Command::AccountRotation => ("host.accountRotation.get", json!({}), None),
            Command::SetAccountRotation(mode) => {
                ("host.accountRotation.set", json!({"mode":mode}), None)
            }
            Command::CreditSpend => ("host.creditSpend.get", json!({}), None),
            Command::SetCreditSpend(enabled) => {
                ("host.creditSpend.set", json!({"enabled":enabled}), None)
            }
            Command::BuiltinRea => ("host.builtinRea.get", json!({}), None),
            Command::SetBuiltinRea(enabled) => {
                ("host.builtinRea.set", json!({"enabled":enabled}), None)
            }
            Command::LocalEngineDetect => ("host.localEngines.get", json!({}), None),
            Command::SetLocalEngineDetect(enabled) => {
                ("host.localEngines.set", json!({"enabled":enabled}), None)
            }
            Command::Desktop => ("host.desktop.get", json!({}), None),
            Command::DesktopUpdate(action) => (
                "host.desktop.update",
                json!({"action":action}),
                Some(90_000 + 5_000),
            ),
        };
        let result = self
            .host
            .remote(owner, device, method, params, timeout)
            .await?;
        validate_reply(method, &result)?;
        Ok(result)
    }
}

fn validate_reply(method: &str, value: &Value) -> Result<(), Fault> {
    let valid = match method {
        "host.modelSetup.pick.get" | "host.modelSetup.pick.set" => value
            .get("pick")
            .is_some_and(|v| v.is_null() || research_pick(v).is_some()),
        "host.accountRotation.get" | "host.accountRotation.set" => {
            value
                .get("mode")
                .and_then(Value::as_str)
                .is_some_and(|m| matches!(m, "quota" | "even"))
                && value
                    .get("evenSupported")
                    .is_some_and(|v| v.is_null() || v.is_boolean())
        }
        "host.creditSpend.get"
        | "host.creditSpend.set"
        | "host.localEngines.get"
        | "host.localEngines.set" => value.get("enabled").is_some_and(Value::is_boolean),
        "host.builtinRea.get" | "host.builtinRea.set" => {
            value.get("enabled").is_some_and(Value::is_boolean)
                && value.get("available").is_some_and(Value::is_boolean)
                && value.get("nodeVersion").is_none_or(Value::is_string)
                && value.get("reason").is_none_or(|r| {
                    r.as_str().is_some_and(|r| {
                        matches!(
                            r,
                            "node-missing"
                                | "npx-missing"
                                | "node-version"
                                | "node-failed"
                                | "npx-failed"
                        )
                    })
                })
        }
        "host.modelSetup.status" => {
            value.get("running").is_some_and(Value::is_boolean)
                && value.get("startedAt").is_none_or(Value::is_number)
                && value.get("activity").is_none_or(|a| {
                    a.get("tool").is_some_and(Value::is_string)
                        && a.get("detail").is_none_or(Value::is_string)
                })
        }
        "host.desktop.get" | "host.desktop.update" => {
            value.get("version").is_some_and(Value::is_string)
                && value.get("update").is_some_and(valid_update)
                && value.get("appearance").is_some_and(|a| {
                    ["themeName", "language"]
                        .iter()
                        .all(|key| a.get(*key).is_some_and(|v| v.is_null() || v.is_string()))
                })
        }
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(Fault::new(
            "invalid_remote_reply",
            "The host returned an invalid machine-service reply",
        ))
    }
}

fn valid_update(value: &Value) -> bool {
    let string = |key| value.get(key).is_some_and(Value::is_string);
    let optional = |key, predicate: fn(&Value) -> bool| value.get(key).is_none_or(predicate);
    let mode = || {
        value
            .get("mode")
            .and_then(Value::as_str)
            .is_some_and(|m| matches!(m, "automatic" | "relaunch" | "manual"))
    };
    match value.get("state").and_then(Value::as_str) {
        Some("idle" | "checking") => true,
        Some("available") => string("version") && mode() && optional("notes", Value::is_string),
        Some("downloading") => {
            string("version") && mode() && value.get("percent").is_some_and(Value::is_number)
        }
        Some("downloaded") => {
            string("version")
                && mode()
                && optional("restartAt", Value::is_number)
                && value.get("installing").is_none_or(|v| v == true)
        }
        Some("not-available") => string("version"),
        Some("error") => {
            string("message")
                && optional("detail", Value::is_string)
                && optional("showInBanner", Value::is_boolean)
        }
        Some("auth-required") => value
            .get("reason")
            .and_then(Value::as_str)
            .is_some_and(|r| matches!(r, "missing" | "invalid" | "denied")),
        _ => false,
    }
}

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;
