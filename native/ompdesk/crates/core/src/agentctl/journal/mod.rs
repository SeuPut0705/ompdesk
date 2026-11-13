//! The files the agent-control service keeps across launches (9g; was `call-journal.ts`, `send-outbox.ts`,
//! `mail-outbox.ts`, `session-fates.ts` and `pending-cleanups.ts` in `src/main/agent-control/`). Built, not yet called:
//! the TypeScript service still uses its own copies until the service cutover.
//!
//! Every file is a JSON array in `<userData>`, written the way the TypeScript wrote it: one
//! `writeFileAtomicSync`/`writeFileAtomicDeferred` (here `disk::tree::write_atomic_if`: a sibling temp file renamed
//! over the target, tried again on Windows while the target is held), mode 0o600 where the TypeScript pinned one, with
//! the keys of every object in the order the TypeScript's object literals gave them (`serde_json`'s `preserve_order`),
//! numbers spelled as `JSON.stringify` spells them (`js_number`).
//!
//! Seams the service passes in (each module's header names its own):
//! - the clock, `Clock` (`Date.now`), so a test fixes the time;
//! - the receiver's omp and the tab pool, as the traits `send_outbox::OwedDeps` and `mail_outbox::RedeliverDeps`.
//!
//! Differences from the TypeScript, shared by every module here:
//! - `session_fates` and `pending_cleanups` wrote with `writeFileAtomicDeferred` (one attempt at once, a refused rename
//!   retried on a timer, a newer write calling the older off). Here the write is one blocking `write_atomic_if`
//!   (the retries sleep in the caller, only on Windows), so there is nothing to call off and writes land in order.
//! - A file with a lone UTF-16 surrogate escape (`"\ud800"`) is unreadable to `serde_json`; `JSON.parse` takes it.
//!   Such a file reads as damaged (nothing recorded). No writer here produces one.
//! - A number that `JSON.stringify` prints with an exponent (`1e+21`) prints as `1e21`.

pub mod attachments;
pub mod call_journal;
pub mod mail_outbox;
pub mod pending_cleanups;
pub mod send_outbox;
pub mod session_fates;

use std::path::Path;
use std::sync::{Arc, LazyLock};

use serde_json::{Map, Value};

/// `Date.now()`, injectable: epoch milliseconds.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// The wall clock (`Date.now`).
pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
    })
}

/// Three days: how long a record the host never took may wait (`3 * 24 * 60 * 60_000`).
pub const THREE_DAYS_MS: f64 = 3.0 * 24.0 * 60.0 * 60_000.0;

/// A number as `JSON.stringify` prints it: a whole number has no fraction digits.
pub(crate) fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);

/// `typeof value === "object" && value !== null`, read as a record: an array is such an object with none of the
/// named fields.
pub(crate) fn object(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(map) => Some(map),
        Value::Array(_) => Some(&EMPTY),
        _ => None,
    }
}

pub(crate) fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

pub(crate) fn number(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

/// The strings of an array field (`filter(x => typeof x === "string")`); None when the field is no array.
pub(crate) fn strings(map: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    match map.get(key)? {
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect(),
        ),
        _ => None,
    }
}

/// The items of the JSON array a file holds; nothing when it is missing, damaged or no array.
pub(crate) fn read_array(file: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// `writeFileAtomicSync(file, text, { mode })`.
pub(crate) fn write_text(file: &Path, text: &str, mode: Option<u32>) -> Result<(), String> {
    crate::disk::saves::write_kept(file, text.as_bytes(), mode, 0o777)
        .map(|_| ())
        .map_err(|fault| fault.message)
}

/// `JSON.stringify(items)`.
pub(crate) fn stringify(items: Vec<Value>) -> String {
    Value::Array(items).to_string()
}

#[cfg(test)]
mod tests;
