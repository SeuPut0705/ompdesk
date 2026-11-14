use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::{machine, setup, stock};
use setup::types::{Boxed, Detection, Environment, Host};

use super::readiness::FirstTab;

pub trait Hooks: Send + Sync + 'static {
    fn omp_ready(&self);
    fn git_aslr_log(&self, entry: setup::git_aslr::Log);
}

pub struct SetupHost {
    machine: Arc<machine::Service>,
    stock: Arc<stock::native::Service>,
    first_tab: Arc<FirstTab>,
    hooks: Arc<dyn Hooks>,
}

impl SetupHost {
    pub fn new(
        machine: Arc<machine::Service>,
        stock: Arc<stock::native::Service>,
        first_tab: Arc<FirstTab>,
        hooks: Arc<dyn Hooks>,
    ) -> Self {
        Self {
            machine,
            stock,
            first_tab,
            hooks,
        }
    }
}

impl Host for SetupHost {
    fn update_environment(&self, omp: &str) -> Boxed<'_, Result<Environment, String>> {
        let omp = omp.to_owned();
        Box::pin(async move {
            let env = self
                .machine
                .environment()
                .await
                .map_err(|error| error.message)?;
            let config = self.machine.config();
            Ok(machine::update_environment(
                Path::new(&omp),
                &env,
                &config.home,
                config.platform,
            ))
        })
    }

    fn compiled_omp(&self, file: &Path) -> bool {
        machine::is_compiled_omp(file, self.machine.config().platform)
    }

    fn bun_minimum(&self, manifest: &Value) -> Option<String> {
        machine::manifest_bun_minimum(manifest)
    }

    fn is_newer(&self, latest: &str, installed: Option<&str>) -> bool {
        installed.is_none_or(|installed| machine::is_newer(latest, installed))
    }

    fn detect(&self) -> Boxed<'_, Result<Detection, String>> {
        Box::pin(async move { self.machine.detect().await.map_err(|error| error.message) })
    }

    fn environment(&self) -> Boxed<'_, Result<Environment, String>> {
        Box::pin(async move {
            self.machine
                .environment()
                .await
                .map_err(|error| error.message)
        })
    }

    fn refresh_path(&self) -> Boxed<'_, Result<(), String>> {
        Box::pin(async move { self.machine.refresh().await.map_err(|error| error.message) })
    }

    fn before_omp_update(&self) -> Boxed<'_, Result<(), String>> {
        Box::pin(async move {
            self.stock.stop().await;
            Ok(())
        })
    }

    fn git_aslr_log(&self, entry: setup::git_aslr::Log) {
        self.hooks.git_aslr_log(entry);
    }

    fn omp_ready(&self) {
        self.hooks.omp_ready();
    }

    fn before_optional(&self) -> Boxed<'_, ()> {
        Box::pin(async move {
            let _ = self.first_tab.wait().await;
        })
    }
}

#[cfg(all(test, unix))]
#[path = "setup_host_tests.rs"]
mod tests;
