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
type ByteSink = Arc<dyn Fn(&[u8]) + Send + Sync>;

#[derive(Clone)]
enum Sink {
    Text(OutputSink),
    Bytes(ByteSink),
}

pub struct CaptureOptions {
    pub cwd: Option<PathBuf>,
    pub input: Vec<u8>,
    pub timeout: Duration,
    pub max_bytes: usize,
}

#[derive(Debug)]
pub struct Captured {
    pub timed_out: bool,
    pub outcome: RunOutcome,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Default)]
struct Kept {
    bytes: Vec<u8>,
    truncated: bool,
}

fn keeper(kept: &Arc<Mutex<Kept>>, limit: usize) -> Sink {
    let kept = kept.clone();
    Sink::Bytes(Arc::new(move |chunk| {
        let mut kept = kept.lock().unwrap_or_else(|poison| poison.into_inner());
        let take = chunk.len().min(limit.saturating_sub(kept.bytes.len()));
        kept.bytes.extend_from_slice(&chunk[..take]);
        kept.truncated |= take != chunk.len();
    }))
}

#[derive(Clone)]
pub struct Runner {
    paths: Arc<Paths>,
}
struct Paths {
    supervisor: PathBuf,
    scratch: PathBuf,
}

struct InputFile(PathBuf);
impl Drop for InputFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn input_file(scratch: &Path, bytes: &[u8]) -> std::io::Result<Option<InputFile>> {
    use std::io::Write as _;
    if bytes.is_empty() {
        return Ok(None);
    }
    std::fs::create_dir_all(scratch)?;
    let mut random = [0; 16];
    crate::sys::random(&mut random)?;
    let path = scratch.join(format!("input-{}", crate::hex(&random)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut output = options.open(&path)?;
    let file = InputFile(path);
    output.write_all(bytes)?;
    Ok(Some(file))
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
            paths: Arc::new(Paths {
                supervisor,
                scratch,
            }),
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
        self.run_streams(
            spec,
            env,
            scope,
            (Sink::Text(output.clone()), Sink::Text(output)),
            cwd,
        )
        .await
    }

    /// The retained reaper owns stdin's scratch file until the supervised tree has exited.
    /// Each stream keeps its first `max_bytes`, draining the rest as upkeep's original runner did.
    pub async fn capture(
        &self,
        mut spec: SpawnSpec,
        env: Environment,
        scope: Scope,
        options: CaptureOptions,
    ) -> Captured {
        let runner = self.clone();
        let held = scope.clone();
        let mut guard = CancelOnDrop(Some(scope));
        let work = tokio::spawn(async move {
            let CaptureOptions {
                cwd,
                input,
                timeout,
                max_bytes,
            } = options;
            let empty = |outcome| Captured {
                outcome,
                stdout: Vec::new(),
                stderr: Vec::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: false,
            };
            if held.cancelled() {
                return empty(RunOutcome::Cancelled);
            }
            if spec.isolated && !input.is_empty() {
                return empty(failed(
                    "spawn",
                    None,
                    "An isolated command cannot read stdin".to_owned(),
                ));
            }
            let paths = runner.paths.clone();
            let file = match tokio::task::spawn_blocking(move || input_file(&paths.scratch, &input))
                .await
            {
                Ok(Ok(file)) => file,
                Ok(Err(error)) => return empty(failed("spawn", None, error.to_string())),
                Err(error) => return empty(failed("spawn", None, error.to_string())),
            };
            spec.input_file = file
                .as_ref()
                .map(|file| file.0.to_string_lossy().into_owned());
            let stdout = Arc::new(Mutex::new(Kept::default()));
            let stderr = Arc::new(Mutex::new(Kept::default()));
            let process = Scope::detached();
            let work = runner.run_streams(
                &spec,
                &env,
                &process,
                (keeper(&stdout, max_bytes), keeper(&stderr, max_bytes)),
                cwd.as_deref(),
            );
            tokio::pin!(work);
            let mut timed_out = false;
            let outcome = tokio::select! {
                biased;
                () = held.on_cancel() => { process.cancel(); work.await },
                () = tokio::time::sleep(timeout) => { timed_out = true; process.cancel(); let _ = work.await; failed("exit", None, format!("Command timed out after {}ms", timeout.as_millis())) },
                outcome = &mut work => outcome,
            };
            // File cleanup is inside the retained task, not the future its caller may have dropped.
            drop(file);
            let mut stdout = stdout.lock().unwrap_or_else(|poison| poison.into_inner());
            let mut stderr = stderr.lock().unwrap_or_else(|poison| poison.into_inner());
            Captured {
                outcome,
                stdout: std::mem::take(&mut stdout.bytes),
                stderr: std::mem::take(&mut stderr.bytes),
                stdout_truncated: stdout.truncated,
                stderr_truncated: stderr.truncated,
                timed_out,
            }
        });
        let captured = work.await.unwrap_or_else(|error| Captured {
            outcome: failed("spawn", None, error.to_string()),
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
        });
        guard.0.take();
        captured
    }

    async fn run_streams(
        &self,
        spec: &SpawnSpec,
        env: &Environment,
        scope: &Scope,
        sinks: (Sink, Sink),
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
            if let Err(error) = std::fs::create_dir_all(&self.paths.scratch) {
                return failed("spawn", None, error.to_string());
            }
            let mut random = [0; 16];
            if let Err(error) = crate::sys::random(&mut random) {
                return failed("spawn", None, error.to_string());
            }
            let log = self
                .paths
                .scratch
                .join(format!("isolated-{}.log", crate::hex(&random)));
            value["log"] = json!({"path":log,"redirect":true});
            value["inputFile"] = serde_json::Value::Null;
        }
        let mut command = Command::new(&self.paths.supervisor);
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
            let mut out = tokio::spawn(forward(stdout, sinks.0, last.clone()));
            let mut err = tokio::spawn(forward(stderr, sinks.1, last.clone()));
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

async fn forward<R: AsyncRead + Unpin>(stream: Option<R>, output: Sink, last: Arc<Mutex<String>>) {
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
        if let Sink::Bytes(sink) = &output {
            sink(&bytes[..count]);
        }
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
            if let Sink::Text(sink) = &output {
                sink(&text);
            }
            pending.drain(..valid);
        }
        if count == 0 {
            return;
        }
    }
}
