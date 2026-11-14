//! The lid policy's thread (`boot_core::lid`) and the platform backends: macOS `caffeinate`, Windows `powercfg`
//! (`boot_core::powercfg`). Inputs arrive from the host's reader thread (`awakeStart`/`awakeStop`) and the hidden window
//! (AC/battery); backend calls block, so they run here, never on the UI thread.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use shell_core::boot_core::lid::{Backend, Input};
use shell_core::boot_core::lid_runtime::{LidRuntime, Logger};

static RUNTIME: Mutex<Option<LidRuntime>> = Mutex::new(None);

pub fn start_with(user_data: &Path, on_ac: bool, log: Logger) -> std::io::Result<()> {
    if std::env::var("OMP_GUI_HEADLESS").as_deref() == Ok("1") {
        return Ok(());
    }
    let mut runtime = RUNTIME.lock().unwrap();
    if runtime.is_some() {
        return Ok(());
    }
    if let Some(backend) = backend(user_data) {
        *runtime = Some(LidRuntime::start(backend, on_ac, log)?);
    }
    Ok(())
}

pub fn blocker(id: &str, held: bool) {
    if let Some(runtime) = RUNTIME.lock().unwrap().as_ref() {
        runtime.input(Input::Blocker {
            key: id.to_string(),
            held,
        });
    }
}

pub fn on_ac(on_ac: bool) {
    if let Some(runtime) = RUNTIME.lock().unwrap().as_ref() {
        runtime.input(Input::OnAc(on_ac));
    }
}

/// Answers after the policy settles, or false when no runtime is available.
pub fn query(answer: impl FnOnce(bool) + Send + 'static) {
    let runtime = RUNTIME.lock().unwrap();
    if let Some(runtime) = runtime.as_ref() {
        runtime.query(answer);
    } else {
        drop(runtime);
        answer(false);
    }
}

/// Releases the backend, allowing up to five seconds for an in-flight call.
pub fn stop() {
    let Some(mut runtime) = RUNTIME.lock().unwrap().take() else {
        return;
    };
    if !runtime.shutdown(Duration::from_secs(5)) {
        crate::log::log(
            "boot.lid_shutdown_timeout",
            json!({ "error": "lid backend did not settle within 5 seconds" }),
        );
    }
}

#[cfg(target_os = "macos")]
fn backend(_user_data: &Path) -> Option<Box<dyn Backend + Send>> {
    Some(Box::new(mac::Caffeinate::default()))
}

#[cfg(windows)]
fn backend(user_data: &Path) -> Option<Box<dyn Backend + Send>> {
    Some(Box::new(windows::lid(user_data.join("lid-awake.json"))))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn backend(_user_data: &Path) -> Option<Box<dyn Backend + Send>> {
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
