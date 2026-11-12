//! ai-memory's per-user service as the operating system sees it: the launchd LaunchAgent (macOS) or the HKCU `Run`
//! logon entry (Windows) that `ai-memory setup` installs. ai-memory has no command that stops or removes only its
//! service (`uninstall` also removes every agent's wiring), so OMPdesk asks the OS. `ours` (the unit runs a binary
//! OMPdesk staged, `<tools>/ai-memory/…`, or the one in use) tells a unit `setup` may repoint from one that runs
//! someone else's ai-memory, which OMPdesk removes before installing its own: only OMPdesk's own build serves.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::Boxed;
use super::terminal::{read_text, within_path};
use super::text::first_field;
use crate::fs::order::{is_js_space, js_trim};

pub const LAUNCHD_LABEL: &str = "com.github.akitaonrails.ai-memory";
const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "ai-memory";
/// How long one `launchctl`, `reg` or `taskkill` may take.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

/// What the OS holds of ai-memory's service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub struct ServiceUnit {
    /// ai-memory's unit exists for this user.
    pub installed: bool,
    /// ...and runs a binary OMPdesk staged.
    pub ours: bool,
}

/// One command's exit code and stdout; a command that cannot start or runs past its time is a failure (code 1).
pub struct Exit {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `file` with `args` (no shell, no console window), the environment `env` or the core's own, for at most
/// `timeout`. A failure is a result, never an error, as `execFile`'s callback read it.
pub async fn run_file(
    file: &str,
    args: &[&str],
    env: Option<&serde_json::Map<String, Value>>,
    timeout: Duration,
) -> Exit {
    let mut command = tokio::process::Command::new(file);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(env) = env {
        command.env_clear();
        for (name, value) in env {
            if let Some(value) = value.as_str() {
                command.env(name, value);
            }
        }
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let failed = |stderr: String| Exit {
        code: 1,
        stdout: String::new(),
        stderr,
    };
    let Ok(child) = command.spawn() else {
        return failed(String::new());
    };
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Exit {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        _ => failed(String::new()),
    }
}

/// The program of a command line: the quoted first token, else the text up to the first space.
pub fn command_program(line: &str) -> String {
    let lead = line.trim_start_matches(is_js_space);
    if let Some(rest) = lead.strip_prefix('"')
        && let Some(end) = rest.find('"')
    {
        return rest[..end].to_owned();
    }
    first_field(line).to_owned()
}

/// `/^\s*ai-memory\s+REG_(EXPAND_)?SZ\s/i`, and where the value starts after `\s+`.
fn entry_value(row: &str) -> Option<&str> {
    let rest = row.trim_start_matches(is_js_space);
    let name = rest.get(..RUN_VALUE.len())?;
    if !name.eq_ignore_ascii_case(RUN_VALUE) {
        return None;
    }
    let rest = &rest[RUN_VALUE.len()..];
    let spaced = rest.trim_start_matches(is_js_space);
    if spaced.len() == rest.len() {
        return None;
    }
    let kind = ["REG_EXPAND_SZ", "REG_SZ"].into_iter().find(|kind| {
        spaced
            .get(..kind.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(kind))
    })?;
    let rest = &spaced[kind.len()..];
    rest.starts_with(is_js_space)
        .then(|| rest.trim_start_matches(is_js_space))
}

/// The entry's command line from `reg query` (`    ai-memory    REG_SZ    "C:\…\ai-memory.exe" service-host`).
pub fn run_entry_command(output: &str) -> Option<String> {
    super::text::lines(output)
        .find_map(entry_value)
        .map(|value| js_trim(value).to_owned())
}

/// How `launchctl`, `reg` and `taskkill` run: on the system, or a test's recorder.
pub type Exec = Arc<dyn Fn(&str, &[&str]) -> Boxed<'static, Exit> + Send + Sync>;

/// The system's commands, each bounded by `COMMAND_TIMEOUT`.
pub fn system() -> Exec {
    Arc::new(|file, args| {
        let file = file.to_owned();
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        Box::pin(async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            run_file(&file, &args, None, COMMAND_TIMEOUT).await
        })
    })
}

enum Kind {
    Launchd { plist: PathBuf, uid: u32 },
    Logon,
}

/// Where the unit lives and how it is inspected and removed.
pub struct Unit {
    kind: Kind,
    exec: Exec,
}

impl Unit {
    pub fn launchd(home: &Path, uid: u32, exec: Exec) -> Unit {
        let plist = home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist"));
        Unit {
            kind: Kind::Launchd { plist, uid },
            exec,
        }
    }

    pub fn logon(exec: Exec) -> Unit {
        Unit {
            kind: Kind::Logon,
            exec,
        }
    }

    /// `owned`: paths whose binaries OMPdesk runs; a unit running one is OMPdesk's.
    pub async fn inspect(&self, owned: &[String]) -> ServiceUnit {
        match &self.kind {
            Kind::Launchd { plist, .. } => match read_text(plist) {
                None => ServiceUnit {
                    installed: false,
                    ours: false,
                },
                Some(text) => ServiceUnit {
                    installed: true,
                    ours: owned.iter().any(|path| text.contains(path.as_str())),
                },
            },
            Kind::Logon => {
                let exit = (self.exec)("reg", &["query", RUN_KEY, "/v", RUN_VALUE]).await;
                let command = (exit.code == 0)
                    .then(|| run_entry_command(&exit.stdout))
                    .flatten();
                match command {
                    None => ServiceUnit {
                        installed: false,
                        ours: false,
                    },
                    Some(command) => ServiceUnit {
                        installed: true,
                        ours: owned
                            .iter()
                            .any(|path| within_path(&command_program(&command), path)),
                    },
                }
            }
        }
    }

    /// Stop the server and remove the unit (it comes back with the next `setup`). `data_dir`: ai-memory's data folder,
    /// whose `service-host.json` names the supervisor and server the logon entry started.
    pub async fn remove(&self, data_dir: Option<&str>) {
        match &self.kind {
            Kind::Launchd { plist, uid } => {
                let target = format!("gui/{uid}/{LAUNCHD_LABEL}");
                (self.exec)("launchctl", &["bootout", &target]).await;
                let _ = std::fs::remove_file(plist);
            }
            Kind::Logon => {
                (self.exec)("reg", &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]).await;
                // The supervisor (`service-host`) restarts the server, so it goes first; both are named by its file.
                let Some(host) =
                    data_dir.and_then(|dir| read_text(&Path::new(dir).join("service-host.json")))
                else {
                    return;
                };
                let Ok(Value::Object(host)) = serde_json::from_str::<Value>(&host) else {
                    return;
                };
                for name in ["supervisor_pid", "server_pid"] {
                    let pid = host.get(name).and_then(Value::as_f64);
                    if let Some(pid) = pid
                        .filter(|pid| pid.fract() == 0.0 && *pid > 0.0 && *pid <= u32::MAX as f64)
                    {
                        let pid = (pid as u32).to_string();
                        (self.exec)("taskkill", &["/PID", &pid, "/T", "/F"]).await;
                    }
                }
            }
        }
    }
}
