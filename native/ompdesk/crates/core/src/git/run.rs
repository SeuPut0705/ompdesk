//! Running one git. Main decides how every git runs (`gitRunner` in `src/main/local/git/exec.ts`, which its own
//! runner for the write side follows too): the binary, the arguments before the command's own, the whole environment
//! (the ambient repository selectors already dropped, `PATH` the login shell's, `GIT_OPTIONAL_LOCKS=0`), the timeout and
//! the output cap. This side only spawns and supervises, as `execBin` does: no shell, stdin closed, stdout kept up to
//! the cap (the process is then asked to end), stderr up to 64 KiB, and a process past its timeout asked to end and
//! killed 2 s later while the caller hears of the timeout at once.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::Notify;

use crate::fs::error::uv_code;
use crate::fs::order::js_trim;
use crate::server::Fault;

/// How long a process asked to end may ignore it before it is killed outright.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// stderr kept for messages.
const STDERR_KEPT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runner {
    bin: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    timeout_ms: u64,
    max_bytes: usize,
}

/// What one git did: `code` 1 when a signal ended it, as node reports `null`.
pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    /// stdout as node's `toString("utf8")` reads it.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

impl Runner {
    /// `gitRaw`: answers whatever git's exit code; fails only when git could not run or ran past its timeout.
    pub async fn raw(&self, cwd: &str, args: &[&str]) -> Result<Output, Fault> {
        self.run(cwd, args, self.max_bytes).await
    }

    /// `gitRaw` with its own output cap.
    pub async fn capped(
        &self,
        cwd: &str,
        args: &[&str],
        max_bytes: usize,
    ) -> Result<Output, Fault> {
        self.run(cwd, args, max_bytes).await
    }

    /// `git`: stdout as text; git's own failure is a fault with its stderr (`GitCommandError`'s message).
    pub async fn text(&self, cwd: &str, args: &[&str]) -> Result<String, Fault> {
        let output = self.raw(cwd, args).await?;
        if output.code != 0 {
            let stderr = js_trim(&output.stderr);
            let message = if stderr.is_empty() {
                format!(
                    "git {} exited with code {}",
                    args.first().unwrap_or(&""),
                    output.code
                )
            } else {
                stderr.to_owned()
            };
            return Err(Fault::new("git_failed", message));
        }
        Ok(output.text())
    }

    async fn run(&self, cwd: &str, args: &[&str], max_bytes: usize) -> Result<Output, Fault> {
        let mut command = Command::new(&self.bin);
        command
            .args(&self.args)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.environment(&mut command);
        #[cfg(windows)]
        {
            // libuv's `windowsHide` with no inherited stdio: no console window for a console program.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| {
            Fault::new(
                "spawn_failed",
                format!("spawn {} {}", self.bin, uv_code(&error)),
            )
        })?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err(Fault::new("internal", "git's pipes were not open"));
        };
        let end = Arc::new(Notify::new());
        let ending = Arc::clone(&end);
        // Its own task: a timed-out git is still ended and reaped after its caller was answered.
        let work = tokio::spawn(async move {
            // stderr past its cap is dropped; nothing waits on this, so it never ends the process.
            let ignored = Notify::new();
            let ((stdout, _), (stderr, _), code) = tokio::join!(
                read_capped(stdout, max_bytes, &ending),
                read_capped(stderr, STDERR_KEPT, &ignored),
                supervise(child, &ending),
            );
            Output {
                code,
                stdout,
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            }
        });
        match tokio::time::timeout(Duration::from_millis(self.timeout_ms), work).await {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(_)) => Err(Fault::new("internal", "git's supervisor failed")),
            Err(_) => {
                end.notify_one();
                // `execBin` names the process's first argument (`-c` for every git).
                let first = self.args.first().map_or_else(
                    || args.first().copied().unwrap_or(&self.bin),
                    String::as_str,
                );
                Err(Fault::new(
                    "git_timeout",
                    format!("{first} timed out after {}ms", self.timeout_ms),
                ))
            }
        }
    }

    /// The environment main built, set as node's spawn sets it.
    fn environment(&self, command: &mut Command) {
        #[cfg(windows)]
        {
            // Windows names are case-insensitive and the main side's object can hold `Path` and `PATH`: node keeps
            // the first in sorted order (`PATH`), where a later `env` call would replace it.
            let mut seen = std::collections::HashSet::new();
            for (name, value) in &self.env {
                if seen.insert(name.to_uppercase()) {
                    command.env(name, value);
                }
            }
        }
        #[cfg(not(windows))]
        command.envs(&self.env);
    }
}

/// Reads `pipe` to its end, keeping its first `max` bytes; past them it asks the process to end (`end`) and drains.
/// The bool says whether bytes were dropped.
async fn read_capped(
    mut pipe: impl AsyncRead + Unpin,
    max: usize,
    end: &Notify,
) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    let mut truncated = false;
    loop {
        let read = match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if truncated {
            continue;
        }
        let room = max - kept.len();
        if read > room {
            kept.extend_from_slice(&chunk[..room]);
            truncated = true;
            end.notify_one();
        } else {
            kept.extend_from_slice(&chunk[..read]);
        }
    }
    (kept, truncated)
}

/// Waits for the process; once asked to end (`end`), sends it SIGTERM and kills it after `KILL_GRACE`.
async fn supervise(mut child: Child, end: &Notify) -> i32 {
    let exited = tokio::select! {
        status = child.wait() => Some(status),
        () = end.notified() => None,
    };
    let status = match exited {
        Some(status) => status,
        None => {
            terminate(&mut child);
            match tokio::time::timeout(KILL_GRACE, child.wait()).await {
                Ok(status) => status,
                Err(_) => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            }
        }
    };
    status.ok().and_then(|status| status.code()).unwrap_or(1)
}

#[cfg(unix)]
fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        crate::sys::terminate(pid);
    }
}

/// node's `kill()` on Windows is TerminateProcess.
#[cfg(windows)]
fn terminate(child: &mut Child) {
    let _ = child.start_kill();
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The runner main hands over, for a git on this machine's PATH.
    pub fn runner() -> Runner {
        let mut env: BTreeMap<String, String> = std::env::vars()
            .filter(|(name, _)| !name.starts_with("GIT_"))
            .collect();
        env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
        env.insert("LC_ALL".into(), "C".into());
        Runner {
            bin: "git".into(),
            args: ["-c", "core.quotepath=false", "-c", "color.ui=false"]
                .map(String::from)
                .to_vec(),
            env,
            timeout_ms: 60_000,
            max_bytes: 8 * 1024 * 1024,
        }
    }

    #[cfg(unix)]
    fn shell(timeout_ms: u64, max_bytes: usize) -> Runner {
        Runner {
            bin: "/bin/sh".into(),
            args: vec!["-c".into()],
            env: BTreeMap::new(),
            timeout_ms,
            max_bytes,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ends_a_process_past_its_timeout_and_names_its_first_argument() {
        let started = std::time::Instant::now();
        let fault = shell(200, 1024)
            .raw("/", &["exec sleep 30"])
            .await
            .err()
            .unwrap();
        assert_eq!(fault.message, "-c timed out after 200ms");
        assert!(started.elapsed() < Duration::from_secs(2));
        // The supervisor, not the caller, ends it: give it the moment it needs before the runtime goes.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_stdout_to_its_cap_and_ends_the_process() {
        let output = shell(10_000, 5)
            .raw("/", &["printf 0123456789; exec sleep 30"])
            .await
            .unwrap();
        assert_eq!(output.stdout, b"01234");
        assert_eq!(output.code, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sets_only_the_environment_it_was_given() {
        let mut runner = shell(10_000, 1024);
        runner.env.insert("ONLY".into(), "this".into());
        let output = runner
            .raw("/", &["echo \"$ONLY-${CARGO_PKG_NAME:-none}\""])
            .await
            .unwrap();
        assert_eq!(output.text(), "this-none\n");
    }

    #[tokio::test]
    async fn reports_a_spawn_failure_as_node_does() {
        let fault = runner()
            .raw("/no/such/folder/here", &["status"])
            .await
            .err()
            .unwrap();
        assert_eq!(fault.message, "spawn git ENOENT");
    }

    #[tokio::test]
    async fn fails_with_git_s_own_words() {
        let dir = std::env::temp_dir();
        let fault = runner()
            .text(dir.to_str().unwrap(), &["no-such-command-here"])
            .await
            .err()
            .unwrap();
        assert!(!fault.message.is_empty());
        assert_eq!(fault.code, "git_failed");
    }
}
