//! The one stop of an omp (was `stopOmp` of `src/main/omp-stop.ts`): every path (tab close, restart, sleep, a revive, the
//! quit, an update's relaunch) goes through it, and it ends only once the process has exited, so a replacement on the
//! same tab or session never overlaps it.
//!
//! The omp is first asked the way a stop should read in its session journal: stock journals `session_exit` and a
//! relaunch's restore dates the stop by it (`cutByEarlierStop`, `shutdownMarks` in restart-core.ts). POSIX: SIGTERM,
//! whose handler disposes the session. Windows has no signals and a tree kill journals nothing, so its stdin ends (stock
//! disposes the session then, as on an app quit). An omp still running `grace` later is killed with its tools
//! (`kill_tree`), unless it said it waits to save (`EXIT_HOLD`): then the kill waits for the time it named, at most
//! `hold_max`. The shim waits for the omp on Windows, so its exit means the omp is gone.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, watch};

/// How long an omp gets to end by itself once its stop began (SIGTERM; on Windows its stdin ended) before it is killed.
/// A Bun process whose main thread is blocked runs its SIGTERM handler only once the thread frees (measured: a 6 s busy
/// loop ran the handler 5 s after the signal), and one that never frees kept every new omp on the machine stalled for
/// minutes after the app quit (8 Nov 2026): past this bound the stop no longer asks.
pub const STOP_GRACE: Duration = Duration::from_millis(5_000);
/// After the kill, how long the stop still waits for the exit (a process in uninterruptible sleep outlasts SIGKILL).
pub const KILL_WAIT: Duration = Duration::from_millis(2_000);
/// Past the time an exit hold asked for, how long the omp still has to end before the kill.
pub const HOLD_SLACK: Duration = Duration::from_millis(2_000);
/// The longest a stop is held for an omp's exit hold, whatever it asks for (stock's longest is 125 s).
pub const HOLD_MAX: Duration = Duration::from_millis(130_000);
/// How much stderr after the last wait line read is kept, for a line the pipe cut in pieces (a line is under 100
/// characters). Only this unread end is bounded: what just came in is searched whole first.
const HOLD_TAIL_CHARS: usize = 256;

/// The stop's waits; a test shortens them.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub grace: Duration,
    pub kill_wait: Duration,
    pub hold_slack: Duration,
    pub hold_max: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            grace: STOP_GRACE,
            kill_wait: KILL_WAIT,
            hold_slack: HOLD_SLACK,
            hold_max: HOLD_MAX,
        }
    }
}

/// What the lane writes to an omp's stdin, in order.
pub enum StdinMsg {
    Line(Vec<u8>),
    /// Ends the pipe: what was written before it goes out first.
    End,
}

/// Asked of the task that owns the child, so a signal never reaches a pid the system already gave to another process.
pub enum Signal {
    /// SIGTERM (`child.kill()`'s default); `TerminateProcess` on Windows.
    Term,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Until when the omp asked not to be killed, read from its stderr once its stop began (none: it asked for nothing). A
/// hold never reaches past `hold_max` from the stop's start. The pipe frames stderr as it likes (the Windows launcher
/// relays it), so the kept end and each new chunk are searched together, never a chunk alone. Stock prints one line per
/// thing its exit waits on: the longest wait counts, and a line once read is dropped, so later output does not renew
/// its hold.
pub struct Hold {
    active: Option<Instant>,
    until: Option<Instant>,
    tail: String,
    slack: Duration,
}

/// The `(up to N s)` waits in `text`: where each match ends and its seconds (`\(up to (\d+) s\)` globally).
fn waits(text: &str) -> Vec<(usize, f64)> {
    const OPEN: &str = "(up to ";
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find(OPEN) {
        let start = from + at;
        let digits_at = start + OPEN.len();
        let digits = text[digits_at..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        let after = digits_at + digits;
        if digits > 0 && text[after..].starts_with(" s)") {
            let seconds = text[digits_at..after]
                .parse::<f64>()
                .unwrap_or(f64::INFINITY);
            found.push((after + 3, seconds));
            from = after + 3;
        } else {
            from = start + 1;
        }
    }
    found
}

impl Hold {
    pub fn new(slack: Duration) -> Hold {
        Hold {
            active: None,
            until: None,
            tail: String::new(),
            slack,
        }
    }

    /// The stop began: stderr is read for waits from now on, up to `latest`.
    pub fn begin(&mut self, latest: Instant) {
        self.active = Some(latest);
    }

    pub fn until(&self) -> Option<Instant> {
        self.until
    }

    /// One chunk of stderr (decoded as node decodes a chunk).
    pub fn feed(&mut self, chunk: &str, now: Instant, pid: u32) {
        let Some(latest) = self.active else {
            return;
        };
        let text = format!("{}{chunk}", self.tail);
        let mut read = 0;
        for (end, seconds) in waits(&text) {
            read = end;
            if seconds == 0.0 {
                continue;
            }
            let asked = Duration::try_from_secs_f64(seconds).unwrap_or(Duration::MAX);
            let until = now
                .checked_add(asked)
                .and_then(|t| t.checked_add(self.slack))
                .map_or(latest, |t| t.min(latest));
            self.until = Some(self.until.map_or(until, |held| held.max(until)));
            eprintln!(
                "[omp-stop] omp {pid} waits to save before it exits (up to {seconds} s): its kill waits too"
            );
        }
        let rest = &text[read..];
        let skip = rest.chars().count().saturating_sub(HOLD_TAIL_CHARS);
        self.tail = rest.chars().skip(skip).collect();
    }
}

/// One omp that is running or was: what the lane and its stop share.
pub struct Proc {
    pub pid: Option<u32>,
    /// True once the process exited.
    pub exited: watch::Receiver<bool>,
    pub stdin: mpsc::UnboundedSender<StdinMsg>,
    pub signals: mpsc::UnboundedSender<Signal>,
    pub hold: Mutex<Hold>,
    pub timing: Timing,
    /// The stop's end, once one began: one stop per process, a second caller waits on the same one.
    stopped: Mutex<Option<watch::Receiver<bool>>>,
}

/// True when `done` became true within `wait`.
async fn within(done: &mut watch::Receiver<bool>, wait: Duration) -> bool {
    tokio::time::timeout(wait, done.wait_for(|done| *done))
        .await
        .is_ok_and(|result| result.is_ok())
}

impl Proc {
    pub fn new(
        pid: Option<u32>,
        exited: watch::Receiver<bool>,
        stdin: mpsc::UnboundedSender<StdinMsg>,
        signals: mpsc::UnboundedSender<Signal>,
        timing: Timing,
    ) -> Arc<Proc> {
        Arc::new(Proc {
            pid,
            exited,
            stdin,
            signals,
            hold: Mutex::new(Hold::new(timing.hold_slack)),
            timing,
            stopped: Mutex::new(None),
        })
    }

    pub fn running(&self) -> bool {
        !*self.exited.borrow()
    }

    /// Stderr text of this omp, for the exit hold (a no-op until its stop began).
    pub fn feed_stderr(&self, chunk: &str) {
        if let Some(pid) = self.pid {
            locked(&self.hold).feed(chunk, Instant::now(), pid);
        }
    }

    /// True when the exit came within `wait`, or within the hold the omp asked for meanwhile.
    async fn within_grace(&self, wait: Duration) -> bool {
        let mut exited = self.exited.clone();
        if within(&mut exited, wait).await {
            return true;
        }
        loop {
            let until = locked(&self.hold).until();
            let left = until.map_or(Duration::ZERO, |until| {
                until.saturating_duration_since(Instant::now())
            });
            if left.is_zero() {
                return false;
            }
            if within(&mut exited, left).await {
                return true;
            }
        }
    }

    /// Stops the omp (`stdin_grace`: close its stdin first and give it this long to end by itself before the
    /// signal: stock emits `session_shutdown`, ai-memory's `session-end` hook, which writes the handoff, only when its
    /// stdin ends). The receiver turns true once the stop is over: the process exited or the kill's wait ran out.
    pub fn stop(self: &Arc<Proc>, stdin_grace: Duration) -> watch::Receiver<bool> {
        let mut stopped = locked(&self.stopped);
        if let Some(known) = stopped.as_ref() {
            return known.clone();
        }
        let (finish, done) = watch::channel(false);
        if !self.running() || self.pid.is_none() {
            finish.send_replace(true);
            return done;
        }
        *stopped = Some(done.clone());
        let proc = Arc::clone(self);
        tokio::spawn(async move {
            proc.run_stop(stdin_grace).await;
            finish.send_replace(true);
        });
        done
    }

    async fn run_stop(&self, stdin_grace: Duration) {
        let Some(pid) = self.pid else { return };
        locked(&self.hold).begin(Instant::now() + self.timing.hold_max);
        if !stdin_grace.is_zero() {
            let _ = self.stdin.send(StdinMsg::End);
            if self.within_grace(stdin_grace).await {
                return;
            }
        }
        if cfg!(windows) {
            let _ = self.stdin.send(StdinMsg::End);
        } else {
            let _ = self.signals.send(Signal::Term);
        }
        if self.within_grace(self.timing.grace).await {
            return;
        }
        eprintln!("[omp-stop] omp {pid} still runs after its stop's grace: killing it");
        kill_tree(
            pid,
            self.signals.clone(),
            self.stdin.clone(),
            self.exited.clone(),
        );
        let mut exited = self.exited.clone();
        within(&mut exited, self.timing.kill_wait).await;
    }
}

/// Kills `pid` and what it started, now. POSIX: SIGKILL to its process group (every omp is spawned in one of its
/// own), else the pid alone. Windows: `taskkill /T /F` (omp runs behind a `.cmd`/`.exe` shim whose real omp would
/// survive a kill of the shim); with WMI down taskkill kills nothing and exits 1, then the shim alone is ended.
#[cfg(unix)]
fn kill_tree(
    pid: u32,
    _signals: mpsc::UnboundedSender<Signal>,
    _stdin: mpsc::UnboundedSender<StdinMsg>,
    _exited: watch::Receiver<bool>,
) {
    if !crate::sys::signal_group(pid, true) {
        crate::sys::signal(pid, true);
    }
}

#[cfg(windows)]
fn kill_tree(
    pid: u32,
    signals: mpsc::UnboundedSender<Signal>,
    stdin: mpsc::UnboundedSender<StdinMsg>,
    exited: watch::Receiver<bool>,
) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    tokio::spawn(async move {
        let mut killer = tokio::process::Command::new("taskkill");
        killer
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let killed = match killer.status().await {
            Ok(status) => status.success(),
            Err(_) => false,
        };
        if !killed && !*exited.borrow() {
            let _ = stdin.send(StdinMsg::End);
            let _ = signals.send(Signal::Term);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAIT_LINE: &str = "Waiting for the login refresh to finish saving (up to 120 s)…\n";

    fn hold_after(chunks: &[&str]) -> (Hold, Instant) {
        let start = Instant::now();
        let mut hold = Hold::new(HOLD_SLACK);
        hold.begin(start + HOLD_MAX);
        for chunk in chunks {
            hold.feed(chunk, start, 1);
        }
        (hold, start)
    }

    /// The cases of `omp-stop.test.ts` "reads the wait however the pipe framed the line".
    #[test]
    fn reads_the_wait_however_the_pipe_framed_the_line() {
        let cut = WAIT_LINE.find("0 s)").unwrap();
        let long = "x".repeat(300);
        let cases: Vec<(&str, Vec<String>)> = vec![
            ("whole", vec![WAIT_LINE.to_owned()]),
            (
                "cut inside the number",
                vec![WAIT_LINE[..cut].to_owned(), WAIT_LINE[cut..].to_owned()],
            ),
            (
                "followed by 300 characters of other output in the same chunk",
                vec![format!("{WAIT_LINE}{long}")],
            ),
            (
                "after 300 characters of other output, cut inside the number",
                vec![
                    format!("{long}{}", &WAIT_LINE[..WAIT_LINE.len() - 8]),
                    WAIT_LINE[WAIT_LINE.len() - 8..].to_owned(),
                ],
            ),
            (
                "with a shorter wait printed after it in the same chunk",
                vec![format!(
                    "{WAIT_LINE}Waiting for something else (up to 2 s)…\n"
                )],
            ),
        ];
        for (name, chunks) in cases {
            let chunks: Vec<&str> = chunks.iter().map(String::as_str).collect();
            let (hold, start) = hold_after(&chunks);
            assert_eq!(
                hold.until(),
                Some(start + Duration::from_secs(120) + HOLD_SLACK),
                "{name}"
            );
        }
    }

    #[test]
    fn is_idle_until_the_stop_began_and_never_holds_longer_than_the_cap() {
        let start = Instant::now();
        let mut hold = Hold::new(HOLD_SLACK);
        hold.feed(WAIT_LINE, start, 1);
        assert_eq!(hold.until(), None);
        hold.begin(start + HOLD_MAX);
        hold.feed("saving (up to 100000 s)…", start, 1);
        assert_eq!(hold.until(), Some(start + HOLD_MAX));
        // A line once read is dropped: later output does not renew its hold, and a shorter wait never shortens it.
        hold.feed("(up to 2 s)", start + Duration::from_secs(1000), 1);
        assert_eq!(hold.until(), Some(start + HOLD_MAX));
        // Zero asks for nothing.
        let (zero, _) = hold_after(&["(up to 0 s)"]);
        assert_eq!(zero.until(), None);
    }

    #[test]
    fn finds_waits_the_way_the_expression_does() {
        assert_eq!(waits("(up to 5 s)(up to 7 s)"), [(11, 5.0), (22, 7.0)]);
        assert_eq!(waits("(up to s)(up to 4 x)(up to 12 s) tail"), [(32, 12.0)]);
        assert_eq!(waits("(up to (up to 9 s)"), [(18, 9.0)]);
        assert!(waits("up to 5 s").is_empty());
    }

    // ---- real processes: the cases of `omp-stop.test.ts` ------------------------------------------------------------

    use std::path::{Path, PathBuf};

    use crate::sidecar::process::{Exit, Start, pump_stderr, pump_stdout, start};

    fn quick(hold_max: Duration) -> Timing {
        Timing {
            grace: Duration::from_millis(300),
            kill_wait: Duration::from_millis(1_500),
            hold_slack: Duration::from_millis(100),
            hold_max,
        }
    }

    /// An omp whose exit waits on a login refresh it has to save: once its stop began it says what stock's exit says
    /// ("(up to N s)…"), then saves and exits when `gate` exists, or never when there is none. A process of this test
    /// binary where a stop ends stdin (Windows), a shell with a SIGTERM trap elsewhere.
    fn refreshing(dir: &Path, hold_seconds: u64) -> Start {
        let mut env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        env.remove("OMP_GUI_BRIDGE");
        env.insert("FAKE_HOLD".into(), hold_seconds.to_string());
        env.insert(
            "FAKE_GATE".into(),
            dir.join("gate").to_string_lossy().into_owned(),
        );
        env.insert(
            "FAKE_SAVED".into(),
            dir.join("saved").to_string_lossy().into_owned(),
        );
        let cwd = dir.to_string_lossy().into_owned();
        if cfg!(windows) {
            env.insert("OMPDESK_FAKE_OMP".into(), "refresh".into());
            let exe = std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let args = [
                "sidecar::tests::fake_omp_stand_in",
                "--exact",
                "--nocapture",
            ];
            return Start {
                bin: exe,
                args: args.iter().map(|arg| (*arg).to_owned()).collect(),
                env,
                cwd,
                shell: false,
            };
        }
        let script = "trap 'echo \"Waiting for the login refresh to finish saving (up to $FAKE_HOLD s)…\" >&2; \
            while [ ! -e \"$FAKE_GATE\" ]; do sleep 0.05; done; echo token > \"$FAKE_SAVED\"; exit 0' TERM; \
            echo up; while true; do sleep 0.05; done";
        Start {
            bin: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env,
            cwd,
            shell: false,
        }
    }

    /// Starts `how`, with its pipes read, and waits until it said `up`.
    async fn running(
        how: &Start,
        timing: Timing,
    ) -> (Arc<Proc>, tokio::sync::oneshot::Receiver<Exit>) {
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        let started = start(how, timing, move |exit| {
            let _ = exit_tx.send(exit);
        })
        .unwrap();
        let (up_tx, up_rx) = tokio::sync::oneshot::channel();
        let mut up = Some(up_tx);
        tokio::spawn(pump_stdout(started.stdout, move |line| {
            if line == b"up"
                && let Some(up) = up.take()
            {
                let _ = up.send(());
            }
        }));
        tokio::spawn(pump_stderr(
            started.stderr,
            Arc::clone(&started.proc),
            |_| {},
        ));
        tokio::time::timeout(Duration::from_secs(30), up_rx)
            .await
            .expect("the stand-in never came up")
            .unwrap();
        (started.proc, exit_rx)
    }

    fn dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-stop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The tests that start processes take turns (see `sidecar::tests`).
    static TURNS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn is_not_killed_at_the_stops_bound_while_it_says_it_waits_to_save_and_ends_by_itself_once_it_saved()
     {
        let _turn = TURNS.lock().await;
        let dir = dir("hold");
        let (proc, exit) = running(&refreshing(&dir, 3), quick(Duration::from_secs(10))).await;
        let mut done = proc.stop(Duration::ZERO);
        // Past the grace (300 ms) it still runs: its hold (3 s and the slack) outlasts it.
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(
            proc.running(),
            "killed at the bound although it asked to be held"
        );
        std::fs::write(dir.join("gate"), "").unwrap();
        tokio::time::timeout(Duration::from_secs(10), done.wait_for(|done| *done))
            .await
            .expect("the stop never ended")
            .unwrap();
        assert!(dir.join("saved").exists());
        assert_eq!(exit.await.unwrap().code, Some(0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn is_killed_once_the_time_it_asked_for_ran_out_and_never_held_longer_than_the_cap() {
        let _turn = TURNS.lock().await;
        let dir = dir("cap");
        // It asks for 1000 s; the cap is 700 ms from the stop's start.
        let (proc, exit) =
            running(&refreshing(&dir, 1000), quick(Duration::from_millis(700))).await;
        let began = Instant::now();
        let mut done = proc.stop(Duration::ZERO);
        tokio::time::sleep(Duration::from_millis(450)).await;
        assert!(proc.running(), "killed before the hold ran out");
        tokio::time::timeout(Duration::from_secs(10), done.wait_for(|done| *done))
            .await
            .expect("the stop never ended")
            .unwrap();
        assert!(
            began.elapsed() >= Duration::from_millis(650),
            "{:?}",
            began.elapsed()
        );
        // The kill, not the stand-in's own exit: it never saved.
        assert!(!dir.join("saved").exists());
        let ended = exit.await.unwrap();
        assert_ne!(ended.code, Some(0), "{ended:?}");
        assert!(!proc.running());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_second_stop_waits_on_the_same_one_and_a_stop_of_an_exited_process_is_done() {
        let _turn = TURNS.lock().await;
        let dir = dir("twice");
        std::fs::write(dir.join("gate"), "").unwrap();
        let (proc, exit) = running(&refreshing(&dir, 0), quick(Duration::from_secs(10))).await;
        let first = proc.stop(Duration::ZERO);
        let second = proc.stop(Duration::from_secs(60));
        let (mut done, mut also) = (first.clone(), second.clone());
        for wait in [&mut done, &mut also] {
            tokio::time::timeout(Duration::from_secs(10), wait.wait_for(|done| *done))
                .await
                .expect("the stop never ended")
                .unwrap();
        }
        assert_eq!(exit.await.unwrap().code, Some(0));
        // Exited: the stop is over at once.
        assert!(*proc.stop(Duration::ZERO).borrow());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
