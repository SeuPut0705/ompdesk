//! `<userData>/shell-started.json`: the proof a launch of the shell got as far as a working app. The installer's swap
//! reads it: a moved install whose new shell never writes it gets the previous Electron back.
//!
//! Written once, atomically, when both happened: Node answered the handshake (`app.init`) and the first app window's
//! page finished loading. Never earlier, so a shell that starts but shows no page leaves no marker.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::json;

pub const FILE_NAME: &str = "shell-started.json";

/// Test seam: the shell exits 1 right after CEF initialised, without a marker (stands in for any start failure).
pub const FAIL_START_ENV: &str = "OMP_GUI_TEST_SHELL_FAIL_START";

/// What the marker waits for; each `note_*` answers true exactly once, when it completes the pair.
#[derive(Debug, Default)]
pub struct Gate {
    node_ready: bool,
    page_loaded: bool,
    fired: bool,
}

impl Gate {
    pub fn note_node_ready(&mut self) -> bool {
        self.node_ready = true;
        self.complete()
    }

    pub fn note_page_loaded(&mut self) -> bool {
        self.page_loaded = true;
        self.complete()
    }

    fn complete(&mut self) -> bool {
        if self.node_ready && self.page_loaded && !self.fired {
            self.fired = true;
            return true;
        }
        false
    }
}

/// The app's version: `"version"` of its `package.json`, as `app.getVersion()` reports it.
pub fn version_from_package_json(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value
        .get("version")?
        .as_str()
        .filter(|v| !v.is_empty())
        .map(String::from)
}

/// `{"version", "pid", "at"}` (`at`: epoch milliseconds) through a temp file and a rename, so a reader sees the whole
/// marker or none.
pub fn write(user_data: &Path, version: &str, pid: u32, at_ms: u64) -> io::Result<PathBuf> {
    let target = user_data.join(FILE_NAME);
    let temp = user_data.join(format!("{FILE_NAME}.{pid}.tmp"));
    let body = json!({ "version": version, "pid": pid, "at": at_ms }).to_string();
    std::fs::write(&temp, body)?;
    if let Err(error) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-marker-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_marker_waits_for_both_and_fires_once() {
        let mut gate = Gate::default();
        assert!(!gate.note_node_ready(), "Node alone is not enough");
        assert!(gate.note_page_loaded());
        assert!(
            !gate.note_page_loaded(),
            "a later page load does not write again"
        );
        assert!(!gate.note_node_ready());

        let mut other = Gate::default();
        assert!(!other.note_page_loaded(), "a page alone is not enough");
        assert!(other.note_node_ready());
    }

    #[test]
    fn the_marker_is_written_whole_with_its_three_fields_and_replaces_an_older_one() {
        let dir = temp_dir("write");
        std::fs::write(dir.join(FILE_NAME), "{\"version\":\"0.0.1\"}").unwrap();
        let path = write(&dir, "0.128.0", 4242, 1_700_000_000_123).unwrap();
        assert_eq!(path, dir.join(FILE_NAME));
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "version": "0.128.0", "pid": 4242, "at": 1_700_000_000_123u64 })
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            leftovers,
            vec![FILE_NAME.to_string()],
            "no temp file stays behind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_written_into_a_missing_folder() {
        let dir = std::env::temp_dir().join("ompdesk-marker-missing-folder");
        assert!(write(&dir.join("nope"), "1.0.0", 1, 1).is_err());
    }

    #[test]
    fn the_version_comes_from_package_json() {
        assert_eq!(
            version_from_package_json(r#"{"name":"ompdesk","version":"0.128.0"}"#).as_deref(),
            Some("0.128.0")
        );
        assert_eq!(version_from_package_json(r#"{"name":"x"}"#), None);
        assert_eq!(version_from_package_json(r#"{"version":""}"#), None);
        assert_eq!(version_from_package_json("not json"), None);
    }
}
