//! Local launch effects. The existing Application/Lane retain launch, gate and process ordering.
//! Root supplies the authenticated execution and concrete machine-wide services; no page input is decoded here.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared};
use ompdesk_app_contract::Owner;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::time::Instant;

use super::{callers::Callers, prefs::Prefs, sessions::SessionIndex};
use crate::aimemory::application::Memory;
use crate::browsers::{self, FindParams, Installed, Named, Places};
use crate::machine::{self, Service as Machine};
use crate::mcp_hub::{McpHub, policy};
use crate::pool::application::Sidecar;
use crate::server::Fault;
use crate::session_ownership::{Facts, Lease, SessionOwnership};
use crate::sidecar::application::{Answer, Ask, Browser, Builtin, EffectFuture, Host, ProcessIdentity, Runtime, SessionFree, Settings};
use crate::sidecar::native::Service as NativeSidecar;

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserStatus {
    pub ego_installed: bool,
    pub browsers: Vec<Installed>,
}

#[derive(Clone)]
struct BrowserProbe {
    identity: Arc<()>,
    answer: Shared<BoxFuture<'static, Result<Arc<BrowserStatus>, Fault>>>,
}

/// One Arc per machine, shared with DEFAULT_BROWSER_STATUS and its explicit reprobe action.
/// Mirrors agent-browsers.ts: a failed probe clears itself, a successful snapshot lives until reprobed.
pub(crate) struct BrowserState {
    machine: Arc<Machine>,
    input: FindParams,
    cached: Mutex<Option<BrowserProbe>>,
}

impl BrowserState {
    pub fn new(machine: Arc<Machine>, places: Places) -> Result<Arc<Self>, Fault> {
        let input = FindParams { places, browsers: browsers::bundled_catalog()? };
        Ok(Arc::new(Self { machine, input, cached: Mutex::new(None) }))
    }

    fn probe(&self) -> BrowserProbe {
        let machine = Arc::clone(&self.machine);
        let input = self.input.clone();
        BrowserProbe {
            identity: Arc::new(()),
            answer: async move {
                let (ego, browsers) = tokio::join!(machine.ego_browser(), browsers::status(input));
                Ok(Arc::new(BrowserStatus { ego_installed: ego.ok().flatten().is_some(), browsers: browsers? }))
            }.boxed().shared(),
        }
    }

    pub async fn read(&self) -> Result<Arc<BrowserStatus>, Fault> {
        let probe = lock(&self.cached).get_or_insert_with(|| self.probe()).clone();
        let answer = probe.answer.await;
        if answer.is_err() {
            let mut cached = lock(&self.cached);
            if cached.as_ref().is_some_and(|known| Arc::ptr_eq(&known.identity, &probe.identity)) {
                *cached = None;
            }
        }
        answer
    }

    pub async fn reprobe(&self) -> Result<(Arc<BrowserStatus>, bool), Fault> {
        let before = lock(&self.cached).clone();
        let before = match before { Some(probe) => probe.answer.await.ok(), None => None };
        let probe = self.probe();
        let status = probe.answer.clone().await?;
        *lock(&self.cached) = Some(probe);
        let changed = before.as_ref().is_some_and(|before| !same_browser_target(before, &status));
        Ok((status, changed))
    }

    async fn selected(&self, pref: &Value) -> Result<Browser, Fault> {
        let status = self.read().await?;
        Ok(select_browser(pref, &status, &self.input.browsers))
    }
}

fn same_browser_target(before: &BrowserStatus, after: &BrowserStatus) -> bool {
    before.ego_installed == after.ego_installed
        && before.browsers.len() == after.browsers.len()
        && before.browsers.iter().zip(&after.browsers).all(|(before, after)| {
            before.id == after.id && before.relay_installed == after.relay_installed
        })
}

// Native pre-spawn counterpart of shared/default-browser.ts::resolveAgentBrowser. Discovery and the
// id/name/port catalog remain the existing native browser engine and its generated canonical artifact.
fn select_browser(pref: &Value, status: &BrowserStatus, catalog: &[Named]) -> Browser {
    let relay = |browser: Option<&Installed>| {
        browser.filter(|browser| browser.relay_installed)
            .and_then(|browser| catalog.iter().find(|named| named.id == browser.id).map(|named| Browser::Relay {
                name: browser.name.clone(), url: format!("http://127.0.0.1:{}", named.port),
            })).unwrap_or(Browser::Builtin)
    };
    match pref.as_str() {
        Some("builtin") => Browser::Builtin,
        Some("ego") => if status.ego_installed { Browser::Ego } else { Browser::Builtin },
        Some(raw) if raw.strip_prefix("chromium:").is_some_and(|id| catalog.iter().any(|named| named.id.name() == id)) => {
            let id = raw.strip_prefix("chromium:").unwrap();
            relay(status.browsers.iter().find(|browser| browser.id.name() == id))
        }
        _ if status.ego_installed => Browser::Ego,
        _ => relay(status.browsers.iter().find(|browser| browser.relay_installed)),
    }
}

/// Trusted boot facts and canonical service Arcs. Constructed only by Root's admitted local factory.
/// `tab` is the external authenticated pool tab, not the sidecar's internal lane id.
pub(crate) struct Config {
    pub owner: Owner,
    pub tab: String,
    pub callers: Arc<Callers>,
    pub source: Arc<NativeSidecar>,
    pub machine: Arc<Machine>,
    pub prefs: Arc<Prefs>,
    pub sessions: Arc<SessionIndex>,
    pub memory: Arc<Memory>,
    pub hub: Arc<McpHub>,
    pub ownership: Arc<SessionOwnership>,
    pub browsers: Arc<BrowserState>,
    pub bridge_dir: PathBuf,
    pub builtin_dir: PathBuf,
    pub memory_state_file: PathBuf,
    pub roles_file: PathBuf,
    pub rotation_ledger: PathBuf,
    pub control_environment: machine::Environment,
    pub user_flags: Vec<String>,
    /// Generated terminal/visual definitions and the generated control definitions, never a copied tool catalog.
    pub host_tools: Arc<[Value]>,
    pub control_tools: Arc<[Value]>,
    pub origin: Option<Value>,
    pub kind: policy::LaunchKind,
    pub device: Option<String>,
    /// Localized by the actual native shell, matching mainT("omp.sessionOwned").
    pub session_owned_text: String,
    /// English language name from the actual device locale, not the UI language.
    pub device_reply_language: Option<String>,
}

pub(crate) struct LaunchHost {
    config: Config,
    lease: Mutex<Option<Lease>>,
}

impl LaunchHost {
    pub fn new(config: Config) -> Result<Arc<Self>, Fault> {
        config.callers.admit_tab_effect(&config.owner, &config.tab, || Ok(()))?;
        Ok(Arc::new(Self { config, lease: Mutex::new(None) }))
    }

    fn admit<T>(&self, effect: impl FnOnce() -> Result<T, Fault>) -> Result<T, Fault> {
        self.config.callers.admit_tab_effect(&self.config.owner, &self.config.tab, effect)
    }
}

impl Host for LaunchHost {
    fn lane_id(&self) -> &str {
        self.config.source.tab()
    }
    fn current(&self, ask: Ask) -> bool {
        self.admit(|| Ok(self.config.source.current(ask))).unwrap_or(false)
    }

    fn runtime(&self) -> EffectFuture<'_, Result<Runtime, String>> {
        Box::pin(async move {
            self.admit(|| Ok(())).map_err(|error| error.message)?;
            let runtime = self.config.machine.runtime().await.map_err(|error| error.message)?;
            Ok(Runtime {
                bun_install: machine::bun_install(&runtime.env, &self.config.machine.config().home),
                bin: runtime.bin, version: runtime.version,
            })
        })
    }

    fn shell_environment(&self) -> EffectFuture<'_, Result<machine::Environment, String>> {
        Box::pin(async move {
            self.admit(|| Ok(())).map_err(|error| error.message)?;
            Ok(self.config.machine.shell_environment().await)
        })
    }

    fn proxy_environment(&self) -> EffectFuture<'_, Result<machine::Environment, String>> {
        Box::pin(async move {
            self.admit(|| Ok(())).map_err(|error| error.message)?;
            self.config.machine.proxy_environment().await.map_err(|error| error.message)
        })
    }

    fn builtin(&self) -> EffectFuture<'_, Result<Builtin, String>> {
        Box::pin(async move {
            self.admit(|| Ok(())).map_err(|error| error.message)?;
            let prefs = self.config.prefs.snapshot();
            let computer_use = if prefs["computerUse"] == "builtin" { policy::ComputerUse::Builtin } else { policy::ComputerUse::AgentDesktop };
            let rea_enabled = prefs["builtinMcp"]["rea"] != false;
            let cwd = self.cwd();
            let rea = self.config.machine.spawn_rea(rea_enabled);
            let memory = self.config.memory.extension_args(Some(&cwd));
            let desktop = async {
                if computer_use == policy::ComputerUse::Builtin { return None; }
                let env = self.config.machine.shell_environment().await;
                let config = self.config.machine.config();
                match crate::setup::detect_agent_desktop(config.platform.into(), &config.tools_dir, config.agent_desktop_bundle.as_deref(), &env).await {
                    crate::setup::types::Presence::Present { path, .. } => path.map(PathBuf::from),
                    _ => None,
                }
            };
            let (rea, memory, desktop_executable) = tokio::join!(rea, memory, desktop);
            let launch = policy::assemble(&policy::BuiltinConfig {
                builtin_dir: self.config.builtin_dir.clone(), rea_enabled,
                agent_control: prefs["agentControl"] != false,
                pstack: prefs["pstack"] != false, ecc: prefs["ecc"] != false, computer_use,
            }, &policy::LaunchInput {
                kind: self.config.kind, inherited_env: machine::Environment::new(),
                memory_args: memory.map_err(|error| error.message())?,
                memory_state_file: Some(self.config.memory_state_file.clone()),
                rea_available: rea.available, desktop_executable,
            });
            let mut env = launch.env;
            if launch.needs_hub { env.extend(self.config.hub.omp_env(&cwd)); }
            Ok(Builtin { args: launch.args, root: launch.rea_root.map(|path| path.to_string_lossy().into_owned()), env })
        })
    }

    fn session_free<'a>(&'a self, path: &'a str) -> EffectFuture<'a, Result<SessionFree, String>> {
        Box::pin(async move {
            self.admit(|| Ok(())).map_err(|error| error.message)?;
            Ok(when_session_free(|| self.config.sessions.owned(Path::new(path))).await)
        })
    }

    fn session_owned_text(&self) -> String { self.config.session_owned_text.clone() }

    fn browser(&self) -> EffectFuture<'_, Result<Option<Browser>, String>> {
        Box::pin(async move {
            self.admit(|| Ok(())).map_err(|error| error.message)?;
            self.config.browsers.selected(&self.config.prefs.snapshot()["defaultBrowser"]).await.map(Some).map_err(|error| error.message)
        })
    }

    fn browser_directory(&self) -> EffectFuture<'_, Result<Option<PathBuf>, String>> {
        Box::pin(async move {
            self.admit(|| Ok(())).map_err(|error| error.message)?;
            self.config.machine.ego_browser().await.map(|path| path.and_then(|path| path.parent().map(Path::to_owned))).map_err(|error| error.message)
        })
    }

    fn settings(&self) -> Settings {
        settings(&self.config.prefs.snapshot(), self.config.device_reply_language.as_deref(), &self.config.roles_file, &self.config.rotation_ledger)
    }

    fn cwd(&self) -> String {
        self.config.source.facts()["cwd"].as_str().expect("native source cwd").to_owned()
    }

    fn bridge_directory(&self) -> Option<PathBuf> { Some(self.config.bridge_dir.clone()) }
    fn inherited_environment(&self) -> machine::Environment { self.config.machine.config().inherited_env.clone() }
    fn control_environment(&self) -> machine::Environment { self.config.control_environment.clone() }
    fn user_flags(&self) -> Vec<String> { self.config.user_flags.clone() }

    fn launch_profile(&self, cwd: &str) -> Option<Value> {
        self.config.prefs.snapshot()["launchProfiles"].get(cwd).filter(|profile| profile.is_object()).cloned()
    }

    fn origin(&self) -> Option<Value> { self.config.origin.clone() }

    fn processes(&self, cwd: &str, session_path: Option<&str>) -> Result<ProcessIdentity, String> {
        self.admit(|| {
            let facts = Facts {
                cwd: cwd.to_owned(), session_path: session_path.map(str::to_owned), device: self.config.device.clone(),
            };
            let mut lease = lock(&self.lease);
            if lease.is_some() {
                self.config.ownership.update(&self.config.owner, facts)?;
            } else {
                *lease = Some(self.config.ownership.acquire(&self.config.owner, facts)?);
            }
            let lease = lease.as_ref().expect("acquired native process identity");
            Ok(ProcessIdentity { tag: Some(lease.tag.clone()), scratch: lease.scratch.as_ref().map(|path| path.to_string_lossy().into_owned()) })
        }).map_err(|error| error.message)
    }

    fn host_tools(&self) -> Value {
        let control = self.config.prefs.snapshot()["agentControl"] != false;
        let mut tools = Vec::with_capacity(self.config.host_tools.len() + if control { self.config.control_tools.len() } else { 0 });
        tools.extend(self.config.host_tools.iter().cloned());
        if control { tools.extend(self.config.control_tools.iter().cloned()); }
        Value::Array(tools)
    }

    fn bridge_connected(&self) -> bool { self.config.source.bridge_connected() }

    fn arm_gate(&self) { let _ = self.admit(|| { self.config.source.arm_gate(); Ok(()) }); }

    fn answer(&self, ask: Ask, answer: Answer) {
        let _ = self.admit(|| {
            if self.config.source.current(ask) { self.config.source.answer(ask, answer); }
            Ok(())
        });
    }

    fn bridge<'a>(&'a self, method: &'static str, params: Value) -> EffectFuture<'a, Result<Value, String>> {
        let pending = self.admit(|| Ok(self.config.source.bridge_for_generation(self.config.source.generation(), method.into(), Some(params), None)));
        Box::pin(async move {
            pending.map_err(|error| error.message)?.await.map_err(|error| error.message)
        })
    }
}

// The sole native counterpart of session-free.ts. An unknown ownership result is free, never a new lease rule.
async fn when_session_free<F, Pending>(mut owned: F) -> SessionFree
where
    F: FnMut() -> Pending,
    Pending: Future<Output = Result<bool, Fault>>,
{
    let started = Instant::now();
    loop {
        if !owned().await.unwrap_or(false) { return SessionFree::Free; }
        let elapsed = started.elapsed();
        if elapsed >= Duration::from_secs(60) { return SessionFree::Owned; }
        tokio::time::sleep(if elapsed < Duration::from_secs(5) { Duration::from_millis(250) } else { Duration::from_secs(2) }).await;
    }
}

// These app-only preference parsers run before omp exists. Counterparts: shared/reply-language.ts,
// modes/user-profile-contracts.ts, modes/{next-prompt,auto-title,delegation}-contracts.ts and shared/account-rotation.ts.
fn settings(prefs: &Value, device_language: Option<&str>, roles: &Path, ledger: &Path) -> Settings {
    let reply_language = match prefs["replyLanguage"].as_str() {
        Some("off") => None,
        Some(language @ ("Korean" | "English" | "Japanese" | "Chinese (Simplified)" | "Chinese (Traditional)" | "Spanish" | "French" | "German" | "Portuguese" | "Vietnamese")) => Some(language.to_owned()),
        _ => device_language.map(str::to_owned),
    };
    let profile = &prefs["userProfile"];
    let name = profile["name"].as_str().filter(|name| crate::fs::order::js_trim(name).encode_utf16().count() <= 64 && !name.chars().any(char::is_control)).map(crate::fs::order::js_trim).unwrap_or("");
    let experience = profile["experience"].as_str().filter(|value| matches!(*value, "beginner" | "vibe-coder" | "junior" | "expert"));
    let delegation = prefs["delegationMode"].as_str().filter(|value| matches!(*value, "default" | "solo" | "assisted" | "collaborative" | "swarm")).unwrap_or("default");
    Settings {
        reply_language, user_profile: Some(json!({"name":name,"experience":experience})),
        next_prompt: Some(json!({"suggestions":prefs["nextPromptSuggestions"].as_bool().unwrap_or(true),"inline":prefs["nextPromptInline"].as_bool().unwrap_or(true)})),
        auto_title: Some(json!({"enabled":prefs["autoTitle"].as_bool().unwrap_or(true),"evolve":prefs["autoTitleEvolve"].as_bool().unwrap_or(true),"suppressed":false})),
        judge_assist: Some(prefs["judgeAssist"] != false), delegation: Some(delegation.to_owned()),
        account_rotation: Some(if prefs["accountRotation"] == "even" { "even" } else { "quota" }.into()),
        account_rotation_ledger: Some(ledger.to_string_lossy().into_owned()), credit_spend: Some(prefs["creditSpend"] == true),
        roles_file: Some(roles.to_string_lossy().into_owned()), browser: None,
    }
}

#[cfg(test)]
#[path = "launch_host_tests.rs"]
mod tests;
