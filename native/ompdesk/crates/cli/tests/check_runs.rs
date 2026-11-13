//! `ompdesk check` end to end through the built binary, with plain shell commands: a disk stop is never a pass, a
//! running check is followed only by a request it answers, and a cancelled waiter never starts.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

struct Case {
    dir: PathBuf,
}

impl Case {
    fn new(name: &str) -> Case {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-check-runs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("work")).unwrap();
        std::fs::write(dir.join("work").join("input.txt"), "one").unwrap();
        Case { dir }
    }

    fn work(&self) -> PathBuf {
        self.dir.join("work")
    }

    fn command(&self, args: &[&str], env: &[(&str, &str)]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ompdesk"));
        c.args(args)
            .current_dir(self.work())
            .env("OMPDESK_HEAVY_DIR", self.dir.join("heavy"))
            .env("OMPDESK_CHECKS_DIR", self.dir.join("store"))
            .env("OMPDESK_HEAVY_SLOTS", "1")
            .env_remove("OMPDESK_HEAVY_HELD")
            .env_remove("OMPDESK_CHECK_RUN");
        for (k, v) in env {
            c.env(k, v);
        }
        c
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> (Output, String) {
        let out = self.command(args, env).output().unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        (out, text)
    }

    fn spawn(&self, args: &[&str]) -> Child {
        self.command(args, &[])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    /// The newest run's journal.
    fn latest(&self) -> Option<serde_json::Value> {
        let mut runs: Vec<PathBuf> = std::fs::read_dir(self.dir.join("store").join("runs"))
            .ok()?
            .flatten()
            .map(|e| e.path())
            .collect();
        runs.sort();
        let text = std::fs::read_to_string(runs.last()?.join("run.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn wait_for(&self, what: &str, cond: impl Fn(&Case) -> bool) {
        let until = Instant::now() + Duration::from_secs(30);
        while !cond(self) {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn state(run: &Option<serde_json::Value>) -> String {
    run.as_ref()
        .and_then(|r| r["state"].as_str())
        .unwrap_or("")
        .to_string()
}

#[test]
fn a_command_stopped_for_disk_space_is_never_a_pass_or_reused() {
    let case = Case::new("disk");
    // Exits 0 on SIGTERM, as many test runners do.
    let cmd = [
        "check",
        "--light",
        "--",
        "sh",
        "-c",
        "trap 'exit 0' TERM; sleep 60 & wait",
    ];
    let low = [
        ("OMPDESK_HEAVY_MIN_FREE_GB", "0"),
        ("OMPDESK_HEAVY_DANGER_GB", "1000000"),
    ];
    let (out, text) = case.run(&cmd, &low);
    assert_ne!(out.status.code(), Some(0), "{text}");
    assert!(text.contains("stopping the command"), "{text}");
    assert_eq!(state(&case.latest()), "error", "{text}");
    let (_, again) = case.run(
        &[
            "check",
            "--light",
            "--",
            "sh",
            "-c",
            "trap 'exit 0' TERM; sleep 60 & wait",
        ],
        &low,
    );
    assert!(
        again.contains("no earlier run"),
        "the stopped run was reused: {again}"
    );
}

#[test]
fn a_running_check_is_followed_only_on_the_same_inputs_and_mode() {
    let case = Case::new("attach");
    let cmd = ["check", "--light", "--", "sh", "-c", "sleep 30"];
    let mut follower = case.spawn(&cmd);
    case.wait_for("the first run to read its inputs", |c| {
        c.latest()
            .is_some_and(|r| r["state"] == "running" && !r["inputs"].is_null())
    });
    let first = case.latest().unwrap()["id"].as_str().unwrap().to_string();
    // What another request decides is its first line; then it is let go (the run it starts goes on its own).
    let first_line = |args: &[&str]| {
        let mut child = case.spawn(args);
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stderr.as_mut().unwrap()),
            &mut line,
        )
        .unwrap();
        let _ = child.kill();
        let _ = child.wait();
        line
    };
    let same = first_line(&cmd);
    assert!(
        same.contains("already under way on the same inputs") && same.contains(&first),
        "{same}"
    );
    let release = first_line(&[
        "check",
        "--light",
        "--release",
        "--",
        "sh",
        "-c",
        "sleep 30",
    ]);
    assert!(release.contains("not the same kind of run"), "{release}");
    std::fs::write(case.work().join("input.txt"), "two").unwrap();
    let edited = first_line(&cmd);
    assert!(
        edited.contains("on other inputs"),
        "an edited tree followed an older run: {edited}"
    );
    for run in std::fs::read_dir(case.dir.join("store").join("runs"))
        .unwrap()
        .flatten()
    {
        let id = run.file_name().to_string_lossy().into_owned();
        let _ = case.run(&["check", "cancel", &id], &[]);
    }
    let _ = follower.wait();
}

#[test]
fn a_cancelled_waiter_never_runs_its_command() {
    let case = Case::new("cancel");
    // Hold the only slot.
    let mut hold = case
        .command(&["heavy", "hold"], &[])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(hold.stdout.as_mut().unwrap()),
        &mut line,
    )
    .unwrap();
    assert!(line.starts_with("held"), "{line}");
    let marker: &Path = &case.dir.join("ran");
    let script = format!("touch '{}'", marker.display());
    let waiter = case.spawn(&["check", "--", "sh", "-c", &script]);
    case.wait_for("the check to wait", |c| state(&c.latest()) == "waiting");
    let id = case.latest().unwrap()["id"].as_str().unwrap().to_string();
    let (out, text) = case.run(&["check", "cancel", &id], &[]);
    assert!(out.status.success(), "{text}");
    case.wait_for("the waiter to give up", |c| {
        state(&c.latest()) == "cancelled"
    });
    drop(hold.stdin.take());
    let _ = hold.wait();
    let _ = waiter.wait_with_output();
    std::thread::sleep(Duration::from_millis(500));
    assert!(!marker.exists(), "the cancelled check ran its command");
}
