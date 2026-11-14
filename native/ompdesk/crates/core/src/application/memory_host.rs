use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::aimemory::application::{
    CaptureCommand, CaptureOutput, Environment, Host, RunCommand, RunOutput,
};
use crate::aimemory::service::{Boxed, Failure};
use crate::server::{Fault, Scope};
use crate::setup::runner::{CaptureOptions, Runner};
use crate::setup::types::{Platform, RunOutcome, SpawnSpec};
use crate::upkeep::model::OmpLaunch;

pub struct MemoryHost {
    machine: Arc<crate::machine::Service>,
    prefs: Arc<super::prefs::Prefs>,
    runner: Runner,
    first_tab: Arc<super::readiness::FirstTab>,
}

impl MemoryHost {
    pub fn new(
        machine: Arc<crate::machine::Service>,
        prefs: Arc<super::prefs::Prefs>,
        runner: Runner,
        first_tab: Arc<super::readiness::FirstTab>,
    ) -> Self {
        Self {
            machine,
            prefs,
            runner,
            first_tab,
        }
    }

    fn spec(&self, command: &RunCommand) -> SpawnSpec {
        let platform = match self.machine.config().platform {
            crate::machine::Platform::Mac => Platform::Darwin,
            crate::machine::Platform::Windows => Platform::Win32,
            crate::machine::Platform::Other => Platform::Other,
        };
        let args: Vec<&str> = command.args.iter().map(String::as_str).collect();
        let mut spec = crate::setup::plans::command(&command.bin, &args, platform);
        spec.isolated = command.isolated;
        spec
    }
}

fn tail(output: &mut String, chunk: &str) {
    output.push_str(chunk);
    let units = output.encode_utf16().count();
    if units > 16 * 1024 {
        let kept: Vec<u16> = output.encode_utf16().skip(units - 16 * 1024).collect();
        *output = String::from_utf16_lossy(&kept);
    }
}

impl Host for MemoryHost {
    fn agent_dir(&self) -> PathBuf {
        self.machine.agent_dir().to_path_buf()
    }
    fn terminal_pref(&self) -> Option<bool> {
        self.prefs
            .get("aiMemoryTerminal")
            .ok()
            .flatten()
            .and_then(|value| value.as_bool())
    }
    fn persist_terminal(&self, enabled: bool) -> Result<(), Failure> {
        self.prefs
            .set("aiMemoryTerminal", Value::Bool(enabled))
            .map_err(|fault| Failure::step(fault.message))
    }
    fn before_start(&self) -> Boxed<'_, Result<(), Failure>> {
        Box::pin(async move {
            self.first_tab
                .wait()
                .await
                .map_err(|fault| Failure::step(fault.message))
        })
    }
    fn spawn_env(&self) -> Boxed<'_, Result<Environment, Failure>> {
        Box::pin(async move { Ok(self.machine.shell_environment().await) })
    }
    fn bun_present(&self) -> Boxed<'_, Result<bool, Failure>> {
        Box::pin(async move {
            self.machine
                .bun()
                .await
                .map(|bun| bun.is_some())
                .map_err(|fault| Failure::step(fault.message))
        })
    }
    fn omp_launch(&self) -> Boxed<'_, Result<OmpLaunch, Failure>> {
        Box::pin(async move {
            let runtime = self
                .machine
                .runtime()
                .await
                .map_err(|fault| Failure::step(fault.message))?;
            Ok(OmpLaunch {
                bin: runtime.bin.to_string_lossy().into_owned(),
                env: runtime.env,
            })
        })
    }
    fn run(&self, command: RunCommand, scope: Scope) -> Boxed<'_, Result<RunOutput, Failure>> {
        Box::pin(async move {
            let spec = self.spec(&command);
            let output = Arc::new(Mutex::new(String::new()));
            let sink = output.clone();
            let outcome = self
                .runner
                .run(
                    &spec,
                    &command.env,
                    &scope,
                    Arc::new(move |chunk| {
                        tail(&mut sink.lock().unwrap_or_else(|e| e.into_inner()), chunk);
                    }),
                    Some(&command.cwd),
                )
                .await;
            let output = output.lock().unwrap_or_else(|e| e.into_inner()).clone();
            match outcome {
                RunOutcome::Succeeded => Ok(RunOutput {
                    ok: true,
                    cancelled: false,
                    output,
                }),
                RunOutcome::Cancelled => Ok(RunOutput {
                    ok: false,
                    cancelled: true,
                    output,
                }),
                RunOutcome::Failed {
                    reason: "spawn",
                    detail,
                    ..
                } => Err(Failure::step(detail.unwrap_or_default())),
                RunOutcome::Failed { .. } => Ok(RunOutput {
                    ok: false,
                    cancelled: false,
                    output,
                }),
            }
        })
    }
    fn capture(
        &self,
        command: CaptureCommand,
        scope: Scope,
    ) -> Boxed<'_, Result<CaptureOutput, Fault>> {
        Box::pin(async move {
            let spec = self.spec(&command.command);
            let timeout = command.timeout;
            let captured = self
                .runner
                .capture(
                    spec,
                    command.command.env,
                    scope,
                    CaptureOptions {
                        cwd: Some(command.command.cwd),
                        input: command.input,
                        timeout,
                        max_bytes: command.max_bytes,
                    },
                )
                .await;
            if captured.timed_out {
                return Err(Fault::new(
                    "omp_timeout",
                    format!("omp -p timed out after {}ms", timeout.as_millis()),
                ));
            }
            let code = match captured.outcome {
                RunOutcome::Succeeded => 0,
                RunOutcome::Cancelled => return Err(Fault::cancelled()),
                RunOutcome::Failed {
                    reason: "spawn",
                    detail,
                    ..
                } => return Err(Fault::new("spawn_failed", detail.unwrap_or_default())),
                RunOutcome::Failed { exit_code, .. } => exit_code.unwrap_or(1),
            };
            Ok(CaptureOutput {
                code,
                stdout: captured.stdout,
                stderr: captured.stderr,
            })
        })
    }
}

#[cfg(test)]
#[path = "memory_host_tests.rs"]
mod tests;
