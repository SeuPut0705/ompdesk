//! The service's passes. What runs, always with the binary `binary.rs` staged, in a neutral working folder (the
//! person's home: ai-memory's own commands read the working folder as "this project"):
//!
//! - on: `setup --plan --json` names the data folder; a fresh one gets ai-memory's own `init` and the one config
//!   change (`text::without_local_embeddings`); `setup --yes --agent omp` installs the data folder, token and user
//!   service. `setup` cannot install the service without wiring an agent, so omp's agent dir is pointed at a scratch
//!   folder (`PI_CODING_AGENT_DIR`), deleted again with the shared skills it newly created: nothing is written to
//!   `~/.omp/agent`. Then the generators fill the extension root (`root.rs`).
//! - service: a unit running someone else's binary is replaced by OMPdesk's own (`take_over`); a server no unit
//!   explains (Docker, a foreground `serve`) fails the pass with a message. `uninstall --apply` is never run: it
//!   removes every agent's wiring.
//! - terminal: "Also use in the terminal omp" runs ai-memory's own `setup --agent omp` into the real agent dir; the
//!   reverse removes just that extension and MCP entry (`terminal.rs`).
//! - purge: the server is stopped (when it is OMPdesk's), the wiki/db/raw folders are deleted, then on again.
//! - a poll every `poll_ms` heals by running the pass again when the server stays down or the root went.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::binary::{self, BuiltAsset};
use super::root::{self, Ran};
use super::terminal::{self, Wiring as TerminalWiring};
use super::text;
use super::unit::ServiceUnit;
use super::{Boxed, Failure, Op, Resolved, Service, Stats, Wiring};
use crate::aimemory::client::{Client, Server};
use crate::aimemory::{DEFAULT_SERVER_URL, server_url_from_config};
use crate::disk::tree::fault as node_fault;
use crate::server::Fault;

const HEALTH_STEP_MS: u64 = 500;
/// Re-run `setup` after this many polls in a row that found the server down, at most once in `REWIRE_COOLDOWN_MS`.
const REWIRE_AFTER_POLLS: u32 = 2;
const REWIRE_COOLDOWN_MS: i64 = 10 * 60_000;
/// The folders `ai-memory reset` wipes; everything else in the data folder (config, token, models) stays.
const DATA_FOLDERS: [&str; 3] = ["wiki", "db", "raw"];
const STATS_MAX_AGE_MS: i64 = 5_000;
/// The last lines of a failed command's output Settings shows.
const TAIL_LINES: usize = 4;
/// omp's agent dir configs, in the order stock reads the first that exists, then the folder's own, lowest to
/// highest precedence (stock's `#configWatchTargets` order).
const AGENT_CONFIGS: [&str; 2] = ["config.yml", "config.yaml"];
const PROJECT_CONFIGS: [&str; 3] = [
    ".omp/config.yml",
    ".omp/settings.json",
    ".claude/settings.json",
];
/// omp's id for the agent dir's `extensions/ai-memory-omp.ts` and for its `ai-memory` MCP server; OMPdesk's own
/// server is `ompdesk-memory`.
const TERMINAL_EXTENSION_ID: &str = "extension-module:ai-memory-omp";
const TERMINAL_MCP_ID: &str = "mcp:ai-memory";

fn io_failure(error: &std::io::Error, syscall: &str, path: &Path) -> Failure {
    Failure::Error {
        message: node_fault(error, syscall, path).message,
        stack: None,
    }
}

/// `setup`'s scratch agent dir and the shared skills before it ran: put back however the run ends, also when the
/// step is stopped while it runs.
struct SetupScratch {
    scratch: PathBuf,
    home: PathBuf,
    before: std::collections::BTreeSet<String>,
}

impl Drop for SetupScratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.scratch);
        terminal::remove_new_shared_skills(&self.home, &self.before);
    }
}

impl Service {
    fn client(&self) -> std::sync::Arc<Client> {
        let state = self.state();
        Client::new(Server {
            url: Some(
                state
                    .server_url
                    .unwrap_or_else(|| DEFAULT_SERVER_URL.to_owned()),
            ),
            data_dir: state.data_dir,
        })
    }

    async fn healthy(&self) -> bool {
        self.client().healthy().await
    }

    fn step_to(&self, step: &'static str) {
        self.patch(|state| {
            state.phase = "starting";
            state.step = Some(step);
        });
    }

    fn fail(&self, failure: &Failure) {
        let detail = failure.message();
        let stack = match failure {
            Failure::Error { stack, .. } => stack.clone(),
            _ => None,
        };
        self.log(
            "failed",
            json!({ "step": self.state().step, "detail": detail, "stack": stack }),
        );
        self.patch(|state| {
            state.phase = "failed";
            state.step = None;
            state.detail = Some(detail.clone());
        });
        self.stop_polling();
    }

    async fn agent_dir(&self) -> Result<PathBuf, Failure> {
        if let Some(native) = &self.native {
            return Ok(native.host.agent_dir());
        }
        match self.ask("agentDir", false, Value::Null).await? {
            Value::String(dir) => Ok(PathBuf::from(dir)),
            _ => Err(Failure::step("omp's agent dir is not known")),
        }
    }

    /// `AI_MEMORY_TERMINAL_PREF`: none until the person (or the one-time migration) decided.
    async fn terminal_pref(&self) -> Result<Option<bool>, Failure> {
        if let Some(native) = &self.native {
            return Ok(native.host.terminal_pref());
        }
        Ok(self
            .ask("terminalPref", false, Value::Null)
            .await?
            .as_bool())
    }

    async fn persist_terminal(&self, enabled: bool) -> Result<(), Failure> {
        if let Some(native) = &self.native {
            return native.host.persist_terminal(enabled);
        }
        self.ask("persistTerminal", false, json!({ "enabled": enabled }))
            .await
            .map(|_| ())
    }

    async fn spawn_env(&self) -> Result<Map<String, Value>, Failure> {
        if let Some(native) = &self.native {
            return Ok(native
                .host
                .spawn_env()
                .await?
                .into_iter()
                .map(|(key, value)| (key, Value::String(value)))
                .collect());
        }
        Ok(match self.ask("spawnEnv", false, Value::Null).await? {
            Value::Object(env) => env,
            _ => Map::new(),
        })
    }

    /// What is on disk now: OMPdesk's own root, and the terminal omp's wiring when the person connected it.
    async fn wiring(&self) -> Result<Wiring, Failure> {
        let agent_dir = self.agent_dir().await?;
        let app = root::root_complete(Path::new(&self.deps.root_dir));
        let terminal = terminal::read_wiring(&agent_dir);
        let pref = self.terminal_pref().await?;
        Ok(Wiring {
            app,
            terminal: pref == Some(true) && (terminal.extension || terminal.mcp),
        })
    }

    /// Detect, then (when on) stage and wire. Ends when the first pass ended; a failure is the `failed` phase.
    pub async fn start(&self) {
        let deps = &self.deps;
        self.log(
            "launch",
            json!({ "automatic": deps.automatic, "platform": deps.platform, "arch": deps.arch, "bundledDir": deps.bundled_dir, "override": deps.binary_override }),
        );
        let started = async {
            let wiring = self.wiring().await?;
            self.patch(|state| state.wiring = wiring);
            if !self.platform_ok() {
                self.patch(|state| {
                    state.phase = "unsupported";
                    state.unsupported = Some("platform");
                    state.detail = Some("ai-memory has no build for this platform.".to_owned());
                });
                return Ok(());
            }
            if !deps.automatic {
                self.patch(|state| {
                    state.phase = "unsupported";
                    state.unsupported = Some("paused");
                    state.detail = Some("This launch does not set ai-memory up (safe mode, or an unpackaged build: set OMP_GUI_AI_MEMORY_BIN).".to_owned());
                });
                return Ok(());
            }
            self.step_to("stage");
            if let Some(native) = &self.native {
                let mut closed = self.closed.subscribe();
                tokio::select! {
                    answer = native.host.before_start() => answer?,
                    _ = closed.wait_for(|closed| *closed) => return Err(Failure::Cancelled),
                };
                if self.inner().disposed {
                    return Err(Failure::Cancelled);
                }
            } else if deps.before_start {
                self.ask("beforeStart", false, Value::Null).await?;
            }
            match self.run_step(Op::Enable).await {
                // A pass stopped past its bound fails the start, as the step's error did.
                Err(fault) if fault.code == "step_stalled" => Err(Failure::Error {
                    message: fault.message,
                    stack: None,
                }),
                _ => Ok::<(), Failure>(()),
            }
        };
        if let Err(failure) = started.await {
            self.fail(&failure);
        }
    }

    /// One queued step, in the queue's turn.
    pub(super) async fn step(self: &Arc<Self>, op: Op) -> Result<(), Fault> {
        match op {
            Op::Enable => {
                self.enable().await;
                Ok(())
            }
            Op::Purge => {
                let purged = self.purge_data().await;
                self.enable().await;
                purged.map_err(|failure| failure.fault())
            }
            Op::Terminal(enabled) => self
                .set_terminal(enabled)
                .await
                .map_err(|failure| failure.fault()),
        }
    }

    /// The setup state reports Bun present: a pass that stopped for want of Bun runs again, once.
    pub fn bun_installed(&self) {
        {
            let mut inner = self.inner();
            if !inner.awaiting_bun {
                return;
            }
            inner.awaiting_bun = false;
            if let Some(retry) = inner.retry.take() {
                retry.abort();
            }
        }
        if !self.managed() {
            return;
        }
        self.patch(|state| {
            state.phase = "starting";
            state.step = Some("stage");
            state.detail = None;
        });
        self.enqueue(Op::Enable, None);
    }

    /// "Also use in the terminal omp": ai-memory's own `setup --agent omp` into omp's real agent dir, or (off) the
    /// removal of exactly that extension and MCP entry. Memory itself (phase, server) is not changed.
    async fn set_terminal(&self, enabled: bool) -> Result<(), Failure> {
        let (phase, detail) = {
            let state = self.state();
            (state.phase, state.detail)
        };
        self.patch(|state| {
            state.phase = "starting";
            state.step = Some("terminal");
            state.detail = None;
        });
        let changed = async {
            if enabled {
                let known = self.inner().resolved.clone();
                let resolved = match known {
                    Some(resolved) => resolved,
                    None => self.resolve().await?,
                };
                self.inner().resolved = Some(resolved.clone());
                self.setup(&resolved.bin, true).await?;
                self.persist_terminal(true).await?;
            } else {
                let agent_dir = self.agent_dir().await?;
                terminal::remove_wiring(&agent_dir)
                    .map_err(|error| io_failure(&error, "open", &agent_dir))?;
                self.persist_terminal(false).await?;
            }
            Ok::<(), Failure>(())
        }
        .await;
        let wiring = self.wiring().await;
        self.patch(|state| {
            state.phase = phase;
            state.step = None;
            state.detail = detail;
            if let Ok(wiring) = &wiring {
                state.wiring = wiring.clone();
            }
        });
        changed?;
        wiring.map(|_| ())
    }

    /// Stats and health, at most every few seconds; Settings calls it when it opens.
    pub async fn refresh(self: &Arc<Self>) -> Result<(), Failure> {
        let now = self.now();
        let phase = {
            let mut inner = self.inner();
            if inner.disposed
                || inner.state.phase == "starting"
                || now - inner.stats_at < STATS_MAX_AGE_MS
            {
                return Ok(());
            }
            inner.stats_at = now;
            inner.state.phase
        };
        if phase == "ready" || phase == "unreachable" {
            self.check(false).await
        } else {
            let wiring = self.wiring().await?;
            self.patch(|state| state.wiring = wiring);
            Ok(())
        }
    }

    /// What the omp sessions OMPdesk spawns (in `cwd`) load for memory: `-e <root>` while memory is on and the root
    /// is complete, so a session captures exactly once and has one memory MCP server, both OMPdesk's own build,
    /// whatever omp's agent dir holds. omp loads the agent dir's ai-memory extension and `ai-memory` MCP entry into
    /// every process it starts, so:
    /// - the terminal omp the person connected (pref true) already loads ours from there (`setup` refreshes it at
    ///   every launch): no `-e`, the root is left out;
    /// - wiring there the person made with their own ai-memory is not ours and not adopted: the root loads and a
    ///   `--config` overlay holds that extension and that MCP entry disabled for this spawn; the agent dir is
    ///   untouched. The root's own MCP server is named `ompdesk-memory`, so the entry's name cannot take it over.
    pub async fn extension_args(&self, cwd: Option<&str>) -> Result<Vec<String>, Failure> {
        let root_dir = &self.deps.root_dir;
        if !self.managed() || !root::root_complete(Path::new(root_dir)) {
            return Ok(Vec::new());
        }
        let agent_dir = self.agent_dir().await?;
        let wiring = terminal::read_wiring(&agent_dir);
        if self.terminal_pref().await? == Some(true) && wiring.extension {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = [
            (wiring.extension, TERMINAL_EXTENSION_ID),
            (wiring.mcp, TERMINAL_MCP_ID),
        ]
        .into_iter()
        .filter(|(wired, _)| *wired)
        .map(|(_, id)| id.to_owned())
        .collect();
        if ids.is_empty() {
            return Ok(vec!["-e".to_owned(), root_dir.clone()]);
        }
        match self.overlay(&agent_dir, cwd, &ids).await {
            Ok(overlay) => Ok(vec![
                "-e".to_owned(),
                root_dir.clone(),
                "--config".to_owned(),
                overlay,
            ]),
            Err(failure) => {
                // Without the overlay both copies would run; the agent dir's alone is one capture and one server.
                self.log(
                    "failed",
                    json!({ "step": "suppress-terminal-wiring", "detail": failure.message(), "stack": null }),
                );
                Ok(Vec::new())
            }
        }
    }

    /// The overlay file for a spawn in `cwd`, under `<userData>/ai-memory/omp-overlays`, named by its content, so
    /// concurrent spawns write the same bytes and a spawn whose lists did not change finds its file in place. A
    /// running omp watches its overlay, so a file is never removed or rewritten.
    async fn overlay(
        &self,
        agent_dir: &Path,
        cwd: Option<&str>,
        ids: &[String],
    ) -> Result<String, Failure> {
        let mut files: Vec<PathBuf> = AGENT_CONFIGS
            .iter()
            .map(|name| agent_dir.join(name))
            .collect();
        if let Some(cwd) = cwd {
            files.extend(PROJECT_CONFIGS.iter().map(|name| Path::new(cwd).join(name)));
        }
        let lists: Vec<Option<Vec<String>>> = if self.native.is_some() {
            files
                .iter()
                .map(|file| super::application::disabled_in(file))
                .collect()
        } else {
            let files: Vec<String> = files
                .iter()
                .map(|file| file.to_string_lossy().into_owned())
                .collect();
            let answered = self
                .ask("disabledLists", false, json!({ "files": files }))
                .await?;
            serde_json::from_value(answered).map_err(|error| Failure::step(error.to_string()))?
        };
        let (text, name) = text::overlay(&lists, AGENT_CONFIGS.len(), ids);
        let dir = Path::new(&self.deps.root_dir)
            .parent()
            .unwrap_or(Path::new(""))
            .join("omp-overlays");
        fs::create_dir_all(&dir).map_err(|error| io_failure(&error, "mkdir", &dir))?;
        let file = dir.join(name);
        if terminal::read_text(&file).as_deref() != Some(text.as_str()) {
            let part = PathBuf::from(format!(
                "{}.{}.{}.part",
                file.to_string_lossy(),
                std::process::id(),
                super::system_now()
            ));
            fs::write(&part, &text).map_err(|error| io_failure(&error, "open", &part))?;
            fs::rename(&part, &file).map_err(|error| io_failure(&error, "rename", &part))?;
        }
        Ok(file.to_string_lossy().into_owned())
    }

    /// Paths whose binaries OMPdesk runs: a unit or an MCP entry running one was written by OMPdesk.
    fn owned_paths(&self) -> Vec<String> {
        let mut owned = vec![
            binary::staging_root(Path::new(&self.deps.tools_dir))
                .to_string_lossy()
                .into_owned(),
        ];
        if let Some(resolved) = &self.inner().resolved {
            owned.push(resolved.bin.clone());
        }
        owned
    }

    async fn unit_inspect(&self) -> Result<ServiceUnit, Failure> {
        match &self.unit {
            Some(unit) => Ok(unit.inspect(&self.owned_paths()).await),
            None => {
                serde_json::from_value(self.ask("unit", false, json!({ "op": "inspect" })).await?)
                    .map_err(|error| Failure::step(error.to_string()))
            }
        }
    }

    async fn unit_remove(&self) -> Result<(), Failure> {
        match &self.unit {
            Some(unit) => {
                unit.remove(self.state().data_dir.as_deref()).await;
                Ok(())
            }
            None => self
                .ask("unit", false, json!({ "op": "remove" }))
                .await
                .map(|_| ()),
        }
    }

    async fn resolve(&self) -> Result<Resolved, Failure> {
        let deps = &self.deps;
        if let Some(bin) = &deps.binary_override {
            let env = self.spawn_env().await?;
            return Ok(Resolved {
                bin: bin.clone(),
                version: binary::probe_version(bin, &env).await,
                staged: None,
            });
        }
        if deps.platform == "other" {
            return Err(Failure::step("ai-memory has no build for this platform."));
        }
        let Some(bundled) = &deps.bundled_dir else {
            return Err(Failure::step(
                "The app carries no ai-memory binary. Reinstall OMPdesk.",
            ));
        };
        let asset =
            binary::read_built_asset(&deps.builds, Path::new(bundled), &deps.platform, &deps.arch)
                .map_err(Failure::Step)?
                .ok_or_else(|| Failure::step("ai-memory has no build for this platform."))?;
        let bin = self
            .stage(&asset, &Path::new(bundled).join(&asset.binary))
            .await?;
        Ok(Resolved {
            bin,
            version: Some(deps.builds.version.clone()),
            staged: Some(asset),
        })
    }

    async fn stage(&self, asset: &BuiltAsset, source: &Path) -> Result<String, Failure> {
        let deps = &self.deps;
        let tools = Path::new(&deps.tools_dir);
        // A packaged macOS release re-signed the shipped file with OMPdesk's certificate (`binary.rs`).
        let requirement = |file: String| -> Boxed<'_, Result<Option<String>, String>> {
            Box::pin(async move {
                if !deps.code_requirement_asks {
                    return Ok(
                        binary::code_requirement_problem(&file, &deps.builds.requirement).await,
                    );
                }
                match self
                    .ask("codeRequirement", false, json!({ "file": file }))
                    .await
                {
                    Ok(Value::String(problem)) => Ok(Some(problem)),
                    Ok(_) => Ok(None),
                    Err(failure) => Err(failure.message()),
                }
            })
        };
        let darwin = deps.platform == "darwin";
        let staged = binary::stage_binary(
            &deps.builds,
            source,
            asset,
            tools,
            darwin.then_some(&requirement as _),
        )
        .await
        .map_err(Failure::Step)?;
        Ok(staged.to_string_lossy().into_owned())
    }

    /// `ai-memory <args>` under main's runner; `env` over main's environment.
    async fn run(
        &self,
        bin: &str,
        args: &[String],
        env: Option<Value>,
        isolated: bool,
    ) -> Result<Ran, Failure> {
        if let Some(native) = &self.native {
            let scope = native.command_scope()?;
            let mut environment = native.host.spawn_env().await?;
            if let Some(extra) = env {
                let extra: super::application::Environment = serde_json::from_value(extra)
                    .map_err(|error| Failure::step(error.to_string()))?;
                environment.extend(extra);
            }
            if self.inner().disposed || scope.cancelled() {
                return Err(Failure::Cancelled);
            }
            let output = native
                .host
                .run(
                    super::application::RunCommand {
                        bin: bin.to_owned(),
                        args: args.to_vec(),
                        env: environment,
                        isolated,
                        cwd: PathBuf::from(&self.deps.home),
                    },
                    scope,
                )
                .await?;
            return Ok(Ran {
                ok: output.ok,
                cancelled: output.cancelled,
                output: output.output,
            });
        }
        let mut params = json!({ "bin": bin, "args": args, "isolated": isolated });
        if let Some(env) = env {
            params["env"] = env;
        }
        let answered = self.ask("run", true, params).await;
        let answered = match answered {
            // The service closed under the command: it was cancelled with it.
            Err(Failure::Error { message, .. }) if message == "Memory's service closed" => {
                return Ok(Ran {
                    ok: false,
                    cancelled: true,
                    output: String::new(),
                });
            }
            answered => answered?,
        };
        if let Some(spawn) = answered.get("spawn") {
            let detail = spawn.as_str().unwrap_or(bin);
            return Err(Failure::step(format!(
                "ai-memory could not start: {detail}"
            )));
        }
        Ok(Ran {
            ok: answered.get("ok") == Some(&Value::Bool(true)),
            cancelled: answered.get("cancelled") == Some(&Value::Bool(true)),
            output: answered
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    }

    /// Only OMPdesk's own build serves: `setup` repoints a unit that already runs OMPdesk's, so a unit running
    /// someone else's binary is removed first (its server stops), and a server that answers with no unit at all
    /// cannot be stopped by OMPdesk, so the pass fails and says so. A service run by the tests themselves
    /// (`no_service`) has no unit to take over.
    async fn take_over(&self, server_was_up: bool) -> Result<(), Failure> {
        if self.deps.no_service {
            return Ok(());
        }
        let unit = self.unit_inspect().await?;
        if unit.installed && !unit.ours {
            self.remove_unit().await?;
        } else if unit.installed || !server_was_up {
            return Ok(());
        }
        if self.healthy().await {
            return Err(Failure::step(
                "A memory server that OMPdesk did not start answers on this computer (Docker, a foreground `ai-memory serve`). Stop it and try again: OMPdesk runs only its own.",
            ));
        }
        Ok(())
    }

    /// `setup` installs the service only together with an agent's wiring. For OMPdesk's server the agent dir is a
    /// scratch folder (deleted afterwards, with the shared skills `setup` newly created); a terminal omp the person
    /// connected is wired into its real agent dir by the very same command. It runs isolated: the service host it may
    /// start outlives OMPdesk by design, and must not hold any handle of OMPdesk's.
    async fn setup(&self, bin: &str, terminal: bool) -> Result<(), Failure> {
        let mut args: Vec<String> = ["setup", "--yes", "--agent", "omp"]
            .map(str::to_owned)
            .to_vec();
        if self.deps.no_service {
            args.push("--no-service".to_owned());
        }
        let scratch = format!("{}.setup", self.deps.root_dir);
        let home = PathBuf::from(&self.deps.home);
        let cleanup = (!terminal).then(|| SetupScratch {
            scratch: PathBuf::from(&scratch),
            before: terminal::list_shared_skills(&home),
            home,
        });
        let env = (!terminal).then(|| json!({ "PI_CODING_AGENT_DIR": scratch }));
        let ran = self.run(bin, &args, env, true).await;
        drop(cleanup);
        let ran = ran?;
        if ran.cancelled {
            return Err(Failure::Cancelled);
        }
        let problems = text::parse_problems(&ran.output);
        // Right after the service starts, setup's own self-check can ask before the server listens; the poll is the
        // real test. Any other problem is a failure.
        let fatal: Vec<&String> = problems
            .iter()
            .filter(|problem| !problem.starts_with("self-check"))
            .collect();
        if !ran.ok && (!fatal.is_empty() || problems.is_empty()) {
            let said = if fatal.is_empty() {
                let tail = text::tail(&ran.output, TAIL_LINES);
                if tail.is_empty() {
                    "no output".to_owned()
                } else {
                    tail
                }
            } else {
                fatal
                    .iter()
                    .map(|problem| problem.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            };
            return Err(Failure::step(format!("setup failed: {said}")));
        }
        Ok(())
    }

    /// The extension root, from ai-memory's own generators; false when a command was cancelled.
    async fn generate_root(&self, bin: &str) -> Result<bool, Failure> {
        let run = |args: Vec<String>| -> Boxed<'_, Result<Ran, Failure>> {
            Box::pin(async move {
                self.run(bin, &args, None, false)
                    .await
                    .map_err(Failure::into_step)
            })
        };
        root::generate_root(
            Path::new(&self.deps.root_dir),
            &self.deps.hub_entry,
            &run,
            |output| text::tail(output, TAIL_LINES),
        )
        .await
        .map_err(Failure::into_step)
    }

    fn read_config(path: Option<&str>) -> Option<String> {
        terminal::read_text(Path::new(path?))
    }

    /// The wiring pass. A failure is the `failed` phase and runs again by itself, a bounded number of times.
    pub(super) async fn enable(self: &Arc<Self>) {
        if let Err(failure) = self.wire().await {
            self.fail(&failure);
            self.schedule_retry();
        }
    }

    async fn wire(self: &Arc<Self>) -> Result<(), Failure> {
        self.inner().awaiting_bun = false;
        let bun_present = if let Some(native) = &self.native {
            native.host.bun_present().await?
        } else if self.deps.bun_check {
            self.ask("bunPresent", false, Value::Null).await?.as_bool() == Some(true)
        } else {
            true
        };
        if !bun_present {
            self.inner().awaiting_bun = true;
            return Err(Failure::step(
                "Waiting for Bun: memory sets itself up as soon as the setup has installed it.",
            ));
        }
        self.step_to("stage");
        let resolved = self.resolve().await?;
        self.inner().resolved = Some(resolved.clone());
        self.patch(|state| {
            state.version = resolved.version.clone();
            state.binary = Some(resolved.bin.clone());
        });
        self.log(
            "binary",
            json!({ "version": resolved.version, "bin": resolved.bin }),
        );
        self.step_to("wire");
        let bin = resolved.bin.as_str();
        // The plan tells the data folder (platform default or AI_MEMORY_DATA_DIR) without touching anything.
        let plan_args = ["setup", "--plan", "--json", "--agent", "omp"].map(str::to_owned);
        let plan = self.run(bin, &plan_args, None, false).await?;
        if plan.cancelled {
            return Ok(());
        }
        let facts = text::parse_plan(&plan.output);
        let config_path = facts.as_ref().and_then(|facts| facts.config_path.clone());
        if let Some(data_dir) = facts.as_ref().and_then(|facts| facts.data_dir.clone()) {
            self.patch(|state| state.data_dir = Some(data_dir));
        }
        // Whether a server of someone else's already runs on this data folder (read before `init` can write one).
        let before = Self::read_config(config_path.as_deref());
        if let Some(before) = &before {
            let configured = server_url_from_config(Some(before));
            self.patch(|state| state.server_url = Some(configured));
        }
        let server_was_up = before.is_some() && self.healthy().await;
        // A fresh data folder: ai-memory's own `init` writes the config (and token) first, and the one setting
        // OMPdesk changes goes in before the service starts, so the embedding model is never fetched. An existing
        // config (a person's, or an earlier OMPdesk run) is left exactly as it is.
        if let (Some(true), Some(config_path)) =
            (facts.as_ref().map(|facts| facts.fresh), &config_path)
        {
            let init = self.run(bin, &["init".to_owned()], None, false).await?;
            if init.cancelled {
                return Ok(());
            }
            if !init.ok {
                let tail = text::tail(&init.output, TAIL_LINES);
                let said = if tail.is_empty() {
                    "no output".to_owned()
                } else {
                    tail
                };
                return Err(Failure::step(format!("init failed: {said}")));
            }
            if let Some(next) = Self::read_config(Some(config_path))
                .and_then(|current| text::without_local_embeddings(&current))
            {
                fs::write(config_path, next)
                    .map_err(|error| io_failure(&error, "open", Path::new(config_path)))?;
            }
        }
        self.take_over(server_was_up).await?;

        // An earlier build wired omp globally (extension + MCP entry running OMPdesk's staged binary): moved to the
        // app-owned root, once. Wiring the person made themselves is never adopted as the terminal's: it stays
        // untouched and is not read as "terminal omp connected" (only the button sets the pref true).
        let agent_dir = self.agent_dir().await?;
        let mut wired: TerminalWiring = terminal::read_wiring(&agent_dir);
        if self.terminal_pref().await?.is_none() {
            if terminal::legacy_owned(&wired, &self.owned_paths()) {
                terminal::remove_wiring(&agent_dir)
                    .map_err(|error| io_failure(&error, "open", &agent_dir))?;
                wired = terminal::read_wiring(&agent_dir);
            }
            self.persist_terminal(false).await?;
        }
        // Keep a connected terminal omp pointed at the binary in use (an app update stages a new version).
        let terminal_wired =
            self.terminal_pref().await? == Some(true) && (wired.extension || wired.mcp);
        if let Err(failure) = self.setup(bin, terminal_wired).await {
            if matches!(failure, Failure::Cancelled) {
                return Ok(());
            }
            // The extension root belongs to the binary in use, not to the service: an update whose service step
            // failed still gets the new extension, or it stays stale for the whole run.
            if let Err(root_failure) = self.generate_root(bin).await {
                self.log(
                    "failed",
                    json!({ "step": "root", "detail": root_failure.message(), "stack": null }),
                );
            }
            let wiring = self.wiring().await?;
            self.patch(|state| state.wiring = wiring);
            return Err(failure);
        }
        let server_url =
            server_url_from_config(Self::read_config(config_path.as_deref()).as_deref());
        self.patch(|state| state.server_url = Some(server_url));
        if !self.generate_root(bin).await? {
            return Ok(());
        }
        let wiring = self.wiring().await?;
        let app = wiring.app;
        self.patch(|state| state.wiring = wiring);
        if !app {
            return Err(Failure::step(format!(
                "ai-memory's extension root is not complete in {}",
                self.deps.root_dir
            )));
        }
        self.step_to("check");
        let up = self.wait_healthy().await;
        self.patch(|state| {
            state.phase = if up { "ready" } else { "unreachable" };
            state.step = None;
            state.detail = (!up).then(|| "The server does not answer yet.".to_owned());
        });
        {
            let mut inner = self.inner();
            inner.down_polls = 0;
            inner.retries = 0;
        }
        if up {
            self.read_stats().await;
        }
        self.start_polling();
        if let Some(staged) = resolved.staged {
            let (builds, tools) = (
                self.deps.builds.clone(),
                PathBuf::from(&self.deps.tools_dir),
            );
            tokio::task::spawn_blocking(move || binary::prune_staged(&builds, &tools, &staged));
        }
        Ok(())
    }

    /// Remove ai-memory's unit (its server goes with it) and wait for the server to stop answering.
    async fn remove_unit(&self) -> Result<(), Failure> {
        self.unit_remove().await?;
        let deadline = self.now() + self.deps.health_wait_ms as i64;
        while self.healthy().await {
            if self.now() >= deadline {
                return Ok(());
            }
            self.sleep(HEALTH_STEP_MS).await;
        }
        Ok(())
    }

    /// Delete all memory: the server is stopped first and then the data folders are wiped by OMPdesk itself
    /// (`uninstall --purge-data` would refuse while any `ai-memory` process runs). The caller wires memory again.
    async fn purge_data(&self) -> Result<(), Failure> {
        self.stop_polling();
        let purged = async {
            self.step_to("purge");
            if self.unit_inspect().await?.installed {
                self.remove_unit().await?;
            }
            self.wipe_data().await?;
            self.patch(|state| {
                state.step = None;
                state.detail = None;
                state.stats = None;
            });
            Ok::<(), Failure>(())
        }
        .await;
        if let Err(failure) = &purged {
            self.fail(failure);
        }
        purged
    }

    /// Empty `wiki/`, `db/` and `raw/` of the data folder (what `ai-memory reset` wipes); the config and token stay.
    async fn wipe_data(&self) -> Result<(), Failure> {
        let dir = self
            .state()
            .data_dir
            .filter(|dir| {
                fs::metadata(Path::new(dir).join("config.toml")).is_ok_and(|meta| meta.is_file())
            })
            .ok_or_else(|| {
                Failure::step("The data folder is not known, so nothing was deleted.")
            })?;
        // The server must be gone: a second server (Docker, a foreground `serve`) would still hold the database.
        self.sleep(HEALTH_STEP_MS).await;
        if self.healthy().await {
            return Err(Failure::step(
                "An ai-memory server still answers, so nothing was deleted. Stop it first.",
            ));
        }
        for name in DATA_FOLDERS {
            let folder = Path::new(&dir).join(name);
            match fs::remove_dir_all(&folder) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(io_failure(&error, "rm", &folder));
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn wait_healthy(&self) -> bool {
        let deadline = self.now() + self.deps.health_wait_ms as i64;
        loop {
            if self.healthy().await {
                return true;
            }
            if self.inner().disposed || self.now() >= deadline {
                return false;
            }
            self.sleep(HEALTH_STEP_MS).await;
        }
    }

    async fn read_stats(&self) {
        let Some(status) = self.client().status().await else {
            return;
        };
        self.patch(|state| {
            if let Some(version) = status.version.clone() {
                state.version = Some(version);
            }
            state.stats = Some(Stats {
                pages: status.pages.clone(),
                sessions: status.sessions.clone(),
                observations: status.observations.clone(),
                disk_bytes: status.disk_bytes.clone(),
            });
        });
    }

    /// Health, stats and the wiring files; heals by running the pass again when the server stays down or a file
    /// went. One check at a time: a check that started while another was reading would apply what it read after the
    /// newer one (seen on Windows, where a poll's file reads outlast the poll interval). A call meanwhile joins it.
    pub async fn check(self: &Arc<Self>, heal: bool) -> Result<(), Failure> {
        let mut running = {
            let mut inner = self.inner();
            match &inner.checking {
                Some(running) => running.clone(),
                None => {
                    let (told, running) = watch::channel(None);
                    inner.checking = Some(running.clone());
                    let service = Arc::clone(self);
                    tokio::spawn(async move {
                        let checked = service
                            .run_check(heal)
                            .await
                            .map_err(|failure| failure.message());
                        service.inner().checking = None;
                        told.send_replace(Some(checked));
                    });
                    running
                }
            }
        };
        let checked = running
            .wait_for(Option::is_some)
            .await
            .map(|checked| checked.clone())
            .ok()
            .flatten()
            .unwrap_or(Ok(()));
        checked.map_err(Failure::step)
    }

    async fn run_check(self: &Arc<Self>, heal: bool) -> Result<(), Failure> {
        let (up, wiring) = tokio::join!(self.healthy(), self.wiring());
        let wiring = wiring?;
        if self.state().phase == "starting" {
            return Ok(());
        }
        let missing = !wiring.app;
        self.patch(|state| state.wiring = wiring);
        if up {
            self.inner().down_polls = 0;
            self.patch(|state| {
                state.phase = "ready";
                state.detail = None;
            });
            self.read_stats().await;
        } else {
            self.inner().down_polls += 1;
            self.patch(|state| {
                state.phase = "unreachable";
                state.stats = None;
                state.detail = Some("The server does not answer.".to_owned());
            });
        }
        let now = self.now();
        let rewire = {
            let mut inner = self.inner();
            let broken = !up && inner.down_polls >= REWIRE_AFTER_POLLS;
            let due = heal && (broken || missing) && now - inner.last_rewire >= REWIRE_COOLDOWN_MS;
            if due {
                inner.last_rewire = now;
            }
            due
        };
        if rewire {
            self.step_to("wire");
            let _ = self.run_step(Op::Enable).await;
        }
        Ok(())
    }

    /// After a failed pass: run it again by itself, a bounded number of times.
    fn schedule_retry(self: &Arc<Self>) {
        let delays = &self.deps.retry_delays_ms;
        let (attempt, in_ms) = {
            let mut inner = self.inner();
            if inner.disposed
                || inner.awaiting_bun
                || inner.retry.is_some()
                || inner.retries >= delays.len()
            {
                return;
            }
            let in_ms = delays[inner.retries];
            inner.retries += 1;
            (inner.retries, in_ms)
        };
        self.log(
            "retry",
            json!({ "attempt": attempt, "of": delays.len(), "inMs": in_ms, "detail": self.state().detail }),
        );
        let service = Arc::clone(self);
        let task = tokio::spawn(async move {
            service.sleep(in_ms).await;
            let due = {
                let mut inner = service.inner();
                inner.retry = None;
                !inner.disposed && inner.state.phase == "failed"
            };
            if due {
                service.patch(|state| {
                    state.phase = "starting";
                    state.step = Some("stage");
                    state.detail = None;
                });
                service.enqueue(Op::Enable, None);
            }
        });
        let mut inner = self.inner();
        if inner.disposed {
            task.abort();
        } else {
            inner.retry = Some(task);
        }
    }

    fn start_polling(self: &Arc<Self>) {
        let mut inner = self.inner();
        if inner.poll.is_some() || inner.disposed {
            return;
        }
        let service = Arc::clone(self);
        let poll_ms = self.deps.poll_ms;
        inner.poll = Some(tokio::spawn(async move {
            service
                .every(poll_ms, |service| {
                    let service = Arc::clone(service);
                    tokio::spawn(async move {
                        if let Err(failure) = service.check(true).await {
                            service.log(
                                "failed",
                                json!({ "step": "poll", "detail": failure.message(), "stack": null }),
                            );
                        }
                    });
                })
                .await;
        }));
    }

    fn stop_polling(&self) {
        if let Some(poll) = self.inner().poll.take() {
            poll.abort();
        }
    }
}
