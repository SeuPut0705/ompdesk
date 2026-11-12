//! The local commands of the `ompdesk` CLI: they work without a running OMPdesk, so a plain shell script, CI or
//! another agent CLI uses them the same way.
//!
//! - `ompdesk run --heavy [--all] [--] CMD [ARG…]`: runs CMD holding a heavy slot (every slot with `--all`), waiting
//!   in order for one; exits with CMD's code.
//! - `ompdesk heavy status [--json]`: the pool's slots, their holders and the queue.
//! - `ompdesk heavy hold [--all]`: for a program that holds a slot itself: prints `held <slots>` once it has the
//!   slot(s) and gives them back when its stdin closes (or it dies).
//! - `ompdesk check [--full] [--light] [--release] [--] CMD [ARG…]`, `check status|attach|cancel`: see `check.rs`.

use std::io::{self, BufRead, Write};
use std::process::Command;

use crate::heavy::{self, HELD_ENV, Owner, Pool, Waiting};

pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
/// A command that could not start, as a shell reports it.
pub const EXIT_NOT_STARTED: i32 = 127;

pub const HELP: &str = concat!(
    "  run       `run --heavy [--all] [--] CMD [ARG...]`: run CMD in one of this computer's heavy slots (all with --all).\n",
    "  heavy     `heavy status [--json]` lists the slots and the queue; `heavy hold [--all]` holds slots until stdin closes.\n",
    "  check     `check [--full] [--light] [--release] [--] CMD [ARG...]`: run a test suite or check, reusing only results\n",
    "            whose inputs are unchanged; survives OMPdesk restarts. `check status [ID] [--all] [--json]`,\n",
    "            `check attach [ID]`, `check cancel ID`.\n",
);

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Runs a local command; `None` when `argv` names none, so the caller goes on with the control commands.
pub fn dispatch(argv: &[String]) -> Option<i32> {
    let (name, rest) = argv.split_first()?;
    match name.as_str() {
        "run" => Some(run(rest)),
        "heavy" => Some(heavy_command(rest)),
        "check" => Some(check_command(rest)),
        _ => None,
    }
}

fn check_command(rest: &[String]) -> i32 {
    let word = |at: usize| rest.get(at).map(String::as_str);
    match word(0) {
        Some("--spawn") => return word(1).map_or(EXIT_USAGE, crate::check::spawn_runner),
        Some("--runner") => return word(1).map_or(EXIT_USAGE, crate::check::run_runner),
        Some("status") => {
            let mut id = None;
            let (mut all, mut json) = (false, false);
            for a in &rest[1..] {
                match a.as_str() {
                    "--all" => all = true,
                    "--json" => json = true,
                    flag if flag.starts_with('-') => {
                        return usage(&format!("check status: unknown option {flag}"));
                    }
                    other => id = Some(other),
                }
            }
            return crate::check::status(id, all, json);
        }
        Some("attach") => return crate::check::attach(word(1)),
        Some("cancel") => {
            return match word(1) {
                Some(id) => crate::check::cancel(id),
                None => usage("check cancel needs a run id (ompdesk check status lists them)"),
            };
        }
        _ => {}
    }
    let (mut full, mut light, mut release) = (false, false, false);
    let mut at = 0;
    while at < rest.len() {
        match rest[at].as_str() {
            "--full" => full = true,
            "--light" => light = true,
            "--release" => release = true,
            "--" => {
                at += 1;
                break;
            }
            flag if flag.starts_with('-') => {
                return usage(&format!("check: unknown option {flag}"));
            }
            _ => break,
        }
        at += 1;
    }
    if at >= rest.len() {
        return usage(
            "check needs a command: ompdesk check [--full] [--light] [--release] [--] CMD [ARG...]",
        );
    }
    crate::check::start(crate::check::Start {
        argv: rest[at..].to_vec(),
        full,
        light,
        release,
    })
}

/// The program Windows would start for `name`: a path as given, else the first match on `PATH` with each of
/// `PATHEXT`'s extensions, so a `.cmd` shim (npm, bunx) is found and run through cmd.
#[cfg(windows)]
pub fn resolve_windows(
    name: &str,
    env: &std::collections::BTreeMap<String, String>,
) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};
    let get = |k: &str| {
        env.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.clone())
    };
    let exts: Vec<String> = get("PATHEXT")
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .collect();
    let candidates = |base: PathBuf| -> Option<PathBuf> {
        if base.extension().is_some() && base.is_file() {
            return Some(base);
        }
        exts.iter()
            .map(|e| PathBuf::from(format!("{}{e}", base.display())))
            .find(|p| p.is_file())
    };
    if name.contains(['/', '\\']) || Path::new(name).is_absolute() {
        return candidates(PathBuf::from(name));
    }
    get("PATH")?
        .split(';')
        .filter(|d| !d.is_empty())
        .find_map(|dir| candidates(Path::new(dir).join(name)))
}

fn usage(message: &str) -> i32 {
    eprintln!("ompdesk: {message}\nRun `ompdesk help` for the commands.");
    EXIT_USAGE
}

fn pool() -> io::Result<Pool> {
    Pool::new(heavy::pool_dir(&env), heavy::machine_size(&env))
}

fn cwd() -> String {
    std::env::current_dir()
        .map(|d| d.display().to_string())
        .unwrap_or_default()
}

fn minutes(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s}s")
    } else {
        format!("{}m{:02}s", s / 60, s % 60)
    }
}

fn wait_line(w: &Waiting) -> String {
    let now = heavy::now_ms();
    let holders: Vec<String> = w
        .holders
        .iter()
        .map(|o| {
            format!(
                "{} (pid {}, {} ago)",
                o.command,
                o.pid,
                minutes(now.saturating_sub(o.since))
            )
        })
        .collect();
    format!(
        "ompdesk: waiting for a heavy slot; {} ahead in the queue; held by {}\n",
        w.ahead,
        if holders.is_empty() {
            "nobody yet".into()
        } else {
            holders.join(", ")
        }
    )
}

/// Takes slots for `command_line`, printing the wait line when it has to wait.
fn take(weight: usize, command_line: &str) -> io::Result<heavy::Lease> {
    let pool = pool()?;
    let weight = if weight == 0 { pool.size } else { weight };
    let lease = pool.acquire(
        weight,
        Owner {
            pid: std::process::id(),
            command: command_line.chars().take(200).collect(),
            cwd: cwd(),
            since: 0,
            weight,
        },
        |w| eprint!("{}", wait_line(w)),
    )?;
    if lease.waited.as_secs() >= 1 {
        eprintln!(
            "ompdesk: heavy slot taken after {}",
            minutes(lease.waited.as_millis() as u64)
        );
    }
    Ok(lease)
}

/// Whether an ancestor already holds a slot for this command.
fn held_by_ancestor() -> bool {
    env(HELD_ENV)
        .and_then(|v| v.trim().parse::<u32>().ok())
        .is_some_and(crate::sys::alive)
}

fn run(rest: &[String]) -> i32 {
    let mut heavy = false;
    let mut all = false;
    let mut at = 0;
    while at < rest.len() {
        match rest[at].as_str() {
            "--heavy" => heavy = true,
            "--all" => all = true,
            "--" => {
                at += 1;
                break;
            }
            flag if flag.starts_with('-') => return usage(&format!("run: unknown option {flag}")),
            _ => break,
        }
        at += 1;
    }
    let command = &rest[at..];
    if !heavy {
        return usage("run needs --heavy (run --heavy [--all] [--] CMD [ARG...])");
    }
    if command.is_empty() {
        return usage("run --heavy needs a command");
    }
    let line = command.join(" ");
    let lease = if held_by_ancestor() {
        None
    } else {
        match take(if all { 0 } else { 1 }, &line) {
            Ok(lease) => Some(lease),
            Err(e) => {
                eprintln!("ompdesk: cannot take a heavy slot: {e}");
                return EXIT_FAILED;
            }
        }
    };
    let code = run_holding(command);
    drop(lease);
    code
}

/// Runs `command` to its end while this process holds its slots; SIGTERM and SIGHUP sent to this process are passed
/// on to it, so the holder never gives its slot back before the command ended.
fn run_holding(command: &[String]) -> i32 {
    let mut child = Command::new(&command[0]);
    child
        .args(&command[1..])
        .env(HELD_ENV, std::process::id().to_string());
    #[cfg(unix)]
    {
        let held = match crate::sys::HeldSignals::block() {
            Ok(held) => held,
            Err(e) => {
                eprintln!("ompdesk: {e}");
                return EXIT_FAILED;
            }
        };
        crate::sys::child_defaults(&mut child, false);
        let mut spawned = match child.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("ompdesk: cannot start {}: {e}", command[0]);
                return EXIT_NOT_STARTED;
            }
        };
        let pid = spawned.id();
        std::thread::spawn(move || {
            loop {
                let signal = held.wait();
                // The terminal's Ctrl-C reaches the command's group already; a kill aimed at this process is passed on.
                if signal != libc::SIGINT {
                    crate::sys::signal(pid, signal);
                }
            }
        });
        exit_code(spawned.wait())
    }
    #[cfg(not(unix))]
    {
        match child.status() {
            Ok(status) => status.code().unwrap_or(EXIT_FAILED),
            Err(e) => {
                eprintln!("ompdesk: cannot start {}: {e}", command[0]);
                EXIT_NOT_STARTED
            }
        }
    }
}

#[cfg(unix)]
pub fn exit_code(status: io::Result<std::process::ExitStatus>) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    match status {
        Ok(s) => s
            .code()
            .or_else(|| s.signal().map(|n| 128 + n))
            .unwrap_or(EXIT_FAILED),
        Err(_) => EXIT_FAILED,
    }
}

fn heavy_command(rest: &[String]) -> i32 {
    match rest.first().map(String::as_str) {
        Some("status") => {
            let json = match &rest[1..] {
                [] => false,
                [flag] if flag == "--json" => true,
                _ => return usage("heavy status takes only --json"),
            };
            let pool = match pool() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("ompdesk: {e}");
                    return EXIT_FAILED;
                }
            };
            let status = pool.status();
            let mut out = io::stdout().lock();
            if json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::to_string(&status).unwrap_or_default()
                );
                return 0;
            }
            let now = heavy::now_ms();
            let busy = status.slots.iter().filter(|s| s.held).count();
            let _ = writeln!(
                out,
                "{busy}/{} heavy slots in use ({})",
                status.size, status.dir
            );
            for slot in &status.slots {
                match (&slot.owner, slot.held) {
                    (Some(o), _) => {
                        let _ = writeln!(
                            out,
                            "  slot {}: {} (pid {}, {} ago, {})",
                            slot.slot,
                            o.command,
                            o.pid,
                            minutes(now.saturating_sub(o.since)),
                            o.cwd
                        );
                    }
                    (None, true) => {
                        let _ = writeln!(out, "  slot {}: held", slot.slot);
                    }
                    (None, false) => {
                        let _ = writeln!(out, "  slot {}: free", slot.slot);
                    }
                }
            }
            if !status.queue.is_empty() {
                let pids: Vec<String> = status.queue.iter().map(u32::to_string).collect();
                let _ = writeln!(out, "  waiting: {}", pids.join(", "));
            }
            0
        }
        Some("hold") => {
            let all = match &rest[1..] {
                [] => false,
                [flag] if flag == "--all" => true,
                _ => return usage("heavy hold takes only --all"),
            };
            let label = env("OMPDESK_HEAVY_LABEL").unwrap_or_else(|| "heavy hold".into());
            let lease = match take(if all { 0 } else { 1 }, &label) {
                Ok(lease) => lease,
                Err(e) => {
                    eprintln!("ompdesk: cannot take a heavy slot: {e}");
                    return EXIT_FAILED;
                }
            };
            let slots: Vec<String> = lease.slots().iter().map(usize::to_string).collect();
            {
                let mut out = io::stdout().lock();
                let _ = writeln!(out, "held {}", slots.join(","));
                let _ = out.flush();
            }
            // Holds until stdin ends: the holder closed it, or died.
            let mut sink = Vec::new();
            let stdin = io::stdin();
            let mut lock = stdin.lock();
            while lock.read_until(b'\n', &mut sink).is_ok_and(|n| n > 0) {
                sink.clear();
            }
            drop(lease);
            0
        }
        _ => usage("heavy takes status or hold"),
    }
}
