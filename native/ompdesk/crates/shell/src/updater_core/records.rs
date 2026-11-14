use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const RELAUNCH_PRESENCE_MS: f64 = 900_000.0;
pub const START_FAILED_FILE: &str = "update-start-failed.json";
pub const START_MARK_FILE: &str = "app-started.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowPresence {
    Hidden,
    Minimized,
    Behind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallHelperMode {
    Relaunch,
    Nsis,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PendingInstall {
    pub from: String,
    pub to: String,
    pub mode: InstallHelperMode,
    pub trigger: String,
    pub at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence: Option<WindowPresence>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StartFailure {
    pub version: String,
    #[serde(serialize_with = "serialize_number")]
    pub count: f64,
    #[serde(serialize_with = "serialize_number")]
    pub at: f64,
}

fn serialize_number<S: serde::Serializer>(number: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if number.is_finite()
        && number.fract() == 0.0
        && *number >= i64::MIN as f64
        && *number < i64::MAX as f64
    {
        serializer.serialize_i64(*number as i64)
    } else {
        serializer.serialize_f64(*number)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SwapLogEntry {
    pub at: String,
    pub outcome: String,
}

#[derive(Clone, Copy, Debug)]
pub struct WindowState {
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
}

pub fn window_presence_of(windows: &[WindowState]) -> Option<WindowPresence> {
    let mut shown = windows.iter().filter(|w| w.visible).peekable();
    if shown.peek().is_none() {
        return (!windows.is_empty()).then_some(WindowPresence::Hidden);
    }
    if shown.all(|w| w.minimized) {
        return Some(WindowPresence::Minimized);
    }
    (!windows.iter().any(|w| w.focused)).then_some(WindowPresence::Behind)
}

pub fn relaunch_presence(pending: Option<&PendingInstall>, now: f64) -> Option<WindowPresence> {
    let pending = pending?;
    if now - pending.at > RELAUNCH_PRESENCE_MS || now < pending.at {
        return None;
    }
    pending.presence
}

pub fn parse_pending_install(raw: &str) -> Option<PendingInstall> {
    let value: Value = serde_json::from_str(raw).ok()?;
    Some(PendingInstall {
        from: value.get("from")?.as_str()?.to_owned(),
        to: value.get("to")?.as_str()?.to_owned(),
        mode: serde_json::from_value(value.get("mode")?.clone()).ok()?,
        trigger: value.get("trigger")?.as_str()?.to_owned(),
        at: value.get("at")?.as_f64()?,
        presence: value
            .get("presence")
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
    })
}

pub fn parse_start_failure(raw: &str) -> Option<StartFailure> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let count = value
        .get("count")
        .and_then(Value::as_f64)
        .filter(|n| *n >= 1.0)
        .map(f64::floor)
        .unwrap_or(1.0);
    Some(StartFailure {
        version: value.get("version")?.as_str()?.to_owned(),
        count,
        at: value.get("at")?.as_f64()?,
    })
}

pub fn last_swap_entry(log: &str) -> Option<SwapLogEntry> {
    const OUTCOMES: &[&str] = &[
        "installed",
        "started",
        "start failed; previous app restored",
        "start failed; previous app lost",
        "start failed; the swap restores",
        "install failed; previous app restored",
        "copy failed",
        "cannot move old app",
        "staged app missing",
        "app still running; swap skipped",
    ];
    let lines: Vec<&str> = log
        .split('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s))
        .collect();
    for (index, line) in lines.iter().enumerate().rev() {
        let Some(rest) = line.strip_prefix("swap ") else {
            continue;
        };
        // The date is the shortest prefix followed by a valid source and destination.
        for (pos, _) in rest.match_indices(": ") {
            let at = &rest[..pos];
            let paths = &rest[pos + 2..];
            if at.is_empty()
                || !paths
                    .split_once(" -> ")
                    .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
            {
                continue;
            }
            let outcome = lines[index + 1..]
                .iter()
                .rev()
                .map(|s| s.trim())
                .find(|s| OUTCOMES.contains(s) || s.starts_with("start failed; restore failed:"))
                .unwrap_or("unknown");
            return Some(SwapLogEntry {
                at: at.to_owned(),
                outcome: outcome.to_owned(),
            });
        }
    }
    None
}

pub fn start_failure_of(
    pending: &PendingInstall,
    current: &str,
    swap: Option<&SwapLogEntry>,
    at: f64,
    earlier: Option<&StartFailure>,
) -> Option<StartFailure> {
    if !swap.is_some_and(|s| s.outcome.starts_with("start failed"))
        || current == pending.to
        || pending.to == "unknown"
    {
        return None;
    }
    Some(StartFailure {
        version: pending.to.clone(),
        count: earlier
            .filter(|e| e.version == pending.to)
            .map_or(1.0, |e| e.count + 1.0),
        at,
    })
}

pub fn start_mark_json(version: &str, pid: u32, at: i64) -> String {
    #[derive(Serialize)]
    struct Mark<'a> {
        version: &'a str,
        pid: u32,
        at: i64,
    }
    serde_json::to_string(&Mark { version, pid, at }).expect("mark serialization is infallible")
}

// ECMAScript TimeClip and UTC civil date conversion, including extended years.
fn iso_date(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    ))
}

pub fn previous_install_details(
    pending: &PendingInstall,
    current: &str,
    swap: Option<&SwapLogEntry>,
) -> Option<Value> {
    let outcome = if current == pending.to {
        "installed"
    } else if current == pending.from {
        "rolled back"
    } else {
        "changed"
    };
    let mut details = json!({"event":"result", "outcome":outcome, "previous":pending.from, "expected":pending.to, "current":current, "mode":pending.mode, "trigger":pending.trigger, "launchedAt":iso_date(pending.at)?});
    if let Some(swap) = swap {
        details["swapAt"] = json!(swap.at);
        details["swapOutcome"] = json!(swap.outcome);
    }
    Some(details)
}

#[derive(Debug)]
pub enum FirstPageError {
    StartMark(io::Error),
    StartFailure(io::Error),
    Records(io::Error),
}

impl std::fmt::Display for FirstPageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StartMark(error) => write!(f, "start mark: {error}"),
            Self::StartFailure(error) => write!(f, "start failure: {error}"),
            Self::Records(error) => write!(f, "update records: {error}"),
        }
    }
}

impl std::error::Error for FirstPageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::StartMark(error) | Self::StartFailure(error) | Self::Records(error) => {
                Some(error)
            }
        }
    }
}

impl From<io::Error> for FirstPageError {
    fn from(error: io::Error) -> Self {
        Self::Records(error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct ReportedInstall {
    from: String,
    to: String,
    at: f64,
}

pub struct Records {
    user_data: PathBuf,
    version: String,
    pid: u32,
    start_noted: bool,
    failure_saved: bool,
    failure: Option<StartFailure>,
    reported_install: Option<ReportedInstall>,
}

fn read_optional(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8(bytes).unwrap_or_else(|error| {
            String::from_utf8_lossy(error.as_bytes()).into_owned()
        }))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
fn remove_optional(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

impl Records {
    pub fn new(user_data: PathBuf, version: String, pid: u32) -> io::Result<Self> {
        let raw = read_optional(&user_data.join(START_FAILED_FILE))?;
        let failure = raw.as_deref().and_then(parse_start_failure);
        let reported_install = raw
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v.get("reportedInstall").cloned())
            .and_then(|v| serde_json::from_value(v).ok());
        Ok(Self {
            user_data,
            version,
            pid,
            start_noted: false,
            failure_saved: failure.is_some() && reported_install.is_some(),
            failure,
            reported_install,
        })
    }
    pub fn launch_presence(
        &self,
        now: f64,
        has_folder_arg: bool,
    ) -> io::Result<Option<WindowPresence>> {
        if has_folder_arg {
            return Ok(None);
        }
        let pending = read_optional(&self.user_data.join("update-install.json"))?
            .and_then(|s| parse_pending_install(&s));
        Ok(relaunch_presence(pending.as_ref(), now))
    }

    pub fn failed_version(&self) -> Option<&str> {
        self.failure
            .as_ref()
            .map(|failure| failure.version.as_str())
    }
    pub fn start_failed_before(&mut self, downloaded: Option<&str>) -> io::Result<bool> {
        let Some(failure) = &self.failure else {
            return Ok(false);
        };
        let Some(downloaded) = downloaded else {
            return Ok(false);
        };
        if downloaded == failure.version {
            return Ok(true);
        }
        remove_optional(&self.user_data.join(START_FAILED_FILE))?;
        self.failure = None;
        self.reported_install = None;
        self.failure_saved = false;
        Ok(false)
    }
    pub fn first_page_loaded(
        &mut self,
        now: i64,
        mut atomic_write: impl FnMut(&Path, &[u8]) -> io::Result<()>,
    ) -> Result<Option<Value>, FirstPageError> {
        if self.start_noted {
            return Ok(None);
        }
        let path = self.user_data.join("update-install.json");
        let raw = read_optional(&path)?;
        let pending = raw.as_deref().and_then(parse_pending_install);
        let swap = if pending
            .as_ref()
            .is_some_and(|pending| pending.mode == InstallHelperMode::Relaunch)
        {
            read_optional(&self.user_data.join("updates").join("swap.log"))?.and_then(|log| {
                let units: Vec<u16> = log.encode_utf16().collect();
                let tail = &units[units.len().saturating_sub(16 * 1024)..];
                last_swap_entry(&String::from_utf16_lossy(tail))
            })
        } else {
            None
        };
        if let Some(pending) = &pending {
            let receipt = ReportedInstall {
                from: pending.from.clone(),
                to: pending.to.clone(),
                at: pending.at,
            };
            if self.reported_install.as_ref() != Some(&receipt)
                && let Some(failure) = start_failure_of(
                    pending,
                    &self.version,
                    swap.as_ref(),
                    now as f64,
                    self.failure.as_ref(),
                )
            {
                // Preserve the hold before writing, and reuse this count if the disk is full.
                self.failure = Some(failure);
                self.reported_install = Some(receipt);
                self.failure_saved = false;
            }
        }
        atomic_write(
            &self.user_data.join(START_MARK_FILE),
            start_mark_json(&self.version, self.pid, now).as_bytes(),
        )
        .map_err(FirstPageError::StartMark)?;
        let mut report = None;
        if let Some(pending) = pending {
            report = Some(
                previous_install_details(&pending, &self.version, swap.as_ref()).ok_or_else(
                    || io::Error::new(io::ErrorKind::InvalidData, "invalid install timestamp"),
                )?,
            );
            if !self.failure_saved
                && self.reported_install.as_ref().is_some_and(|r| {
                    r.from == pending.from && r.to == pending.to && r.at == pending.at
                })
                && let Some(failure) = &self.failure
            {
                let mut saved = serde_json::to_value(failure).map_err(io::Error::other)?;
                saved["reportedInstall"] =
                    serde_json::to_value(&self.reported_install).map_err(io::Error::other)?;
                let bytes = serde_json::to_vec(&saved).map_err(io::Error::other)?;
                atomic_write(&self.user_data.join(START_FAILED_FILE), &bytes)
                    .map_err(FirstPageError::StartFailure)?;
                self.failure_saved = true;
            }
        }
        if self
            .failure
            .as_ref()
            .is_some_and(|f| f.version == self.version)
        {
            remove_optional(&self.user_data.join(START_FAILED_FILE))?;
            self.failure = None;
        }
        if raw.is_some() {
            remove_optional(&path)?;
        }
        self.start_noted = true;
        Ok(report)
    }
}

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
