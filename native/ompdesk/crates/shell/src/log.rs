//! The shell's log: one JSON object per line on stderr (the e2e harness and a developer read it there) and in
//! `<userData>/shell-webview/shell.log.jsonl` once that folder is known. `{"t": <ms since start>, "event": …, …}`.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{Map, Value, json};

static START: OnceLock<Instant> = OnceLock::new();
static FILE: Mutex<Option<File>> = Mutex::new(None);

pub fn start_clock() {
    let _ = START.set(Instant::now());
}

pub fn now_ms() -> u64 {
    START
        .get()
        .map(|s| s.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

/// The log file is cut back to nothing at the start of a launch once it passes this size.
const MAX_BYTES: u64 = 4 << 20;

/// Opens the log file for appending; the lines logged so far are not repeated there. Appending, not truncating: a second
/// launch of the same profile (it hands its arguments to the first and exits) must not wipe the running shell's log.
pub fn open_file(path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(path) {
        *FILE.lock().unwrap() = Some(file);
    }
}

pub fn log(event: &str, fields: Value) {
    let mut object = Map::new();
    object.insert("t".into(), json!(now_ms()));
    object.insert("event".into(), json!(event));
    match fields {
        Value::Object(map) => object.extend(map),
        Value::Null => {}
        other => {
            object.insert("value".into(), other);
        }
    }
    let line = Value::Object(object).to_string();
    // A GUI-subsystem process started without a console has no valid stderr: a failed write is nothing to report.
    let _ = writeln!(std::io::stderr(), "[shell] {line}");
    if let Some(file) = FILE.lock().unwrap().as_mut() {
        let _ = writeln!(file, "{line}");
    }
}
