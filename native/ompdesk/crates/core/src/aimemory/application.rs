//! Native application wiring for memory. Boot data and host handles are injected by the authenticated Rust app,
//! never reconstructed from page JSON. The service queue and passes remain the single lifecycle implementation.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;

pub use super::binary::Builds;
pub use super::{Boxed, Failure, State};
use super::{Deps, Op, Service, locked};
use crate::server::{Events, Fault, Scope};
use crate::upkeep::model::OmpLaunch;

pub type Environment = BTreeMap<String, String>;

/// Trusted boot configuration. Paths and build identity come from the application, not an IPC payload.
pub struct Config {
    pub name: String,
    pub platform: String,
    pub arch: String,
    pub automatic: bool,
    pub tools_dir: PathBuf,
    pub bundled_dir: Option<PathBuf>,
    pub binary_override: Option<PathBuf>,
    pub no_service: bool,
    pub home: PathBuf,
    pub root_dir: PathBuf,
    pub recall_file: Option<PathBuf>,
    pub uid: u32,
    pub builds: Builds,
    pub hub_entry: Value,
}

/// A command selected by the existing memory pass, never by the page. Setup owns process supervision/isolation.
pub struct RunCommand {
    pub bin: String,
    pub args: Vec<String>,
    pub env: Environment,
    pub isolated: bool,
    pub cwd: PathBuf,
}

/// The executor's outcome after the supervised process has exited.
pub struct RunOutput {
    pub ok: bool,
    pub cancelled: bool,
    pub output: String,
}

/// Base implements these with its one prefs store, first-tab barrier, Machine selectors and Setup executor.
/// `run` must observe `scope`, join the supervisor's exit before returning, and retain its output's last 16 KiB
/// UTF-16 units. An isolated setup inherits no app handle; it is not a proxy to Node or a second worker pool.
pub trait Host: Send + Sync {
    fn agent_dir(&self) -> PathBuf;
    fn terminal_pref(&self) -> Option<bool>;
    fn persist_terminal(&self, enabled: bool) -> Result<(), Failure>;
    fn before_start(&self) -> Boxed<'_, Result<(), Failure>>;
    fn spawn_env(&self) -> Boxed<'_, Result<Environment, Failure>>;
    fn bun_present(&self) -> Boxed<'_, Result<bool, Failure>>;
    fn omp_launch(&self) -> Boxed<'_, Result<OmpLaunch, Failure>>;
    fn run(&self, command: RunCommand, scope: Scope) -> Boxed<'_, Result<RunOutput, Failure>>;
}

pub(super) struct Native {
    pub(super) host: Arc<dyn Host>,
    scope: Mutex<Option<Scope>>,
    pub(super) publishing: Mutex<()>,
}

impl Native {
    pub(super) fn new(host: Arc<dyn Host>) -> Self {
        Self {
            host,
            scope: Mutex::new(None),
            publishing: Mutex::new(()),
        }
    }

    pub(super) fn begin_step(&self) {
        *locked(&self.scope) = Some(Scope::detached());
    }

    pub(super) fn cancel(&self) {
        if let Some(scope) = locked(&self.scope).as_ref() {
            scope.cancel();
        }
    }

    pub(super) fn end_step(&self) {
        locked(&self.scope).take();
    }

    pub(super) fn command_scope(&self) -> Result<Scope, Failure> {
        let scope = locked(&self.scope)
            .clone()
            .ok_or_else(|| Failure::step("Memory command outside its queue"))?;
        if scope.cancelled() {
            return Err(Failure::Cancelled);
        }
        Ok(scope)
    }
}

/// Preserve the YAML reader's contract: malformed/absent/non-list is unset, non-string entries are ignored.
pub(super) fn disabled_in(file: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(file).ok()?;
    let document: Value = serde_saphyr::from_str(&text).ok()?;
    Some(
        document
            .get("disabledExtensions")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    )
}

pub struct Memory {
    service: Arc<Service>,
}

impl Memory {
    pub fn open(config: Config, host: Arc<dyn Host>, events: Events) -> Self {
        let path = |path: PathBuf| path.to_string_lossy().into_owned();
        let deps = Deps {
            platform: config.platform,
            arch: config.arch,
            automatic: config.automatic,
            tools_dir: path(config.tools_dir),
            bundled_dir: config.bundled_dir.map(path),
            binary_override: config.binary_override.map(path),
            no_service: config.no_service,
            home: path(config.home),
            root_dir: path(config.root_dir),
            recall_file: config.recall_file.map(path),
            uid: config.uid,
            unit_asks: false,
            code_requirement_asks: false,
            bun_check: true,
            before_start: true,
            poll_ms: 60_000,
            health_wait_ms: 30_000,
            retry_delays_ms: vec![30_000, 2 * 60_000, 10 * 60_000],
            step_max_ms: 30 * 60_000,
            manual: false,
            now: None,
            builds: config.builds,
            hub_entry: config.hub_entry,
        };
        Self {
            service: Service::create(config.name, deps, events, Some(Native::new(host))),
        }
    }

    pub fn state(&self) -> State {
        self.service.state()
    }
    pub async fn start(&self) {
        self.service.start().await;
    }
    pub fn bun_installed(&self) {
        self.service.bun_installed();
    }
    pub async fn extension_args(&self, cwd: Option<&str>) -> Result<Vec<String>, Failure> {
        self.service.extension_args(cwd).await
    }
    pub async fn refresh(&self) -> Result<(), Failure> {
        self.service.refresh().await
    }
    pub async fn retry(&self) -> Result<(), Fault> {
        if !self.service.managed() {
            return Ok(());
        }
        if let Some(retry) = self.service.inner().retry.take() {
            retry.abort();
        }
        self.service.run_step(Op::Enable).await
    }
    pub async fn set_terminal(&self, enabled: bool) -> Result<(), Fault> {
        self.managed()?;
        self.service.run_step(Op::Terminal(enabled)).await
    }
    pub async fn purge(&self) -> Result<(), Fault> {
        self.managed()?;
        self.service.run_step(Op::Purge).await
    }
    pub async fn omp_launch(&self) -> Result<OmpLaunch, Failure> {
        let native = self
            .service
            .native
            .as_ref()
            .ok_or_else(|| Failure::step("Not a native memory service"))?;
        native.host.omp_launch().await
    }
    pub fn model(&self, cwd: PathBuf) -> Result<crate::upkeep::model::Model, Failure> {
        let native = self
            .service
            .native
            .as_ref()
            .ok_or_else(|| Failure::step("Not a native memory service"))?;
        Ok(crate::upkeep::model::Model::Native(
            Arc::clone(&native.host),
            cwd,
        ))
    }
    fn managed(&self) -> Result<(), Fault> {
        if self.service.managed() {
            Ok(())
        } else {
            Err(Fault::new(
                "memory_not_managed",
                "ai-memory is not managed by this build.",
            ))
        }
    }
    pub async fn close(&self) {
        self.service.close();
        let worker = locked(&self.service.worker).take();
        if let Some(worker) = worker {
            let _ = worker.await;
        }
    }
}

impl Drop for Memory {
    fn drop(&mut self) {
        self.service.close();
    }
}

#[cfg(test)]
#[path = "application_tests.rs"]
mod tests;
