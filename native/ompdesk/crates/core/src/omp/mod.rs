//! The omps this app runs, named in a file for the next launch (was the file, the identity and the leftover's stop of
//! `src/main/omp-processes.ts`). Main says when it spawned an omp (`omp.track`) and when one exited (`omp.exited`);
//! a launch first stops the ones an earlier instance left running when it crashed or was forced out (`omp.reap`):
//! one omp stuck on a blocked thread kept every new omp on the machine stalled for three minutes after a relaunch
//! (8 Nov 2026).
//!
//! The file (`<userData>/omp-pids.json`, `{"omps":[{"pid","started"?}]}`) is the whole state: every request reads
//! it, changes it and writes it back, one at a time, so a core that started again goes on where the last one was.
//!
//! A leftover is stopped only while it is still what this app started, never a reused pid of another program.
//! Windows hands a freed pid to a new process within a few hundred ms, so there the process's creation time must
//! equal the one recorded at the spawn (`started`, ms since the epoch, `GetProcessTimes`: the number `Get-Process`
//! shows as `StartTime`, which the TypeScript recorded, so its files still compare); and because the recorded
//! process there is omp's shim, which Windows ends with the app, what a gone shim left is looked for too (`find`).
//! Elsewhere the pid's command line must hold this app's gui-bridge path. An entry leaves the file only when its pid
//! is gone and left nothing, the OS showed the pid and it is not ours, or what was stopped for it is gone. A pid
//! that still runs but could not be read or has no recorded time stays for the next launch, and so does an entry
//! whose stop something survived.
//!
//! The stop of an omp the app still holds (its stdin's end, the hold it asks for while it saves a login) is main's
//! (`omp-stop.ts`), and so is the quit's wait for all of them: both need the child process main spawned.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::disk::tree::write_atomic;
use crate::server::{Fault, Registry, Reply, Scope};

/// How often a stop looks whether a pid it is not the parent of is gone (`kill(pid, 0)`).
#[cfg(unix)]
const GONE_POLL: Duration = Duration::from_millis(100);
/// How often a stop looks whether what it ended through its handles is gone: a terminated process is, within ms.
#[cfg(windows)]
const GONE_POLL: Duration = Duration::from_millis(10);
/// The file names this user's processes: the user's alone.
const FILE_MODE: u32 = 0o600;
const DIR_MODE: u32 = 0o700;

/// One request on the file at a time. A reap holds it for its whole run, so a spawn recorded meanwhile lands after.
static LEDGER: Mutex<()> = Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PidParams {
    file: String,
    pid: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReapParams {
    file: String,
    /// This app's gui-bridge folder, which every omp it spawns has in its command line.
    bridge_dir: String,
    /// How long a leftover asked to end gets before it is killed (main's `STOP_GRACE_MS`).
    grace_ms: u64,
    /// After the kill, how long the stop still waits for the exit (main's `KILL_WAIT_MS`).
    kill_wait_ms: u64,
}

#[derive(Debug, Serialize)]
struct Reaped {
    /// The leftovers confirmed gone after their stop, in the file's order.
    stopped: Vec<u32>,
}

/// One omp the file names. `started` is absent on POSIX, while Windows could not read it, and in files an older
/// OMPdesk wrote; an entry without one is never stopped on Windows.
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    pid: u32,
    started: Option<f64>,
}

pub fn register(registry: &mut Registry) {
    registry.add("omp.track", |call| {
        Box::pin(async move {
            let params: PidParams = call.params()?;
            track(params, call.scope).await?;
            Reply::json(&())
        })
    });
    registry.add("omp.exited", |call| {
        Box::pin(async move {
            let params: PidParams = call.params()?;
            exited(params, call.scope).await?;
            Reply::json(&())
        })
    });
    registry.add("omp.reap", |call| {
        Box::pin(async move {
            let params: ReapParams = call.params()?;
            Reply::json(&reap(params, call.scope).await?)
        })
    });
}

/// File and OS reads on tokio's blocking pool.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The omp file's work panicked"))
}

fn check_pid(pid: u32) -> Result<(), Fault> {
    if pid == 0 {
        return Err(Fault::new("invalid_params", "0 is no process id"));
    }
    Ok(())
}

/// The file's text; empty when it cannot be read (none yet).
fn read(file: &Path) -> String {
    std::fs::read(file)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// The entries of the file's text: each object of `omps` whose `pid` is a whole number a process can have, with its
/// `started` when that is a number. Anything else (a damaged file, another shape) names no omp.
fn parse(text: &str) -> Vec<Entry> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(omps) = value.get("omps").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    omps.iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let pid = entry
                .get("pid")
                .filter(|pid| pid.is_number())?
                .as_f64()
                .filter(|pid| pid.fract() == 0.0 && (1.0..=f64::from(u32::MAX)).contains(pid))?;
            let started = entry
                .get("started")
                .filter(|started| started.is_number())
                .and_then(serde_json::Value::as_f64);
            Some(Entry {
                // A whole number in u32's range, checked above.
                pid: pid as u32,
                started,
            })
        })
        .collect()
}

/// The file's text for `entries`, as `JSON.stringify({ omps })` and a newline wrote it.
fn render(entries: &[Entry]) -> String {
    let mut text = String::from("{\"omps\":[");
    for (index, entry) in entries.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        let _ = write!(text, "{{\"pid\":{}", entry.pid);
        if let Some(started) = entry.started {
            // A whole number prints without a fraction, as JavaScript prints it.
            let _ = write!(text, ",\"started\":{started}");
        }
        text.push('}');
    }
    text.push_str("]}\n");
    text
}

/// Replaces the file when `entries` read otherwise than `before`, the text they were read from.
fn save(file: &Path, before: &str, entries: &[Entry], scope: &Scope) -> Result<(), Fault> {
    let after = render(entries);
    if after != before {
        write_atomic(file, after.as_bytes(), FILE_MODE, DIR_MODE, scope)?;
    }
    Ok(())
}

/// Reads the file, lets `change` edit its entries and writes it back, alone on the file.
async fn edit(
    file: String,
    scope: Scope,
    change: impl FnOnce(&mut Vec<Entry>) + Send + 'static,
) -> Result<(), Fault> {
    let _held = LEDGER.lock().await;
    blocking(move || {
        let file = PathBuf::from(file);
        let before = read(&file);
        let mut entries = parse(&before);
        change(&mut entries);
        save(&file, &before, &entries, &scope)
    })
    .await?
}

/// What a just-spawned omp is recorded as: with its creation time, read now, where that is its identity. None when
/// it is gone already: its pid may name another program by now.
#[cfg(windows)]
fn recorded(pid: u32) -> Option<Entry> {
    match crate::sys::process_started_ms(pid) {
        Ok(Some(started)) => Some(Entry {
            pid,
            started: Some(started as f64),
        }),
        Ok(None) => None,
        Err(_) => Some(Entry { pid, started: None }),
    }
}

/// What a just-spawned omp is recorded as: its pid; its command line is its identity.
#[cfg(unix)]
fn recorded(pid: u32) -> Option<Entry> {
    Some(Entry { pid, started: None })
}

/// Main spawned the omp `pid`. An older entry of that pid names a process that is gone (a pid names one process at a
/// time) and goes.
async fn track(params: PidParams, scope: Scope) -> Result<(), Fault> {
    let pid = params.pid;
    check_pid(pid)?;
    edit(params.file, scope, move |entries| {
        entries.retain(|entry| entry.pid != pid);
        entries.extend(recorded(pid));
    })
    .await
}

/// The omp `pid` main spawned has exited.
async fn exited(params: PidParams, scope: Scope) -> Result<(), Fault> {
    let pid = params.pid;
    check_pid(pid)?;
    edit(params.file, scope, move |entries| {
        entries.retain(|entry| entry.pid != pid);
    })
    .await
}

/// What the OS shows of a pid now. Each system reads one kind of identity; the rule over both is one function, tested
/// on every system.
#[derive(Debug)]
enum Seen {
    /// No process has it.
    Gone,
    /// A process has it and nothing of it could be read.
    Unknown,
    /// Windows: the creation time of the process that has it.
    #[cfg_attr(all(unix, not(test)), allow(dead_code))]
    Started(f64),
    /// Elsewhere: the command line of the process that has it, its arguments joined by spaces as `ps` prints them.
    #[cfg_attr(all(windows, not(test)), allow(dead_code))]
    Command(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Verdict {
    /// The pid is free: the entry goes.
    Gone,
    /// Still the omp this app spawned: it is stopped.
    Ours,
    /// Another program's by now: the entry goes and nothing is stopped.
    NotOurs,
    /// It runs and cannot be told: the entry stays for the next launch.
    Unresolved,
}

/// Whose the process an entry's pid names is. A creation time counts only when the OS gave a usable one (above zero)
/// and the entry recorded one; equal to the bit, because a slack would stop another program that took the pid.
fn judge(entry: &Entry, seen: &Seen, bridge_dir: &str) -> Verdict {
    match seen {
        Seen::Gone => Verdict::Gone,
        Seen::Unknown => Verdict::Unresolved,
        Seen::Started(time) => match entry.started {
            Some(started) if *time > 0.0 => {
                if started == *time {
                    Verdict::Ours
                } else {
                    Verdict::NotOurs
                }
            }
            _ => Verdict::Unresolved,
        },
        Seen::Command(line) => {
            if line.contains(bridge_dir) {
                Verdict::Ours
            } else {
                Verdict::NotOurs
            }
        }
    }
}

#[cfg(windows)]
fn see(pid: u32) -> Seen {
    match crate::sys::process_started_ms(pid) {
        Ok(Some(started)) => Seen::Started(started as f64),
        Ok(None) => Seen::Gone,
        Err(_) => Seen::Unknown,
    }
}

/// A process whose arguments cannot be read (another user's, a zombie) is unknown.
#[cfg(unix)]
fn see(pid: u32) -> Seen {
    if !crate::sys::alive(pid) {
        return Seen::Gone;
    }
    let arguments = crate::procs::Reader::default().arguments(pid);
    if arguments.is_empty() {
        Seen::Unknown
    } else {
        Seen::Command(arguments.join(" "))
    }
}

/// A process a reap stops for an entry.
struct Leftover {
    pid: u32,
    /// It and everything it started, each opened to end it, itself first; empty when it cannot be opened.
    #[cfg(windows)]
    tree: Vec<crate::sys::Process>,
    /// The shim it ran behind died with the app, so its stdin ended then: it gets the grace to end by itself.
    #[cfg(windows)]
    orphan: bool,
}

/// What a reap found for one entry: whose its pid is, and what to stop for it.
struct Finding {
    verdict: Verdict,
    stop: Vec<Leftover>,
}

/// Each entry's finding: the pid's process is stopped when it is ours.
#[cfg(unix)]
fn find(entries: &[Entry], bridge_dir: &str) -> Vec<Finding> {
    entries
        .iter()
        .map(|entry| {
            let verdict = judge(entry, &see(entry.pid), bridge_dir);
            let stop = if verdict == Verdict::Ours {
                vec![Leftover { pid: entry.pid }]
            } else {
                Vec::new()
            };
            Finding { verdict, stop }
        })
        .collect()
}

/// A creation time as the OS gives one: a whole number of ms.
#[cfg(windows)]
fn whole_ms(started: f64) -> Option<u64> {
    (started.fract() == 0.0 && (0.0..9e15).contains(&started)).then_some(started as u64)
}

/// Each entry's finding. The recorded pid is the shim omp runs behind (`omp.cmd`, bun's `omp.exe`), and Windows ends
/// that one with the app that spawned it, however the app ended (node keeps its children in a job that is closed with
/// it), while the real omp behind it runs on. So when the recorded process is gone, what it left is looked for: a
/// process whose parent id is the recorded pid, that started no earlier than the shim, that no later holder of the
/// pid started, and whose command line holds this app's gui-bridge path. A shim that still runs is stopped itself.
/// Either goes with everything it started.
#[cfg(windows)]
fn find(entries: &[Entry], bridge_dir: &str) -> Vec<Finding> {
    // Taken once, when the first entry needs it.
    let mut snapshot: Option<Option<crate::procs::Snapshot>> = None;
    let mut findings = Vec::with_capacity(entries.len());
    for entry in entries {
        let verdict = judge(entry, &see(entry.pid), bridge_dir);
        let started = match (verdict, entry.started.and_then(whole_ms)) {
            (Verdict::Unresolved, _) | (_, None) => {
                findings.push(Finding {
                    verdict,
                    stop: Vec::new(),
                });
                continue;
            }
            (_, Some(started)) => started,
        };
        let Some(snapshot) = snapshot
            .get_or_insert_with(|| crate::procs::Snapshot::take().ok())
            .as_mut()
        else {
            // The processes cannot be listed: nothing is stopped, and what may still run stays listed.
            findings.push(Finding {
                verdict: Verdict::Unresolved,
                stop: Vec::new(),
            });
            continue;
        };
        let (roots, orphan) = match snapshot.find(entry.pid, started) {
            Some(shim) => (vec![shim], false),
            None => (
                snapshot.orphans_holding(entry.pid, started, bridge_dir),
                true,
            ),
        };
        let stop = roots
            .into_iter()
            .map(|root| Leftover {
                pid: snapshot.pid(root),
                tree: snapshot.take_tree(root),
                orphan,
            })
            .collect();
        findings.push(Finding { verdict, stop });
    }
    findings
}

/// What stays in the file and what was stopped, from each entry's verdict and, for every process stopped for it, its
/// pid and whether the stop left it gone. An entry stays while it cannot be told or something stopped for it
/// survived; only what is gone is reported.
fn settle(
    entries: Vec<Entry>,
    outcomes: Vec<(Verdict, Vec<(u32, bool)>)>,
) -> (Vec<Entry>, Vec<u32>) {
    let mut kept = Vec::new();
    let mut stopped = Vec::new();
    for (entry, (verdict, stops)) in entries.into_iter().zip(outcomes) {
        stopped.extend(stops.iter().filter(|(_, gone)| *gone).map(|(pid, _)| *pid));
        if verdict == Verdict::Unresolved || stops.iter().any(|(_, gone)| !gone) {
            kept.push(entry);
        }
    }
    (kept, stopped)
}

/// Looks every `GONE_POLL` until `gone` holds, for at most `wait`; whether it held.
async fn gone_within(wait: Duration, gone: impl Fn() -> bool) -> bool {
    let until = Instant::now() + wait;
    loop {
        if gone() {
            return true;
        }
        let now = Instant::now();
        if now >= until {
            return false;
        }
        tokio::time::sleep(GONE_POLL.min(until - now)).await;
    }
}

/// Stops a leftover omp, one this process is not the parent of: SIGTERM, whose handler disposes the session, and
/// after `grace` SIGKILL to its process group (main spawns every omp as the leader of one, so its tools go with it),
/// else to the pid alone. Whether the pid is gone, at the latest `kill_wait` after the kill. The command line is read
/// again before each signal: a pid that names another program by then is never signalled, and our omp is gone.
#[cfg(unix)]
async fn stop(
    leftover: Leftover,
    bridge_dir: String,
    grace: Duration,
    kill_wait: Duration,
) -> bool {
    let pid = leftover.pid;
    let ours = || matches!(see(pid), Seen::Command(line) if line.contains(&bridge_dir));
    let gone = || !crate::sys::alive(pid);
    if !ours() {
        return true;
    }
    crate::sys::signal(pid, false);
    if gone_within(grace, gone).await || !ours() {
        return true;
    }
    if !crate::sys::signal_group(pid, true) {
        crate::sys::signal(pid, true);
    }
    gone_within(kill_wait, gone).await
}

/// Stops a leftover omp with every process it started. Windows has no signal to ask with: what asks an omp there is
/// its stdin's end, which an orphan got when the app died, so it has `grace` from now to end by itself; a shim that
/// still runs is ended at once, as `taskkill /t /f` ended it. Each process is ended through the handle the snapshot
/// opened, so a reused pid is never hit. Whether all of them are gone, at the latest `kill_wait` after the kill.
#[cfg(windows)]
async fn stop(
    leftover: Leftover,
    _bridge_dir: String,
    grace: Duration,
    kill_wait: Duration,
) -> bool {
    let tree = leftover.tree;
    if tree.is_empty() {
        return false;
    }
    let gone = || tree.iter().all(crate::sys::Process::exited);
    if leftover.orphan && gone_within(grace, gone).await {
        return true;
    }
    for process in &tree {
        process.terminate();
    }
    gone_within(kill_wait, gone).await
}

/// Stops the omps the file names that still run and are still this app's, and drops the entries that are settled.
/// The file changes only at the end, so a crash during the reap leaves every leftover listed.
async fn reap(params: ReapParams, scope: Scope) -> Result<Reaped, Fault> {
    if params.bridge_dir.is_empty() {
        return Err(Fault::new(
            "invalid_params",
            "bridgeDir is empty, which every command line holds",
        ));
    }
    let _held = LEDGER.lock().await;
    let file = PathBuf::from(params.file);
    let bridge_dir = params.bridge_dir;
    let (before, entries, findings) = {
        let file = file.clone();
        let bridge_dir = bridge_dir.clone();
        blocking(move || {
            let before = read(&file);
            let entries = parse(&before);
            let findings = find(&entries, &bridge_dir);
            (before, entries, findings)
        })
        .await?
    };
    if entries.is_empty() {
        return Ok(Reaped {
            stopped: Vec::new(),
        });
    }
    let grace = Duration::from_millis(params.grace_ms);
    let kill_wait = Duration::from_millis(params.kill_wait_ms);
    // Every stop runs at once; each entry's are read in the file's order.
    let running: Vec<_> = findings
        .into_iter()
        .map(|finding| {
            let stops: Vec<_> = finding
                .stop
                .into_iter()
                .map(|leftover| {
                    let pid = leftover.pid;
                    let stop = tokio::spawn(stop(leftover, bridge_dir.clone(), grace, kill_wait));
                    (pid, stop)
                })
                .collect();
            (finding.verdict, stops)
        })
        .collect();
    let mut outcomes = Vec::with_capacity(running.len());
    for (verdict, stops) in running {
        let mut ended = Vec::with_capacity(stops.len());
        for (pid, stop) in stops {
            ended.push((pid, stop.await.unwrap_or(false)));
        }
        outcomes.push((verdict, ended));
    }
    let (kept, stopped) = settle(entries, outcomes);
    blocking(move || save(&file, &before, &kept, &scope)).await??;
    Ok(Reaped { stopped })
}

#[cfg(test)]
mod tests {
    use std::process::{Child, Command, Stdio};

    use super::*;

    /// What the TypeScript decided (`captured.json`, written from `OmpProcesses` with its lookups faked, before it was
    /// deleted): for an entry and what the lookup showed of its pid, whether its stop was asked for, whether it was
    /// reported stopped and whether it stayed in the file; and what each file text read as.
    fn captured() -> serde_json::Value {
        serde_json::from_str(include_str!("captured.json")).unwrap()
    }

    #[test]
    fn judges_and_settles_every_captured_leftover_as_the_typescript_did() {
        let captured = captured();
        let rows = captured["verdicts"].as_array().unwrap();
        assert_eq!(rows.len(), 86);
        for row in rows {
            let entry = Entry {
                pid: 4242,
                started: row.get("started").and_then(serde_json::Value::as_f64),
            };
            let seen = match row["seen"]["kind"].as_str().unwrap() {
                "unknown" => Seen::Unknown,
                "started" => Seen::Started(row["seen"]["time"].as_f64().unwrap()),
                "command" => Seen::Command(row["seen"]["line"].as_str().unwrap().to_owned()),
                kind => panic!("unknown kind {kind}"),
            };
            let verdict = judge(&entry, &seen, "/bridge");
            let stop_gone = row["stopGone"].as_bool().unwrap();
            // The TypeScript stopped one process for an entry it judged ours: the entry's own pid.
            let stops = if verdict == Verdict::Ours {
                vec![(entry.pid, stop_gone)]
            } else {
                Vec::new()
            };
            let (kept, stopped) = settle(vec![entry], vec![(verdict, stops)]);
            assert_eq!(
                (
                    verdict == Verdict::Ours,
                    !stopped.is_empty(),
                    !kept.is_empty()
                ),
                (
                    row["asked"].as_bool().unwrap(),
                    row["stopped"].as_bool().unwrap(),
                    row["kept"].as_bool().unwrap()
                ),
                "{row}"
            );
        }
    }

    #[test]
    fn reads_and_writes_every_captured_file_as_the_typescript_did() {
        let captured = captured();
        let rows = captured["files"].as_array().unwrap();
        assert_eq!(rows.len(), 23);
        for row in rows {
            let input = row["input"].as_str().unwrap();
            let entries = parse(input);
            match row["output"].as_str() {
                Some(output) => assert_eq!(render(&entries), output, "{row}"),
                // The TypeScript left the file as it was: it named no omp, or already read as it writes.
                None => assert!(entries.is_empty() || render(&entries) == input, "{row}"),
            }
        }
    }

    #[test]
    fn a_pid_no_process_can_have_names_no_omp() {
        let text = r#"{"omps":[{"pid":0},{"pid":-7},{"pid":4294967296},{"pid":7}]}"#;
        assert_eq!(
            parse(text),
            [Entry {
                pid: 7,
                started: None
            }]
        );
    }

    #[test]
    fn a_gone_pid_leaves_the_file_and_an_unreadable_one_stays() {
        let entry = |pid| Entry {
            pid,
            started: Some(7000.0),
        };
        let verdicts = [
            judge(&entry(1), &Seen::Gone, "/bridge"),
            judge(&entry(2), &Seen::Unknown, "/bridge"),
        ];
        assert_eq!(verdicts, [Verdict::Gone, Verdict::Unresolved]);
        let (kept, stopped) = settle(
            vec![entry(1), entry(2)],
            verdicts.map(|verdict| (verdict, Vec::new())).to_vec(),
        );
        assert_eq!((kept, stopped), (vec![entry(2)], vec![]));
    }

    #[test]
    fn an_entry_whose_pid_is_gone_stays_while_what_it_left_survives_its_stop() {
        let entry = |pid| Entry {
            pid,
            started: Some(7000.0),
        };
        let (kept, stopped) = settle(
            vec![entry(1), entry(2)],
            vec![
                (Verdict::Gone, vec![(10, true), (11, false)]),
                (Verdict::NotOurs, vec![(20, true)]),
            ],
        );
        assert_eq!((kept, stopped), (vec![entry(1)], vec![10, 20]));
    }

    fn hex(bytes: usize) -> String {
        let mut random = vec![0; bytes];
        crate::sys::random(&mut random).unwrap();
        random.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// A folder of the test's own, removed with it.
    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Temp {
            let dir = std::env::temp_dir().join(format!("ompdesk-omp-{}", hex(6)));
            std::fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }

        fn file(&self) -> String {
            self.0.join("omp-pids.json").to_string_lossy().into_owned()
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Processes a test started; whatever of them still runs is ended when the test ends, failed or not.
    #[derive(Default)]
    struct Started(Vec<Child>);

    impl Started {
        fn spawn(&mut self, mut command: Command) -> u32 {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // CREATE_NO_WINDOW
                command.creation_flags(0x0800_0000);
            }
            let child = command.spawn().unwrap();
            let pid = child.id();
            self.0.push(child);
            pid
        }

        fn child(&mut self, pid: u32) -> &mut Child {
            self.0.iter_mut().find(|child| child.id() == pid).unwrap()
        }

        /// Whether the child still runs; this also reaps one that ended, as the app that spawned an omp does.
        fn running(&mut self, pid: u32) -> bool {
            self.child(pid).try_wait().unwrap().is_none()
        }
    }

    impl Drop for Started {
        fn drop(&mut self) {
            for child in &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn pid_params(file: &str, pid: u32) -> PidParams {
        PidParams {
            file: file.to_owned(),
            pid,
        }
    }

    fn reaping(file: &str, bridge_dir: &str, grace_ms: u64) -> ReapParams {
        ReapParams {
            file: file.to_owned(),
            bridge_dir: bridge_dir.to_owned(),
            grace_ms,
            kill_wait_ms: 5_000,
        }
    }

    fn entries_of(file: &str) -> Vec<Entry> {
        parse(&read(Path::new(file)))
    }

    /// A process that runs two minutes doing nothing.
    fn long() -> Command {
        if cfg!(windows) {
            let mut command = Command::new("ping");
            command.args(["-n", "120", "127.0.0.1"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("120");
            command
        }
    }

    #[tokio::test]
    async fn a_spawn_is_recorded_once_and_its_exit_takes_it_out() {
        let temp = Temp::new();
        let file = temp.file();
        let mut started = Started::default();
        let pid = started.spawn(long());

        track(pid_params(&file, pid), Scope::detached())
            .await
            .unwrap();
        track(pid_params(&file, pid), Scope::detached())
            .await
            .unwrap();

        let entries = entries_of(&file);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, pid);
        #[cfg(windows)]
        {
            let read = crate::sys::process_started_ms(pid).unwrap().unwrap();
            assert_eq!(entries[0].started, Some(read as f64));
            assert_eq!(crate::sys::process_started_ms(pid).unwrap(), Some(read));
        }
        #[cfg(unix)]
        assert_eq!(entries[0].started, None);
        assert_eq!(read(Path::new(&file)), render(&entries));

        exited(pid_params(&file, pid), Scope::detached())
            .await
            .unwrap();
        assert_eq!(read(Path::new(&file)), "{\"omps\":[]}\n");
    }

    #[tokio::test]
    async fn a_file_that_names_no_omp_is_left_as_it_is_by_a_reap() {
        let temp = Temp::new();
        let file = temp.file();
        std::fs::write(&file, "not json").unwrap();

        let reaped = reap(reaping(&file, "/bridge", 100), Scope::detached())
            .await
            .unwrap();

        assert!(reaped.stopped.is_empty());
        assert_eq!(read(Path::new(&file)), "not json");
    }

    /// The process `parent` started whose image is `image`, once it has.
    #[cfg(windows)]
    async fn child_of(parent: u32, image: &str) -> u32 {
        let began = Instant::now();
        loop {
            let found = crate::sys::processes(false)
                .unwrap()
                .into_iter()
                .find(|entry| entry.parent == parent && entry.image.eq_ignore_ascii_case(image));
            if let Some(found) = found {
                return found.pid;
            }
            assert!(
                began.elapsed() < Duration::from_secs(20),
                "{parent} started no {image}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Windows: a leftover is the process with the recorded pid and creation time. It goes with what it started (the
    /// shim's real omp); a program with the pid and another time, one with no recorded time and a free pid do not.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_launch_ends_the_leftover_with_its_tree_and_no_other_process() {
        use std::os::windows::process::CommandExt;

        let temp = Temp::new();
        let file = temp.file();
        let mut started = Started::default();
        let mut shim = Command::new("cmd");
        shim.raw_arg("/d /c ping -n 120 127.0.0.1 >nul");
        let leftover = started.spawn(shim);
        let stranger = started.spawn(long());
        let unrecorded = started.spawn(long());
        let inner = child_of(leftover, "PING.EXE").await;

        track(pid_params(&file, leftover), Scope::detached())
            .await
            .unwrap();
        let recorded = entries_of(&file)[0].started.unwrap();
        let entry = |pid, started| Entry { pid, started };
        std::fs::write(
            &file,
            render(&[
                entry(leftover, Some(recorded)),
                entry(stranger, Some(recorded + 300.0)),
                entry(unrecorded, None),
                entry(999_999_999, Some(recorded)),
            ]),
        )
        .unwrap();

        let reaped = reap(reaping(&file, "/bridge", 100), Scope::detached())
            .await
            .unwrap();

        assert_eq!(reaped.stopped, [leftover]);
        assert!(!started.running(leftover));
        assert_eq!(crate::sys::process_started_ms(inner).unwrap(), None);
        assert!(started.running(stranger));
        assert!(started.running(unrecorded));
        assert_eq!(entries_of(&file), [entry(unrecorded, None)]);
    }

    /// Ends what a test left running that is no child of its own, failed or not.
    #[cfg(windows)]
    struct Strays(Vec<u32>);

    #[cfg(windows)]
    impl Drop for Strays {
        fn drop(&mut self) {
            for pid in &self.0 {
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }

    /// A shim as omp's is: a `cmd` that runs another `cmd`, whose command line holds `argument`, which runs `ping`.
    #[cfg(windows)]
    fn shim(argument: &str) -> Command {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd");
        command.raw_arg(format!(
            "/d /c cmd /d /c \"ping -n 120 127.0.0.1 >nul & rem {argument}\""
        ));
        command
    }

    /// Windows ends the recorded shim with the app, and the real omp behind it runs on: the launch finds it by its
    /// dead parent's pid and this app's gui-bridge path, gives it the grace and ends it with what it started. What
    /// another dead shim left, whose command line holds another path, is not touched.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_launch_ends_the_omp_a_dead_shim_left_and_no_other_orphan() {
        let temp = Temp::new();
        let file = temp.file();
        let bridge = temp.0.join("gui-bridge").to_string_lossy().into_owned();
        let mut started = Started::default();
        let ours = started.spawn(shim(&format!("{bridge}\\index.ts")));
        let other = started.spawn(shim("C:\\elsewhere\\gui-bridge\\index.ts"));
        let omp = child_of(ours, "cmd.exe").await;
        let stranger = child_of(other, "cmd.exe").await;
        let _strays = Strays(vec![omp, stranger]);
        let tool = child_of(omp, "PING.EXE").await;
        for shim in [ours, other] {
            track(pid_params(&file, shim), Scope::detached())
                .await
                .unwrap();
        }
        // The app dies: Windows ends the shims, and only them.
        for shim in [ours, other] {
            started.child(shim).kill().unwrap();
            started.child(shim).wait().unwrap();
        }
        assert!(crate::sys::process_started_ms(omp).unwrap().is_some());

        let began = Instant::now();
        let reaped = reap(reaping(&file, &bridge, 300), Scope::detached())
            .await
            .unwrap();

        assert_eq!(reaped.stopped, [omp]);
        assert!(
            began.elapsed() >= Duration::from_millis(300),
            "it had the grace"
        );
        assert_eq!(crate::sys::process_started_ms(omp).unwrap(), None);
        assert_eq!(crate::sys::process_started_ms(tool).unwrap(), None);
        assert!(crate::sys::process_started_ms(stranger).unwrap().is_some());
        assert_eq!(read(Path::new(&file)), "{\"omps\":[]}\n");
    }

    /// A shell that loops, with `argument` in its command line; `deaf` ignores SIGTERM.
    #[cfg(unix)]
    fn looping(argument: &str, deaf: bool) -> Command {
        let mut command = Command::new("sh");
        let script = if deaf {
            "trap '' TERM; while :; do sleep 1; done"
        } else {
            "while :; do sleep 1; done"
        };
        command.args(["-c", script, "sh", argument]);
        command
    }

    /// Waits for children as the app that spawned them would, so one that ended leaves no zombie holding its pid.
    #[cfg(unix)]
    async fn reaping_children<T>(started: &mut Started, work: impl Future<Output = T>) -> T {
        tokio::pin!(work);
        loop {
            tokio::select! {
                done = &mut work => return done,
                () = tokio::time::sleep(Duration::from_millis(20)) => {
                    for child in &mut started.0 {
                        let _ = child.try_wait();
                    }
                }
            }
        }
    }

    /// Elsewhere: a leftover is a pid whose command line holds this app's gui-bridge path. One that ends when asked
    /// and one that ignores SIGTERM both go; another program's pid and a free one leave the file untouched.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_launch_ends_the_leftovers_and_no_other_process() {
        let temp = Temp::new();
        let file = temp.file();
        let bridge = temp.0.join("gui-bridge").to_string_lossy().into_owned();
        let index = format!("{bridge}/index.ts");
        let mut started = Started::default();
        let polite = started.spawn(looping(&index, false));
        let deaf = started.spawn(looping(&index, true));
        let stranger = started.spawn(looping("/elsewhere/index.ts", false));
        let entry = |pid| Entry { pid, started: None };
        std::fs::write(
            &file,
            render(&[
                entry(polite),
                entry(deaf),
                entry(stranger),
                entry(999_999_999),
            ]),
        )
        .unwrap();

        let reaped = reaping_children(
            &mut started,
            reap(reaping(&file, &bridge, 500), Scope::detached()),
        )
        .await
        .unwrap();

        assert_eq!(reaped.stopped, [polite, deaf]);
        assert!(!started.running(polite));
        assert!(!started.running(deaf));
        assert!(started.running(stranger));
        assert_eq!(read(Path::new(&file)), "{\"omps\":[]}\n");
    }
}
