use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::machine::{Platform as MachinePlatform, Service as Machine};
use crate::server::{Fault, Scope};
use crate::setup::runner::{CaptureOptions, Runner};
use crate::setup::types::{Platform, RunOutcome};

/// Trusted command context captured by native admission, never deserialized from a page.
pub struct Command {
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub input: Vec<u8>,
    pub timeout: Duration,
}

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Uses the machine's canonical omp/Bun environment and the existing supervised process runner.
pub struct Service {
    machine: Arc<Machine>,
    runner: Runner,
}

impl Service {
    pub fn new(machine: Arc<Machine>, runner: Runner) -> Arc<Self> {
        Arc::new(Self { machine, runner })
    }

    pub async fn run(&self, command: Command, scope: Scope) -> Result<Output, Fault> {
        if scope.cancelled() {
            return Err(Fault::cancelled());
        }
        let runtime = self.machine.runtime().await?;
        if scope.cancelled() {
            return Err(Fault::cancelled());
        }
        let platform = match self.machine.config().platform {
            MachinePlatform::Mac => Platform::Darwin,
            MachinePlatform::Windows => Platform::Win32,
            MachinePlatform::Other => Platform::Other,
        };
        let args: Vec<&str> = command.args.iter().map(String::as_str).collect();
        let spec = crate::setup::plans::command(&runtime.bin.to_string_lossy(), &args, platform);
        let timeout = command.timeout;
        let captured = self
            .runner
            .capture(
                spec,
                runtime.env,
                scope,
                CaptureOptions {
                    cwd: Some(command.cwd),
                    input: command.input,
                    timeout,
                    // OmpRuntime.run kept both complete streams. Capture drains them independently.
                    max_bytes: usize::MAX,
                },
            )
            .await;
        if captured.timed_out {
            return Err(Fault::new(
                "omp_timeout",
                format!(
                    "omp {} timed out after {}ms",
                    command.args.first().map_or("", String::as_str),
                    timeout.as_millis()
                ),
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
        Ok(Output {
            code,
            stdout: text(captured.stdout),
            stderr: text(captured.stderr),
        })
    }
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}
