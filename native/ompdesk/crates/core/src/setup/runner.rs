use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::types::{Environment, RunOutcome, SpawnSpec};
use crate::server::Scope;

pub type OutputSink = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Runner {
    supervisor: PathBuf,
    scratch: PathBuf,
}

struct CancelOnDrop(Option<Scope>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(scope) = &self.0 {
            scope.cancel();
        }
    }
}

impl Runner {
    pub fn new(supervisor: PathBuf, scratch: PathBuf) -> Self {
        Self {
            supervisor,
            scratch,
        }
    }

    /// Dropping this future cancels its scope. The task that holds the child still reaps it.
    pub async fn run(
        &self,
        spec: &SpawnSpec,
        env: &Environment,
        scope: &Scope,
        output: OutputSink,
        cwd: Option<&Path>,
    ) -> RunOutcome {
        if scope.cancelled() {
            return RunOutcome::Cancelled;
        }
        // Base owns the Windows STARTUPINFOEX handle allowlist. Never replace it with a Bun/Node launcher.
        #[cfg(windows)]
        if spec.isolated {
            return failed(
                "spawn",
                None,
                "Native isolated Windows handle allowlist is not integrated".to_owned(),
            );
        }
        let mut value = match serde_json::to_value(spec) {
            Ok(value) => value,
            Err(error) => return failed("spawn", None, error.to_string()),
        };
        if spec.isolated {
            if let Err(error) = std::fs::create_dir_all(&self.scratch) {
                return failed("spawn", None, error.to_string());
            }
            let mut random = [0; 16];
            if let Err(error) = crate::sys::random(&mut random) {
                return failed("spawn", None, error.to_string());
            }
            let log = self
                .scratch
                .join(format!("isolated-{}.log", crate::hex(&random)));
            value["log"] = json!({"path":log,"redirect":true});
            value["inputFile"] = serde_json::Value::Null;
        }
        let mut command = Command::new(&self.supervisor);
        command
            .arg("--supervise")
            .env_clear()
            .envs(env)
            .env("OMPDESK_SETUP_SPEC", value.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return failed("spawn", None, error.to_string()),
        };
        let mut guard = CancelOnDrop(Some(scope.clone()));
        let scope = scope.clone();
        let work = tokio::spawn(async move {
            let mut stdin = child.stdin.take();
            let last = Arc::new(Mutex::new(String::new()));
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let mut out = tokio::spawn(forward(stdout, output.clone(), last.clone()));
            let mut err = tokio::spawn(forward(stderr, output, last.clone()));
            let mut cancelled = false;
            let status = tokio::select! {
                biased;
                () = scope.on_cancel() => { cancelled = true; drop(stdin.take()); child.wait().await }
                status = child.wait() => status,
            };
            drop(stdin);
            let drained = tokio::time::timeout(Duration::from_millis(500), async {
                let _ = tokio::join!(&mut out, &mut err);
            })
            .await;
            if drained.is_err() {
                out.abort();
                err.abort();
                let _ = tokio::join!(out, err);
            }
            if cancelled || scope.cancelled() {
                return RunOutcome::Cancelled;
            }
            match status {
                Ok(status) if status.success() => RunOutcome::Succeeded,
                Ok(status) => {
                    let code = status.code();
                    let line = last
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .clone();
                    RunOutcome::Failed {
                        reason: if code == Some(127) { "spawn" } else { "exit" },
                        exit_code: code,
                        detail: super::service::update_detail(&line),
                    }
                }
                Err(error) => failed("spawn", None, error.to_string()),
            }
        });
        let outcome = work
            .await
            .unwrap_or_else(|error| failed("spawn", None, error.to_string()));
        // Do not signal a caller's scope after a completed command.
        guard.0.take();
        outcome
    }
}

fn failed(reason: &'static str, exit_code: Option<i32>, detail: String) -> RunOutcome {
    RunOutcome::Failed {
        reason,
        exit_code,
        detail: Some(detail),
    }
}

async fn forward<R: AsyncRead + Unpin>(
    stream: Option<R>,
    output: OutputSink,
    last: Arc<Mutex<String>>,
) {
    let Some(mut stream) = stream else {
        return;
    };
    let mut bytes = [0; 8192];
    let mut pending = Vec::with_capacity(8196);
    loop {
        let count = match stream.read(&mut bytes).await {
            Ok(count) => count,
            Err(_) => return,
        };
        pending.extend_from_slice(&bytes[..count]);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(error) if error.error_len().is_none() && count != 0 => error.valid_up_to(),
            Err(_) => pending.len(),
        };
        if valid > 0 {
            let text = String::from_utf8_lossy(&pending[..valid]);
            if let Some(line) = text.lines().rev().find(|line| !line.trim().is_empty()) {
                let mut tail = last.lock().unwrap_or_else(|poison| poison.into_inner());
                *tail = line.trim().chars().take(4096).collect();
            }
            output(&text);
            pending.drain(..valid);
        }
        if count == 0 {
            return;
        }
    }
}
