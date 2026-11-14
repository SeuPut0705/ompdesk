//! Starting the Windows installer (was `src/main/installer-spawn.ts` and electron-updater's `spawnLog`): detached,
//! with no standard streams, so it outlives the app that started it. The caller runs it off the thread that must not
//! wait (Defender scans a fresh unsigned setup inside `CreateProcess`). The installer's arguments are electron-updater's:
//! a restart passes `RESTART_ARGS`, the install at app quit `QUIT_ARGS`.

use std::path::Path;
use std::process::{Command, Stdio};

/// "Restart & install": the installer shows its progress and starts the app again.
pub const RESTART_ARGS: [&str; 2] = ["--updated", "--force-run"];
/// The install at an approved quit: silent, nothing started afterwards.
pub const QUIT_ARGS: [&str; 2] = ["--updated", "/S"];

/// Starts `installer` with `args`; `Ok` once the process exists, the spawn's error otherwise (a missing file, one
/// Windows refuses to run).
pub fn start_installer(installer: &Path, args: &[&str]) -> std::io::Result<()> {
    let mut command = Command::new(installer);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    command.spawn().map(drop)
}

/// A process of its own, as Node's `detached: true`: the app's exit does not take it along.
#[cfg(unix)]
pub fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
pub fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
pub fn detach(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let mut bytes = [0u8; 6];
        getrandom::fill(&mut bytes).unwrap();
        let tag: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        std::env::temp_dir().join(format!("ompdesk-installer-{tag}-{name}"))
    }

    /// What the stand-in wrote, once it did (it runs detached: nothing here waits for it).
    fn written(file: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(text) = std::fs::read_to_string(file)
                && text.ends_with('\n')
            {
                let _ = std::fs::remove_file(file);
                return text;
            }
            assert!(
                Instant::now() < deadline,
                "the started process never wrote {}",
                file.display()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A real process gets the installer's arguments, in order, as separate words.
    #[cfg(unix)]
    #[test]
    fn a_real_process_starts_with_the_installers_arguments() {
        for args in [RESTART_ARGS, QUIT_ARGS] {
            let out = temp_file("args.txt");
            let script = format!(
                "printf '%s|' \"$@\" > '{}.tmp'; echo >> '{0}.tmp'; mv '{0}.tmp' '{0}'",
                out.display()
            );
            let mut all = vec!["-c", script.as_str(), "stand-in"];
            all.extend(args);
            start_installer(Path::new("/bin/sh"), &all).unwrap();
            assert_eq!(written(&out), format!("{}|{}|\n", args[0], args[1]));
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_real_process_starts_with_the_installers_arguments() {
        let cmd = PathBuf::from(std::env::var("SystemRoot").unwrap())
            .join("System32")
            .join("cmd.exe");
        for args in [RESTART_ARGS, QUIT_ARGS] {
            let out = temp_file("args.txt");
            let target = out.display().to_string();
            let mut all = vec!["/d", "/c", "echo"];
            all.extend(args);
            all.extend([">", target.as_str()]);
            start_installer(&cmd, &all).unwrap();
            assert_eq!(written(&out).trim_end(), format!("{} {}", args[0], args[1]));
        }
    }

    #[test]
    fn a_missing_installer_is_an_error_not_a_hang() {
        let error = start_installer(&temp_file("missing.exe"), &RESTART_ARGS).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn a_file_that_is_no_program_is_an_error() {
        let file = temp_file("not-a-program.exe");
        std::fs::write(&file, b"MZ but not really a program").unwrap();
        let outcome = start_installer(&file, &RESTART_ARGS);
        let _ = std::fs::remove_file(&file);
        assert!(outcome.is_err(), "a non-executable file started");
    }
}
