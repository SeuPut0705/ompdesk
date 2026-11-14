use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value, json};

const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

macro_rules! sources {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum RuntimeErrorSource { $($variant),+ }
        impl RuntimeErrorSource {
            pub fn as_str(self) -> &'static str { match self { $(Self::$variant => $name),+ } }
            pub fn parse(value: &str) -> Self { match value { $($name => Self::$variant,)+ _ => Self::Unknown } }
        }
    };
}

sources! {
    ReactRender => "react-render", ReactUncaught => "react-uncaught", ReactRecoverable => "react-recoverable",
    WindowError => "window-error", UnhandledRejection => "unhandled-rejection", RendererConsole => "renderer-console",
    RendererLoad => "renderer-load", Preload => "preload", RendererProcess => "renderer-process",
    RendererUnresponsive => "renderer-unresponsive", ApplicationResources => "application-resources",
    ChildProcess => "child-process", MainUncaught => "main-uncaught", MainUnhandledRejection => "main-unhandled-rejection",
    ErrorToast => "error-toast", BackgroundTask => "background-task", StartupTiming => "startup-timing",
    TurnResume => "turn-resume", Hub => "hub", TabLayout => "tab-layout", Autopilot => "autopilot",
    AppUpdate => "app-update", AiMemory => "ai-memory", DiskCare => "disk-care", MainThreadHang => "main-thread-hang",
    WebReload => "web-reload", RemoteTab => "remote-tab", SessionDelete => "session-delete", TurnStop => "turn-stop",
    RemoteLink => "remote-link", GpuFallback => "gpu-fallback", LaunchGuard => "launch-guard",
    UserDataMigration => "user-data-migration", Setup => "setup", KeepAwake => "keep-awake", ShellBoot => "shell-boot",
    Remote => "remote", MemorySync => "memory-sync", SettleWatch => "settle-watch", SidecarRestart => "sidecar-restart",
    OmpSlowStart => "omp-slow-start", ProcessPriority => "process-priority", OmpReap => "omp-reap",
    SessionProcesses => "session-processes", SessionOwner => "session-owner", GoalTimeLimit => "goal-time-limit",
    TurnStages => "turn-stages", ChainStall => "chain-stall", Routines => "routines", Memory => "memory",
    Sidebar => "sidebar", Unknown => "unknown"
}

#[derive(Clone, Debug)]
pub struct RuntimeLogContext {
    pub app_version: String,
    pub platform: String,
    pub pid: u32,
    pub window_id: Option<f64>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RuntimeLogReport {
    pub source: RuntimeErrorSource,
    pub message: String,
    pub stack: Option<String>,
    pub component_stack: Option<String>,
    pub url: Option<String>,
    pub line: Option<f64>,
    pub column: Option<f64>,
    pub details: Option<Value>,
}

impl RuntimeLogReport {
    pub fn new(source: RuntimeErrorSource, message: impl Into<String>) -> Self {
        Self {
            source,
            message: message.into(),
            stack: None,
            component_stack: None,
            url: None,
            line: None,
            column: None,
            details: None,
        }
    }
    fn value(&self) -> Value {
        json!({"source": self.source.as_str(), "message": self.message, "stack": self.stack,
            "componentStack": self.component_stack, "url": self.url, "line": self.line,
            "column": self.column, "details": self.details})
    }
}

fn bounded(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        let next = units + ch.len_utf16();
        if next > max {
            // Rust strings cannot contain the lone surrogate produced by JS slice.
            let mut out = text[..index].to_owned();
            if units < max {
                out.push('\u{fffd}');
            }
            out.push('…');
            return Some(out);
        }
        units = next;
    }
    Some(text.to_owned())
}

pub fn normalize_runtime_error_report(value: &Value) -> Value {
    let get = |key| value.get(key);
    let mut out = Map::new();
    out.insert(
        "source".into(),
        Value::String(
            RuntimeErrorSource::parse(get("source").and_then(Value::as_str).unwrap_or(""))
                .as_str()
                .into(),
        ),
    );
    out.insert(
        "message".into(),
        Value::String(
            bounded(get("message"), 8192).unwrap_or_else(|| "Unknown runtime error".into()),
        ),
    );
    for (key, limit) in [("stack", 32768), ("componentStack", 32768), ("url", 4096)] {
        if let Some(text) = bounded(get(key), limit) {
            out.insert(key.into(), Value::String(text));
        }
    }
    for key in ["line", "column"] {
        if let Some(number) = get(key).and_then(Value::as_number) {
            out.insert(key.into(), Value::Number(number.clone()));
        }
    }
    let mut details = Map::new();
    let mut insert = |key: String, detail: &Value| {
        let value = match detail {
            Value::Null | Value::Bool(_) | Value::Number(_) => Some(detail.clone()),
            Value::String(_) => bounded(Some(detail), 4096).map(Value::String),
            _ => None,
        };
        if let Some(value) = value {
            details.insert(key, value);
        }
    };
    match get("details") {
        Some(Value::Object(input)) => {
            for (key, value) in input.iter().take(24) {
                insert(key.clone(), value);
            }
        }
        Some(Value::Array(input)) => {
            for (index, value) in input.iter().take(24).enumerate() {
                insert(index.to_string(), value);
            }
        }
        _ => {}
    }
    if !details.is_empty() {
        out.insert("details".into(), Value::Object(details));
    }
    Value::Object(out)
}

fn write_json(out: &mut Vec<u8>, value: &impl serde::Serialize) -> std::io::Result<()> {
    serde_json::to_writer(out, value).map_err(std::io::Error::other)
}

fn write_bounded_json(
    out: &mut Vec<u8>,
    original: Option<&Value>,
    normalized: &Value,
    max: usize,
) -> std::io::Result<()> {
    if let Some(text) = original.and_then(Value::as_str) {
        let mut units = 0;
        for (index, ch) in text.char_indices() {
            let next = units + ch.len_utf16();
            if next > max {
                if units < max {
                    let mut prefix =
                        serde_json::to_string(&text[..index]).map_err(std::io::Error::other)?;
                    prefix.pop();
                    let high = 0xd800 + ((ch as u32 - 0x10000) >> 10);
                    write!(out, "{prefix}\\u{high:04x}…\"")?;
                    return Ok(());
                }
                break;
            }
            units = next;
        }
    }
    write_json(out, normalized)
}

fn write_entry(entry: &Map<String, Value>, report: &Value) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    out.push(b'{');
    for (index, (key, value)) in entry.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        write_json(&mut out, key)?;
        out.push(b':');
        match key.as_str() {
            "message" => write_bounded_json(&mut out, report.get(key), value, 8192)?,
            "stack" | "componentStack" => {
                write_bounded_json(&mut out, report.get(key), value, 32768)?
            }
            "url" => write_bounded_json(&mut out, report.get(key), value, 4096)?,
            "details" => {
                if let Value::Object(details) = value {
                    out.push(b'{');
                    for (index, (name, detail)) in details.iter().enumerate() {
                        if index > 0 {
                            out.push(b',');
                        }
                        write_json(&mut out, name)?;
                        out.push(b':');
                        let original = match report.get("details") {
                            Some(Value::Object(values)) => values.get(name),
                            Some(Value::Array(values)) => {
                                name.parse::<usize>().ok().and_then(|i| values.get(i))
                            }
                            _ => None,
                        };
                        write_bounded_json(&mut out, original, detail, 4096)?;
                    }
                    out.push(b'}');
                } else {
                    write_json(&mut out, value)?;
                }
            }
            _ => write_json(&mut out, value)?,
        }
    }
    out.push(b'}');
    Ok(out)
}

pub struct Writer {
    path: PathBuf,
    context: RuntimeLogContext,
    lock: Mutex<()>,
}

impl Writer {
    pub fn new(path: PathBuf, context: RuntimeLogContext) -> Self {
        Self {
            path,
            context,
            lock: Mutex::new(()),
        }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn write(&self, report: &RuntimeLogReport, window_id: Option<f64>, cwd: Option<&str>) {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self.append(report, window_id, cwd);
    }
    fn append(
        &self,
        report: &RuntimeLogReport,
        window_id: Option<f64>,
        cwd: Option<&str>,
    ) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::metadata(&self.path) {
            Ok(meta) if meta.len() >= MAX_LOG_BYTES => {
                let mut backup = self.path.as_os_str().to_os_string();
                backup.push(".1");
                let backup = PathBuf::from(backup);
                match fs::remove_file(&backup) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
                fs::rename(&self.path, backup)?;
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut entry = Map::new();
        entry.insert(
            "timestamp".into(),
            Value::String(crate::aimemory::value::iso_now()),
        );
        entry.insert("appVersion".into(), json!(self.context.app_version));
        entry.insert("platform".into(), json!(self.context.platform));
        entry.insert("pid".into(), json!(self.context.pid));
        if let Some(id) = window_id.or(self.context.window_id) {
            entry.insert("windowId".into(), json!(id));
        }
        if let Some(cwd) = cwd.or(self.context.cwd.as_deref()) {
            entry.insert("cwd".into(), json!(cwd));
        }
        let original = report.value();
        if let Value::Object(report) = normalize_runtime_error_report(&original) {
            entry.extend(report);
        }
        let mut bytes = write_entry(&entry, &original)?;
        bytes.push(b'\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(&bytes)
    }
}

pub fn tail_log_lines(path: &Path, max_lines: usize, max_bytes: usize) -> Vec<String> {
    fn read(path: &Path, max_lines: usize, max_bytes: usize) -> std::io::Result<Vec<String>> {
        let mut file = File::open(path)?;
        let size = file.metadata()?.len();
        let length = size.min(max_bytes as u64);
        file.seek(SeekFrom::Start(size - length))?;
        let mut bytes = Vec::with_capacity(length as usize);
        file.take(length).read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes);
        let mut lines = text.split('\n');
        if size > length {
            lines.next();
        }
        let lines: Vec<String> = lines
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        let start = if max_lines == 0 {
            0
        } else {
            lines.len().saturating_sub(max_lines)
        };
        Ok(lines[start..].to_vec())
    }
    read(path, max_lines, max_bytes).unwrap_or_default()
}

#[cfg(test)]
#[path = "runtime_log_tests.rs"]
mod tests;
