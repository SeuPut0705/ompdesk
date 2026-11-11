//! Running one child process: a git (`git`) or a gh (`gh`). Main decides how every one runs (`gitRunner` and
//! `ghRunner` in `src/main/local/git/exec.ts`): the binary, the arguments before the command's own, the whole
//! environment (the ambient repository selectors already dropped, `PATH` the login shell's, `GIT_OPTIONAL_LOCKS=0`), the
//! timeout and the output cap. A command names only what `execBin`'s callers named: a longer timeout, another cap,
//! variables over the environment, bytes on stdin (`Opts`). This side spawns and supervises as `execBin` did: no shell,
//! stdin closed unless the command gives input (`patch-id`), stdout kept up to the cap (the process is then asked to
//! end), stderr up to 64 KiB, and a process past its timeout asked to end and killed 2 s later. A cancelled request
//! (`Scope`) starts no process, and the one it runs is ended the same way. Either way `run` returns once the process
//! exited, so what the request made for it (a body file, a scratch object store) outlives it; the request's answer
//! waited for that already.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Notify;

use crate::fs::error::uv_code;
use crate::server::{Fault, Scope};

/// How long a process asked to end may ignore it before it is killed outright.
pub const KILL_GRACE: Duration = Duration::from_secs(2);
/// stderr kept for messages.
const STDERR_KEPT: usize = 64 * 1024;

/// How a process runs, as main hands it over with every request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runner {
    pub(crate) bin: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) timeout_ms: u64,
    pub(crate) max_bytes: usize,
}

/// What one process did: `code` 1 when a signal ended it, as node reports `null`.
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

/// What one process sets past the runner's own: its timeout, its output cap, variables over the environment, and the
/// bytes it reads on stdin (none: stdin is closed).
#[derive(Default, Clone, Copy)]
pub struct Opts<'a> {
    pub timeout_ms: Option<u64>,
    pub max_bytes: Option<usize>,
    pub env: &'a [(&'a str, &'a str)],
    pub input: Option<&'a [u8]>,
}

/// The processes of one request: main's runner, held to the request's scope. `tool` names the timeout's fault code
/// (`git_timeout`, `gh_timeout`).
pub struct Exec {
    runner: Runner,
    scope: Scope,
    tool: &'static str,
}

impl Exec {
    pub fn new(runner: Runner, scope: Scope, tool: &'static str) -> Exec {
        Exec {
            runner,
            scope,
            tool,
        }
    }

    /// A variable of the environment main handed over (the ambient repository selectors already dropped).
    pub fn env(&self, name: &str) -> Option<&str> {
        self.runner.env.get(name).map(String::as_str)
    }

    /// Answers whatever the exit code; fails only when the process could not run, ran past its timeout or the request
    /// was cancelled.
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
            .stdin(if opts.input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
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
            return Err(Fault::new("internal", "the process's pipes were not open"));
        };
        let stdin = child.stdin.take();
        let input = opts.input.map(<[u8]>::to_vec);
        let end = Arc::new(Notify::new());
        let ending = Arc::clone(&end);
        // Its own task, holding the request's scope until the process is reaped: the request answers only once it
        // exited, also when the future of this call is dropped (a sibling of a `try_join!` failed).
        let scope = self.scope.clone();
        let mut work = tokio::spawn(async move {
            // stderr past its cap is dropped; nothing waits on this, so it never ends the process.
            let ignored = Notify::new();
            let ((stdout, truncated), (stderr, _), code, ()) = tokio::join!(
                read_capped(stdout, max_bytes, &ending),
                read_capped(stderr, STDERR_KEPT, &ignored),
                supervise(child, &ending, &scope),
                feed(stdin, input),
            );
            Output {
                code,
                stdout,
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                truncated,
            }
        });
        let reaped = match tokio::time::timeout(Duration::from_millis(timeout_ms), &mut work).await
        {
            Ok(reaped) => reaped,
            Err(_) => {
                end.notify_one();
                let _ = work.await;
                // `execBin` names the process's first argument (`-c` for every git).
                let first = runner.args.first().map_or_else(
                    || args.first().copied().unwrap_or(&runner.bin),
                    String::as_str,
                );
                return Err(Fault::new(
                    Cow::Owned(format!("{}_timeout", self.tool)),
                    format!("{first} timed out after {timeout_ms}ms"),
                ));
            }
        };
        match reaped {
            Ok(_) if self.scope.cancelled() => Err(Fault::cancelled()),
            Ok(output) => Ok(output),
            Err(_) => Err(Fault::new("internal", "the process's supervisor failed")),
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

/// Writes `input` to the process's stdin, then closes it. A process that exits before reading all of it closes the
/// pipe: its exit code says so, not this write (`execBin` ignored the pipe's error too).
async fn feed(stdin: Option<ChildStdin>, input: Option<Vec<u8>>) {
    if let (Some(mut stdin), Some(input)) = (stdin, input) {
        let _ = stdin.write_all(&input).await;
    }
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

    /// A runner of `/bin/sh -c`, so a test's script is the process.
    #[cfg(unix)]
    pub fn shell(timeout_ms: u64, max_bytes: usize) -> Runner {
        Runner {
            bin: "/bin/sh".into(),
            args: vec!["-c".into()],
            env: BTreeMap::new(),
            timeout_ms,
            max_bytes,
        }
    }

    fn exec(runner: Runner, scope: Scope) -> Exec {
        Exec::new(runner, scope, "git")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ends_a_process_past_its_timeout_names_its_first_argument_and_returns_once_it_exited() {
        let pid_file =
            std::env::temp_dir().join(format!("ompdesk-core-timeout-{}", std::process::id()));
        let script = format!(
            "trap '' TERM; echo $$ > '{}'; exec sleep 30",
            pid_file.display()
        );
        let started = std::time::Instant::now();
        let fault = exec(shell(300, 1024), Scope::detached())
            .run("/", &[script.as_str()], Opts::default())
            .await
            .err()
            .unwrap();
        assert_eq!(fault.message, "-c timed out after 300ms");
        assert_eq!(fault.code, "git_timeout");
        assert!(started.elapsed() >= KILL_GRACE, "returned before the kill");
        let pid = std::fs::read_to_string(&pid_file).unwrap();
        let alive = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the process outlived its timeout's fault");
        let _ = std::fs::remove_file(pid_file);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn names_the_command_s_first_argument_when_the_runner_has_none() {
        let runner = Runner {
            bin: "/bin/sleep".into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            timeout_ms: 100,
            max_bytes: 1024,
        };
        let fault = Exec::new(runner, Scope::detached(), "gh")
            .run("/", &["30"], Opts::default())
            .await
            .err()
            .unwrap();
        assert_eq!(fault.message, "30 timed out after 100ms");
        assert_eq!(fault.code, "gh_timeout");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_stdout_to_its_cap_and_ends_the_process() {
        let output = exec(shell(10_000, 5), Scope::detached())
            .run("/", &["printf 0123456789; exec sleep 30"], Opts::default())
            .await
            .unwrap();
        assert_eq!(output.stdout, b"01234");
        assert!(output.truncated);
        assert_eq!(output.code, 1);
    }

    /// More input than a pipe holds, read while the output is read (`patch-id`), and input a process never reads.
    #[cfg(unix)]
    #[tokio::test]
    async fn feeds_its_input_on_stdin_and_survives_a_process_that_reads_none() {
        let input = vec![b'x'; 1024 * 1024];
        let opts = Opts {
            input: Some(&input),
            ..Opts::default()
        };
        let exec = exec(shell(10_000, 2 * 1024 * 1024), Scope::detached());
        let output = exec.run("/", &["cat"], opts).await.unwrap();
        assert_eq!(output.stdout, input);
        let output = exec.run("/", &["exit 4"], opts).await.unwrap();
        assert_eq!(output.code, 4);
        let output = exec.run("/", &["wc -c"], Opts::default()).await.unwrap();
        assert_eq!(output.text().trim(), "0");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sets_only_the_environment_it_was_given_and_the_command_s_own_over_it() {
        let mut runner = shell(10_000, 1024);
        runner.env.insert("ONLY".into(), "this".into());
        runner.env.insert("MINE".into(), "runner".into());
        let exec = exec(runner, Scope::detached());
        let output = exec
            .run(
                "/",
                &["echo \"$ONLY-${CARGO_PKG_NAME:-none}-$MINE\""],
                Opts::default(),
            )
            .await
            .unwrap();
        assert_eq!(output.text(), "this-none-runner\n");
        let opts = Opts {
            timeout_ms: Some(5_000),
            env: &[("MINE", "command")],
            ..Opts::default()
        };
        let output = exec.run("/", &["echo \"$MINE\""], opts).await.unwrap();
        assert_eq!(output.text(), "command\n");
        assert!(!output.truncated);
    }

    #[tokio::test]
    async fn reports_a_spawn_failure_as_node_does() {
        let runner = Runner {
            bin: "git".into(),
            args: Vec::new(),
            env: std::env::vars().collect(),
            timeout_ms: 60_000,
            max_bytes: 1024,
        };
        let fault = exec(runner, Scope::detached())
            .run("/no/such/folder/here", &["status"], Opts::default())
            .await
            .err()
            .unwrap();
        assert_eq!(fault.message, "spawn git ENOENT");
        assert_eq!(fault.code, "spawn_failed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn starts_no_process_once_its_request_was_cancelled() {
        let scope = Scope::detached();
        scope.cancel();
        let marker =
            std::env::temp_dir().join(format!("ompdesk-core-started-{}", std::process::id()));
        let script = format!("touch '{}'", marker.display());
        let fault = exec(shell(10_000, 1024), scope)
            .run("/", &[script.as_str()], Opts::default())
            .await
            .err()
            .unwrap();
        assert_eq!(fault, Fault::cancelled());
        assert!(!marker.exists(), "a cancelled request started a process");
    }

    /// A process that ignores SIGTERM: a cancel sends it, the kill 2 s later ends it, and only then the caller hears.
    #[cfg(unix)]
    #[tokio::test]
    async fn ends_the_running_process_of_a_cancelled_request_and_answers_once_it_exited() {
        let pid_file =
            std::env::temp_dir().join(format!("ompdesk-core-cancel-{}", std::process::id()));
        let script = format!(
            "trap '' TERM; echo $$ > '{}'; exec sleep 30",
            pid_file.display()
        );
        let scope = Scope::detached();
        let exec = exec(shell(60_000, 1024), scope.clone());
        let started = std::time::Instant::now();
        let args = [script.as_str()];
        let (outcome, pid) = tokio::join!(exec.run("/", &args, Opts::default()), async {
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
        assert!(!alive, "the process outlived its answer");
        let _ = std::fs::remove_file(pid_file);
    }
}
