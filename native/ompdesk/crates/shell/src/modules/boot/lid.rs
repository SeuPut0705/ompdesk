//! The lid policy's thread (`boot_core::lid`) and the platform backends: macOS `caffeinate`, Windows `powercfg`
//! (`boot_core::powercfg`). Inputs arrive from the host's reader thread (`awakeStart`/`awakeStop`) and the hidden window
//! (AC/battery); backend calls block, so they run here, never on the UI thread.

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use serde_json::{Value, json};
use shell_core::boot_core::lid::{Backend, Input, Policy};

use crate::modules::Ctx;

enum Msg {
    Input(Input),
    /// Answered with `held` once the policy settled on everything sent before it.
    Query(Box<dyn FnOnce(bool) + Send>),
    Dispose(Sender<()>),
}

static INPUTS: Mutex<Option<Sender<Msg>>> = Mutex::new(None);

fn send(msg: Msg) -> bool {
    INPUTS
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|tx| tx.send(msg).is_ok())
}

/// Starts the policy (UI thread, `ready`). A test launch (`OMP_GUI_HEADLESS=1`) never changes the machine's power
/// settings: a killed test app would leave them changed.
pub fn start(ctx: Ctx) {
    if std::env::var("OMP_GUI_HEADLESS").as_deref() == Ok("1") {
        return;
    }
    let Some(backend) = backend() else { return };
    let on_ac = !crate::system::on_battery();
    let (tx, rx) = channel();
    *INPUTS.lock().unwrap() = Some(tx);
    let spawned = std::thread::Builder::new()
        .name("boot-lid".into())
        .spawn(move || run(backend, on_ac, &rx, ctx));
    if let Err(error) = spawned {
        INPUTS.lock().unwrap().take();
        crate::log::log(
            "boot.lid_thread_failed",
            json!({ "error": error.to_string() }),
        );
    }
}

pub fn blocker(id: &str, held: bool) {
    send(Msg::Input(Input::Blocker {
        key: id.to_string(),
        held,
    }));
}

pub fn on_ac(on_ac: bool) {
    send(Msg::Input(Input::OnAc(on_ac)));
}

/// `answer(held)` once the policy settled; `false` at once when none runs (a desktop OS without a backend, a test).
pub fn query(answer: impl FnOnce(bool) + Send + 'static) {
    let tx = INPUTS.lock().unwrap().clone();
    match tx {
        Some(tx) => {
            if let Err(error) = tx.send(Msg::Query(Box::new(answer)))
                && let Msg::Query(answer) = error.0
            {
                answer(false);
            }
        }
        None => answer(false),
    }
}

/// Quit (UI thread): releases at once and waits up to 5 s for a backend call under way.
pub fn stop() {
    let Some(tx) = INPUTS.lock().unwrap().take() else {
        return;
    };
    let (ack, done) = channel();
    if tx.send(Msg::Dispose(ack)).is_ok() {
        let _ = done.recv_timeout(Duration::from_secs(5));
    }
}

fn run(mut backend: Box<dyn Backend + Send>, on_ac: bool, rx: &Receiver<Msg>, ctx: Ctx) {
    let mut log = |message: &'static str, details: Value| {
        ctx.runtime_log(
            json!({ "source": "keep-awake", "message": message, "details": details }),
            None,
        );
    };
    let mut policy = Policy::new(on_ac);
    policy.start(backend.as_mut(), &mut log);
    while let Ok(msg) = rx.recv() {
        let mut queries = Vec::new();
        let mut acks = Vec::new();
        if take(&mut policy, msg, &mut queries, &mut acks) {
            policy.converge(backend.as_mut(), &mut log, &mut |policy| {
                while let Ok(more) = rx.try_recv() {
                    take(policy, more, &mut queries, &mut acks);
                }
            });
        }
        if !acks.is_empty() {
            policy.dispose(backend.as_mut(), &mut log);
        }
        for answer in queries {
            answer(policy.held());
        }
        for ack in acks {
            let _ = ack.send(());
        }
    }
}

type Answer = Box<dyn FnOnce(bool) + Send>;

/// Applies one message: an input (true when the backend may have to move), a query or a dispose kept for when the
/// policy settled.
fn take(
    policy: &mut Policy,
    msg: Msg,
    queries: &mut Vec<Answer>,
    acks: &mut Vec<Sender<()>>,
) -> bool {
    match msg {
        Msg::Input(input) => policy.apply(input),
        Msg::Query(answer) => {
            queries.push(answer);
            false
        }
        Msg::Dispose(ack) => {
            policy.apply(Input::Dispose);
            acks.push(ack);
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn backend() -> Option<Box<dyn Backend + Send>> {
    Some(Box::new(mac::Caffeinate::default()))
}

#[cfg(windows)]
fn backend() -> Option<Box<dyn Backend + Send>> {
    let user_data = crate::state::FACTS.get()?["paths"]["userData"]
        .as_str()
        .map(std::path::PathBuf::from)?;
    Some(Box::new(windows::lid(user_data.join("lid-awake.json"))))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn backend() -> Option<Box<dyn Backend + Send>> {
    None
}

/// macOS: stock `/usr/bin/caffeinate -s -w <shell pid>` holds a PreventSystemSleep assertion, which macOS honours only
/// on AC power, for as long as it runs; `-w` ends it with the shell, so a crash or kill leaves nothing held. No admin
/// rights and no `pmset disablesleep`.
#[cfg(target_os = "macos")]
mod mac {
    use std::process::{Child, Command, Stdio};

    use serde_json::{Map, Value};
    use shell_core::boot_core::lid::{Backend, Outcome};

    #[derive(Default)]
    pub struct Caffeinate {
        child: Option<Child>,
    }

    impl Backend for Caffeinate {
        fn name(&self) -> &'static str {
            "caffeinate"
        }

        fn is_laptop(&mut self) -> Result<bool, String> {
            let output = Command::new("/usr/bin/pmset")
                .args(["-g", "batt"])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .map_err(|e| format!("pmset -g batt: {e}"))?;
            if !output.status.success() {
                return Err(format!("pmset -g batt exited with {}", output.status));
            }
            Ok(String::from_utf8_lossy(&output.stdout).contains("InternalBattery"))
        }

        fn recover(&mut self) -> Result<Option<Map<String, Value>>, String> {
            Ok(None)
        }

        fn hold(&mut self) -> Result<Outcome, String> {
            if self.child.is_none() {
                let child = Command::new("/usr/bin/caffeinate")
                    .args(["-s", "-w", &std::process::id().to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| format!("caffeinate: {e}"))?;
                self.child = Some(child);
            }
            Ok(Outcome {
                changed: true,
                details: Map::new(),
            })
        }

        fn release(&mut self) -> Result<(), String> {
            self.release_now()
        }

        fn release_now(&mut self) -> Result<(), String> {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    use shell_core::boot_core::powercfg::WindowsLid;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn lid(marker_file: PathBuf) -> WindowsLid {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let powercfg = PathBuf::from(root).join("System32").join("powercfg.exe");
        WindowsLid::new(
            Box::new(move |args: &[String]| {
                let output = Command::new(&powercfg)
                    .args(args)
                    .stdin(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map_err(|e| format!("{}: {e}", powercfg.display()))?;
                if !output.status.success() {
                    return Err(format!(
                        "Command failed: {} {}\n{}",
                        powercfg.display(),
                        args.join(" "),
                        String::from_utf8_lossy(&output.stderr).trim()
                    ));
                }
                Ok(String::from_utf8_lossy(&output.stdout).into_owned())
            }),
            Box::new(|| Ok(shell_core::sys::system::has_battery())),
            marker_file,
            Box::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64)
            }),
        )
    }
}
