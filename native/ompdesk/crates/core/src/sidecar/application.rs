//! Native launch assembly and live settings of a tab's omp. Inputs are host-owned snapshots, never page JSON.
//! The lane still owns start/restart/exit ordering; this module owns the environment formerly built in sidecar.ts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

pub type Environment = BTreeMap<String, String>;

const SESSION_ENV: &[&str] = &[
    "OMP_GUI_BRIDGE",
    "OMP_GUI_REPLY_LANGUAGE",
    "OMP_GUI_BROWSER",
    "OMP_GUI_COMPUTER_USE",
    "OMP_GUI_AGENT_DESKTOP",
    "OMP_GUI_USER_PROFILE",
    "OMP_GUI_NEXT_PROMPT",
    "OMP_GUI_AUTO_TITLE",
    "OMP_GUI_JUDGE_ASSIST",
    "OMP_GUI_PROMPT_ORIGIN",
    "OMP_GUI_DELEGATION",
    "OMP_GUI_ACCOUNT_ROTATION",
    "OMP_GUI_ACCOUNT_ROTATION_STATE",
    "OMP_GUI_CREDIT_SPEND",
    "OMP_GUI_OMPDESK_ROLES",
    "OMP_GUI_REA_ROOT",
    "OMP_GUI_MCP_HUB",
    "OMP_GUI_MCP_AUTH",
    "OMP_GUI_MCP_CWD",
    "OMP_GUI_PSTACK",
    "OMP_GUI_ECC",
    "OMP_GUI_MEMORY",
    "OMP_GUI_SESSION_TAG",
    "OMP_GUI_SCRATCH",
];
const CONTROL_ENV: &[&str] = &[
    "OMPDESK_SOCKET",
    "OMPDESK_CONTROL_DIR",
    "OMPDESK_CONTROL_OFF",
];

#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub reply_language: Option<String>,
    pub user_profile: Option<Value>,
    pub next_prompt: Option<Value>,
    pub auto_title: Option<Value>,
    pub judge_assist: Option<bool>,
    pub delegation: Option<String>,
    pub account_rotation: Option<String>,
    pub account_rotation_ledger: Option<String>,
    pub credit_spend: Option<bool>,
    pub roles_file: Option<String>,
    pub browser: Option<Browser>,
}

#[derive(Clone, Debug)]
pub enum Browser {
    Ego,
    Builtin,
    Relay { name: String, url: String },
}

impl Browser {
    fn environment(&self) -> String {
        match self {
            Self::Ego => "ego".into(),
            Self::Builtin => "builtin".into(),
            Self::Relay { name, url } => format!("relay:{name}@{url}"),
        }
    }

    fn value(&self) -> Value {
        match self {
            Self::Ego => json!({"kind": "ego"}),
            Self::Builtin => json!({"kind": "builtin"}),
            Self::Relay { name, url } => json!({"kind": "relay", "name": name, "url": url}),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Builtin {
    pub args: Vec<String>,
    pub root: Option<String>,
    pub env: Environment,
}

pub use super::launch::Open;

/// A host capability assembled after the authenticated owner is resolved. Deliberately not Deserialize.
pub struct Launch<'a> {
    pub bin: &'a Path,
    pub cwd: &'a str,
    pub open: &'a Open,
    pub bridge: Option<(&'a Path, &'a str)>,
    pub model: Option<&'a str>,
    pub builtin: &'a Builtin,
    pub user_flags: &'a [String],
    pub profile: Option<&'a Value>,
    pub settings: &'a Settings,
    pub inherited: &'a Environment,
    pub shell: &'a Environment,
    pub proxy: &'a Environment,
    pub control: &'a Environment,
    pub bun_install: &'a Path,
    pub browser_dir: Option<&'a Path>,
    pub origin: Option<&'a Value>,
    pub process_tag: Option<&'a str>,
    pub scratch: Option<&'a str>,
}

/// Unquoted argv. The platform spawn adapter retains sole ownership of Windows cmd.exe quoting.
#[derive(Debug, Serialize)]
pub struct Command {
    pub bin: PathBuf,
    pub args: Vec<String>,
    pub env: Environment,
    pub cwd: String,
}

impl Launch<'_> {
    pub fn command(&self) -> Command {
        let mut args = vec!["--mode".into(), "rpc-ui".into()];
        match self.open {
            Open::Session(path) => args.extend(["--session".into(), path.clone()]),
            Open::New => {
                if let Some((dir, _)) = self.bridge {
                    args.extend([
                        "--config".into(),
                        dir.join("fresh-launch.yml").to_string_lossy().into_owned(),
                    ]);
                }
            }
            Open::Default => {}
        }
        if let Some(model) = self.model {
            args.extend(["--model".into(), model.into()]);
        }
        if let Some((dir, _)) = self.bridge {
            args.extend([
                "-e".into(),
                dir.join("index.ts").to_string_lossy().into_owned(),
            ]);
        }
        args.extend(self.builtin.args.iter().cloned());
        let mut user = self.user_flags.to_vec();
        if let Some(profile) = self.profile {
            profile_flags(profile, &mut user);
        }
        args.extend(strip_flags(user));

        let mut env = self.inherited.clone();
        env.extend(
            self.shell
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        for key in SESSION_ENV.iter().chain(CONTROL_ENV) {
            env.remove(*key);
        }
        #[cfg(windows)]
        env.entry("BUN_RUNTIME_TRANSPILER_CACHE_PATH".into())
            .or_insert_with(|| "0".into());
        env.extend(
            self.proxy
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        let base = self
            .shell
            .get("PATH")
            .or_else(|| self.inherited.get("PATH"))
            .map(String::as_str)
            .unwrap_or("");
        let delimiter = if cfg!(windows) { ";" } else { ":" };
        let mut paths: Vec<&str> = base
            .split(delimiter)
            .filter(|path| !path.is_empty())
            .collect();
        let bin_dir = self.bin.parent().map(Path::to_string_lossy);
        let bun_bin = self.bun_install.join("bin");
        let bun_dir = bun_bin.to_string_lossy();
        let browser_dir = self.browser_dir.map(Path::to_string_lossy);
        for dir in [
            bin_dir.as_deref(),
            Some(bun_dir.as_ref()),
            browser_dir.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if !paths.contains(&dir) {
                paths.push(dir);
            }
        }
        let path = paths.join(delimiter);
        env.insert("PATH".into(), path);
        env.extend(self.settings.environment(self.title_suppressed()));
        if let Some((_, address)) = self.bridge {
            env.insert("OMP_GUI_BRIDGE".into(), address.into());
        }
        if let Some(origin) = self.origin {
            env.insert("OMP_GUI_PROMPT_ORIGIN".into(), origin.to_string());
        }
        insert_text(&mut env, "OMP_GUI_REA_ROOT", self.builtin.root.as_deref());
        insert_text(&mut env, "OMP_GUI_SESSION_TAG", self.process_tag);
        insert_text(&mut env, "OMP_GUI_SCRATCH", self.scratch);
        env.extend(
            self.builtin
                .env
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        env.extend(
            self.control
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        env.insert("PI_RPC_EMIT_TITLE".into(), "1".into());
        env.insert("PI_NO_PTY".into(), "1".into());
        env.insert("PI_NOTIFICATIONS".into(), "off".into());
        env.insert("OTEL_SDK_DISABLED".into(), "true".into());
        Command {
            bin: self.bin.into(),
            args,
            env,
            cwd: self.cwd.into(),
        }
    }

    pub fn title_suppressed(&self) -> bool {
        self.shell
            .get("PI_NO_TITLE")
            .or_else(|| self.inherited.get("PI_NO_TITLE"))
            .is_some_and(|value| !value.is_empty() && value != "0")
    }
}

fn insert_text(env: &mut Environment, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        env.insert(key.into(), value.into());
    }
}

impl Settings {
    pub fn environment(&self, suppressed: bool) -> Environment {
        let mut env = Environment::new();
        insert_text(
            &mut env,
            "OMP_GUI_REPLY_LANGUAGE",
            self.reply_language.as_deref(),
        );
        if let Some(profile) = &self.user_profile
            && (crate::remote::events::js::truthy(profile.get("name"))
                || crate::remote::events::js::truthy(profile.get("experience")))
        {
            env.insert("OMP_GUI_USER_PROFILE".into(), profile.to_string());
        }
        for (key, value) in [
            ("OMP_GUI_NEXT_PROMPT", self.next_prompt.as_ref()),
            ("OMP_GUI_AUTO_TITLE", self.title(suppressed).as_ref()),
        ] {
            if let Some(value) = value {
                env.insert(key.into(), value.to_string());
            }
        }
        for (key, value) in [
            ("OMP_GUI_JUDGE_ASSIST", self.judge_assist),
            ("OMP_GUI_CREDIT_SPEND", self.credit_spend),
        ] {
            if let Some(value) = value {
                env.insert(key.into(), if value { "1" } else { "0" }.into());
            }
        }
        insert_text(
            &mut env,
            "OMP_GUI_DELEGATION",
            self.delegation.as_deref().filter(|mode| *mode != "default"),
        );
        insert_text(
            &mut env,
            "OMP_GUI_ACCOUNT_ROTATION",
            self.account_rotation.as_deref(),
        );
        insert_text(
            &mut env,
            "OMP_GUI_ACCOUNT_ROTATION_STATE",
            self.account_rotation_ledger.as_deref(),
        );
        insert_text(
            &mut env,
            "OMP_GUI_OMPDESK_ROLES",
            self.roles_file.as_deref(),
        );
        if let Some(browser) = &self.browser {
            env.insert("OMP_GUI_BROWSER".into(), browser.environment());
        }
        env
    }

    fn title(&self, suppressed: bool) -> Option<Value> {
        self.auto_title.as_ref().map(|title| {
            let mut title = title.clone();
            if let Some(object) = title.as_object_mut() {
                object.insert("suppressed".into(), Value::Bool(suppressed));
            }
            title
        })
    }

    /// Ordered bridge calls for the same settings used by the next spawn. Absent optional settings stay absent.
    pub fn updates(&self, suppressed: bool) -> Vec<(&'static str, Value)> {
        let mut updates = vec![(
            "reply_language_set",
            json!({"language": self.reply_language}),
        )];
        if let Some(browser) = &self.browser {
            updates.push(("default_browser_set", json!({"browser": browser.value()})));
        }
        if let Some(profile) = &self.user_profile {
            updates.push(("user_profile_set", profile.clone()));
        }
        if let Some(next) = &self.next_prompt {
            updates.push((
                "next_prompt_set",
                json!({"suggestions": next["suggestions"], "inline": next["inline"]}),
            ));
        }
        if let Some(title) = self.title(suppressed) {
            updates.push(("auto_title_set", title));
        }
        if let Some(enabled) = self.judge_assist {
            updates.push(("judge_assist_set", json!({"enabled": enabled})));
        }
        if let Some(mode) = &self.account_rotation {
            updates.push(("account_rotation_set", json!({"mode": mode})));
        }
        if let Some(enabled) = self.credit_spend {
            updates.push(("credit_spend_set", json!({"enabled": enabled})));
        }
        updates
    }
}

fn strip_flags(flags: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(flags.len());
    let mut flags = flags.into_iter();
    while let Some(token) = flags.next() {
        let (name, inline) = token
            .split_once('=')
            .map_or((token.as_str(), false), |(name, _)| (name, true));
        let valued = matches!(
            name,
            "--session" | "--mode" | "--export" | "--cwd" | "--resume" | "--fork" | "--api-key"
        );
        if valued
            || matches!(
                name,
                "--print"
                    | "--print-thoughts"
                    | "--help"
                    | "--version"
                    | "--no-pty"
                    | "--no-title"
                    | "--no-tools"
            )
        {
            if !inline
                && valued
                && flags
                    .as_slice()
                    .first()
                    .is_some_and(|value| !value.starts_with('-'))
            {
                let _ = flags.next();
            }
        } else {
            let valued = !inline
                && matches!(
                    name,
                    "--system-prompt"
                        | "--append-system-prompt"
                        | "--add-dir"
                        | "--tools"
                        | "--profile"
                        | "--session-dir"
                        | "--config"
                );
            out.push(token);
            if valued && let Some(value) = flags.next() {
                out.push(value);
            }
        }
    }
    out
}

fn profile_flags(profile: &Value, out: &mut Vec<String>) {
    for (key, flag) in [
        ("systemPrompt", "--system-prompt"),
        ("appendSystemPrompt", "--append-system-prompt"),
    ] {
        if let Some(value) = profile[key]
            .as_str()
            .filter(|value| !crate::control::js::trim(value).is_empty())
        {
            out.extend([flag.into(), value.into()]);
        }
    }
    if profile["noRules"] == true {
        out.push("--no-rules".into());
    }
    if let Some(dirs) = profile["addDirs"].as_array() {
        for dir in dirs
            .iter()
            .filter_map(Value::as_str)
            .map(crate::control::js::trim)
            .filter(|dir| !dir.is_empty())
        {
            out.extend(["--add-dir".into(), dir.into()]);
        }
    }
    if let Some(tools) = profile["tools"].as_array() {
        let tools = tools
            .iter()
            .filter_map(Value::as_str)
            .map(crate::control::js::trim)
            .filter(|tool| !tool.is_empty())
            .collect::<Vec<_>>();
        if !tools.is_empty() {
            out.extend(["--tools".into(), tools.join(",")]);
        }
    }
    for (key, flag) in [("noLsp", "--no-lsp"), ("planYolo", "--plan-yolo")] {
        if profile[key] == true {
            out.push(flag.into());
        }
    }
    for (key, flag) in [
        ("profile", "--profile"),
        ("sessionDir", "--session-dir"),
        ("config", "--config"),
    ] {
        if let Some(value) = profile[key]
            .as_str()
            .map(crate::control::js::trim)
            .filter(|value| !value.is_empty())
        {
            out.extend([flag.into(), value.into()]);
        }
    }
}

pub type EffectFuture<'a, T> = std::pin::Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type StartGate =
    Box<dyn FnOnce() -> EffectFuture<'static, Result<Option<String>, String>> + Send>;

/// The existing lane's ask identity. A host checks this against that lane before applying an async answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ask {
    pub ask: u64,
    pub cmd: u64,
}

#[derive(Clone, Debug)]
pub struct Runtime {
    pub bin: PathBuf,
    pub version: String,
    pub bun_install: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionFree {
    Free,
    Owned,
}

#[derive(Debug)]
pub enum Answer {
    Resolved {
        outcome: &'static str,
        message: Option<String>,
    },
    Launched {
        command: Command,
        host_tools: Value,
    },
    LaunchFailed(String),
    Gated(Option<String>),
    SessionFreed(SessionFree),
}

#[derive(Default)]
pub struct ProcessIdentity {
    pub tag: Option<String>,
    pub scratch: Option<String>,
}

/// Per-tab native services. Base supplies implementations backed by the actual machine/prefs/pool services.
/// No method accepts a deserialized caller or synthesizes authority from an event payload.
pub trait Host: Send + Sync {
    fn current(&self, ask: Ask) -> bool;
    fn runtime(&self) -> EffectFuture<'_, Result<Runtime, String>>;
    fn shell_environment(&self) -> EffectFuture<'_, Result<Environment, String>>;
    fn proxy_environment(&self) -> EffectFuture<'_, Result<Environment, String>>;
    fn builtin(&self) -> EffectFuture<'_, Result<Builtin, String>>;
    fn session_free<'a>(&'a self, path: &'a str) -> EffectFuture<'a, Result<SessionFree, String>>;
    fn session_owned_text(&self) -> String;
    fn browser(&self) -> EffectFuture<'_, Result<Option<Browser>, String>>;
    fn browser_directory(&self) -> EffectFuture<'_, Result<Option<PathBuf>, String>>;
    fn settings(&self) -> Settings;
    fn cwd(&self) -> String;
    fn bridge_directory(&self) -> Option<PathBuf>;
    fn inherited_environment(&self) -> Environment;
    fn control_environment(&self) -> Environment;
    fn user_flags(&self) -> Vec<String>;
    fn launch_profile(&self, cwd: &str) -> Option<Value>;
    fn origin(&self) -> Option<Value>;
    fn processes(&self, cwd: &str) -> Result<ProcessIdentity, String>;
    fn host_tools(&self) -> Value;
    fn bridge_connected(&self) -> bool;
    fn arm_gate(&self);
    fn answer(&self, ask: Ask, answer: Answer);
    fn bridge<'a>(
        &'a self,
        method: &'static str,
        params: Value,
    ) -> EffectFuture<'a, Result<Value, String>>;
}

struct Resolved {
    runtime: Runtime,
    shell: Environment,
    proxy: Environment,
    builtin: Builtin,
    browser: Option<Browser>,
    browser_dir: Option<PathBuf>,
}

#[derive(Default)]
struct Snapshot {
    resolved: Option<std::sync::Arc<Resolved>>,
    title_suppressed: bool,
}

/// Only host application effects and resolved launch facts. The existing Lane owns all lifecycle transitions.
pub struct Application<H: Host> {
    host: std::sync::Arc<H>,
    snapshot: std::sync::Mutex<Snapshot>,
    gate: std::sync::Mutex<Option<StartGate>>,
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl<H: Host> Application<H> {
    pub fn new(host: std::sync::Arc<H>) -> Self {
        Self {
            host,
            snapshot: Default::default(),
            gate: Default::default(),
        }
    }

    pub async fn resolve(&self, ask: Ask, session_path: Option<&str>) {
        let session = async {
            match session_path {
                Some(path) => self
                    .host
                    .session_free(path)
                    .await
                    .unwrap_or(SessionFree::Free),
                None => SessionFree::Free,
            }
        };
        let (runtime, proxy, shell, builtin, session, browser, browser_dir) = tokio::join!(
            self.host.runtime(),
            self.host.proxy_environment(),
            self.host.shell_environment(),
            self.host.builtin(),
            session,
            self.host.browser(),
            self.host.browser_directory()
        );
        if !self.host.current(ask) {
            return;
        }
        if session == SessionFree::Owned {
            self.host.answer(
                ask,
                Answer::Resolved {
                    outcome: "owned",
                    message: Some(self.host.session_owned_text()),
                },
            );
            return;
        }
        let runtime = match runtime {
            Ok(runtime) => runtime,
            Err(message) => {
                self.host.answer(
                    ask,
                    Answer::Resolved {
                        outcome: "waiting",
                        message: Some(message),
                    },
                );
                return;
            }
        };
        lock(&self.snapshot).resolved = Some(std::sync::Arc::new(Resolved {
            runtime,
            shell: shell.unwrap_or_default(),
            proxy: proxy.unwrap_or_default(),
            builtin: builtin.unwrap_or_default(),
            browser: browser.unwrap_or_default(),
            browser_dir: browser_dir.unwrap_or_default(),
        }));
        self.host.answer(
            ask,
            Answer::Resolved {
                outcome: "ok",
                message: None,
            },
        );
    }

    pub fn launch(&self, ask: Ask, open: &Open, address: Option<&str>, model: Option<&str>) {
        if !self.host.current(ask) {
            return;
        }
        let Some(resolved) = lock(&self.snapshot).resolved.clone() else {
            self.host
                .answer(ask, Answer::LaunchFailed("omp is not resolved".into()));
            return;
        };
        let cwd = self.host.cwd();
        let process = match self.host.processes(&cwd) {
            Ok(process) => process,
            Err(error) => {
                self.host.answer(ask, Answer::LaunchFailed(error));
                return;
            }
        };
        let mut settings = self.host.settings();
        settings.browser = resolved.browser.clone();
        let inherited = self.host.inherited_environment();
        let control = self.host.control_environment();
        let flags = self.host.user_flags();
        let profile = self.host.launch_profile(&cwd);
        let origin = self.host.origin();
        let bridge_dir = self.host.bridge_directory();
        let launch = Launch {
            bin: &resolved.runtime.bin,
            cwd: &cwd,
            open,
            bridge: bridge_dir.as_deref().zip(address),
            model,
            builtin: &resolved.builtin,
            user_flags: &flags,
            profile: profile.as_ref(),
            settings: &settings,
            inherited: &inherited,
            shell: &resolved.shell,
            proxy: &resolved.proxy,
            control: &control,
            bun_install: &resolved.runtime.bun_install,
            browser_dir: resolved.browser_dir.as_deref(),
            origin: origin.as_ref(),
            process_tag: process.tag.as_deref(),
            scratch: process.scratch.as_deref(),
        };
        let suppressed = launch.title_suppressed();
        let command = launch.command();
        lock(&self.snapshot).title_suppressed = suppressed;
        self.host.answer(
            ask,
            Answer::Launched {
                command,
                host_tools: self.host.host_tools(),
            },
        );
    }

    pub fn set_start_gate(&self, gate: StartGate) {
        *lock(&self.gate) = Some(gate);
        self.host.arm_gate();
    }

    pub async fn gate(&self, ask: Ask) {
        if !self.host.current(ask) {
            return;
        }
        let gate = lock(&self.gate).take();
        let cwd = match gate {
            Some(gate) if self.host.bridge_connected() => gate().await.unwrap_or_default(),
            Some(_) | None => None,
        };
        if self.host.current(ask) {
            self.host.answer(ask, Answer::Gated(cwd));
        }
    }

    pub async fn session_wait(&self, ask: Ask, path: &str) {
        if !self.host.current(ask) {
            return;
        }
        let free = self
            .host
            .session_free(path)
            .await
            .unwrap_or(SessionFree::Free);
        if self.host.current(ask) {
            self.host.answer(ask, Answer::SessionFreed(free));
        }
    }

    pub async fn sync_settings(&self) {
        let suppressed = lock(&self.snapshot).title_suppressed;
        let mut settings = self.host.settings();
        settings.browser = None;
        let updates = settings.updates(suppressed);
        let calls = updates
            .into_iter()
            .map(|(method, params)| self.host.bridge(method, params));
        let browser = async {
            if let Ok(Some(browser)) = self.host.browser().await {
                let _ = self
                    .host
                    .bridge("default_browser_set", json!({"browser": browser.value()}))
                    .await;
            }
        };
        tokio::join!(futures_util::future::join_all(calls), browser);
    }
}

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;
