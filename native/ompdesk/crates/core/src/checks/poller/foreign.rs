//! Heavy work on this computer that holds none of OMPdesk's slots: another project's own lock (yuyu's `heavy-run`,
//! RNGAN's `godot_slot.sh`), a build in a plain terminal, an IDE's `cargo check`. It is read from the computer's
//! processes, counted beside the pool's slots and shown as foreign load, never managed: nothing here signals,
//! queues or judges it. The clean path for such a script is to take OMPdesk's slot (`ompdesk run --heavy`, or
//! `ompdesk heavy hold` for a shell script; rule `check-control` › Pools), which takes its work out of this count.
//!
//! What counts, by the process's own command line:
//! - `cargo`: `cargo`, `rustc`, `cargo-clippy`, `clippy-driver`;
//! - `godot`: a Godot run without its editor window (`--headless`, `--export-…`, `--script`); an open editor is no
//!   heavy work;
//! - `playwright`: a node, bun or deno process naming Playwright, and the browsers Playwright downloaded
//!   (`ms-playwright`);
//! - `vitest`: a node, bun or deno process naming Vitest (its workers are titled `node (vitest N)`).
//!
//! One piece of work is the topmost process of a kind and every process of that kind under it (a cargo and its
//! rustc's). Work under a slot's holder is OMPdesk's own: the holder of `ompdesk run --heavy` and `ompdesk check` is
//! the command's ancestor, and a script that took `ompdesk heavy hold` is the hold's parent, so everything that
//! script runs is held.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use crate::checks::contract::ForeignLoad;

/// One process as the system lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// The command line; the program alone where the line cannot be read.
    pub command: String,
}

const COMMAND_CHARS: usize = 200;
/// How far up a parent chain is followed: deeper is a cycle in a listing taken while processes came and went.
const DEPTH_MAX: usize = 64;
/// How long listing the processes may take.
const LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// The program a command line runs: its first word (quoted on Windows), without folder or `.exe`, in lower case.
fn program(command: &str) -> String {
    let command = command.trim_start();
    let first = match command.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or_default(),
        None => command.split_whitespace().next().unwrap_or_default(),
    };
    let name = first.rsplit(['/', '\\']).next().unwrap_or_default();
    let name = name.to_ascii_lowercase();
    name.strip_suffix(".exe")
        .map_or(name.clone(), str::to_owned)
}

/// The kind of heavy work a process is, when it is one.
pub fn kind_of(command: &str) -> Option<&'static str> {
    let program = program(command);
    let lower = command.to_ascii_lowercase();
    if matches!(
        program.as_str(),
        "cargo" | "rustc" | "cargo-clippy" | "clippy-driver"
    ) {
        return Some("cargo");
    }
    if program.starts_with("godot") {
        let words: Vec<&str> = lower.split_whitespace().collect();
        let unattended = words.iter().any(|word| {
            *word == "--headless" || *word == "--script" || word.starts_with("--export")
        });
        return unattended.then_some("godot");
    }
    let runtime = matches!(program.as_str(), "node" | "bun" | "bunx" | "deno" | "npx")
        || lower.starts_with("node (");
    if lower.contains("ms-playwright") || (runtime && lower.contains("playwright")) {
        return Some("playwright");
    }
    if runtime && lower.contains("vitest") {
        return Some("vitest");
    }
    None
}

fn cut(command: &str) -> String {
    match command.char_indices().nth(COMMAND_CHARS) {
        Some((at, _)) => command[..at].to_owned(),
        None => command.to_owned(),
    }
}

/// The foreign heavy work among `procs`. `holders` are the processes holding a slot of the pool (each slot's owner);
/// `own` is this process, whose tree is never foreign (the core's own children).
pub fn foreign(procs: &[Proc], holders: &[u32], own: u32) -> Vec<ForeignLoad> {
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|proc| (proc.pid, proc)).collect();
    let mut held: HashSet<u32> = holders.iter().copied().collect();
    held.insert(own);
    for holder in holders {
        if let Some(proc) = by_pid.get(holder)
            && proc.command.contains("heavy hold")
        {
            held.insert(proc.ppid);
        }
    }
    // The chain above a process, itself first.
    let chain = |pid: u32| {
        let mut chain = vec![pid];
        let mut at = pid;
        while chain.len() < DEPTH_MAX {
            let Some(parent) = by_pid.get(&at).map(|proc| proc.ppid) else {
                break;
            };
            if parent == 0 || parent == at || chain.contains(&parent) {
                break;
            }
            chain.push(parent);
            at = parent;
        }
        chain
    };
    let mut work: Vec<ForeignLoad> = Vec::new();
    for proc in procs {
        let Some(kind) = kind_of(&proc.command) else {
            continue;
        };
        let above = chain(proc.pid);
        if above.iter().any(|pid| held.contains(pid)) {
            continue;
        }
        // The topmost process of the same kind in its chain is the work it belongs to.
        let top = above
            .iter()
            .rev()
            .find(|pid| {
                by_pid
                    .get(pid)
                    .is_some_and(|proc| kind_of(&proc.command) == Some(kind))
            })
            .copied()
            .unwrap_or(proc.pid);
        match work.iter_mut().find(|work| work.pid == top) {
            Some(work) => work.processes += 1,
            None => work.push(ForeignLoad {
                kind: kind.to_owned(),
                pid: top,
                command: cut(&by_pid[&top].command),
                processes: 1,
            }),
        }
    }
    work.sort_by_key(|work| work.pid);
    work
}

/// Every process of this computer: `ps` on macOS and Linux, a Toolhelp snapshot on Windows.
pub async fn list() -> Result<Vec<Proc>, String> {
    #[cfg(unix)]
    {
        let mut command = tokio::process::Command::new("ps");
        command
            .args(["-A", "-ww", "-o", "pid=,ppid=,command="])
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(LIST_TIMEOUT, command.output())
            .await
            .map_err(|_| "ps took too long".to_owned())?
            .map_err(|error| format!("cannot run ps: {error}"))?;
        if !output.status.success() {
            return Err(format!("ps exited with {}", output.status));
        }
        Ok(parse_ps(&String::from_utf8_lossy(&output.stdout)))
    }
    #[cfg(windows)]
    {
        let entries = tokio::time::timeout(
            LIST_TIMEOUT,
            tokio::task::spawn_blocking(|| crate::sys::processes(true)),
        )
        .await
        .map_err(|_| "listing the processes took too long".to_owned())?
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        Ok(entries
            .into_iter()
            .map(|entry| {
                let command = entry
                    .process
                    .as_ref()
                    .and_then(crate::sys::Process::command_line)
                    .map_or(entry.image, |line| String::from_utf16_lossy(&line));
                Proc {
                    pid: entry.pid,
                    ppid: entry.parent,
                    command,
                }
            })
            .collect())
    }
}

/// `ps -o pid=,ppid=,command=`: two numbers and the rest of the line.
fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, rest) = line.split_once(char::is_whitespace)?;
            let rest = rest.trim_start();
            let (ppid, command) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            Some(Proc {
                pid: pid.parse().ok()?,
                ppid: ppid.parse().ok()?,
                command: command.trim().to_owned(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, ppid: u32, command: &str) -> Proc {
        Proc {
            pid,
            ppid,
            command: command.to_owned(),
        }
    }

    #[test]
    fn heavy_work_is_known_by_its_program() {
        for (command, kind) in [
            ("/Users/x/.cargo/bin/cargo build --release", Some("cargo")),
            (
                "/Users/x/.rustup/toolchains/1.95-aarch64-apple-darwin/bin/rustc --crate-name core",
                Some("cargo"),
            ),
            (
                "\"C:\\Users\\x\\.cargo\\bin\\cargo.exe\" test --workspace",
                Some("cargo"),
            ),
            ("clippy-driver --edition 2024", Some("cargo")),
            (
                "/Applications/Godot.app/Contents/MacOS/Godot --headless --path . -s tests/run.gd",
                Some("godot"),
            ),
            ("godot4 --export-release Linux build/game", Some("godot")),
            // The editor a person has open is no heavy work.
            (
                "/Applications/Godot.app/Contents/MacOS/Godot --path .",
                None,
            ),
            (
                "node /w/node_modules/@playwright/test/cli.js test e2e/smoke.e2e.ts",
                Some("playwright"),
            ),
            (
                "/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell --headless",
                Some("playwright"),
            ),
            ("node (vitest 3)", Some("vitest")),
            ("bun /w/node_modules/vitest/vitest.mjs run", Some("vitest")),
            // Words in another program's line are not that work.
            ("grep -r vitest src", None),
            ("vim playwright.config.ts", None),
            ("rust-analyzer", None),
            ("", None),
        ] {
            assert_eq!(kind_of(command), kind, "{command}");
        }
    }

    #[test]
    fn a_tree_of_one_kind_is_one_piece_of_work() {
        let procs = [
            proc(1, 0, "launchd"),
            proc(100, 1, "zsh"),
            proc(101, 100, "cargo test --workspace"),
            proc(102, 101, "rustc --crate-name a"),
            proc(103, 101, "rustc --crate-name b"),
            proc(104, 101, "cc -c x.c"),
            proc(200, 1, "node /w/node_modules/vitest/vitest.mjs run"),
            proc(201, 200, "node (vitest 1)"),
            proc(202, 200, "node (vitest 2)"),
            proc(300, 1, "/usr/bin/vim"),
        ];
        assert_eq!(
            foreign(&procs, &[], 9),
            [
                ForeignLoad {
                    kind: "cargo".to_owned(),
                    pid: 101,
                    command: "cargo test --workspace".to_owned(),
                    processes: 3
                },
                ForeignLoad {
                    kind: "vitest".to_owned(),
                    pid: 200,
                    command: "node /w/node_modules/vitest/vitest.mjs run".to_owned(),
                    processes: 3
                },
            ]
        );
    }

    #[test]
    fn work_under_a_slots_holder_is_ompdesks_own() {
        let procs = [
            proc(1, 0, "launchd"),
            // `ompdesk run --heavy -- cargo build`: the holder is the command's ancestor.
            proc(10, 1, "ompdesk run --heavy -- cargo build"),
            proc(11, 10, "cargo build"),
            proc(12, 11, "rustc --crate-name a"),
            // A script that took `ompdesk heavy hold`: the hold's parent holds everything it runs.
            proc(20, 1, "/bin/sh scripts/yuyu heavy-run"),
            proc(21, 20, "ompdesk heavy hold"),
            proc(22, 20, "godot --headless -s tests/run.gd"),
            // Another project's own lock: foreign.
            proc(30, 1, "/bin/sh tools/godot_slot.sh"),
            proc(31, 30, "godot --headless -s tests/run.gd"),
            // The core's own children.
            proc(40, 1, "ompdesk-core"),
            proc(41, 40, "cargo metadata"),
        ];
        let work = foreign(&procs, &[10, 21], 40);
        assert_eq!(
            work.iter()
                .map(|work| (work.kind.as_str(), work.pid))
                .collect::<Vec<_>>(),
            [("godot", 31)]
        );
    }

    #[test]
    fn a_long_line_is_cut_and_a_listing_with_a_cycle_ends() {
        let long = format!("cargo build {}", "é".repeat(400));
        let procs = [proc(5, 6, &long), proc(6, 5, "cargo build")];
        let work = foreign(&procs, &[], 1);
        assert_eq!(work.iter().map(|work| work.processes).sum::<u32>(), 2);
        assert!(
            work.iter()
                .all(|work| work.command.chars().count() <= COMMAND_CHARS)
        );
    }

    #[test]
    fn ps_lines_read_as_processes() {
        let text = "    1     0 /sbin/launchd\n  501     1 /bin/zsh -l\n  777   501 cargo   build  --release\n\
            garbage line\n  888   777\n";
        assert_eq!(
            parse_ps(text),
            [
                proc(1, 0, "/sbin/launchd"),
                proc(501, 1, "/bin/zsh -l"),
                proc(777, 501, "cargo   build  --release"),
                proc(888, 777, ""),
            ]
        );
    }

    /// This computer's own listing: the test process itself is in it, under its parent.
    #[tokio::test]
    async fn this_computers_processes_are_listed() {
        let procs = list().await.unwrap();
        let me = std::process::id();
        let mine = procs
            .iter()
            .find(|proc| proc.pid == me)
            .expect("this process");
        assert!(!mine.command.is_empty());
        assert!(procs.len() > 3);
    }
}
