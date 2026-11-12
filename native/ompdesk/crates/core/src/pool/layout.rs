//! A saved tab layout read back (was `src/main/tab-layout.ts`'s `sanitizePersistedTabLayout(s)`; unit 9e): what a
//! window's tabs come back as at launch, and a paired device's window's (`web/web-tab-layouts.ts`). A hub instance of
//! kind `layout`, which holds nothing: each call checks one value.
//!
//! The folder, session file and content checks are the core's own reads (`Disk`), or, when main's caller handed its
//! own checks (tests), questions to main (`Asked`). Whether a session was deleted is main's (`deleted-sessions.ts`),
//! always asked.

use std::collections::HashSet;
use std::io::Read;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use super::split::{
    SplitNode, as_split_layout, map_split_leaves, read_remembered_splits, read_split_node,
    split_tab_ids,
};
use crate::fs::order::js_trim;
use crate::hub::{self, Kind, Out, Outcome};
use crate::json::utf16_prefix;
use crate::server::Fault;

pub const KIND: Kind = Kind {
    name: "layout",
    open,
    call,
    close,
};

const TAB_LAYOUT_VERSION: f64 = 1.0;
/// A persisted title is display data only: bound so prefs cannot grow.
const MAX_PERSISTED_TITLE: usize = 120;
const MAX_FORMER_TAB_IDS: usize = 8;
/// A session file larger than this counts as having content without being read.
const CONTENT_READ_LIMIT: u64 = 128 * 1024;

thread_local! {
    static OUTS: std::cell::RefCell<std::collections::HashMap<u64, Out>> = std::cell::RefCell::default();
}

fn open(id: u64, _opts: &RawValue, out: Out) -> Result<(), Fault> {
    OUTS.with(|outs| outs.borrow_mut().insert(id, out));
    Ok(())
}

fn close(id: u64) {
    OUTS.with(|outs| outs.borrow_mut().remove(&id));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SanitizeParams {
    value: Value,
    /// Main's caller handed its own path checks: each one is asked.
    #[serde(default)]
    asked: bool,
    /// The value may be an array of layouts (`sanitizePersistedTabLayouts`).
    #[serde(default)]
    many: bool,
}

#[derive(Serialize, Debug, PartialEq)]
struct Drop {
    reason: &'static str,
    cwd: String,
    #[serde(rename = "sessionPath", skip_serializing_if = "Option::is_none")]
    session_path: Option<String>,
}

#[derive(Serialize)]
struct Sanitized {
    /// One layout (or null), or with `many` every kept one.
    layout: Value,
    drops: Vec<Drop>,
}

fn call(id: u64, method: &str, params: &RawValue) -> Outcome {
    if method != "sanitize" {
        return Outcome::fault("no_method", method.to_string());
    }
    let params: SanitizeParams = match hub::params(params) {
        Ok(params) => params,
        Err(fault) => return Outcome::Now(Err(fault)),
    };
    let Some(out) = OUTS.with(|outs| outs.borrow().get(&id).copied()) else {
        return Outcome::fault("no_instance", format!("No instance {id}"));
    };
    Outcome::Later(Box::pin(async move {
        let checks = Checks {
            out,
            asked: params.asked,
        };
        let mut drops = Vec::new();
        let layout = if params.many {
            let candidates = match &params.value {
                Value::Array(items) => items.clone(),
                other => vec![other.clone()],
            };
            let mut kept = Vec::new();
            for candidate in &candidates {
                if let Some(layout) = sanitize(candidate, &checks, &mut drops).await? {
                    kept.push(layout);
                }
            }
            Value::Array(kept)
        } else {
            sanitize(&params.value, &checks, &mut drops)
                .await?
                .unwrap_or(Value::Null)
        };
        hub::to_value(&Sanitized { layout, drops })
    }))
}

/// Where the path checks are answered.
struct Checks {
    out: Out,
    asked: bool,
}

impl Checks {
    async fn ask_bool(&self, q: &str, payload: Value) -> Result<bool, Fault> {
        Ok(self.out.ask(q, &payload).await?.as_bool().unwrap_or(false))
    }

    async fn directory_exists(&self, path: &str) -> Result<bool, Fault> {
        if self.asked {
            return self
                .ask_bool("directoryExists", json!({"path": path}))
                .await;
        }
        Ok(std::fs::metadata(path).is_ok_and(|meta| meta.is_dir()))
    }

    async fn file_exists(&self, path: &str) -> Result<bool, Fault> {
        if self.asked {
            return self.ask_bool("fileExists", json!({"path": path})).await;
        }
        Ok(std::fs::metadata(path).is_ok_and(|meta| meta.is_file()))
    }

    /// `None`: the caller's checks have no content probe (the TypeScript's optional `sessionHasContent`).
    async fn session_has_content(&self, path: &str) -> Result<Option<bool>, Fault> {
        if self.asked {
            let answer = self
                .out
                .ask("sessionHasContent", &json!({"path": path}))
                .await?;
            return Ok(answer.as_bool());
        }
        Ok(Some(disk_session_has_content(path)))
    }

    async fn deleted(&self, path: &str, device: Option<&str>) -> Result<bool, Fault> {
        self.ask_bool("deleted", json!({"path": path, "device": device}))
            .await
    }
}

/// Whether a session file holds a message: empty sessions are small, so a large one counts without being read; a line
/// that is no JSON is no evidence it is empty, nor is a file that cannot be read.
fn disk_session_has_content(path: &str) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return true;
    };
    if meta.len() > CONTENT_READ_LIMIT {
        return true;
    }
    let mut bytes = Vec::new();
    if std::fs::File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .is_err()
    {
        return true;
    }
    has_message(&String::from_utf8_lossy(&bytes))
}

fn has_message(text: &str) -> bool {
    for line in text.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&crate::json::whole_surrogates(line)) {
            Ok(value) => {
                if value.get("type").and_then(Value::as_str) == Some("message") {
                    return true;
                }
            }
            Err(_) => return true,
        }
    }
    false
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!js_trim(text).is_empty()).then(|| text.to_string())
}

/// The ids an earlier launch gave a tab: `/^[\w:-]{1,64}$/`.
fn former_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'_' || byte == b':' || byte == b'-'
        })
}

/// A worktree binding saved before `path` existed is dropped: the tab's saved cwd follows session switches, so it
/// cannot stand in for the checkout the close prompt would remove with `--force`. The worktree itself stays on disk.
fn parse_worktree(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let name = non_empty_string(object.get("name"))?;
    let branch = non_empty_string(object.get("branch"))?;
    let base_cwd = non_empty_string(object.get("baseCwd"))?;
    let path = non_empty_string(object.get("path"))?;
    Some(json!({"name": name, "branch": branch, "baseCwd": base_cwd, "path": path}))
}

/// `sanitizePersistedTabLayout`: the layout stored at launch, validated before it reaches a sidecar. Missing folders
/// are dropped; a deleted session's tab is dropped; a session file missing without a tombstone becomes a fresh tab in
/// its folder. A remote descriptor (`device`) skips both disk checks: its paths live on the host.
async fn sanitize(
    value: &Value,
    checks: &Checks,
    drops: &mut Vec<Drop>,
) -> Result<Option<Value>, Fault> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    if object.get("version").and_then(Value::as_f64) != Some(TAB_LAYOUT_VERSION) {
        return Ok(None);
    }
    let Some(tabs) = object.get("tabs").and_then(Value::as_array) else {
        return Ok(None);
    };
    let requested_active = object
        .get("activeIndex")
        .and_then(Value::as_f64)
        .filter(|index| index.fract() == 0.0 && *index >= 0.0)
        .unwrap_or(0.0);
    let mut retained: Vec<(Map<String, Value>, usize)> = Vec::new();
    let mut session_keys: HashSet<String> = HashSet::new();

    for (source_index, candidate) in tabs.iter().enumerate() {
        let Some(candidate) = candidate.as_object() else {
            continue;
        };
        let cwd = non_empty_string(candidate.get("cwd"));
        let kind = candidate
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| *kind == "agent" || *kind == "chat");
        let device = non_empty_string(candidate.get("device"));
        let (Some(cwd), Some(kind)) = (cwd, kind) else {
            continue;
        };
        let stored = non_empty_string(candidate.get("sessionPath"));
        let drop = |reason: &'static str| Drop {
            reason,
            cwd: cwd.clone(),
            session_path: stored.clone(),
        };
        if device.is_none() && !checks.directory_exists(&cwd).await? {
            drops.push(drop("folder"));
            continue;
        }
        // A deleted session's tab is gone with it: never a fresh tab in its folder, which is kept only for a file that
        // is missing without having been deleted (a session never written).
        if let Some(stored) = &stored
            && checks.deleted(stored, device.as_deref()).await?
        {
            drops.push(drop("deleted"));
            continue;
        }
        let session_path = match &stored {
            Some(stored) if device.is_some() || checks.file_exists(stored).await? => {
                Some(stored.clone())
            }
            _ => None,
        };
        if stored.is_some() && session_path.is_none() {
            drops.push(drop("fresh"));
        }
        // The same path on two machines is two files (F-OWN keys device + path too).
        if let Some(path) = &session_path {
            let key = format!("{}\u{0}{path}", device.as_deref().unwrap_or(""));
            if !session_keys.insert(key) {
                drops.push(drop("duplicate"));
                continue;
            }
        }

        let mut descriptor = Map::new();
        descriptor.insert("cwd".into(), Value::from(cwd.clone()));
        descriptor.insert("kind".into(), Value::from(kind));
        if let Some(path) = &session_path {
            descriptor.insert("sessionPath".into(), Value::from(path.clone()));
        }
        if let Some(device) = &device {
            descriptor.insert("device".into(), Value::from(device.clone()));
        }
        if let Some(worktree) = parse_worktree(candidate.get("worktree")) {
            descriptor.insert("worktree".into(), worktree);
        }
        let legacy_empty_startup_chat = !candidate.contains_key("placeholder")
            && source_index == 0
            && kind == "chat"
            && device.is_none()
            && match &session_path {
                None => true,
                Some(path) => checks.session_has_content(path).await? == Some(false),
            };
        if candidate.get("placeholder") == Some(&Value::Bool(true)) || legacy_empty_startup_chat {
            descriptor.insert("placeholder".into(), Value::Bool(true));
        }
        if let Some(title) = non_empty_string(candidate.get("title")) {
            descriptor.insert(
                "title".into(),
                Value::from(utf16_prefix(&title, MAX_PERSISTED_TITLE)),
            );
        }
        // A path is only a key to match against another tab's session file; it is never opened from here.
        if let Some(opened_by) = non_empty_string(candidate.get("openedBy"))
            && Some(&opened_by) != session_path.as_ref()
        {
            descriptor.insert("openedBy".into(), Value::from(opened_by));
        }
        let former: Vec<Value> = candidate
            .get("formerIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .filter(|id| former_id(id))
                    .take(MAX_FORMER_TAB_IDS)
                    .map(Value::from)
                    .collect()
            })
            .unwrap_or_default();
        if !former.is_empty() {
            descriptor.insert("formerIds".into(), Value::Array(former));
        }
        retained.push((descriptor, source_index));
    }

    // Startup placeholders are disposable. Never restore the legacy empty startup chat after Work mode became the
    // default full-agent surface.
    let effective: Vec<&(Map<String, Value>, usize)> = retained
        .iter()
        .filter(|(descriptor, _)| descriptor.get("placeholder") != Some(&Value::Bool(true)))
        .collect();
    if effective.is_empty() {
        return Ok(None);
    }
    let index_of_source = |source: f64| {
        effective
            .iter()
            .position(|(_, index)| *index as f64 == source)
    };
    let mut active_index = index_of_source(requested_active)
        .or_else(|| {
            effective
                .iter()
                .position(|(_, index)| *index as f64 > requested_active)
        })
        .unwrap_or(effective.len() - 1);

    let mut split: Option<Value> = None;
    if let Some(raw) = object.get("split").and_then(Value::as_object) {
        let migrated = if raw.contains_key("firstIndex") && raw.contains_key("secondIndex") {
            json!({
                "axis": raw.get("axis"),
                "ratio": raw.get("ratio"),
                "first": {"tabId": js_string(raw.get("firstIndex"))},
                "second": {"tabId": js_string(raw.get("secondIndex"))},
            })
        } else {
            Value::Object(raw.clone())
        };
        if let Some(parsed) = read_split_node(&migrated, 0) {
            let layout = as_split_layout(map_split_leaves(&parsed, &mut |source| {
                index_of_source(js_number(source)).map(|index| SplitNode::Leaf(index.to_string()))
            }));
            if let Some(layout) = &layout {
                let ids = layout.tab_ids();
                if !ids.contains(&active_index.to_string())
                    && let Some(first) = ids.first()
                {
                    active_index = first.parse().unwrap_or(active_index);
                }
            }
            split = layout.map(|layout| layout.to_value());
        }
    }
    // What is on screen (the visible split, else the active tab alone) is not also remembered.
    let mut claimed: HashSet<String> = match &split {
        Some(value) => read_split_node(value, 0)
            .map(|node| split_tab_ids(&node))
            .unwrap_or_default()
            .into_iter()
            .collect(),
        None => [active_index.to_string()].into_iter().collect(),
    };
    let splits = read_remembered_splits(
        object.get("splits").unwrap_or(&Value::Null),
        &mut |source| index_of_source(js_number(source)).map(|index| index.to_string()),
        &mut claimed,
    );

    let mut layout = Map::new();
    layout.insert("version".into(), Value::from(1));
    layout.insert(
        "tabs".into(),
        Value::Array(
            effective
                .iter()
                .map(|(descriptor, _)| Value::Object(descriptor.clone()))
                .collect(),
        ),
    );
    layout.insert("activeIndex".into(), Value::from(active_index));
    if let Some(split) = split {
        layout.insert("split".into(), split);
    }
    if !splits.is_empty() {
        layout.insert(
            "splits".into(),
            Value::Array(splits.iter().map(|split| split.to_value()).collect()),
        );
    }
    Ok(Some(Value::Object(layout)))
}

/// `String(value)` for what a legacy split stored as an index (a number, or anything else).
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{float:.0}"),
            _ => number.to_string(),
        },
        Some(other) => other.to_string(),
    }
}

/// `Number(text)` for a stored leaf: an index, or NaN (which no index equals).
fn js_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_session_content_as_the_typescript_did() {
        assert!(!has_message(""));
        assert!(!has_message("\n  \n"));
        assert!(!has_message("{\"type\":\"session\"}\n"));
        assert!(has_message(
            "{\"type\":\"session\"}\n{\"type\":\"message\"}"
        ));
        assert!(has_message("not json"));
        assert!(!has_message("{\"type\":\"session\",\"x\":\"\\ud800\"}"));
    }

    #[test]
    fn keeps_former_ids_as_the_pattern_did() {
        assert!(former_id("abc:1-_"));
        assert!(!former_id(""));
        assert!(!former_id(&"a".repeat(65)));
        assert!(!former_id("a b"));
        assert!(!former_id("é"));
    }

    #[test]
    fn reads_a_legacy_index_as_javascript_spells_it() {
        assert_eq!(js_string(Some(&json!(1))), "1");
        assert_eq!(js_string(Some(&json!(1.0))), "1");
        assert_eq!(js_string(Some(&json!("2"))), "2");
        assert_eq!(js_number(" 2 "), 2.0);
        assert_eq!(js_number(""), 0.0);
        assert!(js_number("x").is_nan());
    }
}
