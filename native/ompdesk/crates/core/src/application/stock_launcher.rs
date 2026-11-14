use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use crate::machine::{Resolution, Service, omp_path};
use crate::server::Fault;
use crate::stock::native::{LaunchCommand, Launcher, WorkerKind};

pub struct StockLauncher {
    machine: Arc<Service>,
    bridge_dir: PathBuf,
}

impl StockLauncher {
    pub fn new(machine: Arc<Service>, bridge_dir: PathBuf) -> Self {
        Self {
            machine,
            bridge_dir,
        }
    }
}

impl Launcher for StockLauncher {
    fn launch(
        &self,
        kind: WorkerKind,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchCommand, Fault>> + Send + '_>> {
        Box::pin(async move {
            let (resolution, shell, bun) = tokio::join!(
                self.machine.resolution(),
                self.machine.shell_environment(),
                self.machine.bun(),
            );
            let runtime = match resolution {
                Resolution::Ready(runtime) => runtime,
                Resolution::Failed { error, .. } => {
                    return Err(Fault::new("omp_unavailable", error));
                }
            };
            let root = runtime
                .package_root
                .ok_or_else(|| Fault::new("omp_unavailable", "Cannot locate omp package"))?;
            let bun = bun?.ok_or_else(|| Fault::new("bun_missing", "Cannot locate Bun"))?;
            let config = self.machine.config();
            let mut env = config.inherited_env.clone();
            for key in [
                "OMPDESK_SOCKET",
                "OMPDESK_CONTROL_DIR",
                "OMPDESK_CONTROL_OFF",
            ] {
                env.remove(key);
            }
            env.insert(
                "PATH".into(),
                omp_path(
                    &runtime.bin,
                    shell.get("PATH").map_or("", String::as_str),
                    &config.inherited_env,
                    &config.home,
                    config.platform,
                ),
            );
            env.insert(
                "OMP_PACKAGE_ROOT".into(),
                root.to_string_lossy().into_owned(),
            );
            env.insert("PI_NOTIFICATIONS".into(), "off".into());
            let worker = match kind {
                WorkerKind::Stock => "stock",
                WorkerKind::Terminals => "terminals",
                WorkerKind::Extensions => "extensions",
            };
            Ok(LaunchCommand {
                bin: bun.to_string_lossy().into_owned(),
                args: vec![
                    self.bridge_dir
                        .join("stock-helper/host.ts")
                        .to_string_lossy()
                        .into_owned(),
                    worker.into(),
                ],
                env,
                stamp_file: Some(root.join("package.json")),
            })
        })
    }
}

#[cfg(all(test, unix))]
#[path = "stock_launcher_tests.rs"]
mod tests;
