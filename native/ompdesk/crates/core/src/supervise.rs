//! `ompdesk-core --supervise`: the process main starts beside every command that must neither outlive the app nor
//! leave anything behind when stopped (an installer, a scheduled omp run, ai-memory's `setup`, Autopilot's land
//! check, a worktree hook; `spawnSupervised` in `src/main/setup/supervisor.ts`). Installers neither watch stdin nor die
//! with the app, so this process holds the command, passes its output through, and ends the command's whole tree when
//! its own stdin closes: a cancel (main ends stdin), an app quit, or a crash of the app that skips every quit handler.
//! It then exits `STOPPED`; otherwise with the command's exit code.
//!
//! The tree: on POSIX the command leads a session and process group of its own (`setsid`, node's `detached`), which a
//! stop signals (SIGTERM, SIGKILL 2 s later) and which is killed once the command exited, so a descendant that outlived
//! it goes with its group. On Windows the command starts suspended and runs only once it is in a job of its own, which
//! every process it starts joins; a stop ends the job at once and waits until it is empty. The job also ends with this
//! process, however it ends: main's libuv puts this process in its own kill-on-close job, so a crash of the app ends
//! this process before it reads its stdin's end, and the job's last handle closing then ends the tree. An isolated
//! command's job (`isolated`) does not end with this process: its descendant (ai-memory's service host) is meant to
//! outlive it, and only a stop ends that tree.
//!
//! The command comes from `OMPDESK_SETUP_SPEC` (`{file, args, shell, inputFile?, log?, isolated?}` JSON), never from
//! argv. `inputFile` becomes the command's stdin (else it gets none). `log` is the output file of an isolated command
//! (`SpawnSpec.isolated`, `isolatedLaunch`): with `redirect` the command writes its stdout and stderr there; either way
//! the file's bytes become this process's output once the command exited, and the file is removed.

use std::fs::File;
use std::io::{self, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use serde::Deserialize;

use crate::fs::error::{NodeError, uv_code};

/// The variable the command arrives in (`SUPERVISOR_SPEC_ENV`), left out of the command's own environment.
const SPEC_ENV: &str = "OMPDESK_SETUP_SPEC";
/// The exit status after a stop ended the command (`SUPERVISOR_STOPPED_CODE`).
const STOPPED: i32 = 130;
/// The exit status when the command could not start, as a shell's.
const NOT_STARTED: i32 = 127;
/// How long a stopped command's group has between SIGTERM and SIGKILL.
#[cfg(unix)]
const KILL_AFTER: Duration = Duration::from_secs(2);
/// How long a stop waits for the ended job to be empty before this process exits anyway.
#[cfg(windows)]
const EMPTY_WITHIN: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
struct Spec {
    file: String,
    args: Vec<String>,
    #[serde(default)]
    shell: bool,
    #[serde(default, rename = "inputFile")]
    input_file: Option<String>,
    #[serde(default)]
    log: Option<Log>,
    /// Only Windows reads it: on POSIX the group is killed once the command exited, which a detached (`setsid`)
    /// service host has left.
    #[cfg(windows)]
    #[serde(default)]
    isolated: bool,
}

#[derive(Deserialize)]
struct Log {
    path: String,
    redirect: bool,
}

enum Event {
    /// stdin closed, or (POSIX) SIGTERM or SIGINT arrived.
    Stop,
    Exited(io::Result<ExitStatus>),
}

/// Runs the mode to its end; the exit status this process ends with.
pub fn run() -> i32 {
    // Before any thread starts, so every one of them leaves the signals to the one that waits for them.
    #[cfg(unix)]
    let signals = crate::sys::StopSignals::block();
    let spec = match std::env::var(SPEC_ENV)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str::<Spec>(&text).map_err(|error| error.to_string()))
    {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("ompdesk-core --supervise: no command in {SPEC_ENV}: {error}");
            return NOT_STARTED;
        }
    };
    let held = match start(&spec) {
        Ok(held) => held,
        Err(message) => {
            drop_log(&spec);
            eprintln!("{message}");
            return NOT_STARTED;
        }
    };
    let Held {
        mut child,
        #[cfg(windows)]
        tree,
    } = held;
    #[cfg(unix)]
    let pid = child.id();
    let (events, received) = mpsc::channel();
    let stop = events.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buffer = [0; 512];
        while matches!(stdin.read(&mut buffer), Ok(read) if read > 0) {}
        // The receiver lives until this process exits.
        let _ = stop.send(Event::Stop);
    });
    #[cfg(unix)]
    if let Ok(signals) = signals {
        let stop = events.clone();
        thread::spawn(move || {
            loop {
                signals.wait();
                if stop.send(Event::Stop).is_err() {
                    break;
                }
            }
        });
    }
    thread::spawn(move || {
        let _ = events.send(Event::Exited(child.wait()));
    });

    let mut stopping = false;
    #[cfg(unix)]
    let mut kill_at: Option<Instant> = None;
    let status = loop {
        #[cfg(unix)]
        let event = match kill_at {
            Some(at) => match received.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    crate::sys::signal_group(pid, true);
                    kill_at = None;
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            },
            None => match received.recv() {
                Ok(event) => event,
                Err(_) => break None,
            },
        };
        #[cfg(windows)]
        let Ok(event) = received.recv() else {
            break None;
        };
        match event {
            Event::Stop if !stopping => {
                stopping = true;
                #[cfg(unix)]
                {
                    crate::sys::signal_group(pid, false);
                    kill_at = Some(Instant::now() + KILL_AFTER);
                }
                #[cfg(windows)]
                tree.end();
            }
            Event::Stop => {}
            Event::Exited(status) => break status.ok(),
        }
    };
    // A descendant that outlived the command goes with its group.
    #[cfg(unix)]
    crate::sys::signal_group(pid, true);
    // The command ending is not its tree ending: report the stop only once nothing of it runs.
    #[cfg(windows)]
    if stopping {
        let since = std::time::Instant::now();
        while tree.alive() && since.elapsed() < EMPTY_WITHIN {
            tree.end();
            thread::sleep(Duration::from_millis(50));
        }
    }
    let code = if stopping {
        STOPPED
    } else {
        status.and_then(|status| status.code()).unwrap_or(1)
    };
    if let Some(log) = &spec.log {
        let text = std::fs::read(&log.path).unwrap_or_default();
        drop_log(&spec);
        let mut stdout = io::stdout().lock();
        // Nobody may read any more (main is gone): the status still says how the command ended.
        let _ = stdout.write_all(&text).and_then(|()| stdout.flush());
    }
    code
}

/// The started command; on Windows with its job.
struct Held {
    child: Child,
    #[cfg(windows)]
    tree: crate::sys::ProcessTree,
}

/// Starts the command as node's `spawn(file, args, {stdio, detached: !windows, shell, windowsHide: true})` did; a
/// failure is the message node gave (`spawn <file> ENOENT`, `ENOENT: no such file or directory, open '<path>'`).
fn start(spec: &Spec) -> Result<Held, String> {
    let (mut command, program) = if spec.shell {
        shell_command(spec)
    } else {
        let mut command = Command::new(&spec.file);
        command.args(&spec.args);
        (command, spec.file.clone())
    };
    command.env_remove(SPEC_ENV);
    let input = match spec.input_file.as_deref().filter(|path| !path.is_empty()) {
        Some(path) => Stdio::from(File::open(path).map_err(|error| opening(&error, path))?),
        None => Stdio::null(),
    };
    command.stdin(input);
    if let Some(log) = spec.log.as_ref().filter(|log| log.redirect) {
        // One file for both, so the two streams keep their order of arrival.
        let output = File::create(&log.path).map_err(|error| opening(&error, &log.path))?;
        let errors = output
            .try_clone()
            .map_err(|error| opening(&error, &log.path))?;
        command.stdout(output).stderr(errors);
    }
    #[cfg(unix)]
    crate::sys::new_session(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // std looks a bare name up in the PATH it was handed before its own places (the system folders), as libuv
        // looks in the command's PATH.
        if let Some((name, value)) =
            std::env::vars_os().find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
        {
            command.env(name, value);
        }
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("spawn {program} {}", uv_code(&error)))?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        // Suspended until it is in the job, so nothing it starts escapes the tree.
        let tree = if spec.isolated {
            crate::sys::ProcessTree::outliving(child.as_raw_handle())
        } else {
            crate::sys::ProcessTree::of(child.as_raw_handle())
        };
        let held = tree.and_then(|tree| {
            crate::sys::resume_process(child.id())?;
            Ok(tree)
        });
        match held {
            Ok(tree) => Ok(Held { child, tree }),
            Err(error) => {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                Err(format!(
                    "spawn {program}: cannot hold its process tree: {error}"
                ))
            }
        }
    }
    #[cfg(unix)]
    Ok(Held { child })
}

/// The command through the shell, as node's `shell: true` runs it: `[file, ...args]` joined by spaces, given to
/// `/bin/sh -c`, on Windows to `%ComSpec% /d /s /c "…"` verbatim (callers quote for cmd.exe).
fn shell_command(spec: &Spec) -> (Command, String) {
    let mut line = spec.file.clone();
    for arg in &spec.args {
        line.push(' ');
        line.push_str(arg);
    }
    #[cfg(unix)]
    {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(line);
        (command, "/bin/sh".to_owned())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned());
        let mut command = Command::new(&shell);
        command.raw_arg(format!("/d /s /c \"{line}\""));
        (command, shell)
    }
}

fn opening(error: &io::Error, path: &str) -> String {
    NodeError::new(error, "open", Some(path)).message
}

fn drop_log(spec: &Spec) {
    if let Some(log) = &spec.log {
        let _ = std::fs::remove_file(&log.path);
    }
}
