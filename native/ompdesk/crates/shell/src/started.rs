//! The shell's side of `marker.rs`: remembers the user-data folder and version, and writes the marker once Node has said
//! `app.init` and the first app window's page has loaded.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use shell_core::marker::{self, Gate};

use crate::log::log;

struct State {
    user_data: PathBuf,
    version: String,
    gate: Gate,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// At startup, before Node runs: `version` is the app's (its `package.json`'s).
pub fn init(user_data: PathBuf, version: String) {
    *STATE.lock().unwrap() = Some(State {
        user_data,
        version,
        gate: Gate::default(),
    });
}

/// Node's `app.init` arrived.
pub fn node_ready() {
    complete(Gate::note_node_ready);
}

/// A main frame of an app window finished loading.
pub fn page_loaded() {
    complete(Gate::note_page_loaded);
}

fn complete(note: fn(&mut Gate) -> bool) {
    let mut guard = STATE.lock().unwrap();
    let Some(state) = guard.as_mut() else { return };
    if !note(&mut state.gate) {
        return;
    }
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    match marker::write(&state.user_data, &state.version, std::process::id(), at) {
        Ok(path) => log(
            "started.marker",
            json!({ "file": path.display().to_string(), "version": state.version }),
        ),
        Err(error) => log(
            "started.marker_failed",
            json!({ "error": error.to_string() }),
        ),
    }
}
