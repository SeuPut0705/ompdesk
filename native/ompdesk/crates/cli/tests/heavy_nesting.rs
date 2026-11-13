//! Heavy work nested in heavy work reuses the outer lease: a `heavy hold` or `run --heavy` started under a live holder
//! (`OMPDESK_HEAVY_HELD`) takes no slot of its own, so on a one-slot pool it never waits on its own ancestor.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ompdesk-nesting-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The CLI on a one-slot pool in `dir`, outside any holder.
fn cli(dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ompdesk"));
    command
        .current_dir(dir)
        .env("OMPDESK_HEAVY_DIR", dir.join("heavy"))
        .env("OMPDESK_HEAVY_SLOTS", "1")
        .env("OMPDESK_HEAVY_MIN_FREE_GB", "0")
        .env_remove("OMPDESK_HEAVY_HELD");
    command
}

/// Runs `command` to its end, failing the test past 20 s (a wait on a slot its ancestor holds never ends).
fn finish(mut command: Command) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(20);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > until {
            let _ = child.kill();
            panic!(
                "still waiting after 20 s: {:?}",
                child.wait_with_output().unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}

fn text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// An outer `heavy hold`, and the pid its `held` line names.
fn outer(dir: &Path) -> (Child, String) {
    let mut hold = cli(dir)
        .args(["heavy", "hold"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(hold.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let pid = line
        .trim()
        .strip_prefix("held 0 pid ")
        .unwrap_or_else(|| panic!("held line: {line:?}"))
        .to_owned();
    assert_eq!(pid, hold.id().to_string());
    (hold, pid)
}

fn status(dir: &Path) -> String {
    let mut command = cli(dir);
    command.args(["heavy", "status"]);
    text(&finish(command))
}

#[test]
fn nested_holds_two_deep_reuse_the_outer_slot_and_a_killed_outer_frees_it() {
    let dir = temp("two-deep");
    let (mut hold, pid) = outer(&dir);
    assert!(status(&dir).starts_with("1/1 heavy slots in use"));

    // A hold inside it: reuses, takes nothing.
    let mut inner = cli(&dir);
    inner
        .env("OMPDESK_HEAVY_HELD", &pid)
        .args(["heavy", "hold"]);
    let inner = finish(inner);
    assert_eq!(inner.status.code(), Some(0));
    assert_eq!(text(&inner).trim(), "held reused");

    // Two deep: `run --heavy` under the hold, and a hold under that run (which names the run as its holder).
    let mut nested = cli(&dir);
    nested.env("OMPDESK_HEAVY_HELD", &pid).args([
        "run",
        "--heavy",
        "--",
        env!("CARGO_BIN_EXE_ompdesk"),
        "heavy",
        "hold",
    ]);
    let nested = finish(nested);
    assert_eq!(nested.status.code(), Some(0), "{nested:?}");
    assert_eq!(text(&nested).trim(), "held reused");
    let mut seen = cli(&dir);
    seen.env("OMPDESK_HEAVY_HELD", &pid).args([
        "run",
        "--heavy",
        "--",
        env!("CARGO_BIN_EXE_ompdesk"),
        "heavy",
        "status",
    ]);
    let seen = finish(seen);
    assert!(
        text(&seen).starts_with("1/1 heavy slots in use"),
        "{seen:?}"
    );

    hold.kill().unwrap();
    hold.wait().unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !status(&dir).starts_with("0/1 heavy slots in use") {
        assert!(
            Instant::now() < until,
            "the killed hold's slot stayed taken: {}",
            status(&dir)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_hold_whose_named_holder_is_gone_takes_a_slot() {
    let dir = temp("gone");
    let mut gone = cli(&dir)
        .args(["heavy", "status"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let dead = gone.id().to_string();
    gone.wait().unwrap();
    let mut hold = cli(&dir);
    hold.env("OMPDESK_HEAVY_HELD", &dead)
        .args(["heavy", "hold"]);
    let hold = finish(hold);
    assert!(text(&hold).starts_with("held 0 pid "), "{hold:?}");
    let _ = std::fs::remove_dir_all(dir);
}
