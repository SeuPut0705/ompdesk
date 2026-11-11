//! Running one git. Main decides how every git runs (`gitRunner` in `src/main/local/git/exec.ts`, which its own
//! runner follows too): the binary, the arguments before the command's own, the whole environment (the ambient
//! repository selectors already dropped, `PATH` the login shell's, `GIT_OPTIONAL_LOCKS=0`), the timeout and the output
//! cap. A command names only what `execBin`'s callers named: a longer timeout, another cap, variables over the
//! environment (`Opts`). This side spawns and supervises as `execBin` does: no shell, stdin closed, stdout kept up to
//! the cap (the process is then asked to end), stderr up to 64 KiB, and a process past its timeout asked to end and
//! killed 2 s later while the caller hears of the timeout at once. A cancelled request (`Scope`) starts no git, and
//! the one it runs is ended the same way; its caller hears of it once the process exited.

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
use crate::server::{Fault, Scope};

/// How long a process asked to end may ignore it before it is killed outright.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// stderr kept for messages.
const STDERR_KEPT: usize = 64 * 1024;

/// How a git runs, as main hands it over with every request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runner {
    bin: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    timeout_ms: u64,
    max_bytes: usize,
}

/// The gits of one request: main's runner, held to the request's scope.
pub struct Git {
    runner: Runner,
    scope: Scope,
}

/// What one git did: `code` 1 when a signal ended it, as node reports `null`.
pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
    /// stdout passed the cap and the process was asked to end.
    pub truncated: bool,
}

impl Output {
    /// stdout as node's `toString("utf8")` reads it.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// What one git sets past the runner's own: its timeout, its output cap, variables over the environment.
#[derive(Default, Clone, Copy)]
pub struct Opts<'a> {
    pub timeout_ms: Option<u64>,
    pub max_bytes: Option<usize>,
    pub env: &'a [(&'a str, &'a str)],
}

/// `GitCommandError`: git's stderr, else `git <command> exited with code <n>`. Its code is no app code: main's
/// callers read the message, a mutation reports it as `git_failed`.
pub fn failure(args: &[&str], output: &Output) -> Fault {
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
    Fault::new("git_exit", message)
}

impl Git {
    pub fn new(runner: Runner, scope: Scope) -> Git {
        Git { runner, scope }
    }

    /// `gitRaw`: answers whatever git's exit code; fails only when git could not run, ran past its timeout or the
    /// request was cancelled.
    pub async fn raw(&self, cwd: &str, args: &[&str]) -> Result<Output, Fault> {
        self.run(cwd, args, Opts::default()).await
    }

    /// `gitRaw` with its own output cap.
    pub async fn capped(
        &self,
        cwd: &str,
        args: &[&str],
        max_bytes: usize,
    ) -> Result<Output, Fault> {
        let opts = Opts {
            max_bytes: Some(max_bytes),
            ..Opts::default()
        };
        self.run(cwd, args, opts).await
    }

    /// `git`: stdout as text; git's own failure is a fault with its stderr (`GitCommandError`'s message).
    pub async fn text(&self, cwd: &str, args: &[&str]) -> Result<String, Fault> {
        self.text_with(cwd, args, Opts::default()).await
    }

    /// `git` with its own settings.
    pub async fn text_with(
        &self,
        cwd: &str,
        args: &[&str],
        opts: Opts<'_>,
    ) -> Result<String, Fault> {
        let output = self.run(cwd, args, opts).await?;
        if output.code != 0 {
            return Err(failure(args, &output));
        }
        Ok(output.text())
    }

    pub async fn run(&self, cwd: &str, args: &[&str], opts: Opts<'_>) -> Result<Output, Fault> {
        if self.scope.cancelled() {
            return Err(Fault::cancelled());
        }
        let runner = &self.runner;
        let timeout_ms = opts.timeout_ms.unwrap_or(runner.timeout_ms);
        let max_bytes = opts.max_bytes.unwrap_or(runner.max_bytes);
        let mut command = Command::new(&runner.bin);
        command
            .args(&runner.args)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        runner.environment(&mut command, opts.env);
        #[cfg(windows)]
        {
            // libuv's `windowsHide` with no inherited stdio: no console window for a console program.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| {
            Fault::new(
                "spawn_failed",
                format!("spawn {} {}", runner.bin, uv_code(&error)),
            )
        })?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err(Fault::new("internal", "git's pipes were not open"));
        };
        let end = Arc::new(Notify::new());
        let ending = Arc::clone(&end);
        // Its own task, holding the request's scope until the process is reaped: a git that timed out or was
        // cancelled is still ended after its caller heard, and the request answers only once it exited.
        let scope = self.scope.clone();
        let work = tokio::spawn(async move {
            // stderr past its cap is dropped; nothing waits on this, so it never ends the process.
            let ignored = Notify::new();
            let ((stdout, truncated), (stderr, _), code) = tokio::join!(
                read_capped(stdout, max_bytes, &ending),
                read_capped(stderr, STDERR_KEPT, &ignored),
                supervise(child, &ending, &scope),
            );
            Output {
                code,
                stdout,
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                truncated,
            }
        });
        match tokio::time::timeout(Duration::from_millis(timeout_ms), work).await {
            Ok(Ok(_)) if self.scope.cancelled() => Err(Fault::cancelled()),
            Ok(Ok(output)) => Ok(output),
            Ok(Err(_)) => Err(Fault::new("internal", "git's supervisor failed")),
            Err(_) => {
                end.notify_one();
                // `execBin` names the process's first argument (`-c` for every git).
                let first = runner.args.first().map_or_else(
                    || args.first().copied().unwrap_or(&runner.bin),
                    String::as_str,
                );
                Err(Fault::new(
                    "git_timeout",
                    format!("{first} timed out after {timeout_ms}ms"),
                ))
            }
        }
    }
}

impl Runner {
    /// The environment main built with the command's own variables over it, set as node's spawn sets it.
    fn environment(&self, command: &mut Command, extra: &[(&str, &str)]) {
        let merged;
        let env = if extra.is_empty() {
            &self.env
        } else {
            let mut env = self.env.clone();
            for (name, value) in extra {
                env.insert((*name).to_owned(), (*value).to_owned());
            }
            merged = env;
            &merged
        };
        #[cfg(windows)]
        {
            // Windows names are case-insensitive and the main side's object can hold `Path` and `PATH`: node keeps
            // the first in sorted order (`PATH`), where a later `env` call would replace it.
            let mut seen = std::collections::HashSet::new();
            for (name, value) in env {
                if seen.insert(name.to_uppercase()) {
                    command.env(name, value);
                }
            }
        }
        #[cfg(not(windows))]
        command.envs(env);
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

/// Waits for the process; once asked to end (`end`, or its request cancelled), sends it SIGTERM and kills it after
/// `KILL_GRACE`.
async fn supervise(mut child: Child, end: &Notify, scope: &Scope) -> i32 {
    let exited = tokio::select! {
        status = child.wait() => Some(status),
        () = end.notified() => None,
        () = scope.on_cancel() => None,
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

    /// That runner outside any request.
    pub fn git() -> Git {
        Git::new(runner(), Scope::detached())
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
        let fault = Git::new(shell(200, 1024), Scope::detached())
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
        let output = Git::new(shell(10_000, 5), Scope::detached())
            .raw("/", &["printf 0123456789; exec sleep 30"])
            .await
            .unwrap();
        assert_eq!(output.stdout, b"01234");
        assert!(output.truncated);
        assert_eq!(output.code, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sets_only_the_environment_it_was_given_and_the_command_s_own_over_it() {
        let mut runner = shell(10_000, 1024);
        runner.env.insert("ONLY".into(), "this".into());
        runner.env.insert("MINE".into(), "runner".into());
        let git = Git::new(runner, Scope::detached());
        let output = git
            .raw("/", &["echo \"$ONLY-${CARGO_PKG_NAME:-none}-$MINE\""])
            .await
            .unwrap();
        assert_eq!(output.text(), "this-none-runner\n");
        let opts = Opts {
            timeout_ms: Some(5_000),
            env: &[("MINE", "command")],
            ..Opts::default()
        };
        let output = git.run("/", &["echo \"$MINE\""], opts).await.unwrap();
        assert_eq!(output.text(), "command\n");
        assert!(!output.truncated);
    }

    #[tokio::test]
    async fn reports_a_spawn_failure_as_node_does() {
        let fault = git()
            .raw("/no/such/folder/here", &["status"])
            .await
            .err()
            .unwrap();
        assert_eq!(fault.message, "spawn git ENOENT");
    }

    #[tokio::test]
    async fn fails_with_git_s_own_words() {
        let dir = std::env::temp_dir();
        let fault = git()
            .text(dir.to_str().unwrap(), &["no-such-command-here"])
            .await
            .err()
            .unwrap();
        assert!(!fault.message.is_empty());
        assert_eq!(fault.code, "git_exit");
        let empty = Output {
            code: 3,
            stdout: Vec::new(),
            stderr: " \n".into(),
            truncated: false,
        };
        assert_eq!(
            failure(&["push", "x"], &empty).message,
            "git push exited with code 3"
        );
    }

    #[tokio::test]
    async fn starts_no_git_once_its_request_was_cancelled() {
        let scope = Scope::detached();
        scope.cancel();
        let fault = Git::new(runner(), scope)
            .raw("/no/such/folder/here", &["status"])
            .await
            .err()
            .unwrap();
        assert_eq!(fault, Fault::cancelled());
    }

    /// A process that ignores SIGTERM: a cancel sends it, the kill 2 s later ends it, and only then the caller hears.
    #[cfg(unix)]
    #[tokio::test]
    async fn ends_the_running_git_of_a_cancelled_request_and_answers_once_it_exited() {
        let pid_file =
            std::env::temp_dir().join(format!("ompdesk-core-cancel-{}", std::process::id()));
        let script = format!(
            "trap '' TERM; echo $$ > '{}'; exec sleep 30",
            pid_file.display()
        );
        let scope = Scope::detached();
        let git = Git::new(shell(60_000, 1024), scope.clone());
        let started = std::time::Instant::now();
        let args = [script.as_str()];
        let (outcome, pid) = tokio::join!(git.raw("/", &args), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file)
                    && let Ok(pid) = text.trim().parse::<u32>()
                {
                    scope.cancel();
                    return pid;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        assert_eq!(outcome.err().unwrap(), Fault::cancelled());
        assert!(started.elapsed() >= KILL_GRACE, "answered before the kill");
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the git outlived its answer");
        let _ = std::fs::remove_file(pid_file);
    }
}
