//! What the updater does to the machine: may this bundle be replaced, copy the app out of the verified DMG and prove
//! it, start the macOS swap helper or the Windows installer, open the manual DMG.
#![allow(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use shell_core::updater_core::rules::{self, SWAP_SCRIPT};

/// `access(path, W_OK)`: what the TypeScript asked of the bundle and its folder.
#[cfg(unix)]
pub fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `c_path` is a valid NUL-terminated string for the duration of the call; `access` reads it only.
    unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
pub fn writable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| !m.permissions().readonly())
}

/// The bundle the relaunch mode may replace, else `None` (the manual DMG).
pub fn swappable_bundle(bundle: Option<&str>) -> Option<PathBuf> {
    let bundle = bundle?;
    let path = Path::new(bundle);
    (rules::is_swappable_location(bundle) && writable(path) && path.parent().is_some_and(writable))
        .then(|| path.to_path_buf())
}

/// Why a DMG could not be staged.
pub enum StageError {
    Mount,
    Missing,
    Copy,
    Verify,
    Io(String),
}

fn run(program: &str, args: &[&str]) -> (bool, String) {
    match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        ),
        Err(_) => (false, String::new()),
    }
}

fn plist_value(app: &Path, key: &str) -> Option<String> {
    let plist = app.join("Contents").join("Info.plist");
    let (ok, out) = run(
        "/usr/bin/plutil",
        &["-extract", key, "raw", "-o", "-", &plist.to_string_lossy()],
    );
    ok.then(|| out.trim().to_string())
}

/// Copy the app out of the release DMG and prove it is this app at `version`, intact: mount read-only without Finder,
/// `ditto` the bundle out, always detach, then check `codesign --verify --deep --strict`, the bundle id and the short
/// version. Returns the staged `.app`.
pub fn stage_bundle(
    dmg: &Path,
    staging: &Path,
    mount_root: &Path,
    version: &str,
    own: &Path,
) -> Result<PathBuf, StageError> {
    let io = |e: std::io::Error| StageError::Io(e.to_string());
    let _ = std::fs::remove_dir_all(staging);
    std::fs::create_dir_all(staging).map_err(io)?;
    std::fs::create_dir_all(mount_root).map_err(io)?;
    let mount = make_temp_dir(mount_root, "ompdesk-update-").map_err(io)?;
    let mount_text = mount.to_string_lossy().into_owned();
    let dmg_text = dmg.to_string_lossy().into_owned();
    let staged = (|| {
        let (attached, _) = run(
            "/usr/bin/hdiutil",
            &[
                "attach",
                "-nobrowse",
                "-readonly",
                "-noautoopen",
                "-mountpoint",
                &mount_text,
                &dmg_text,
            ],
        );
        if !attached {
            return Err(StageError::Mount);
        }
        let copied = (|| {
            // The DMG also holds the /Applications symlink; only a real directory is the app.
            let bundle = std::fs::read_dir(&mount)
                .map_err(io)?
                .flatten()
                .find(|entry| {
                    entry.file_type().is_ok_and(|t| t.is_dir())
                        && entry.file_name().to_string_lossy().ends_with(".app")
                })
                .ok_or(StageError::Missing)?;
            let staged = staging.join(bundle.file_name());
            let (ok, _) = run(
                "/usr/bin/ditto",
                &[&bundle.path().to_string_lossy(), &staged.to_string_lossy()],
            );
            if ok {
                Ok(staged)
            } else {
                Err(StageError::Copy)
            }
        })();
        let (detached, _) = run("/usr/bin/hdiutil", &["detach", &mount_text]);
        if !detached {
            run("/usr/bin/hdiutil", &["detach", "-force", &mount_text]);
        }
        copied
    })();
    // rmdir, never a recursive removal: a mount that refused to detach keeps its contents.
    let _ = std::fs::remove_dir(&mount);
    let staged = staged?;
    let (signed, _) = run(
        "/usr/bin/codesign",
        &["--verify", "--deep", "--strict", &staged.to_string_lossy()],
    );
    let bundle_id = plist_value(&staged, "CFBundleIdentifier");
    let verified = signed
        && bundle_id.is_some()
        && bundle_id == plist_value(own, "CFBundleIdentifier")
        && plist_value(&staged, "CFBundleShortVersionString").as_deref() == Some(version);
    if !verified {
        let _ = std::fs::remove_dir_all(staging);
        return Err(StageError::Verify);
    }
    Ok(staged)
}

fn make_temp_dir(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    for _ in 0..16 {
        let mut bytes = [0u8; 6];
        getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
        let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let dir = parent.join(format!("{prefix}{suffix}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("no free temporary folder name"))
}

/// Hands the swap to a detached `/bin/bash` that waits for this process to exit (never launchd).
pub fn launch_swap(
    staged: &Path,
    destination: &Path,
    relaunch: bool,
    log: &Path,
    start_mark: &Path,
    expected_version: &str,
    relaunch_args: &[String],
) -> std::io::Result<()> {
    let mut command = Command::new("/bin/bash");
    command
        .arg("-c")
        .arg(SWAP_SCRIPT)
        .arg("ompdesk-swap")
        .arg(std::process::id().to_string())
        .arg(staged)
        .arg(destination)
        .arg(if relaunch { "1" } else { "0" })
        .arg(log)
        .arg(start_mark)
        .arg(expected_version)
        .args(relaunch_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    command.spawn().map(drop)
}

/// The Windows installer, detached (it outlives the app): electron-updater's `--updated` arguments.
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

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // Its own session, as Node's `detached: true`: the app's exit does not take it along.
    command.process_group(0);
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

/// Reveals and opens the manual installer (Finder mounts the DMG).
pub fn open_installer(file: &Path) -> Result<(), String> {
    let text = file.to_string_lossy().into_owned();
    #[cfg(windows)]
    use shell_core::sys::shellops as native;
    #[cfg(target_os = "macos")]
    use shell_core::sys_mac::shellops as native;
    #[cfg(any(windows, target_os = "macos"))]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        crate::ui::post(move || {
            let _ = native::show_item_in_folder(&text);
            let _ = tx.send(native::open_path(&text));
        });
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = text;
        Err("no file manager on this platform".into())
    }
}
