//! The software-rendering escape hatch (was `src/main/gpu-fallback.ts` and `gpu-fallback-core.ts`, with the launch
//! history of `launch.rs` beside it). A GPU process crash in a hardware launch writes `<userData>/gpu-fallback.json`
//! with the GPU it crashed on; later launches render in software until the GPU or its driver changed (a software
//! launch records the GPU it sees) or `HARDWARE_RETRY_AFTER_MS` passed, then one launch tries hardware again. That
//! trial is recorded in the marker before it runs, so it happens once; it clears the marker when it stays up, and a
//! crash in it writes a fresh marker. Whether a crash may relaunch is `launch::gpu_relaunch_decision`'s, so a trial
//! can never start a cycle. `Gpu` is the whole state machine of one launch over a `Files` it reads and writes, so the
//! shell and the tests run the same code.

use serde::Serialize;
use serde_json::{Value, json};

use super::launch::{
    CRASH_LOOP_LAUNCHES, GpuRelaunchDecision, Guard, RelaunchInput, RelaunchWhy, STABLE_AFTER_MS,
    gpu_relaunch_decision, js_number,
};

pub const HARDWARE_RETRY_AFTER_MS: i64 = 7 * 24 * 60 * 60_000;
/// The crash policy of this build. 2 (4 Nov 2026): a crash in a launch up `GPU_CRASH_SETTLED_MS` writes no marker. A
/// marker without it came from a build that wrote one for every crash, a mid-run one included, so the next launch
/// tries hardware once under this policy instead of serving out the week.
pub const MARKER_POLICY: i64 = 2;
/// SwiftShader's device, which a software launch lists beside the real adapter.
const SWIFTSHADER_VENDOR: i64 = 0xffff;

/// The adapter Chromium names in `getGPUInfo("basic").gpuDevice`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GpuIdentity {
    #[serde(rename = "vendorId")]
    pub vendor_id: i64,
    #[serde(rename = "deviceId")]
    pub device_id: i64,
    #[serde(rename = "driverVersion", skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    #[serde(rename = "driverDate", skip_serializing_if = "Option::is_none")]
    pub driver_date: Option<String>,
}

fn identity_from(value: &Value) -> Option<GpuIdentity> {
    let object = value.as_object()?;
    let vendor_id = js_number(object.get("vendorId"))?;
    let device_id = js_number(object.get("deviceId"))?;
    if vendor_id == SWIFTSHADER_VENDOR {
        return None;
    }
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    Some(GpuIdentity {
        vendor_id,
        device_id,
        driver_version: text("driverVersion"),
        driver_date: text("driverDate"),
    })
}

/// The active real adapter of `gpuDevice`, else the first real one.
pub fn identity_of(devices: &Value) -> Option<GpuIdentity> {
    let list = devices.as_array()?;
    let real: Vec<&Value> = list.iter().filter(|d| identity_from(d).is_some()).collect();
    let active = real
        .iter()
        .find(|d| d.get("active") == Some(&Value::Bool(true)));
    identity_from(active.or(real.first())?)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GpuChange {
    GpuChanged,
    DriverChanged,
}

impl GpuChange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GpuChanged => "gpu-changed",
            Self::DriverChanged => "driver-changed",
        }
    }
}

pub fn gpu_change(before: &GpuIdentity, after: &GpuIdentity) -> Option<GpuChange> {
    if before.vendor_id != after.vendor_id || before.device_id != after.device_id {
        return Some(GpuChange::GpuChanged);
    }
    if before.driver_version != after.driver_version || before.driver_date != after.driver_date {
        return Some(GpuChange::DriverChanged);
    }
    None
}

#[derive(Clone, Debug, PartialEq, Default, Serialize)]
pub struct GpuMarker {
    /// Epoch ms of the crash that wrote it (0 when an older build left no readable time).
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `Some(None)` is a JSON `null`.
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Option<i64>>,
    /// The GPU the crash happened on, or the one the last hardware trial ran on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuIdentity>,
    /// The GPU a later software launch saw.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen: Option<GpuIdentity>,
    /// Epoch ms of the last hardware trial.
    #[serde(rename = "trialAt", skip_serializing_if = "Option::is_none")]
    pub trial_at: Option<i64>,
    /// The crash policy the marker was written under; absent in older builds' markers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<i64>,
}

/// The file's text: the marker with `at` as an ISO time.
pub fn marker_text(marker: &GpuMarker) -> String {
    let mut value = serde_json::to_value(marker).expect("marker serializes");
    value["at"] = json!(iso(marker.at));
    value.to_string()
}

/// An unreadable marker still forces software rendering; its missing fields read as unknown.
pub fn parse_marker(text: &str) -> GpuMarker {
    let value = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let get = |key: &str| value.get(key);
    let at = match get("at") {
        Some(Value::String(s)) => parse_iso(s),
        Some(other @ Value::Number(_)) => js_number(Some(other)),
        _ => None,
    };
    GpuMarker {
        at: at.unwrap_or(0),
        reason: get("reason").and_then(Value::as_str).map(String::from),
        exit_code: match get("exitCode") {
            Some(Value::Null) => Some(None),
            Some(other @ Value::Number(_)) => js_number(Some(other)).map(Some),
            _ => None,
        },
        gpu: get("gpu").and_then(identity_from),
        seen: get("seen").and_then(identity_from),
        trial_at: match get("trialAt") {
            Some(other @ Value::Number(_)) => js_number(Some(other)),
            _ => None,
        },
        policy: match get("policy") {
            Some(other @ Value::Number(_)) => js_number(Some(other)),
            _ => None,
        },
    }
}

/// GPU-process exits that mean compositing is dead. `clean-exit` is lifecycle; `killed` is an outside termination
/// (Windows logoff, shutdown or an installer ends the whole tree with DBG_TERMINATE_PROCESS), never a GPU failure.
pub fn is_gpu_process_crash(kind: &str, reason: &str) -> bool {
    kind == "GPU" && reason != "clean-exit" && reason != "killed"
}

/// A marker an older build wrote for a non-crash exit (killed) is stale; an unreadable one still counts.
pub fn marker_forces_software(text: &str) -> bool {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => match value.get("reason") {
            Some(Value::String(reason)) => is_gpu_process_crash("GPU", reason),
            _ => true,
        },
        Err(_) => true,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Trial {
    Change(GpuChange),
    CoolOff,
    Policy,
}

impl Trial {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Change(change) => change.as_str(),
            Self::CoolOff => "cool-off",
            Self::Policy => "policy",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MarkerDecision {
    Software,
    Hardware(Trial),
}

/// Whether a launch under this marker renders in software or tries hardware once.
pub fn marker_decision(marker: &GpuMarker, now: i64) -> MarkerDecision {
    if marker.policy != Some(MARKER_POLICY) {
        return MarkerDecision::Hardware(Trial::Policy);
    }
    let change = match (&marker.gpu, &marker.seen) {
        (Some(gpu), Some(seen)) => gpu_change(gpu, seen),
        _ => None,
    };
    if let Some(change) = change {
        return MarkerDecision::Hardware(Trial::Change(change));
    }
    if now - marker.at.max(marker.trial_at.unwrap_or(0)) >= HARDWARE_RETRY_AFTER_MS {
        return MarkerDecision::Hardware(Trial::CoolOff);
    }
    MarkerDecision::Software
}

/// The marker a hardware trial leaves before it runs: the GPU it tries is the crash GPU from now on.
pub fn marker_for_trial(marker: &GpuMarker, now: i64) -> GpuMarker {
    GpuMarker {
        gpu: marker.seen.clone().or_else(|| marker.gpu.clone()),
        seen: None,
        trial_at: Some(now),
        policy: Some(MARKER_POLICY),
        ..marker.clone()
    }
}

// ---- time -------------------------------------------------------------------------------------------------------

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

/// `Date.parse` of the forms this app writes (`toISOString`) and the usual ISO ones: `YYYY-MM-DD`, with `THH:MM`,
/// `:SS`, `.fff` and `Z` or `±HH:MM` after it. A time with no offset is read as UTC (JavaScript reads it as local).
pub fn parse_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = bytes.get(from..from + len)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let (year, mut at) = match bytes.first()? {
        b'+' | b'-' => {
            let value = digits(1, 6)?;
            (if bytes[0] == b'-' { -value } else { value }, 7)
        }
        _ => (digits(0, 4)?, 4),
    };
    let mut month = 1;
    let mut day = 1;
    if bytes.get(at) == Some(&b'-') {
        month = digits(at + 1, 2)?;
        at += 3;
        if bytes.get(at) == Some(&b'-') {
            day = digits(at + 1, 2)?;
            at += 3;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut seconds = 0;
    let mut millis = 0;
    let mut offset = 0;
    if bytes.get(at) == Some(&b'T') {
        let hour = digits(at + 1, 2)?;
        if bytes.get(at + 3) != Some(&b':') {
            return None;
        }
        let minute = digits(at + 4, 2)?;
        at += 6;
        let mut second = 0;
        if bytes.get(at) == Some(&b':') {
            second = digits(at + 1, 2)?;
            at += 3;
            if bytes.get(at) == Some(&b'.') {
                let mut end = at + 1;
                while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                    end += 1;
                }
                if end == at + 1 {
                    return None;
                }
                let fraction = &text[at + 1..end];
                millis = format!("{fraction:0<3}")[..3].parse().ok()?;
                at = end;
            }
        }
        if hour > 24 || minute > 59 || second > 59 {
            return None;
        }
        seconds = hour * 3600 + minute * 60 + second;
        match bytes.get(at) {
            Some(b'Z') => at += 1,
            Some(sign @ (b'+' | b'-')) => {
                if bytes.get(at + 3) != Some(&b':') {
                    return None;
                }
                let minutes = digits(at + 1, 2)? * 60 + digits(at + 4, 2)?;
                offset = if *sign == b'-' { -minutes } else { minutes };
                at += 6;
            }
            _ => {}
        }
    }
    (at == bytes.len()).then(|| {
        (days_from_civil(year, month, day) * 86_400 + seconds - offset * 60) * 1000 + millis
    })
}

// ---- one launch -------------------------------------------------------------------------------------------------

/// The files a launch reads and writes in `<userData>`. A write that fails is the implementation's to swallow: both
/// files are advisory.
pub trait Files {
    fn marker(&self) -> Option<String>;
    fn write_marker(&mut self, text: &str);
    /// False when the file could not be removed.
    fn remove_marker(&mut self) -> bool;
    fn history(&self) -> Option<String>;
    fn write_history(&mut self, text: &str);
}

/// One `gui-runtime.jsonl` line (`RuntimeLogReport` shape).
#[derive(Clone, Debug, PartialEq)]
pub struct LogLine {
    pub source: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

impl LogLine {
    pub fn gpu(message: impl Into<String>, details: Option<Value>) -> Self {
        Self {
            source: "gpu-fallback",
            message: message.into(),
            details,
        }
    }

    pub fn report(&self) -> Value {
        let mut report = json!({ "source": self.source, "message": self.message });
        if let Some(details) = &self.details {
            report["details"] = details.clone();
        }
        report
    }
}

pub struct Start {
    /// The launch guard records this launch (packaged and not a test, or `OMP_GUI_LAUNCH_GUARD=1`).
    pub guard_on: bool,
    pub enable_gpu: bool,
    pub disable_gpu: bool,
    /// `OMP_GUI_HEADLESS=1`.
    pub test_launch: bool,
    pub now: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GoneDetails {
    pub kind: String,
    pub reason: String,
    pub exit_code: Option<i64>,
}

/// What a GPU process exit asks of the shell.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Gone {
    Ignored,
    /// Written down; Chromium recovers by itself.
    Stay,
    /// The marker is written and the history noted: relaunch (`app.relaunch(); app.exit(0)`).
    Relaunch,
}

pub struct Gpu {
    guard: Option<Guard>,
    start: Start,
    /// This launch turned hardware acceleration off before ready.
    software_launch: bool,
    /// This launch tries hardware again under a crash marker (driver or GPU changed, or the cool-off passed).
    hardware_trial: bool,
    /// The GPU Chromium named once ready.
    current_gpu: Option<GpuIdentity>,
    crash_handled: bool,
    /// When this launch's GPU process last crashed while the launch went on (a settled crash Chromium recovered).
    crashed_at: Option<i64>,
}

impl Gpu {
    /// Before CEF starts (`startLaunchGuard` then `applyGpuFallbackIfNeeded(safeMode)`): records the launch, finds
    /// safe mode, reads and settles the marker and decides whether hardware acceleration is off. Call once, after the
    /// single-instance lock is held (a second instance quits at once and must not count).
    pub fn start(files: &mut dyn Files, start: Start, logs: &mut Vec<LogLine>) -> Self {
        let guard = start.guard_on.then(|| {
            let guard = Guard::start(files.history().as_deref(), start.now);
            files.write_history(&guard.text());
            guard
        });
        let safe_mode = guard.as_ref().is_some_and(Guard::safe_mode);
        if safe_mode {
            logs.push(LogLine {
                source: "launch-guard",
                message: format!(
                    "Safe mode: the last {CRASH_LOOP_LAUNCHES} launches ended within {} s of starting; software rendering, no automatic relaunch, setup paused",
                    STABLE_AFTER_MS / 1000
                ),
                details: None,
            });
        }
        let mut gpu = Self {
            guard,
            software_launch: false,
            hardware_trial: false,
            current_gpu: None,
            crash_handled: false,
            crashed_at: None,
            start,
        };
        gpu.software_launch = gpu.apply(files, safe_mode, logs);
        gpu
    }

    /// `applyGpuFallbackIfNeeded`: safe mode renders in software whatever the switches or the marker say.
    fn apply(&mut self, files: &mut dyn Files, safe_mode: bool, logs: &mut Vec<LogLine>) -> bool {
        let mut disabled = safe_mode;
        if safe_mode {
        } else if self.start.enable_gpu {
            // The marker is advisory; failing to clear it must not block startup.
            files.remove_marker();
        } else if self.start.disable_gpu {
            disabled = true;
        } else if let Some(text) = files.marker() {
            if marker_forces_software(&text) {
                let marker = parse_marker(&text);
                match marker_decision(&marker, self.start.now) {
                    MarkerDecision::Software => disabled = true,
                    MarkerDecision::Hardware(trial) => {
                        // Recorded before it runs, so a trial that never gets a verdict is not repeated.
                        files
                            .write_marker(&marker_text(&marker_for_trial(&marker, self.start.now)));
                        self.hardware_trial = true;
                        logs.push(LogLine::gpu(
                            format!(
                                "GPU crash marker: trying hardware acceleration again ({})",
                                trial.as_str()
                            ),
                            Some(json!({
                                "trial": trial.as_str(),
                                "crashedOn": marker.gpu,
                                "now": marker.seen,
                                "crashedAt": (marker.at != 0).then(|| iso(marker.at)),
                            })),
                        ));
                    }
                }
            } else {
                files.remove_marker();
            }
        }
        if disabled {
            logs.push(LogLine::gpu(
                if safe_mode {
                    "Hardware acceleration disabled (safe mode)"
                } else {
                    "Hardware acceleration disabled (crash marker or --disable-gpu)"
                },
                None,
            ));
        }
        disabled
    }

    pub fn safe_mode(&self) -> bool {
        self.guard.as_ref().is_some_and(Guard::safe_mode)
    }

    /// This launch turned hardware acceleration off before ready.
    pub fn software_launch(&self) -> bool {
        self.software_launch
    }

    /// Once ready: the GPU Chromium names (`devices` is `getGPUInfo("basic").gpuDevice`; `None` when the info could not
    /// be read). A software launch under a marker records it as `seen`, so the next launch tries hardware when it
    /// changed.
    pub fn record_identity(
        &mut self,
        files: &mut dyn Files,
        devices: Option<&Value>,
        logs: &mut Vec<LogLine>,
    ) {
        let Some(devices) = devices else { return };
        self.current_gpu = identity_of(devices);
        let Some(current) = self.current_gpu.clone().filter(|_| self.software_launch) else {
            return;
        };
        let Some(text) = files.marker().filter(|t| marker_forces_software(t)) else {
            return;
        };
        let marker = parse_marker(&text);
        if marker
            .seen
            .as_ref()
            .is_some_and(|seen| gpu_change(seen, &current).is_none())
        {
            return;
        }
        files.write_marker(&marker_text(&GpuMarker {
            seen: Some(current.clone()),
            ..marker.clone()
        }));
        let change = marker
            .gpu
            .as_ref()
            .and_then(|gpu| gpu_change(gpu, &current));
        logs.push(LogLine::gpu(
            match change {
                Some(change) => format!(
                    "GPU {} since the crash: the next launch tries hardware acceleration",
                    change.as_str()
                ),
                None => "GPU unchanged since the crash: software rendering stays".to_string(),
            },
            Some(json!({ "crashedOn": marker.gpu, "now": current })),
        ));
    }

    /// A hardware trial ran long enough without a GPU crash: the marker goes, hardware acceleration stays.
    pub fn confirm_hardware_trial(&mut self, files: &mut dyn Files, logs: &mut Vec<LogLine>) {
        if !self.hardware_trial || self.crash_handled {
            return;
        }
        self.hardware_trial = false;
        if !files.remove_marker() {
            return;
        }
        logs.push(LogLine::gpu(
            "GPU crash marker cleared: hardware acceleration works again",
            None,
        ));
    }

    /// This launch ran long enough (`STABLE_AFTER_MS`) or quits cleanly: it ends no crash loop. A GPU relaunch's exit
    /// and a crash skip both, so those launches stay unstable.
    pub fn mark_stable(&mut self, files: &mut dyn Files) {
        if let Some(guard) = self.guard.as_mut()
            && guard.mark_stable()
        {
            files.write_history(&guard.text());
        }
    }

    /// The `STABLE_AFTER_MS` timer: stable, and a hardware trial that ran this long keeps hardware.
    pub fn stable_after_delay(&mut self, files: &mut dyn Files, logs: &mut Vec<LogLine>) {
        self.mark_stable(files);
        self.confirm_hardware_trial(files, logs);
    }

    /// A GPU process ended (`handleGpuProcessGone`). A hardware launch whose GPU process dies early writes the marker
    /// and relaunches into software rendering, once. A launch up for `GPU_CRASH_SETTLED_MS` leaves its first crash to
    /// Chromium (it restarts the GPU process and the window stays up) and writes no marker, so hardware stays, here
    /// and on the next launch; a second crash within the cooldown of that one is a GPU that keeps dying and takes the
    /// marker path. Every other launch leaves recovery to Chromium. `up_ms` is this launch's age.
    pub fn gone(
        &mut self,
        files: &mut dyn Files,
        details: &GoneDetails,
        now: i64,
        up_ms: f64,
        logs: &mut Vec<LogLine>,
    ) -> Gone {
        if !is_gpu_process_crash(&details.kind, &details.reason) || self.crash_handled {
            return Gone::Ignored;
        }
        let exit = json!({ "reason": details.reason, "exitCode": details.exit_code });
        let history = self.guard.as_ref().map(Guard::history).unwrap_or_default();
        let decision = gpu_relaunch_decision(&RelaunchInput {
            software: self.software_launch,
            safe_mode: self.safe_mode(),
            test_launch: self.start.test_launch,
            history: &history,
            now,
            up_ms,
            crashed_before: self.crashed_at,
        });
        let with = |extra: Value| {
            let mut object = exit.clone();
            object
                .as_object_mut()
                .expect("object")
                .extend(extra.as_object().cloned().expect("object"));
            object
        };
        if let GpuRelaunchDecision::Stay {
            why: RelaunchWhy::Settled,
            ..
        } = decision
        {
            self.crashed_at = Some(now);
            logs.push(LogLine::gpu(
                format!(
                    "GPU process exited ({}) after {} s up: Chromium restarts it, hardware acceleration stays",
                    details.reason,
                    js_round(up_ms / 1000.0)
                ),
                Some(with(json!({ "why": "settled", "upMs": js_round(up_ms) }))),
            ));
            return Gone::Stay;
        }
        self.crash_handled = true;
        if !self.software_launch {
            // A crash in a hardware trial starts the cool-off again with the GPU it crashed on.
            let gpu = self
                .current_gpu
                .clone()
                .or_else(|| files.marker().and_then(|text| parse_marker(&text).gpu));
            files.write_marker(&marker_text(&GpuMarker {
                at: now,
                policy: Some(MARKER_POLICY),
                reason: Some(details.reason.clone()),
                exit_code: Some(details.exit_code),
                gpu,
                ..GpuMarker::default()
            }));
        }
        match decision {
            GpuRelaunchDecision::Stay {
                why,
                last_relaunch_at,
            } => {
                logs.push(LogLine::gpu(
                    format!(
                        "GPU process exited ({}): no relaunch ({}); Chromium restarts it",
                        details.reason,
                        why.as_str()
                    ),
                    Some(with(
                        json!({ "why": why.as_str(), "lastRelaunchAt": last_relaunch_at }),
                    )),
                ));
                Gone::Stay
            }
            GpuRelaunchDecision::Relaunch => {
                logs.push(LogLine::gpu(
                    format!(
                        "GPU process exited ({}): relaunching with software rendering",
                        details.reason
                    ),
                    Some(exit),
                ));
                if let Some(guard) = self.guard.as_mut() {
                    guard.note_gpu_relaunch(now);
                    files.write_history(&guard.text());
                }
                Gone::Relaunch
            }
        }
    }
}

/// `Math.round`: halves go up.
pub fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

// ---- the GPU process Chromium launches ------------------------------------------------------------------------

/// Whether the GPU process's arguments say it renders in software: Chromium launches it with the mode it decided
/// (`--disable-gpu`, `--disable-gpu-compositing`, `--use-gl=disabled`, or ANGLE on SwiftShader).
pub fn gpu_args_are_software(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--disable-gpu"
                | "--disable-gpu-compositing"
                | "--use-gl=disabled"
                | "--use-angle=swiftshader"
                | "--use-gl=swiftshader"
                | "--use-angle=swiftshader-webgl"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chrome_core::captured;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct Mem {
        files: BTreeMap<&'static str, String>,
        removals_fail: bool,
    }

    impl Files for Mem {
        fn marker(&self) -> Option<String> {
            self.files.get("marker").cloned()
        }
        fn write_marker(&mut self, text: &str) {
            self.files.insert("marker", text.to_string());
        }
        fn remove_marker(&mut self) -> bool {
            if self.removals_fail {
                return false;
            }
            self.files.remove("marker");
            true
        }
        fn history(&self) -> Option<String> {
            self.files.get("history").cloned()
        }
        fn write_history(&mut self, text: &str) {
            self.files.insert("history", text.to_string());
        }
    }

    const T0: i64 = 1_800_000_000_000;
    const CRASH: GoneDetails = GoneDetails {
        kind: String::new(),
        reason: String::new(),
        exit_code: Some(-1_073_741_819),
    };

    fn crash() -> GoneDetails {
        GoneDetails {
            kind: "GPU".into(),
            reason: "crashed".into(),
            ..CRASH
        }
    }

    fn start(mem: &mut Mem, guard_on: bool, now: i64) -> (Gpu, Vec<LogLine>) {
        let mut logs = Vec::new();
        let gpu = Gpu::start(
            mem,
            Start {
                guard_on,
                enable_gpu: false,
                disable_gpu: false,
                test_launch: false,
                now,
            },
            &mut logs,
        );
        (gpu, logs)
    }

    fn messages(logs: &[LogLine]) -> String {
        logs.iter()
            .map(|l| l.message.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn i_gpu(version: &str) -> Value {
        json!({ "active": true, "vendorId": 0x8086, "deviceId": 0x9a49, "driverVersion": version, "driverDate": "2021-6-14" })
    }

    fn swift() -> Value {
        json!({ "active": false, "vendorId": 0xffff, "deviceId": 0xffff, "driverVersion": "5.0.0" })
    }

    #[test]
    fn isgpuprocesscrash_triggers_only_for_gpu_process_failures() {
        for reason in ["crashed", "oom", "launch-failed"] {
            assert!(is_gpu_process_crash("GPU", reason));
        }
        assert!(!is_gpu_process_crash("GPU", "clean-exit"));
        assert!(!is_gpu_process_crash("GPU", "killed"));
        assert!(!is_gpu_process_crash("Tab", "crashed"));
        assert!(!is_gpu_process_crash("Utility", "crashed"));
    }

    #[test]
    fn markerforcessoftware_keeps_software_only_for_a_real_gpu_failure() {
        assert!(marker_forces_software(
            r#"{"reason":"crashed","exitCode":-1}"#
        ));
        assert!(!marker_forces_software(
            r#"{"reason":"killed","exitCode":1073807364}"#
        ));
        assert!(marker_forces_software("not json"));
    }

    #[test]
    fn never_relaunches_a_launch_that_already_renders_in_software() {
        let mut mem = Mem::default();
        mem.write_marker(
            &json!({ "at": iso(T0), "reason": "crashed", "exitCode": -1, "policy": 2 }).to_string(),
        );
        let (mut gpu, _) = start(&mut mem, true, T0 + 1000);
        assert!(gpu.software_launch());
        let mut logs = Vec::new();
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 2000, 1000.0, &mut logs),
            Gone::Stay
        );
        assert!(messages(&logs).contains("no relaunch"));
    }

    #[test]
    fn never_relaunches_a_launch_started_with_disable_gpu() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let mut gpu = Gpu::start(
            &mut mem,
            Start {
                guard_on: true,
                enable_gpu: false,
                disable_gpu: true,
                test_launch: false,
                now: T0,
            },
            &mut logs,
        );
        assert!(gpu.software_launch());
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 1, 1000.0, &mut logs),
            Gone::Stay
        );
    }

    #[test]
    fn relaunches_a_hardware_launch_once_into_software_and_that_launch_stays_up() {
        let mut mem = Mem::default();
        let (mut first, _) = start(&mut mem, true, T0);
        let mut logs = Vec::new();
        assert_eq!(
            first.gone(&mut mem, &crash(), T0 + 100, 100.0, &mut logs),
            Gone::Relaunch
        );
        let (mut second, _) = start(&mut mem, true, T0 + 1000);
        assert!(second.software_launch());
        assert_eq!(
            second.gone(&mut mem, &crash(), T0 + 1100, 100.0, &mut logs),
            Gone::Stay
        );
        assert_eq!(
            second.gone(&mut mem, &crash(), T0 + 1200, 100.0, &mut logs),
            Gone::Ignored
        );
    }

    #[test]
    fn relaunches_at_most_once_per_ten_minutes_even_with_enable_gpu() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut first, _) = start(&mut mem, true, T0);
        assert_eq!(
            first.gone(&mut mem, &crash(), T0 + 100, 100.0, &mut logs),
            Gone::Relaunch
        );
        let mut again = Gpu::start(
            &mut mem,
            Start {
                guard_on: true,
                enable_gpu: true,
                disable_gpu: false,
                test_launch: false,
                now: T0 + 1000,
            },
            &mut logs,
        );
        assert!(!again.software_launch());
        assert_eq!(
            again.gone(&mut mem, &crash(), T0 + 1100, 100.0, &mut logs),
            Gone::Stay
        );
        // The marker is written, so the next plain launch renders in software.
        assert!(start(&mut mem, true, T0 + 2000).0.software_launch());
    }

    #[test]
    fn never_relaunches_in_safe_mode_which_renders_in_software_whatever_the_switches_say() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        for i in 0..3 {
            Gpu::start(
                &mut mem,
                Start {
                    guard_on: true,
                    enable_gpu: true,
                    disable_gpu: false,
                    test_launch: false,
                    now: T0 + i,
                },
                &mut logs,
            );
        }
        let mut safe = Gpu::start(
            &mut mem,
            Start {
                guard_on: true,
                enable_gpu: true,
                disable_gpu: false,
                test_launch: false,
                now: T0 + 3,
            },
            &mut logs,
        );
        assert!(safe.software_launch() && safe.safe_mode());
        assert!(
            messages(&logs)
                .contains("Safe mode: the last 3 launches ended within 20 s of starting")
        );
        assert_eq!(
            safe.gone(&mut mem, &crash(), T0 + 10, 10.0, &mut logs),
            Gone::Stay
        );
    }

    #[test]
    fn never_relaunches_a_test_launch() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let mut gpu = Gpu::start(
            &mut mem,
            Start {
                guard_on: true,
                enable_gpu: false,
                disable_gpu: false,
                test_launch: true,
                now: T0,
            },
            &mut logs,
        );
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 1, 10.0, &mut logs),
            Gone::Stay
        );
        assert!(messages(&logs).contains("no relaunch (test-launch)"));
    }

    /// A launch that also reads the GPU once ready and outlives the crash-loop window, as the shell does.
    fn launch_with(mem: &mut Mem, device: Value, now: i64) -> (Gpu, Vec<LogLine>) {
        let (mut gpu, mut logs) = start(mem, true, now);
        gpu.record_identity(mem, Some(&json!([swift(), device])), &mut logs);
        gpu.mark_stable(mem);
        (gpu, logs)
    }

    #[test]
    fn stays_in_software_while_the_driver_that_crashed_is_still_installed() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut gpu, _) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 5, 5.0, &mut logs),
            Gone::Relaunch
        );
        let mut software = 0;
        for i in 1..3 {
            software += i32::from(
                launch_with(&mut mem, i_gpu("27.20.100.9466"), T0 + i * 60_000)
                    .0
                    .software_launch(),
            );
        }
        assert_eq!(software, 2);
    }

    #[test]
    fn tries_hardware_once_after_the_driver_changed_and_keeps_it_when_that_launch_stays_up() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut gpu, _) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        gpu.gone(&mut mem, &crash(), T0 + 5, 5.0, &mut logs);
        // The software launch after the update sees the new driver.
        assert!(
            launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 60_000)
                .0
                .software_launch()
        );
        let (mut trial, trial_logs) = launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 120_000);
        assert!(!trial.software_launch());
        assert!(
            messages(&trial_logs).contains("trying hardware acceleration again (driver-changed)")
        );
        let mut confirm = Vec::new();
        trial.confirm_hardware_trial(&mut mem, &mut confirm);
        assert!(messages(&confirm).contains("hardware acceleration works again"));
        assert!(
            !launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 180_000)
                .0
                .software_launch()
        );
    }

    #[test]
    fn tries_hardware_once_only_a_trial_without_a_verdict_leaves_the_next_launch_in_software() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut gpu, _) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        gpu.gone(&mut mem, &crash(), T0 + 5, 5.0, &mut logs);
        launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 60_000);
        assert!(
            !launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 120_000)
                .0
                .software_launch()
        );
        assert!(
            launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 180_000)
                .0
                .software_launch()
        );
    }

    #[test]
    fn a_crash_in_the_trial_goes_back_to_software_without_a_second_relaunch_inside_the_cap() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut gpu, _) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 5, 5.0, &mut logs),
            Gone::Relaunch
        );
        launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 60_000);
        let (mut trial, _) = launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 120_000);
        assert_eq!(
            trial.gone(&mut mem, &crash(), T0 + 125_000, 5000.0, &mut logs),
            Gone::Stay
        );
        assert!(
            launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 180_000)
                .0
                .software_launch()
        );
        assert!(
            launch_with(&mut mem, i_gpu("31.0.101.5186"), T0 + 240_000)
                .0
                .software_launch()
        );
    }

    #[test]
    fn tries_hardware_once_again_after_a_seven_day_cool_off() {
        let mut mem = Mem::default();
        let eight_days_ago = T0 - 8 * 24 * 60 * 60_000;
        mem.write_marker(
            &json!({ "at": iso(eight_days_ago), "reason": "crashed", "exitCode": -1, "policy": 2 })
                .to_string(),
        );
        let (gpu, logs) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        assert!(!gpu.software_launch());
        assert!(messages(&logs).contains("trying hardware acceleration again (cool-off)"));
    }

    #[test]
    fn leaves_the_first_crash_of_a_settled_hardware_launch_to_chromium() {
        let settled = 40.0 * 60_000.0;
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut gpu, _) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 1, settled, &mut logs),
            Gone::Stay
        );
        assert!(messages(&logs).contains("Chromium restarts it, hardware acceleration stays"));
        assert!(mem.marker().is_none());
        assert!(
            !launch_with(&mut mem, i_gpu("27.20.100.9466"), T0 + 60_000)
                .0
                .software_launch()
        );
    }

    #[test]
    fn a_second_crash_within_the_cooldown_of_the_first_is_a_gpu_that_keeps_dying() {
        let settled = 40.0 * 60_000.0;
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut gpu, _) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 1, settled, &mut logs),
            Gone::Stay
        );
        assert_eq!(
            gpu.gone(
                &mut mem,
                &crash(),
                T0 + 30_001,
                settled + 30_000.0,
                &mut logs
            ),
            Gone::Relaunch
        );
        assert!(
            launch_with(&mut mem, i_gpu("27.20.100.9466"), T0 + 60_000)
                .0
                .software_launch()
        );
    }

    #[test]
    fn an_early_crash_still_relaunches_into_software() {
        let mut mem = Mem::default();
        let mut logs = Vec::new();
        let (mut gpu, _) = launch_with(&mut mem, i_gpu("27.20.100.9466"), T0);
        assert_eq!(
            gpu.gone(&mut mem, &crash(), T0 + 1, 3000.0, &mut logs),
            Gone::Relaunch
        );
    }

    #[test]
    fn a_marker_an_older_build_wrote_gets_one_hardware_trial_under_this_policy() {
        let mut mem = Mem::default();
        mem.write_marker(
            &json!({ "at": iso(T0), "reason": "crashed", "exitCode": 34, "gpu": i_gpu("32.0.16.2101") }).to_string(),
        );
        let (mut trial, logs) = launch_with(&mut mem, i_gpu("32.0.16.2101"), T0 + 1);
        assert!(!trial.software_launch());
        assert!(messages(&logs).contains("trying hardware acceleration again (policy)"));
        let mut confirm = Vec::new();
        trial.confirm_hardware_trial(&mut mem, &mut confirm);
        assert!(
            !launch_with(&mut mem, i_gpu("32.0.16.2101"), T0 + 60_000)
                .0
                .software_launch()
        );
    }

    #[test]
    fn a_marker_that_cannot_be_removed_confirms_nothing() {
        let mut mem = Mem::default();
        mem.write_marker(&json!({ "at": iso(T0), "reason": "crashed", "policy": 1 }).to_string());
        let (mut trial, _) = start(&mut mem, true, T0 + 1);
        mem.removals_fail = true;
        let mut logs = Vec::new();
        trial.confirm_hardware_trial(&mut mem, &mut logs);
        assert!(logs.is_empty());
    }

    #[test]
    fn a_killed_marker_is_stale_and_goes() {
        let mut mem = Mem::default();
        mem.write_marker(
            &json!({ "at": iso(T0), "reason": "killed", "exitCode": 1073807364 }).to_string(),
        );
        let (gpu, _) = start(&mut mem, true, T0 + 1);
        assert!(!gpu.software_launch());
        assert!(mem.marker().is_none());
    }

    #[test]
    fn iso_times_round_trip() {
        for ms in [0, 1, 999, T0, T0 + 123, -86_400_000, 253_402_300_799_999] {
            assert_eq!(parse_iso(&iso(ms)), Some(ms), "{ms}");
        }
        assert_eq!(iso(T0), "2027-01-15T08:00:00.000Z");
        assert_eq!(
            parse_iso("2026-10-20T01:38:33.839Z"),
            Some(1_792_460_313_839)
        );
        assert_eq!(parse_iso("2026-10-20"), Some(1_792_454_400_000));
        assert_eq!(
            parse_iso("2026-10-20T03:38:33+02:00"),
            Some(1_792_460_313_000)
        );
        assert_eq!(parse_iso("yesterday"), None);
        assert_eq!(parse_iso("2026-13-01"), None);
    }

    #[test]
    fn the_gpu_process_mode_comes_from_its_arguments() {
        let args = |line: &str| -> Vec<String> { line.split(' ').map(String::from).collect() };
        assert!(gpu_args_are_software(&args(
            "x --type=gpu-process --use-angle=swiftshader"
        )));
        assert!(gpu_args_are_software(&args(
            "x --type=gpu-process --disable-gpu"
        )));
        assert!(!gpu_args_are_software(&args(
            "x --type=gpu-process --use-angle=d3d11"
        )));
    }

    // ---- the TypeScript's own answers (captured/gpu.json) ----

    fn marker_value(marker: &GpuMarker) -> Value {
        serde_json::to_value(marker).unwrap()
    }

    #[test]
    fn pure_functions_as_the_typescript_did() {
        for step in captured::of("gpu", "src/main/gpu-fallback-core.ts#parseGpuMarker") {
            let got = parse_marker(step.input["text"].as_str().unwrap());
            assert_eq!(marker_value(&got), step.output, "{step:?}");
        }
        for step in captured::of("gpu", "src/main/gpu-fallback-core.ts#gpuIdentityOf") {
            let got = identity_of(&step.input["devices"]);
            assert_eq!(json!(got), step.output, "{step:?}");
        }
        for step in captured::of("gpu", "src/main/gpu-fallback-core.ts#gpuChange") {
            let identity = |v: &Value| identity_from(v).expect("identity");
            let got = gpu_change(
                &identity(&step.input["before"]),
                &identity(&step.input["after"]),
            )
            .map(GpuChange::as_str);
            assert_eq!(json!(got), step.output, "{step:?}");
        }
        for step in captured::of("gpu", "src/main/gpu-fallback-core.ts#gpuMarkerDecision") {
            let marker = parse_marker(step.input["text"].as_str().unwrap());
            let got = match marker_decision(&marker, step.input["now"].as_i64().unwrap()) {
                MarkerDecision::Software => json!({ "software": true }),
                MarkerDecision::Hardware(trial) => {
                    json!({ "software": false, "trial": trial.as_str() })
                }
            };
            assert_eq!(got, step.output, "{step:?}");
        }
        for step in captured::of("gpu", "src/main/gpu-fallback-core.ts#markerForTrial") {
            let marker = parse_marker(step.input["text"].as_str().unwrap());
            let got = marker_for_trial(&marker, step.input["now"].as_i64().unwrap());
            assert_eq!(marker_value(&got), step.output, "{step:?}");
        }
        for step in captured::of("gpu", "src/main/gpu-fallback.ts#markerForcesSoftware") {
            let got = marker_forces_software(step.input["text"].as_str().unwrap());
            assert_eq!(json!(got), step.output, "{step:?}");
        }
        for step in captured::of("gpu", "src/main/gpu-fallback.ts#isGpuProcessCrash") {
            let got = is_gpu_process_crash(
                step.input["type"].as_str().unwrap(),
                step.input["reason"].as_str().unwrap(),
            );
            assert_eq!(json!(got), step.output, "{step:?}");
        }
    }

    /// The scenarios: one launch over files, its events, and everything it wrote.
    #[test]
    fn launches_as_the_typescript_did() {
        for step in captured::of("gpu", "src/main/gpu-fallback.ts#launch") {
            let input = &step.input;
            let mut mem = Mem::default();
            if let Some(text) = input["marker"].as_str() {
                mem.write_marker(text);
            }
            if let Some(text) = input["history"].as_str() {
                mem.write_history(text);
            }
            let switches: Vec<&str> = input["switches"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            let mut logs = Vec::new();
            let mut gpu = Gpu::start(
                &mut mem,
                Start {
                    guard_on: input["guardOn"].as_bool().unwrap(),
                    enable_gpu: switches.contains(&"enable-gpu"),
                    disable_gpu: switches.contains(&"disable-gpu"),
                    test_launch: input["headless"].as_bool().unwrap(),
                    now: input["now"].as_i64().unwrap(),
                },
                &mut logs,
            );
            let mut results = Vec::new();
            for event in input["events"].as_array().unwrap() {
                match event["kind"].as_str().unwrap() {
                    "identity" => gpu.record_identity(
                        &mut mem,
                        event["devices"].as_array().map(|_| &event["devices"]),
                        &mut logs,
                    ),
                    "timer" => gpu.stable_after_delay(&mut mem, &mut logs),
                    "quit" => gpu.mark_stable(&mut mem),
                    "gone" => {
                        let details = GoneDetails {
                            kind: event["type"].as_str().unwrap().into(),
                            reason: event["reason"].as_str().unwrap().into(),
                            exit_code: event["exitCode"].as_i64(),
                        };
                        let got = gpu.gone(
                            &mut mem,
                            &details,
                            event["now"].as_i64().unwrap(),
                            event["upMs"].as_f64().unwrap(),
                            &mut logs,
                        );
                        results.push(json!(got == Gone::Relaunch));
                    }
                    other => panic!("unknown event {other}"),
                }
            }
            let parse = |text: Option<String>| {
                text.map_or(Value::Null, |t| {
                    serde_json::from_str(&t).unwrap_or(Value::String(t))
                })
            };
            let got = json!({
                "software": gpu.software_launch(),
                "safeMode": gpu.safe_mode(),
                "relaunches": results,
                "marker": parse(mem.marker()),
                "history": parse(mem.history()),
                "logs": logs.iter().map(LogLine::report).collect::<Vec<_>>(),
            });
            assert_eq!(got, step.output, "{step:?}");
        }
    }
}
