//! The launch history behind the crash-loop guard (was `src/main/launch-guard-core.ts` and the state of
//! `launch-guard.ts`). `<userData>/launch-history.json` lists the last launches; a launch is recorded as it starts and
//! marked stable once it ran `STABLE_AFTER_MS` or quit cleanly. A launch that ended any other way (a crash, the GPU
//! fallback's relaunch, a kill) stays unstable. When the last `CRASH_LOOP_LAUNCHES` launches all ended unstable within
//! `CRASH_LOOP_WINDOW_MS`, the next one starts in safe mode: software rendering, no automatic relaunch, machine setup
//! paused. The history is advisory: an unreadable or unwritable file never blocks a start.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LaunchRecord {
    /// Epoch ms the launch started.
    pub at: i64,
    /// It ran `STABLE_AFTER_MS` or quit cleanly.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stable: bool,
    /// Epoch ms it relaunched itself for a GPU process crash.
    #[serde(rename = "gpuRelaunchAt", skip_serializing_if = "Option::is_none")]
    pub gpu_relaunch_at: Option<i64>,
    /// It started in safe mode.
    #[serde(rename = "safeMode", skip_serializing_if = "std::ops::Not::not")]
    pub safe_mode: bool,
}

pub const STABLE_AFTER_MS: i64 = 20_000;
pub const CRASH_LOOP_LAUNCHES: usize = 3;
pub const CRASH_LOOP_WINDOW_MS: i64 = 10 * 60_000;
/// At most one automatic GPU relaunch per this long, across processes.
pub const GPU_RELAUNCH_COOLDOWN_MS: i64 = 10 * 60_000;
/// Launches the history file keeps.
pub const HISTORY_KEEP: usize = 10;
/// A hardware launch up this long before its GPU process crashed is not one whose GPU cannot start: the crash is a
/// one-off (a driver reset, a device lost), Chromium restarts the GPU process by itself and the window stays up.
pub const GPU_CRASH_SETTLED_MS: f64 = 5.0 * 60_000.0;

/// A JSON number as JavaScript's `typeof x === "number"` takes it (finite), cut to whole milliseconds.
pub(crate) fn js_number(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    number.is_finite().then_some(number as i64)
}

/// An unreadable or foreign history is no history.
pub fn parse_history(text: Option<&str>) -> Vec<LaunchRecord> {
    let Some(text) = text.filter(|t| !t.is_empty()) else {
        return Vec::new();
    };
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            Some(LaunchRecord {
                at: js_number(object.get("at"))?,
                stable: object.get("stable") == Some(&Value::Bool(true)),
                gpu_relaunch_at: js_number(object.get("gpuRelaunchAt")),
                safe_mode: object.get("safeMode") == Some(&Value::Bool(true)),
            })
        })
        .collect()
}

/// The previous launches (this one not yet recorded) form a crash loop.
pub fn crash_loop_detected(previous: &[LaunchRecord], now: i64) -> bool {
    let recent = &previous[previous.len().saturating_sub(CRASH_LOOP_LAUNCHES)..];
    if recent.len() < CRASH_LOOP_LAUNCHES {
        return false;
    }
    recent.iter().all(|launch| {
        !launch.stable && now - launch.at >= 0 && now - launch.at <= CRASH_LOOP_WINDOW_MS
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RelaunchWhy {
    Software,
    SafeMode,
    Cooldown,
    TestLaunch,
    Settled,
}

impl RelaunchWhy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Software => "software",
            Self::SafeMode => "safe-mode",
            Self::Cooldown => "cooldown",
            Self::TestLaunch => "test-launch",
            Self::Settled => "settled",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GpuRelaunchDecision {
    Relaunch,
    Stay {
        why: RelaunchWhy,
        last_relaunch_at: Option<i64>,
    },
}

pub struct RelaunchInput<'a> {
    pub software: bool,
    pub safe_mode: bool,
    pub test_launch: bool,
    pub history: &'a [LaunchRecord],
    pub now: i64,
    /// How long this launch had run when its GPU process crashed (0 when unknown).
    pub up_ms: f64,
    /// When this launch's GPU process crashed before, if it did.
    pub crashed_before: Option<i64>,
}

/// Whether a GPU process crash may relaunch the app into software rendering. Never from a launch that already renders
/// in software (Windows still runs a GPU process for SwiftShader/WARP, and its crash would start the same launch again
/// forever), never in safe mode, never in a test launch (the process the test drives would exit and the relaunched one
/// run unwatched), never for the first crash of a launch up `GPU_CRASH_SETTLED_MS` (a second crash within
/// `GPU_RELAUNCH_COOLDOWN_MS` of it is a GPU that keeps dying), and at most once per `GPU_RELAUNCH_COOLDOWN_MS`.
pub fn gpu_relaunch_decision(input: &RelaunchInput) -> GpuRelaunchDecision {
    let stay = |why| GpuRelaunchDecision::Stay {
        why,
        last_relaunch_at: None,
    };
    if input.test_launch {
        return stay(RelaunchWhy::TestLaunch);
    }
    if input.safe_mode {
        return stay(RelaunchWhy::SafeMode);
    }
    if input.software {
        return stay(RelaunchWhy::Software);
    }
    let repeated = input
        .crashed_before
        .is_some_and(|before| input.now - before < GPU_RELAUNCH_COOLDOWN_MS);
    if input.up_ms >= GPU_CRASH_SETTLED_MS && !repeated {
        return stay(RelaunchWhy::Settled);
    }
    let last = input
        .history
        .iter()
        .filter_map(|launch| launch.gpu_relaunch_at)
        .max();
    match last {
        Some(at) if input.now - at < GPU_RELAUNCH_COOLDOWN_MS => GpuRelaunchDecision::Stay {
            why: RelaunchWhy::Cooldown,
            last_relaunch_at: Some(at),
        },
        _ => GpuRelaunchDecision::Relaunch,
    }
}

/// This process's own record plus the ones before it.
pub struct Guard {
    previous: Vec<LaunchRecord>,
    current: LaunchRecord,
}

impl Guard {
    /// Records this launch (`text` is the file's content, `None` when unreadable) and says whether the launches before
    /// it form a crash loop, in which case this one runs in safe mode.
    pub fn start(text: Option<&str>, now: i64) -> Self {
        let previous = parse_history(text);
        let safe_mode = crash_loop_detected(&previous, now);
        Self {
            previous,
            current: LaunchRecord {
                at: now,
                stable: false,
                gpu_relaunch_at: None,
                safe_mode,
            },
        }
    }

    /// The file's content: the last `HISTORY_KEEP` launches, this one last.
    pub fn text(&self) -> String {
        let all: Vec<&LaunchRecord> = self
            .previous
            .iter()
            .chain(std::iter::once(&self.current))
            .collect();
        let kept = &all[all.len().saturating_sub(HISTORY_KEEP)..];
        serde_json::to_string(kept).expect("records serialize")
    }

    pub fn safe_mode(&self) -> bool {
        self.current.safe_mode
    }

    /// False when it already was stable (nothing to save).
    pub fn mark_stable(&mut self) -> bool {
        !std::mem::replace(&mut self.current.stable, true)
    }

    pub fn note_gpu_relaunch(&mut self, at: i64) {
        self.current.gpu_relaunch_at = Some(at);
    }

    /// Every recorded launch, this one last.
    pub fn history(&self) -> Vec<LaunchRecord> {
        self.previous
            .iter()
            .cloned()
            .chain(std::iter::once(self.current.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chrome_core::captured;
    use serde_json::json;

    const SECOND: i64 = 1000;
    const T0: i64 = 1_800_000_000_000;

    /// `launch-guard.test.ts`'s file: each start reads what the one before saved.
    struct File(Option<String>);

    impl File {
        fn start(&mut self, now: i64) -> (Guard, bool) {
            let guard = Guard::start(self.0.as_deref(), now);
            self.0 = Some(guard.text());
            let safe = guard.safe_mode();
            (guard, safe)
        }

        fn save(&mut self, guard: &Guard) {
            self.0 = Some(guard.text());
        }
    }

    #[test]
    fn three_launches_that_never_became_stable_make_the_next_one_safe() {
        let mut file = File(None);
        assert!(!file.start(T0).1);
        assert!(!file.start(T0 + 5 * SECOND).1);
        assert!(!file.start(T0 + 10 * SECOND).1);
        assert!(file.start(T0 + 15 * SECOND).1);
    }

    #[test]
    fn a_safe_mode_launch_that_stays_up_ends_safe_mode_for_the_next_one() {
        let mut file = File(None);
        for i in 0..3 {
            file.start(T0 + i * SECOND);
        }
        let (mut guard, safe) = file.start(T0 + 3 * SECOND);
        assert!(safe);
        assert!(guard.mark_stable());
        assert!(!guard.mark_stable());
        file.save(&guard);
        assert!(!file.start(T0 + 60 * SECOND).1);
    }

    #[test]
    fn a_stable_or_cleanly_quit_launch_among_them_is_no_loop() {
        let mut file = File(None);
        file.start(T0);
        let (mut second, _) = file.start(T0 + SECOND);
        second.mark_stable();
        file.save(&second);
        file.start(T0 + 2 * SECOND);
        assert!(!file.start(T0 + 3 * SECOND).1);
    }

    #[test]
    fn launches_that_ended_long_ago_are_no_loop() {
        let mut file = File(None);
        for i in 0..3 {
            file.start(T0 + i * SECOND);
        }
        assert!(
            !file
                .start(T0 + 2 * SECOND + CRASH_LOOP_WINDOW_MS + SECOND)
                .1
        );
    }

    #[test]
    fn an_unreadable_history_never_blocks_a_start() {
        assert!(!Guard::start(Some("{not json"), T0).safe_mode());
        assert!(!Guard::start(None, T0).safe_mode());
    }

    #[test]
    fn the_file_keeps_the_last_ten_launches_and_reads_foreign_entries_as_none() {
        let mut file = File(None);
        for i in 0..15 {
            file.start(T0 + i * 60 * 60 * 1000);
        }
        let kept: Value = serde_json::from_str(file.0.as_deref().unwrap()).unwrap();
        assert_eq!(kept.as_array().unwrap().len(), HISTORY_KEEP);
        let text = r#"[{"at":1,"stable":true},5,null,{"at":"x"},{"at":2,"gpuRelaunchAt":3,"safeMode":true},{"at":4,"stable":1}]"#;
        let read = parse_history(Some(text));
        assert_eq!(read.len(), 3);
        assert!(read[0].stable && !read[2].stable);
        assert_eq!(read[1].gpu_relaunch_at, Some(3));
        assert!(read[1].safe_mode);
        assert!(parse_history(Some(r#"{"at":1}"#)).is_empty());
    }

    fn records(value: &Value) -> Vec<LaunchRecord> {
        parse_history(Some(&value.to_string()))
    }

    #[test]
    fn parses_and_detects_loops_as_the_typescript_did() {
        for step in captured::of("gpu", "src/main/launch-guard-core.ts#parseLaunchHistory") {
            let got = parse_history(step.input["text"].as_str());
            assert_eq!(serde_json::to_value(&got).unwrap(), step.output, "{step:?}");
        }
        for step in captured::of("gpu", "src/main/launch-guard-core.ts#crashLoopDetected") {
            let got = crash_loop_detected(
                &records(&step.input["previous"]),
                step.input["now"].as_i64().unwrap(),
            );
            assert_eq!(json!(got), step.output, "{step:?}");
        }
    }

    #[test]
    fn relaunch_decisions_as_the_typescript_did() {
        for step in captured::of("gpu", "src/main/launch-guard-core.ts#gpuRelaunchDecision") {
            let input = &step.input;
            let history = records(&input["history"]);
            let got = gpu_relaunch_decision(&RelaunchInput {
                software: input["software"].as_bool().unwrap(),
                safe_mode: input["safeMode"].as_bool().unwrap(),
                test_launch: input["testLaunch"].as_bool().unwrap(),
                history: &history,
                now: input["now"].as_i64().unwrap(),
                up_ms: input["upMs"].as_f64().unwrap_or(0.0),
                crashed_before: input["crashedBefore"].as_i64(),
            });
            let out = match got {
                GpuRelaunchDecision::Relaunch => json!({ "relaunch": true }),
                GpuRelaunchDecision::Stay {
                    why,
                    last_relaunch_at,
                } => {
                    let mut out = json!({ "relaunch": false, "why": why.as_str() });
                    if let Some(at) = last_relaunch_at {
                        out["lastRelaunchAt"] = json!(at);
                    }
                    out
                }
            };
            assert_eq!(out, step.output, "{step:?}");
        }
    }
}
