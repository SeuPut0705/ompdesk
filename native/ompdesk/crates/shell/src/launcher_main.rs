// UNVERIFIED on macOS: written on Windows without a compiler for this target; `shell-batch-checks` compiles it.
//! `ompdesk-launcher`: the macOS bundle's `CFBundleExecutable` (`Contents/MacOS/OMPdesk`). It `exec`s the real shell
//! (`Contents/MacOS/ompdesk-shell`) with the same arguments, so the app's pid stays the shell's (Dock, LaunchServices and
//! Apple Events see one process). On the first launch of a version an update installed, it first leaves a detached copy
//! of itself that waits for `<userData>/app-started.json` to hold this version and, if it never does, puts the last
//! Electron release back (`rollback`). Never a dialog; every step goes to `<userData>/updates/swap.log`.
//!
//! The decisions and parsers are `shell_core::launcher`, tested everywhere. This file is the process work.

#[cfg(not(unix))]
fn main() {
    eprintln!("ompdesk-launcher runs only in the macOS app bundle");
    std::process::exit(1);
}

#[cfg(unix)]
fn main() {
    unix::main();
}

// The process work calls `kill` and `setsid` (each use carries its SAFETY line), as the crate's other OS modules do.
#[cfg(unix)]
#[allow(unsafe_code)]
mod unix {
    use std::ffi::OsString;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use shell_core::launcher::{self, Release};
    use shell_core::startup;

    /// The last Electron release (`last-electron.json`, baked by build.rs): the app the rollback puts back.
    const LAST_ELECTRON_TAG: &str = env!("OMPDESK_LAST_ELECTRON_TAG");
    /// Hidden first argument of the watcher: `--ompdesk-launcher-watch <shell pid> <bundle> <user data> <version>`.
    const WATCH_FLAG: &str = "--ompdesk-launcher-watch";

    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
        fn setsid() -> i32;
    }

    pub fn main() {
        let argv: Vec<OsString> = std::env::args_os().collect();
        if argv.get(1).is_some_and(|a| a == WATCH_FLAG) {
            let args: Vec<String> = argv[2..]
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            if let [pid, bundle, user_data, version] = args.as_slice() {
                watch(
                    pid.parse().unwrap_or(0),
                    bundle,
                    Path::new(user_data),
                    version,
                );
            }
            return;
        }
        let exe = std::env::current_exe().unwrap_or_default();
        let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
        let shell = dir.join("ompdesk-shell");
        // Contents/MacOS/OMPdesk → the bundle.
        let bundle = dir.parent().and_then(Path::parent).map(Path::to_path_buf);
        if let Some(bundle) = bundle {
            arm_watcher(&exe, &bundle, &argv);
        }
        let error = Command::new(&shell).args(&argv[1..]).exec();
        eprintln!(
            "ompdesk-launcher: cannot start {}: {error}",
            shell.display()
        );
        std::process::exit(1);
    }

    fn user_data(argv: &[OsString]) -> PathBuf {
        let args: Vec<String> = argv
            .iter()
            .skip(1)
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let default = startup::default_user_data(
            &PathBuf::from(std::env::var("HOME").unwrap_or_default())
                .join("Library")
                .join("Application Support"),
        );
        startup::resolve_user_data(
            &args,
            std::env::var(startup::USER_DATA_ENV).ok().as_deref(),
            default,
        )
    }

    /// Leaves the watcher when this launch is the first of an installed version; every failure here only means no
    /// watcher: the start itself is never held up or refused.
    fn arm_watcher(exe: &Path, bundle: &Path, argv: &[OsString]) {
        let Ok(plist) = fs::read_to_string(bundle.join("Contents").join("Info.plist")) else {
            return;
        };
        let Some(version) = launcher::bundle_version(&plist) else {
            return;
        };
        let user_data = user_data(argv);
        let install = fs::read_to_string(user_data.join("update-install.json")).ok();
        let started = fs::read_to_string(user_data.join("app-started.json")).ok();
        let armed = launcher::armed(
            &version,
            install
                .as_deref()
                .and_then(launcher::install_target)
                .as_deref(),
            started
                .as_deref()
                .and_then(launcher::started_version)
                .as_deref(),
        );
        if !armed {
            return;
        }
        let updates = user_data.join("updates");
        if fs::create_dir_all(&updates).is_err() {
            return;
        }
        let Ok(log) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(updates.join("swap.log"))
        else {
            return;
        };
        let Ok(log_err) = log.try_clone() else { return };
        let mut watcher = Command::new(exe);
        watcher
            .arg(WATCH_FLAG)
            .arg(std::process::id().to_string())
            .arg(bundle)
            .arg(&user_data)
            .arg(&version)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(log_err);
        // SAFETY: setsid is async-signal-safe and only detaches the child from this session before it execs.
        unsafe {
            watcher.pre_exec(|| {
                setsid();
                Ok(())
            });
        }
        let _ = watcher.spawn();
    }

    // ------------------------------------------------------------------------------------------ the watcher

    fn env(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists and may be signalled.
        pid != 0 && unsafe { kill(pid as i32, 0) } == 0
    }

    fn say(line: &str) {
        println!("{line}");
        let _ = std::io::stdout().flush();
    }

    fn date() -> String {
        Command::new("/bin/date")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }

    fn mark_holds(user_data: &Path, version: &str) -> bool {
        fs::read_to_string(user_data.join("app-started.json"))
            .ok()
            .and_then(|t| launcher::started_version(&t))
            .as_deref()
            == Some(version)
    }

    fn watch(shell_pid: u32, bundle: &str, user_data: &Path, version: &str) {
        let user_data_env = env(shell_core::startup::USER_DATA_ENV);
        let wait = launcher::wait_secs(
            env(launcher::START_WAIT_ENV).as_deref(),
            user_data_env.as_deref(),
        );
        say(&launcher::header(&date(), bundle));
        let started = Instant::now();
        let mut gone_since: Option<Instant> = None;
        loop {
            if mark_holds(user_data, version) {
                say(launcher::LINE_STARTED);
                return;
            }
            if started.elapsed() >= Duration::from_secs(wait) {
                break;
            }
            if alive(shell_pid) {
                gone_since = None;
            } else if gone_since.get_or_insert_with(Instant::now).elapsed()
                >= Duration::from_secs(launcher::SHELL_GONE_SECS)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if mark_holds(user_data, version) {
            say(launcher::LINE_STARTED);
            return;
        }
        if Path::new(&launcher::previous_path(bundle)).exists() {
            // The app the update replaced keeps its own copy until it has seen this one start; its swap script restores it.
            say(launcher::LINE_SWAP_RESTORES);
            return;
        }
        match rollback(
            shell_pid,
            Path::new(bundle),
            user_data,
            user_data_env.as_deref(),
        ) {
            Ok(()) => say(launcher::LINE_RESTORED),
            Err(why) => say(&launcher::restore_failed_line(&why)),
        }
    }

    fn run(program: &str, args: &[&str]) -> Result<String, String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|e| format!("{program} did not run: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "{program} {} failed ({}): {}",
                args.first().copied().unwrap_or(""),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Ends the shell and every process of the bundle (TERM, KILL after 5 s).
    fn end_processes(shell_pid: u32, bundle: &Path) -> Result<(), String> {
        let prefix = format!("{}/Contents/", bundle.display());
        let listing = run("/bin/ps", &["-axo", "pid=,comm="])?;
        let mut pids = launcher::processes_under(&listing, &prefix, &[std::process::id()]);
        if shell_pid != 0 && !pids.contains(&shell_pid) {
            pids.push(shell_pid);
        }
        say(&format!(
            "rollback: ending {}",
            pids.iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(" ")
        ));
        for signal in [15, 9] {
            for pid in pids.iter().filter(|p| alive(**p)) {
                // SAFETY: a signal to a process of the bundle being replaced.
                unsafe { kill(*pid as i32, signal) };
            }
            let until = Instant::now() + Duration::from_secs(5);
            while Instant::now() < until && pids.iter().any(|p| alive(*p)) {
                std::thread::sleep(Duration::from_millis(100));
            }
            if !pids.iter().any(|p| alive(*p)) {
                return Ok(());
            }
        }
        Err("a process of the new app would not end".into())
    }

    fn curl(url: &str, accept: &str, out: Option<&Path>) -> Result<String, String> {
        // The system curl: the proxy and the certificates are the system's.
        let mut args = vec!["-fsSL", "--max-time", "900", "-H", accept, url];
        let out_text = out.map(|p| p.display().to_string());
        if let Some(out) = &out_text {
            args.extend(["-o", out]);
        }
        run("/usr/bin/curl", &args)
    }

    fn fetch_release() -> Result<Release, String> {
        let base = launcher::api_base(
            env(launcher::RELEASE_URL_ENV).as_deref(),
            env(startup::USER_DATA_ENV).as_deref(),
        );
        say(&format!("rollback: fetching {LAST_ELECTRON_TAG}"));
        let url = format!(
            "{base}/repos/{}/releases/tags/{LAST_ELECTRON_TAG}",
            launcher::REPO
        );
        let json = curl(&url, "Accept: application/vnd.github+json", None)?;
        launcher::parse_release(&json, LAST_ELECTRON_TAG)
    }

    fn download(release: &Release, to: &Path) -> Result<(), String> {
        let _ = fs::remove_file(to);
        curl(
            &release.asset_url,
            "Accept: application/octet-stream",
            Some(to),
        )?;
        let file = File::open(to).map_err(|e| format!("the download is missing: {e}"))?;
        let (length, sha) =
            launcher::sha512_of(file).map_err(|e| format!("reading the download: {e}"))?;
        say(&format!("rollback: download ok {length}"));
        launcher::check_download(length, &sha, release)?;
        say("rollback: sha512 ok");
        Ok(())
    }

    /// Mounts the DMG read-only without Finder, copies the `.app` out, always detaches.
    fn stage(dmg: &Path, mount: &Path, staged: &Path) -> Result<PathBuf, String> {
        let _ = fs::remove_dir_all(mount);
        let _ = fs::remove_dir_all(staged);
        fs::create_dir_all(mount).map_err(|e| format!("no mount folder: {e}"))?;
        fs::create_dir_all(staged).map_err(|e| format!("no staging folder: {e}"))?;
        let mount_text = mount.display().to_string();
        run(
            "/usr/bin/hdiutil",
            &[
                "attach",
                "-nobrowse",
                "-readonly",
                "-noautoopen",
                "-mountpoint",
                &mount_text,
                &dmg.display().to_string(),
            ],
        )?;
        let copied = (|| {
            let app = fs::read_dir(mount)
                .map_err(|e| format!("cannot read the mounted image: {e}"))?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .find(|p| p.extension().is_some_and(|x| x == "app"))
                .ok_or("the image holds no app")?;
            let target = staged.join(app.file_name().unwrap_or_default());
            run(
                "/usr/bin/ditto",
                &[&app.display().to_string(), &target.display().to_string()],
            )?;
            Ok::<_, String>(target)
        })();
        let detached = run("/usr/bin/hdiutil", &["detach", &mount_text, "-force"]);
        let target = copied?;
        detached.map(|_| target)
    }

    fn verify(app: &Path, version: &str) -> Result<(), String> {
        let _ = run(
            "/usr/bin/xattr",
            &["-dr", "com.apple.quarantine", &app.display().to_string()],
        );
        run(
            "/usr/bin/codesign",
            &["--verify", "--deep", "--strict", &app.display().to_string()],
        )?;
        let plist = fs::read_to_string(app.join("Contents").join("Info.plist"))
            .map_err(|e| format!("the restored app has no Info.plist: {e}"))?;
        if launcher::plist_string(&plist, "CFBundleIdentifier").as_deref()
            != Some(launcher::BUNDLE_ID)
        {
            return Err(format!("the restored app is not {}", launcher::BUNDLE_ID));
        }
        let found = launcher::bundle_version(&plist).unwrap_or_default();
        if found != version {
            return Err(format!(
                "the restored app is version {found}, not {version}"
            ));
        }
        Ok(())
    }

    /// `<bundle>` becomes `<bundle>.failed` and the restored copy takes its place; on any failure the bundle is put back.
    fn swap(bundle: &Path, restored: &Path) -> Result<(), String> {
        let name = bundle.display().to_string();
        let failed = PathBuf::from(format!("{name}.failed"));
        let restoring = PathBuf::from(format!("{name}.restoring"));
        let _ = fs::remove_dir_all(&failed);
        let _ = fs::remove_dir_all(&restoring);
        run(
            "/usr/bin/ditto",
            &[
                &restored.display().to_string(),
                &restoring.display().to_string(),
            ],
        )?;
        if let Err(e) = fs::rename(bundle, &failed) {
            let _ = fs::remove_dir_all(&restoring);
            return Err(format!("cannot move the new app aside: {e}"));
        }
        if let Err(e) = fs::rename(&restoring, bundle) {
            let _ = fs::rename(&failed, bundle);
            let _ = fs::remove_dir_all(&restoring);
            return Err(format!("cannot put the previous app in place: {e}"));
        }
        say("rollback: swapped");
        let _ = fs::remove_dir_all(&failed);
        Ok(())
    }

    fn rollback(
        shell_pid: u32,
        bundle: &Path,
        user_data: &Path,
        user_data_env: Option<&str>,
    ) -> Result<(), String> {
        end_processes(shell_pid, bundle)?;
        let work = user_data.join("updates").join("rollback");
        fs::create_dir_all(&work).map_err(|e| format!("no work folder: {e}"))?;
        let release = fetch_release()?;
        let dmg = work.join(launcher::DMG_NAME);
        download(&release, &dmg)?;
        let staged = stage(&dmg, &work.join("mount"), &work.join("staged"))?;
        say(&format!("rollback: staged {}", staged.display()));
        verify(&staged, &release.version)?;
        say("rollback: verified");
        swap(bundle, &staged)?;
        let _ = fs::remove_dir_all(&work);
        let mut open = Command::new("/usr/bin/open");
        open.arg("-n").arg(bundle);
        // A rehearsal's restored app keeps its throwaway profile.
        if let Some(dir) = user_data_env.filter(|d| !d.is_empty()) {
            open.arg("--args").arg(format!("--user-data-dir={dir}"));
        }
        open.status()
            .map_err(|e| format!("open did not run: {e}"))
            .and_then(|s| {
                if s.success() {
                    Ok(())
                } else {
                    Err(format!("open failed ({s})"))
                }
            })?;
        say("rollback: opened");
        Ok(())
    }
}
