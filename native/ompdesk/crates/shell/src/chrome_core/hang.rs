//! The main-thread hang watchdog's rules (was `src/main/hang-watchdog-core.ts`, the worker's logic of
//! `hang-watchdog-worker.ts` and `reportPreviousHang`). Observation only: nothing here ever kills or restarts Node.
//!
//! Node posts a heartbeat every `HANG_HEARTBEAT_INTERVAL_MS`; the shell's watch thread ticks on its own timer and
//! reports a hang once no heartbeat arrived for longer than `HANG_TIMEOUT_MS`. It writes a marker file, rewritten when
//! the heartbeats resume (`selfRecovered`), and the next launch reports it in `gui-runtime.jsonl` (`source:
//! "main-thread-hang"`). The idea (worker plus heartbeat, tick-gap sleep detection, marker consumed on the next launch)
//! is Orca's `src/main/hang-watchdog/`, reimplemented.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::gpu::{iso, js_round};

pub const HANG_HEARTBEAT_INTERVAL_MS: i64 = 1_000;
pub const HANG_CHECK_INTERVAL_MS: i64 = 1_000;
pub const HANG_TIMEOUT_MS: i64 = 5_000;
/// A tick later than this many check intervals means the process was suspended, not that Node hung.
pub const SLEEP_GAP_FACTOR: i64 = 3;
const MAX_MARKER_BYTES: u64 = 64 * 1024;
/// Steps a marker names: the stalled one last, the ones before it for context.
pub const HANG_STEP_HISTORY: usize = 8;

/// What Node was doing: launching, running, quitting (the teardown), or applying an update.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MainPhase {
    Startup,
    Running,
    Quit,
    Update,
}

impl MainPhase {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "startup" => Self::Startup,
            "running" => Self::Running,
            "quit" => Self::Quit,
            "update" => Self::Update,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Running => "running",
            Self::Quit => "quit",
            Self::Update => "update",
        }
    }
}

pub struct Detector {
    timeout_ms: i64,
    check_interval_ms: i64,
    last_heartbeat_at: i64,
    last_tick_at: i64,
    reported: bool,
}

impl Detector {
    pub fn new(timeout_ms: i64, check_interval_ms: i64, now: i64) -> Self {
        Self {
            timeout_ms,
            check_interval_ms,
            last_heartbeat_at: now,
            last_tick_at: now,
            reported: false,
        }
    }

    /// A heartbeat; `Some(ms)` when it ended a reported hang: Node was stalled, not deadlocked.
    pub fn heartbeat(&mut self, now: i64) -> Option<i64> {
        let resolved = self.reported.then(|| now - self.last_heartbeat_at);
        self.reported = false;
        self.last_heartbeat_at = now;
        resolved
    }

    /// One check; `Some(ms)` the moment a hang is reported (once per stall).
    pub fn tick(&mut self, now: i64) -> Option<i64> {
        let gap = now - self.last_tick_at;
        // Kept moving while a hang is outstanding, or the first tick after it clears would read as a sleep.
        self.last_tick_at = now;
        if self.reported {
            return None;
        }
        if gap > self.check_interval_ms * SLEEP_GAP_FACTOR {
            // This thread was suspended too (system sleep): start the wait over.
            self.last_heartbeat_at = now;
            return None;
        }
        let unresponsive = now - self.last_heartbeat_at;
        if unresponsive > self.timeout_ms {
            self.reported = true;
            return Some(unresponsive);
        }
        None
    }

    /// The OS resumed from suspend: wait for fresh heartbeats before judging Node.
    pub fn reset(&mut self, now: i64) {
        self.last_heartbeat_at = now;
        self.last_tick_at = now;
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MainSteps {
    pub phase: MainPhase,
    /// `<phase>:<step>`, oldest first.
    pub steps: Vec<String>,
}

/// The watch's copy of Node's last steps. Node posts each step before running it, and the shell gets the message even
/// while Node is blocked, so the last entry at a hang is the step that never returned.
pub struct StepRing {
    size: usize,
    phase: MainPhase,
    steps: Vec<String>,
}

impl StepRing {
    pub fn new(size: usize) -> Self {
        Self {
            size,
            phase: MainPhase::Startup,
            steps: Vec::new(),
        }
    }

    pub fn enter(&mut self, phase: MainPhase, step: &str) {
        self.phase = phase;
        self.steps.push(format!("{}:{step}", phase.as_str()));
        if self.steps.len() > self.size {
            self.steps.drain(..self.steps.len() - self.size);
        }
    }

    pub fn snapshot(&self) -> MainSteps {
        MainSteps {
            phase: self.phase,
            steps: self.steps.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HangMarker {
    pub detected_at: i64,
    pub pid: u32,
    pub unresponsive_ms: f64,
    /// False for a marker the stall never cleared (a deadlock, or the app was killed during it).
    pub self_recovered: bool,
    /// Node's phase and last steps when the stall was detected (absent in markers older builds wrote).
    pub main: Option<MainSteps>,
}

/// A whole number as JavaScript prints it (`5628`, not `5628.0`).
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

impl HangMarker {
    pub fn text(&self) -> String {
        let mut object = Map::new();
        object.insert("detectedAt".into(), json!(self.detected_at));
        object.insert("pid".into(), json!(self.pid));
        object.insert("unresponsiveMs".into(), number(self.unresponsive_ms));
        object.insert("selfRecovered".into(), json!(self.self_recovered));
        if let Some(main) = &self.main {
            object.insert("phase".into(), json!(main.phase.as_str()));
            object.insert("steps".into(), json!(main.steps));
        }
        Value::Object(object).to_string()
    }
}

/// A marker file's content; `None` for anything unreadable or invalid.
pub fn parse_marker(raw: &str) -> Option<HangMarker> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let detected_at = object
        .get("detectedAt")?
        .as_f64()
        .filter(|n| n.is_finite())?;
    let pid = object
        .get("pid")?
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= f64::from(u32::MAX))?;
    let unresponsive_ms = object
        .get("unresponsiveMs")?
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)?;
    let main = object
        .get("phase")
        .and_then(Value::as_str)
        .and_then(MainPhase::parse)
        .zip(object.get("steps").and_then(Value::as_array))
        .and_then(|(phase, steps)| {
            let steps: Option<Vec<String>> =
                steps.iter().map(|s| s.as_str().map(String::from)).collect();
            let steps = steps?;
            let from = steps.len().saturating_sub(HANG_STEP_HISTORY);
            Some(MainSteps {
                phase,
                steps: steps[from..].to_vec(),
            })
        });
    Some(HangMarker {
        detected_at: detected_at as i64,
        pid: pid as u32,
        unresponsive_ms,
        self_recovered: object.get("selfRecovered") == Some(&Value::Bool(true)),
        main,
    })
}

/// Reads and removes the previous run's marker; `None` when there is none or it is unreadable.
pub fn consume_marker(path: &Path) -> Option<HangMarker> {
    let marker = match std::fs::metadata(path) {
        Ok(meta) if meta.len() <= MAX_MARKER_BYTES => std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| parse_marker(&raw)),
        Ok(_) => None,
        Err(_) => return None,
    };
    // A marker that cannot be removed may be reported twice; it never blocks launch.
    let _ = std::fs::remove_file(path);
    marker
}

/// The line the next launch writes for the previous run's stall. The runtime log keeps only primitive details, so the
/// steps Node stalled in arrive as text.
pub fn previous_hang_report(marker: &HangMarker) -> Value {
    let seconds = js_round(marker.unresponsive_ms / 1000.0);
    json!({
        "source": "main-thread-hang",
        "message": if marker.self_recovered {
            format!("Main thread stalled for {seconds}s and recovered")
        } else {
            format!("Main thread stalled for {seconds}s and never recovered")
        },
        "details": {
            "unresponsiveMs": js_round(marker.unresponsive_ms),
            "selfRecovered": marker.self_recovered,
            "detectedAt": iso(marker.detected_at),
            "previousPid": marker.pid,
            "phase": marker.main.as_ref().map(|m| m.phase.as_str()),
            "steps": marker.main.as_ref().map(|m| m.steps.join(" > ")),
        },
    })
}

/// The worker's logic: the detector and the step ring, and the marker each change asks to be written.
pub struct Watch {
    pid: u32,
    detector: Detector,
    ring: StepRing,
    /// The steps at the moment of the hang: a recovered stall's rewrite still names the step that stalled.
    at_hang: MainSteps,
}

impl Watch {
    pub fn new(pid: u32, now: i64) -> Self {
        let ring = StepRing::new(HANG_STEP_HISTORY);
        Self {
            pid,
            detector: Detector::new(HANG_TIMEOUT_MS, HANG_CHECK_INTERVAL_MS, now),
            at_hang: ring.snapshot(),
            ring,
        }
    }

    fn marker(&self, now: i64, unresponsive_ms: i64, self_recovered: bool) -> HangMarker {
        HangMarker {
            detected_at: now,
            pid: self.pid,
            unresponsive_ms: unresponsive_ms as f64,
            self_recovered,
            main: Some(self.at_hang.clone()),
        }
    }

    /// A heartbeat; the marker to rewrite as recovered when it ended a reported hang (one record per stall).
    pub fn heartbeat(&mut self, now: i64) -> Option<HangMarker> {
        let ms = self.detector.heartbeat(now)?;
        Some(self.marker(now, ms, true))
    }

    /// One check; the marker to write when it found a hang.
    pub fn tick(&mut self, now: i64) -> Option<HangMarker> {
        let ms = self.detector.tick(now)?;
        self.at_hang = self.ring.snapshot();
        Some(self.marker(now, ms, false))
    }

    pub fn step(&mut self, phase: MainPhase, step: &str) {
        self.ring.enter(phase, step);
    }

    pub fn reset(&mut self, now: i64) {
        self.detector.reset(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chrome_core::captured;

    const CHECK: i64 = 1_000;
    const TIMEOUT: i64 = 5_000;

    struct Harness {
        now: i64,
        detector: Detector,
        hangs: Vec<i64>,
        resolved: Vec<i64>,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                now: 0,
                detector: Detector::new(TIMEOUT, CHECK, 0),
                hangs: Vec::new(),
                resolved: Vec::new(),
            }
        }

        /// Advances the clock, optionally delivering a heartbeat first, then ticks.
        fn step(&mut self, beat: bool, ms: i64) {
            self.now += ms;
            if beat {
                self.resolved.extend(self.detector.heartbeat(self.now));
            }
            self.hangs.extend(self.detector.tick(self.now));
        }

        fn run(&mut self, beat: bool, times: usize) {
            for _ in 0..times {
                self.step(beat, CHECK);
            }
        }
    }

    #[test]
    fn stays_quiet_while_heartbeats_keep_coming() {
        let mut h = Harness::new();
        h.run(true, 30);
        assert!(h.hangs.is_empty());
    }

    #[test]
    fn reports_a_hang_once_after_the_timeout_without_a_heartbeat() {
        let mut h = Harness::new();
        h.step(true, CHECK);
        h.run(false, 5);
        assert!(h.hangs.is_empty());
        h.step(false, CHECK);
        assert_eq!(h.hangs, vec![6_000]);
        h.run(false, 10);
        assert_eq!(h.hangs.len(), 1);
    }

    #[test]
    fn treats_a_tick_gap_over_three_intervals_as_a_system_suspend() {
        let mut h = Harness::new();
        h.step(true, CHECK);
        h.now += 10 * 60_000;
        h.hangs.extend(h.detector.tick(h.now));
        assert!(h.hangs.is_empty());
        h.run(false, 6);
        assert_eq!(h.hangs.len(), 1);
        assert!(h.hangs[0] < TIMEOUT + 2 * CHECK);
    }

    #[test]
    fn reports_the_resolution_when_heartbeats_resume_and_can_report_a_later_stall() {
        let mut h = Harness::new();
        h.run(false, 8);
        assert_eq!(h.hangs.len(), 1);
        h.step(true, CHECK);
        assert_eq!(h.resolved, vec![9_000]);
        h.run(true, 3);
        h.run(false, 7);
        assert_eq!(h.hangs.len(), 2);
    }

    #[test]
    fn does_not_read_the_first_tick_after_a_long_stall_as_a_sleep() {
        let mut h = Harness::new();
        h.run(false, 20);
        h.step(true, CHECK);
        assert_eq!((h.hangs.len(), h.resolved.len()), (1, 1));
        h.step(false, CHECK);
        assert_eq!(h.hangs.len(), 1);
    }

    #[test]
    fn reset_waits_for_fresh_heartbeats_after_the_os_resumed() {
        let mut h = Harness::new();
        h.step(true, CHECK);
        h.run(false, 4);
        h.detector.reset(h.now);
        h.run(false, 2);
        assert!(h.hangs.is_empty());
    }

    #[test]
    fn the_step_ring_names_the_phase_and_the_last_steps_newest_last() {
        let mut ring = StepRing::new(HANG_STEP_HISTORY);
        assert_eq!(
            ring.snapshot(),
            MainSteps {
                phase: MainPhase::Startup,
                steps: vec![]
            }
        );
        for i in 0..HANG_STEP_HISTORY + 3 {
            ring.enter(MainPhase::Startup, &format!("step-{i}"));
        }
        ring.enter(MainPhase::Quit, "teardown:sidecars");
        let MainSteps { phase, steps } = ring.snapshot();
        assert_eq!(phase, MainPhase::Quit);
        assert_eq!(steps.len(), HANG_STEP_HISTORY);
        assert_eq!(steps.last().unwrap(), "quit:teardown:sidecars");
        assert_eq!(steps[0], "startup:step-4");
    }

    #[test]
    fn the_snapshot_taken_at_the_hang_is_what_the_marker_names() {
        let mut watch = Watch::new(7, 0);
        watch.step(MainPhase::Update, "quit-and-install");
        let mut found = None;
        for i in 1..=7 {
            found = found.or(watch.tick(i * CHECK));
        }
        let hang = found.expect("a hang");
        assert!(!hang.self_recovered);
        watch.step(MainPhase::Quit, "will-quit");
        let recovered = watch.heartbeat(9_000).expect("recovered");
        assert!(recovered.self_recovered);
        let main = recovered.main.unwrap();
        assert_eq!(
            (main.phase, main.steps),
            (
                MainPhase::Update,
                vec!["update:quit-and-install".to_string()]
            )
        );
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shell-hang-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("main-thread-hang.json")
    }

    fn marker() -> HangMarker {
        HangMarker {
            detected_at: 1_700_000_000_000,
            pid: 4242,
            unresponsive_ms: 6_100.0,
            self_recovered: false,
            main: None,
        }
    }

    #[test]
    fn a_marker_round_trips_and_is_removed_once_consumed() {
        let file = temp("round");
        std::fs::write(&file, marker().text()).unwrap();
        assert_eq!(consume_marker(&file), Some(marker()));
        assert!(!file.exists());
        assert_eq!(consume_marker(&file), None);
    }

    #[test]
    fn a_rewritten_marker_reads_as_recovered() {
        let file = temp("rewrite");
        std::fs::write(&file, marker().text()).unwrap();
        std::fs::write(
            &file,
            HangMarker {
                unresponsive_ms: 9_000.0,
                self_recovered: true,
                ..marker()
            }
            .text(),
        )
        .unwrap();
        let read = consume_marker(&file).unwrap();
        assert_eq!((read.unresponsive_ms, read.self_recovered), (9_000.0, true));
    }

    #[test]
    fn a_corrupt_or_invalid_marker_is_dropped_without_failing() {
        let file = temp("corrupt");
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(consume_marker(&file), None);
        assert!(!file.exists());
        std::fs::write(&file, r#"{"detectedAt":1,"pid":-3,"unresponsiveMs":5}"#).unwrap();
        assert_eq!(consume_marker(&file), None);
        std::fs::write(&file, "x".repeat(70_000)).unwrap();
        assert_eq!(consume_marker(&file), None);
    }

    #[test]
    fn phase_and_steps_travel_through_the_marker_and_an_older_marker_has_none() {
        let with_steps = HangMarker {
            detected_at: 1,
            pid: 7,
            unresponsive_ms: 5_300.0,
            self_recovered: true,
            main: Some(MainSteps {
                phase: MainPhase::Quit,
                steps: vec![
                    "update:quit-and-install".into(),
                    "quit:teardown:sidecars".into(),
                ],
            }),
        };
        assert_eq!(parse_marker(&with_steps.text()), Some(with_steps.clone()));
        let older = r#"{"detectedAt":1,"pid":7,"unresponsiveMs":5300,"selfRecovered":true}"#;
        let expected = HangMarker {
            main: None,
            ..with_steps.clone()
        };
        assert_eq!(parse_marker(older), Some(expected.clone()));
        let nonsense = r#"{"detectedAt":1,"pid":7,"unresponsiveMs":5300,"selfRecovered":true,"phase":"nonsense","steps":[1,2]}"#;
        assert_eq!(parse_marker(nonsense), Some(expected));
    }

    #[test]
    fn the_next_launch_reports_the_phase_and_the_steps_oldest_first() {
        let report = previous_hang_report(&HangMarker {
            detected_at: 1_792_460_313_839,
            pid: 29292,
            unresponsive_ms: 5628.0,
            self_recovered: true,
            main: Some(MainSteps {
                phase: MainPhase::Update,
                steps: vec![
                    "update:quit-and-install".into(),
                    "quit:teardown:sidecars".into(),
                ],
            }),
        });
        assert_eq!(report["source"], "main-thread-hang");
        assert_eq!(
            report["message"],
            "Main thread stalled for 6s and recovered"
        );
        assert_eq!(
            report["details"]["steps"],
            "update:quit-and-install > quit:teardown:sidecars"
        );
        assert_eq!(report["details"]["detectedAt"], "2026-10-20T01:38:33.839Z");
    }

    // ---- the TypeScript's own answers (captured/hang.json) ----

    #[test]
    fn the_detector_as_the_typescript_did() {
        for step in captured::of("hang", "src/main/hang-watchdog-core.ts#createHangDetector") {
            let mut h = Harness::new();
            for op in step.input["ops"].as_array().unwrap() {
                match op["op"].as_str().unwrap() {
                    "step" => h.step(
                        op["beat"].as_bool().unwrap(),
                        op["ms"].as_i64().unwrap_or(CHECK),
                    ),
                    "jump" => h.now += op["ms"].as_i64().unwrap(),
                    "tick" => h.hangs.extend(h.detector.tick(h.now)),
                    "reset" => h.detector.reset(h.now),
                    other => panic!("unknown op {other}"),
                }
            }
            assert_eq!(
                json!({ "hangs": h.hangs, "resolved": h.resolved }),
                step.output,
                "{step:?}"
            );
        }
    }

    #[test]
    fn the_step_ring_as_the_typescript_did() {
        for step in captured::of("hang", "src/main/hang-watchdog-core.ts#createStepRing") {
            let mut ring = StepRing::new(HANG_STEP_HISTORY);
            let mut snapshots = Vec::new();
            for op in step.input["ops"].as_array().unwrap() {
                if let Some(enter) = op.get("enter") {
                    ring.enter(
                        MainPhase::parse(enter[0].as_str().unwrap()).unwrap(),
                        enter[1].as_str().unwrap(),
                    );
                } else {
                    let snapshot = ring.snapshot();
                    snapshots
                        .push(json!({ "phase": snapshot.phase.as_str(), "steps": snapshot.steps }));
                }
            }
            assert_eq!(json!(snapshots), step.output, "{step:?}");
        }
    }

    #[test]
    fn markers_and_reports_as_the_typescript_did() {
        for step in captured::of("hang", "src/main/hang-watchdog-core.ts#consumeHangMarker") {
            let file = temp("captured");
            std::fs::write(&file, step.input["raw"].as_str().unwrap()).unwrap();
            let got =
                consume_marker(&file).map(|m| serde_json::from_str::<Value>(&m.text()).unwrap());
            assert_eq!(got.unwrap_or(Value::Null), step.output, "{step:?}");
            assert!(!file.exists(), "consumed: {step:?}");
        }
        for step in captured::of("hang", "src/main/hang-watchdog.ts#reportPreviousHang") {
            let marker = parse_marker(step.input["raw"].as_str().unwrap()).expect("a marker");
            assert_eq!(previous_hang_report(&marker), step.output, "{step:?}");
        }
    }
}
