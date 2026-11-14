//! Starting one omp and the tasks that serve it: the writer of its stdin, the owner of the child (its exit, the
//! signals asked of it) and the readers of its two pipes. Main hands in how it starts (`sidecar.launched`): the binary,
//! its arguments, the whole environment and the folder; a `.cmd` shim on Windows runs as node's `shell: true` runs it.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch};

use super::frames::Lines;
use super::stop::{Proc, Signal, StdinMsg, Timing};
use crate::fs::error::uv_code;
use crate::run::{Runner, terminate};

/// How an omp starts, as main answered the launch ask.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub bin: String,
    pub args: Vec<String>,
    /// The child's whole environment: nothing of the core's own is added.
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    /// A `.cmd`/`.bat` shim (Windows): `bin` and `args` are already quoted for `cmd.exe`, which runs the line.
    #[serde(default)]
    #[cfg_attr(not(windows), allow(dead_code))]
    pub shell: bool,
}

/// How a child ended.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Exit {
    /// The exit code; none for a process a signal ended.
    pub code: Option<i64>,
    pub signal: Option<i32>,
}

/// A started omp: its shared handle and the pipes the lane reads.
pub struct Started {
    pub proc: Arc<Proc>,
    pub receipt: watch::Receiver<Option<Result<(), crate::server::Fault>>>,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

/// node's name for a signal number (`child.on("exit", (code, signal))`).
pub fn signal_name(signal: i32) -> String {
    #[cfg(unix)]
    {
        let table = [
            (libc::SIGHUP, "SIGHUP"),
            (libc::SIGINT, "SIGINT"),
            (libc::SIGQUIT, "SIGQUIT"),
            (libc::SIGILL, "SIGILL"),
            (libc::SIGTRAP, "SIGTRAP"),
            (libc::SIGABRT, "SIGABRT"),
            (libc::SIGBUS, "SIGBUS"),
            (libc::SIGFPE, "SIGFPE"),
            (libc::SIGKILL, "SIGKILL"),
            (libc::SIGUSR1, "SIGUSR1"),
            (libc::SIGSEGV, "SIGSEGV"),
            (libc::SIGUSR2, "SIGUSR2"),
            (libc::SIGPIPE, "SIGPIPE"),
            (libc::SIGALRM, "SIGALRM"),
            (libc::SIGTERM, "SIGTERM"),
        ];
        if let Some((_, name)) = table.iter().find(|(number, _)| *number == signal) {
            return (*name).to_owned();
        }
    }
    format!("SIG{signal}")
}

fn command(start: &Start) -> Command {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt as _;
    let runner = Runner {
        bin: start.bin.clone(),
        args: Vec::new(),
        env: start.env.clone(),
        timeout_ms: 0,
        max_bytes: 0,
    };
    let mut command;
    #[cfg(windows)]
    if start.shell {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        command = Command::new(shell);
        let mut line = start.bin.clone();
        for arg in &start.args {
            line.push(' ');
            line.push_str(arg);
        }
        command.as_std_mut().raw_arg(format!("/d /s /c \"{line}\""));
    } else {
        command = Command::new(&start.bin);
        command.args(&start.args);
    }
    #[cfg(not(windows))]
    {
        command = Command::new(&start.bin);
        command.args(&start.args);
    }
    command
        .current_dir(&start.cwd)
        .env_clear()
        // Open pipes: omp exits when its stdin closes, so it never outlives the core.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    runner.environment(&mut command, &[]);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // A process group (a session) of its own, so the kill at the end of a stop takes the tools it started with it.
    #[cfg(unix)]
    crate::sys::new_session(command.as_std_mut());
    command
}

/// The failure of a start, as node worded it (`spawn <bin> ENOENT`).
fn refused(start: &Start, error: &std::io::Error) -> String {
    format!("spawn {} {}", start.bin, uv_code(error))
}

/// Writes the lines to the omp's stdin in order; the pipe closes at `End` or when the omp is gone.
async fn write_stdin(mut stdin: ChildStdin, mut msgs: mpsc::UnboundedReceiver<StdinMsg>) {
    while let Some(msg) = msgs.recv().await {
        match msg {
            StdinMsg::Line(line) => {
                if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
            StdinMsg::End => break,
        }
    }
}

/// Starts the omp. `on_exit` runs once, when the child exited (and before `Proc::exited` is read by anything that
/// waits on the lane's own message: the flag turns true first).
pub fn start(
    start: &Start,
    timing: Timing,
    on_exit: impl FnOnce(Exit) + Send + 'static,
) -> Result<Started, String> {
    let mut child = command(start)
        .spawn()
        .map_err(|error| refused(start, &error))?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(format!("spawn {} the pipes were not open", start.bin));
    };
    let pid = child.id();
    let (lines, written) = mpsc::unbounded_channel();
    tokio::spawn(write_stdin(stdin, written));
    let (signals, mut asked) = mpsc::unbounded_channel::<Signal>();
    let (exit, exited) = watch::channel(false);
    let (receipt, received) = watch::channel(None);
    tokio::spawn(async move {
        let status = loop {
            tokio::select! {
                status = child.wait() => break status,
                Some(Signal::Term) = asked.recv() => terminate(&mut child),
            }
        };
        let info = match status {
            Ok(status) => {
                receipt.send_replace(Some(Ok(())));
                exit.send_replace(true);
                exit_of(status)
            }
            Err(error) => {
                receipt.send_replace(Some(Err(crate::server::Fault::new(
                    "child_wait_failed",
                    error.to_string(),
                ))));
                Exit {
                    code: Some(1),
                    signal: None,
                }
            }
        };
        on_exit(info);
    });
    Ok(Started {
        proc: Proc::new(pid, exited, lines, signals, timing),
        receipt: received,
        stdout,
        stderr,
    })
}

#[cfg(unix)]
fn exit_of(status: std::process::ExitStatus) -> Exit {
    use std::os::unix::process::ExitStatusExt;
    Exit {
        code: status.code().map(i64::from),
        signal: status.signal(),
    }
}

#[cfg(windows)]
fn exit_of(status: std::process::ExitStatus) -> Exit {
    // Node reports the 32-bit code unsigned (`3221225786`), not as the signed number Rust's `code()` gives.
    Exit {
        code: status.code().map(|code| i64::from(code as u32)),
        signal: None,
    }
}

/// Reads the omp's stderr to its end, handing each chunk (decoded as node decodes a chunk) to `each` after the exit
/// hold saw it. Returns when the pipe closed.
pub async fn pump_stderr(mut stderr: ChildStderr, proc: Arc<Proc>, mut each: impl FnMut(String)) {
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buffer[..n]).into_owned();
                proc.feed_stderr(&text);
                each(text);
            }
        }
    }
}

/// Reads the omp's stdout to its end, handing each line (its end cut off) to `each`.
pub async fn pump_stdout(mut stdout: ChildStdout, mut each: impl FnMut(&[u8])) {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut lines = Lines::default();
    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) | Err(_) => {
                lines.finish(&mut each);
                return;
            }
            Ok(n) => lines.push(&buffer[..n], &mut each),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A `.cmd` omp (npm's shim), in a folder with a space, started as node's `shell: true` starts it: through
    /// `cmd.exe /d /s /c "<bin> <args>"`, `bin` and each argument already quoted as main sends them.
    #[tokio::test]
    async fn runs_a_cmd_shim_through_cmd_exe_with_the_quoting_main_sent() {
        let dir = std::env::temp_dir().join(format!("ompdesk-core-shim-{}", std::process::id()));
        let folder = dir.join("fake omp");
        std::fs::create_dir_all(&folder).unwrap();
        let shim = folder.join("omp.cmd");
        std::fs::write(
            &shim,
            "@echo off\r\necho %* > args.txt\r\necho up\r\nfindstr \"^\" > nul\r\n",
        )
        .unwrap();
        let how = Start {
            bin: format!("\"{}\"", shim.display()),
            args: vec!["\"--mode\"".into(), "\"rpc-ui\"".into(), "\"a b\"".into()],
            env: std::env::vars().collect(),
            cwd: folder.to_string_lossy().into_owned(),
            shell: true,
        };
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        let started = start(&how, Timing::default(), move |exit| {
            let _ = exit_tx.send(exit);
        })
        .unwrap();
        let (up_tx, up_rx) = tokio::sync::oneshot::channel();
        let mut up = Some(up_tx);
        tokio::spawn(pump_stdout(started.stdout, move |line| {
            if line == b"up"
                && let Some(up) = up.take()
            {
                let _ = up.send(());
            }
        }));
        tokio::spawn(pump_stderr(
            started.stderr,
            Arc::clone(&started.proc),
            |_| {},
        ));
        tokio::time::timeout(std::time::Duration::from_secs(30), up_rx)
            .await
            .unwrap()
            .unwrap();
        let args = std::fs::read_to_string(folder.join("args.txt")).unwrap();
        assert_eq!(args.trim(), "\"--mode\" \"rpc-ui\" \"a b\"");
        // Its stdin ends: the shim ends with it.
        started.proc.stop(std::time::Duration::from_secs(10));
        let exit = tokio::time::timeout(std::time::Duration::from_secs(30), exit_rx)
            .await
            .unwrap()
            .unwrap();
        // `findstr` found no line to match at the end of input, so the shim's own code is 1: what matters is that it ended.
        assert!(exit.code.is_some(), "{exit:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
