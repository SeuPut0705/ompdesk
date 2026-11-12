//! What the pool knows about a tab (`ResumeFact`), the marker file's rows (`ResumeMarker`) and the pure rules over
//! them (`deriveMarkers`, `launchAction`, `openedRunning`, `restoreSummary`; were in `src/main/turn-resume.ts`).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A run's final outcome, with the id the TypeScript client gave the object: a rule that compared outcomes by
/// identity (judged once, the failure a hold is for) compares ids.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub id: u64,
    pub stop_reason: String,
    #[serde(default)]
    pub error_message: Option<String>,
}

/// Stock's auto-retry saga waiting for its next attempt: one object per `auto_retry_start`, so one id.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetryRef {
    pub id: u64,
    pub error_message: String,
}

/// What the pool knows about one tab, the only input of the marker rules.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Fact {
    pub tab_id: String,
    pub win_id: i64,
    pub device: Option<String>,
    pub peer: Option<String>,
    pub session_file: Option<String>,
    pub cwd: String,
    pub kind: String,
    pub running: bool,
    pub settling: bool,
    pub stopped: bool,
    pub awaiting_ui: bool,
    pub awaiting_connection: bool,
    pub last_run: Option<RunOutcome>,
    pub retry: Option<RetryRef>,
    pub touched: Option<i64>,
    pub prompted: Option<i64>,
    pub unsaved_prompt: Option<String>,
    pub exits: Option<i64>,
    pub opened_by: Option<String>,
    pub opened_by_session: Option<String>,
    /// `limitHeldElsewhere(tab) === true`, read by main for the tabs that have a run's outcome.
    pub limit_held: bool,
}

/// JavaScript truthiness of an optional string.
pub fn truthy(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.is_empty())
}

impl Fact {
    pub fn touched(&self) -> i64 {
        self.touched.unwrap_or(0)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Running,
    Asking,
    Network,
    Limit,
}

/// One row of the marker file. Field order is the order the TypeScript built the object in, which the file's text
/// (`JSON.stringify`) keeps.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarkerData {
    pub window: i64,
    pub tab: String,
    pub session_path: String,
    pub cwd: String,
    pub kind: String,
    pub started_at: f64,
    pub reason: Reason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Restore,
    Retry,
    Revive,
}

impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Action::Restore => "restore",
            Action::Retry => "retry",
            Action::Revive => "revive",
        }
    }
}

/// Which tabs are worth resuming and why. A tab the user stopped is never one; a turn blocked on a person is kept (as
/// "asking") so it reopens its card, a turn waiting for the connection is kept so a crash during the wait still
/// resumes, and so is one waiting for a provider's limit (`limited`). `startedAt` survives a reason change within
/// one run.
pub fn derive_markers(
    facts: &[Fact],
    previous: &[MarkerData],
    now: f64,
    limited: &HashSet<String>,
) -> Vec<MarkerData> {
    let mut markers = Vec::new();
    for fact in facts {
        let Some(session_file) = fact.session_file.as_ref().filter(|file| !file.is_empty()) else {
            continue;
        };
        let reason = if fact.awaiting_connection {
            Some(Reason::Network)
        } else if fact.stopped {
            None
        } else if fact.awaiting_ui {
            Some(Reason::Asking)
        } else if fact.running {
            Some(Reason::Running)
        } else if limited.contains(&fact.tab_id) {
            Some(Reason::Limit)
        } else {
            None
        };
        let Some(reason) = reason else { continue };
        let before = previous
            .iter()
            .find(|marker| marker.tab == fact.tab_id && &marker.session_path == session_file);
        markers.push(MarkerData {
            window: fact.win_id,
            tab: fact.tab_id.clone(),
            session_path: session_file.clone(),
            cwd: fact.cwd.clone(),
            kind: fact.kind.clone(),
            started_at: before.map_or(now, |marker| marker.started_at),
            reason,
            peer: truthy(&fact.peer).then(|| fact.peer.clone().unwrap_or_default()),
            prompt: truthy(&fact.unsaved_prompt)
                .then(|| fact.unsaved_prompt.clone().unwrap_or_default()),
            background: fact.settling && reason != Reason::Network,
        });
    }
    markers
}

/// What a launch does with a marker: a turn that waited for the connection or a limit had failed, so stock retries it.
pub fn launch_action(marker: &MarkerData) -> Action {
    if matches!(marker.reason, Reason::Network | Reason::Limit) {
        Action::Retry
    } else if marker.background {
        Action::Revive
    } else {
        Action::Restore
    }
}

/// Sessions this tab's agent opened that run now (they continue on their own marker): the resume's log says how many
/// stand beside the tab it continues.
pub fn opened_running(facts: &[Fact], tab_id: &str) -> usize {
    let file = facts
        .iter()
        .find(|fact| fact.tab_id == tab_id)
        .and_then(|fact| fact.session_file.as_deref());
    facts
        .iter()
        .filter(|fact| {
            fact.running
                && (fact.opened_by.as_deref() == Some(tab_id)
                    || (file.is_some() && fact.opened_by_session.as_deref() == file))
        })
        .count()
}

/// What stock's `restore_interrupted` found, in a word: the cut-off turn, what it revived or named stopped, or nothing.
pub fn restore_summary(data: Option<&Map<String, Value>>) -> String {
    let Some(data) = data else {
        return "failed".to_owned();
    };
    if data.get("turn") == Some(&Value::Bool(true)) {
        return "turn".to_owned();
    }
    let mut parts: Vec<String> = ["subagents", "jobs", "stopped"]
        .iter()
        .filter_map(|key| match data.get(*key) {
            Some(Value::Array(items)) if !items.is_empty() => {
                Some(format!("{key}:{}", items.len()))
            }
            _ => None,
        })
        .collect();
    // A turn stock could not retry (a note came after its aborted reply), continued by the bridge's follow-up.
    if data.get("turnCut") == Some(&Value::Bool(true)) {
        parts.insert(0, "turn-behind-notes".to_owned());
    }
    if parts.is_empty() {
        "nothing".to_owned()
    } else {
        parts.join(",")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fact(patch: Value) -> Fact {
        let mut base = json!({
            "tabId": "t1", "winId": 1, "cwd": "/work", "kind": "agent", "sessionFile": "/s/a.jsonl",
            "running": false, "stopped": false, "awaitingUi": false, "awaitingConnection": false
        });
        for (key, value) in patch.as_object().expect("object") {
            base[key] = value.clone();
        }
        serde_json::from_value(base).expect("fact")
    }

    fn reasons(facts: &[Fact], previous: &[MarkerData], limited: &[&str]) -> Vec<Reason> {
        let limited = limited.iter().map(|tab| (*tab).to_owned()).collect();
        derive_markers(facts, previous, 500.0, &limited)
            .iter()
            .map(|marker| marker.reason)
            .collect()
    }

    // The cases of `src/main/turn-resume.test.ts` "deriveMarkers", row for row.
    #[test]
    fn marks_a_running_turn_with_its_window_tab_session_and_start_time() {
        let markers = derive_markers(
            &[fact(json!({"running": true}))],
            &[],
            500.0,
            &HashSet::new(),
        );
        assert_eq!(
            serde_json::to_string(&markers).expect("json"),
            r#"[{"window":1,"tab":"t1","sessionPath":"/s/a.jsonl","cwd":"/work","kind":"agent","startedAt":500.0,"reason":"running"}]"#
        );
    }

    #[test]
    fn keeps_the_original_start_time_while_the_same_run_continues() {
        let first = derive_markers(
            &[fact(json!({"running": true}))],
            &[],
            500.0,
            &HashSet::new(),
        );
        let again = derive_markers(
            &[fact(json!({"running": true}))],
            &first,
            900.0,
            &HashSet::new(),
        );
        assert_eq!(again[0].started_at, 500.0);
    }

    #[test]
    fn a_stop_a_finished_turn_and_a_missing_file_leave_no_marker() {
        let tab = |patch: Value| fact(patch);
        assert!(reasons(&[tab(json!({"running": false}))], &[], &[]).is_empty());
        assert!(reasons(&[tab(json!({"running": true, "stopped": true}))], &[], &[]).is_empty());
        assert!(
            reasons(
                &[tab(json!({"running": true, "sessionFile": null}))],
                &[],
                &[]
            )
            .is_empty()
        );
        assert!(
            reasons(
                &[tab(json!({"running": true, "sessionFile": ""}))],
                &[],
                &[]
            )
            .is_empty()
        );
    }

    #[test]
    fn asking_network_and_limit_are_kept_with_the_precedence_the_typescript_had() {
        assert_eq!(
            reasons(
                &[fact(json!({"running": true, "awaitingUi": true}))],
                &[],
                &[]
            ),
            [Reason::Asking]
        );
        assert_eq!(
            reasons(&[fact(json!({"awaitingConnection": true}))], &[], &[]),
            [Reason::Network]
        );
        assert_eq!(reasons(&[fact(json!({}))], &[], &["t1"]), [Reason::Limit]);
        assert_eq!(
            reasons(&[fact(json!({"running": true}))], &[], &["t1"]),
            [Reason::Running]
        );
        assert!(reasons(&[fact(json!({"stopped": true}))], &[], &["t1"]).is_empty());
        assert!(reasons(&[fact(json!({}))], &[], &["other"]).is_empty());
    }

    #[test]
    fn records_the_peer_and_the_background_work_that_kept_the_run_on() {
        let markers = derive_markers(
            &[fact(
                json!({"running": true, "peer": "device-a", "settling": true}),
            )],
            &[],
            500.0,
            &HashSet::new(),
        );
        assert_eq!(markers[0].peer.as_deref(), Some("device-a"));
        assert!(markers[0].background);
        // A failed turn waiting for the connection is retried, background work or not.
        let waiting = derive_markers(
            &[fact(json!({"settling": true, "awaitingConnection": true}))],
            &[],
            500.0,
            &HashSet::new(),
        );
        assert!(!waiting[0].background);
        let plain = derive_markers(
            &[fact(json!({"running": true}))],
            &[],
            500.0,
            &HashSet::new(),
        );
        assert!(
            !serde_json::to_string(&plain)
                .expect("json")
                .contains("background")
        );
    }

    #[test]
    fn launch_actions() {
        let marker = |reason: Reason, background: bool| MarkerData {
            window: 1,
            tab: "old".into(),
            session_path: "/s/a.jsonl".into(),
            cwd: "/work".into(),
            kind: "agent".into(),
            started_at: 100.0,
            reason,
            peer: None,
            prompt: None,
            background,
        };
        assert_eq!(
            launch_action(&marker(Reason::Running, false)),
            Action::Restore
        );
        assert_eq!(
            launch_action(&marker(Reason::Network, false)),
            Action::Retry
        );
        assert_eq!(launch_action(&marker(Reason::Limit, false)), Action::Retry);
        assert_eq!(
            launch_action(&marker(Reason::Asking, false)),
            Action::Restore
        );
        assert_eq!(
            launch_action(&marker(Reason::Running, true)),
            Action::Revive
        );
    }

    #[test]
    fn restore_summaries() {
        let summary = |value: Value| restore_summary(value.as_object());
        assert_eq!(restore_summary(None), "failed");
        assert_eq!(summary(json!({"turn": true, "subagents": [1]})), "turn");
        assert_eq!(
            summary(json!({"subagents": [1, 2], "jobs": [1], "stopped": []})),
            "subagents:2,jobs:1"
        );
        assert_eq!(
            summary(json!({"turnCut": true, "jobs": [1]})),
            "turn-behind-notes,jobs:1"
        );
        assert_eq!(summary(json!({})), "nothing");
    }

    #[test]
    fn counts_the_sessions_a_tab_opened_that_run() {
        let facts = [
            fact(json!({"tabId": "a"})),
            fact(json!({"tabId": "b", "running": true, "openedBy": "a"})),
            fact(json!({"tabId": "c", "running": true, "openedBySession": "/s/a.jsonl"})),
            fact(json!({"tabId": "d", "running": false, "openedBy": "a"})),
        ];
        assert_eq!(opened_running(&facts, "a"), 2);
        assert_eq!(opened_running(&facts, "zzz"), 0);
    }
}
