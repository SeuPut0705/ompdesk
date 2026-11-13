//! `SWAP_SCRIPT` run for real with `/bin/bash` (was `updater-state.test.ts` › swap script, with the start check of
//! omp/agent/swap-rollback): `open` is a stand-in on the PATH that logs its call and, for the new bundle, writes the
//! start mark as the new app does once its first page loaded; `ditto` and `xattr` stand in only where the host has
//! none (they come last on the PATH).

use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::rules::SWAP_SCRIPT;

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> Dir {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).unwrap();
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("ompdesk-swap-{name}"));
    std::fs::create_dir_all(&dir).unwrap();
    Dir(dir.canonicalize().unwrap())
}

fn make_app(app: &Path, marker: &str) {
    std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    std::fs::write(app.join("Contents/marker"), marker).unwrap();
}

fn marker_of(app: &Path) -> String {
    std::fs::read_to_string(app.join("Contents/marker")).unwrap()
}

fn tool(folder: &Path, name: &str, body: &str) {
    let file = folder.join(name);
    std::fs::write(&file, format!("#!/bin/bash\n{body}\n")).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[derive(Default)]
struct Options<'a> {
    relaunch: Option<&'a str>,
    /// What the opener stand-in writes into the mark (none: a new app that never starts).
    mark_version: Option<&'a str>,
    mark_delay: Option<&'a str>,
    expect: Option<&'a str>,
    wait_seconds: Option<&'a str>,
}

struct Swap {
    dir: Dir,
}

impl Swap {
    fn new() -> Swap {
        Swap { dir: temp_dir() }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.0.join(rel)
    }

    fn mark(&self) -> PathBuf {
        self.path("userData/app-started.json")
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.path("swap.log")).unwrap_or_default()
    }

    /// The last line the script closed its entry with.
    fn outcome(&self) -> String {
        self.log()
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    fn opened(&self) -> Vec<String> {
        std::fs::read_to_string(self.path("opened.log"))
            .map(|t| t.lines().map(String::from).collect())
            .unwrap_or_default()
    }

    /// The staged new bundle and the destination.
    fn staged(&self) -> (PathBuf, PathBuf) {
        let src = self.path("updates/2.0.0/ompdesk.app");
        make_app(&src, "new");
        (src, self.path("Applications/ompdesk.app"))
    }

    fn tools_path(&self) -> String {
        let first = self.path("bin-first");
        let last = self.path("bin-last");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&last).unwrap();
        tool(
            &first,
            "open",
            r#"bundle="$2"
echo "$* [$(cat "$bundle/Contents/marker")]" >> "$STAND_IN_OPENED"
if [ "$(cat "$bundle/Contents/marker")" = "new" ] && [ -n "$STAND_IN_MARK_VERSION" ]; then
  mark() { mkdir -p "$(dirname "$STAND_IN_MARK")"; printf '{"version":"%s","pid":%s,"at":1}' "$STAND_IN_MARK_VERSION" "$$" > "$STAND_IN_MARK.tmp" && mv "$STAND_IN_MARK.tmp" "$STAND_IN_MARK"; }
  if [ -n "$STAND_IN_MARK_DELAY" ]; then ( sleep "$STAND_IN_MARK_DELAY"; mark ) >/dev/null 2>&1 & else mark; fi
fi"#,
        );
        tool(&last, "ditto", r#"cp -R "$1" "$2""#);
        tool(&last, "xattr", "exit 0");
        format!(
            "{}:{}:{}",
            first.display(),
            std::env::var("PATH").unwrap_or_default(),
            last.display()
        )
    }

    fn run(&self, pid: u32, src: &Path, dest: &Path, options: Options) -> i32 {
        let status = Command::new("/bin/bash")
            .arg("-c")
            .arg(SWAP_SCRIPT)
            .arg("swap")
            .arg(pid.to_string())
            .arg(src)
            .arg(dest)
            .arg(options.relaunch.unwrap_or("0"))
            .arg(self.path("swap.log"))
            .arg(self.mark())
            .arg(options.expect.unwrap_or("2.0.0"))
            .arg("--flag")
            .env("PATH", self.tools_path())
            .env("STAND_IN_OPENED", self.path("opened.log"))
            .env("STAND_IN_MARK", self.mark())
            .env("STAND_IN_MARK_VERSION", options.mark_version.unwrap_or(""))
            .env("STAND_IN_MARK_DELAY", options.mark_delay.unwrap_or(""))
            .env(
                "OMPDESK_SWAP_START_WAIT_S",
                options.wait_seconds.unwrap_or("0"),
            )
            .stdin(Stdio::null())
            .status()
            .unwrap();
        status.code().unwrap_or(-1)
    }

    fn entries(&self, rel: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.path(rel))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with("bin-"))
            .collect();
        names.sort();
        names
    }
}

/// A pid no process has (the app already exited).
const GONE: u32 = 999_999;

#[test]
fn waits_for_the_app_to_exit_then_replaces_it_and_leaves_no_debris() {
    let swap = Swap::new();
    let dest = swap.path("Applications/ompdesk.app");
    let src = swap.path("updates/0.2.2/ompdesk.app");
    make_app(&dest, "old");
    make_app(&src, "new");
    let mut app: Child = Command::new("/bin/sleep").arg("0.6").spawn().unwrap();
    let pid = app.id();
    let started = Instant::now();
    // Reaped as it exits, or it would linger as a zombie that still answers `kill -0`.
    let reaper = std::thread::spawn(move || app.wait());
    assert_eq!(swap.run(pid, &src, &dest, Options::default()), 0);
    let _ = reaper.join();
    assert!(started.elapsed() >= Duration::from_millis(400));
    assert_eq!(marker_of(&dest), "new");
    assert_eq!(swap.entries("Applications"), ["ompdesk.app"]);
    assert!(!src.exists());
    assert!(swap.log().contains("installed"));
}

#[test]
fn without_a_relaunch_removes_the_old_app_at_once_and_opens_nothing() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    make_app(&dest, "old");
    assert_eq!(
        swap.run(
            GONE,
            &src,
            &dest,
            Options {
                relaunch: Some("0"),
                ..Default::default()
            }
        ),
        0
    );
    assert_eq!(swap.entries("Applications"), ["ompdesk.app"]);
    assert!(swap.opened().is_empty());
    assert_eq!(swap.outcome(), "installed");
}

#[test]
fn keeps_the_old_app_until_the_new_one_marked_its_start() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    make_app(&dest, "old");
    let options = Options {
        relaunch: Some("1"),
        mark_version: Some("2.0.0"),
        ..Default::default()
    };
    assert_eq!(swap.run(GONE, &src, &dest, options), 0);
    assert_eq!(marker_of(&dest), "new");
    assert_eq!(swap.entries("Applications"), ["ompdesk.app"]);
    assert_eq!(
        swap.opened(),
        [format!("-n {} --args --flag [new]", dest.display())]
    );
    assert!(
        swap.log()
            .ends_with("installed\nwaiting for the new app to start\nstarted\n")
    );
}

#[test]
fn waits_for_a_mark_that_comes_some_time_after_the_open() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    make_app(&dest, "old");
    let options = Options {
        relaunch: Some("1"),
        mark_version: Some("2.0.0"),
        mark_delay: Some("0.3"),
        wait_seconds: Some("20"),
        ..Default::default()
    };
    assert_eq!(swap.run(GONE, &src, &dest, options), 0);
    assert_eq!(swap.outcome(), "started");
    assert_eq!(marker_of(&dest), "new");
    assert!(!swap.path("Applications/ompdesk.app.previous").exists());
}

#[test]
fn puts_the_previous_app_back_and_reopens_it_when_the_new_one_never_marks_its_start() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    make_app(&dest, "old");
    std::fs::write(dest.join("Contents/MacOS/app-file"), "intact").unwrap();
    assert_eq!(
        swap.run(
            GONE,
            &src,
            &dest,
            Options {
                relaunch: Some("1"),
                ..Default::default()
            }
        ),
        0
    );
    assert_eq!(marker_of(&dest), "old");
    assert_eq!(
        std::fs::read_to_string(dest.join("Contents/MacOS/app-file")).unwrap(),
        "intact"
    );
    assert_eq!(swap.entries("Applications"), ["ompdesk.app"]);
    assert_eq!(
        swap.opened(),
        [
            format!("-n {} --args --flag [new]", dest.display()),
            format!("-n {} --args --flag [old]", dest.display())
        ]
    );
    assert!(swap.log().ends_with(
        "installed\nwaiting for the new app to start\nstart failed; previous app restored\n"
    ));
}

#[test]
fn counts_a_mark_for_another_version_as_not_started() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    make_app(&dest, "old");
    let options = Options {
        relaunch: Some("1"),
        mark_version: Some("1.9.0"),
        ..Default::default()
    };
    assert_eq!(swap.run(GONE, &src, &dest, options), 0);
    assert_eq!(marker_of(&dest), "old");
    assert_eq!(swap.outcome(), "start failed; previous app restored");
}

#[test]
fn never_reads_a_mark_left_by_an_earlier_launch_as_the_new_apps() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    make_app(&dest, "old");
    std::fs::create_dir_all(swap.mark().parent().unwrap()).unwrap();
    std::fs::write(swap.mark(), r#"{"version":"2.0.0","pid":1,"at":1}"#).unwrap();
    assert_eq!(
        swap.run(
            GONE,
            &src,
            &dest,
            Options {
                relaunch: Some("1"),
                ..Default::default()
            }
        ),
        0
    );
    assert_eq!(marker_of(&dest), "old");
    assert!(!swap.mark().exists());
    assert_eq!(swap.outcome(), "start failed; previous app restored");
}

#[test]
fn ends_what_the_new_app_left_running_before_it_takes_the_old_one_back() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    make_app(&dest, "old");
    let program = dest.join("Contents/MacOS/app");
    let mut leftover = Command::new("/bin/bash")
        .arg("-c")
        .arg(r#"exec -a "$0" sleep 60"#)
        .arg(&program)
        .spawn()
        .unwrap();
    let listed = format!("{} {}", leftover.id(), program.display());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let out = Command::new("ps")
            .args(["-axww", "-o", "pid=", "-o", "command="])
            .output()
            .unwrap();
        if String::from_utf8_lossy(&out.stdout)
            .lines()
            .any(|l| l.trim_start().starts_with(&listed))
        {
            break;
        }
        assert!(Instant::now() < deadline, "the stand-in never showed in ps");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        swap.run(
            GONE,
            &src,
            &dest,
            Options {
                relaunch: Some("1"),
                ..Default::default()
            }
        ),
        0
    );
    assert_eq!(leftover.wait().unwrap().signal(), Some(15));
    assert_eq!(marker_of(&dest), "old");
    assert_eq!(swap.outcome(), "start failed; previous app restored");
}

#[test]
fn says_the_previous_app_is_lost_when_there_was_none_to_put_back() {
    let swap = Swap::new();
    let (src, dest) = swap.staged();
    assert_eq!(
        swap.run(
            GONE,
            &src,
            &dest,
            Options {
                relaunch: Some("1"),
                ..Default::default()
            }
        ),
        0
    );
    assert_eq!(marker_of(&dest), "new");
    assert_eq!(
        swap.opened(),
        [format!("-n {} --args --flag [new]", dest.display())]
    );
    assert_eq!(swap.outcome(), "start failed; previous app lost");
}

#[test]
fn leaves_the_installed_app_untouched_when_the_staged_bundle_is_gone() {
    let swap = Swap::new();
    let dest = swap.path("ompdesk.app");
    make_app(&dest, "old");
    assert_eq!(
        swap.run(
            GONE,
            &swap.path("missing/ompdesk.app"),
            &dest,
            Options::default()
        ),
        1
    );
    assert_eq!(marker_of(&dest), "old");
    assert_eq!(swap.entries(""), ["ompdesk.app", "swap.log"]);
}
