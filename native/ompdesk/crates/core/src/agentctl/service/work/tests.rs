//! Tests of the work tools against a fake main (what `service.test.ts` asks of compare, merge, schedule, Autopilot, the
//! review board, family edits, auto-close and the app tools; the full run of that file against the real core is the
//! parity suite at cutover) and of the pure cuts (`turnEdits`, `costSplitOf`, the command timeouts) against tables
//! captured from the TypeScript (`captured.json`).

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::host::{Caps, HostState};
use super::super::tuning::Tuning;
use super::super::{AgentControl, Files};
use super::command_timeout;
use super::review::{cost_split_of, turn_edits};
use crate::agentctl::journal::system_clock;
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

/// A control over a fake main: `reply` answers every ask; what was asked and told is kept in order.
fn rig(
    id: u64,
    state: Value,
    caps: Caps,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _task) = crate::wire::spawn_writer(writer);
    let events = crate::server::test_events(&tx);
    std::mem::forget(tx);
    let port =
        Port::<HostState>::open(&events, id, serde_json::from_value(state).unwrap()).unwrap();
    let asked: Asked = Arc::default();
    let record = asked.clone();
    let answers = port.clone();
    let mut lines = BufReader::new(reader).lines();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let event: Value = serde_json::from_str(&line).unwrap();
            let data = &event["data"];
            let method = data["method"].as_str().unwrap_or("").to_owned();
            let args = data["args"].clone();
            record.lock().unwrap().push((method.clone(), args.clone()));
            if let Some(ask) = data["ask"].as_u64() {
                match reply(&method, &args) {
                    Ok(value) => crate::ports::apply_answer(&answers, ask, Ok(&value.to_string())),
                    Err(message) => {
                        crate::ports::apply_answer(&answers, ask, Err((&message, None)))
                    }
                }
            }
        }
    });
    let tuning = Tuning {
        close_wait_ms: 50,
        ready_poll_ms: 20,
        ..Tuning::default()
    };
    let control = AgentControl::new(port, caps, &Files::default(), tuning, system_clock());
    (control, asked)
}

fn tab(id: &str, fields: Value) -> Value {
    let mut tab = json!({ "tabId": id, "status": "ready", "title": id, "cwd": "/repo" });
    for (key, value) in fields.as_object().cloned().unwrap_or_default() {
        tab[key] = value;
    }
    tab
}

fn worktree(branch: &str) -> Value {
    json!({ "name": branch, "branch": branch, "baseCwd": "/repo", "path": format!("/wt/{branch}") })
}

const CLEAN: &str = r#"{"branch":"omp/agent/a","baseBranch":"main","commitsAhead":2,"files":[{"path":"src/a.ts","added":10,"removed":2},{"path":"src/b.ts","added":5,"removed":0}],"uncommitted":0,"untracked":0,"merged":false}"#;

fn facts(branch: &str, uncommitted: u32) -> Value {
    let mut facts: Value = serde_json::from_str(CLEAN).unwrap();
    facts["branch"] = json!(branch);
    facts["uncommitted"] = json!(uncommitted);
    facts
}

/// The caller `main0001` and two worktree children it opened.
fn family() -> Value {
    json!({
        "enabled": true,
        "tabs": [
            tab("main0001", json!({ "title": "Boss", "sessionPath": "/s/boss.jsonl" })),
            tab("alpha001", json!({ "title": "Alpha", "worktree": worktree("omp/agent/a"), "sessionPath": "/s/a.jsonl" })),
            tab("beta0002", json!({ "title": "Beta", "worktree": worktree("omp/agent/b"), "sessionPath": "/s/b.jsonl" })),
        ],
        "windowOf": { "main0001": "w", "alpha001": "w", "beta0002": "w" },
        "parents": {
            "alpha001": { "callerTabId": "main0001" },
            "beta0002": { "callerTabId": "main0001" },
        },
        "texts": {
            "mergeTitle": "Merge?",
            "mergeMessage": "{caller} merges {target} ({branch} into {base} in {cwd})",
            "scheduleTitle": "Schedule?",
            "scheduleMessage": "{caller} schedules {name} {when} in {folder}",
        },
    })
}

fn branch_of(args: &Value) -> String {
    args["worktree"]["branch"].as_str().unwrap_or("").to_owned()
}

/// What a fake main answers about git and the omp of a session, for the tools of this family.
fn main_of(
    reply: impl Fn(&str, &Value) -> Option<Value> + Send + 'static,
) -> impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static {
    move |method, args| {
        if let Some(value) = reply(method, args) {
            return Ok(value);
        }
        match method {
            "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
            "state" => Ok(Value::Null),
            "branchFacts" => Ok(facts(&branch_of(args), 0)),
            "branchEvidence" => {
                Ok(json!({ "diff": "", "diffOmitted": 0, "merge": { "kind": "clean" } }))
            }
            "confirm" => Ok(json!(true)),
            "command" => match args["command"]["type"].as_str() {
                Some("get_state") => Ok(
                    json!({ "success": true, "data": { "isStreaming": false, "isSettled": true } }),
                ),
                Some("get_last_assistant_text") => {
                    let text = if args["tabId"] == "alpha001" {
                        "Alpha is done: tests pass"
                    } else {
                        "Beta is done"
                    };
                    Ok(json!({ "success": true, "data": { "text": text } }))
                }
                Some("get_transcript_page") => {
                    Ok(json!({ "success": true, "data": { "messages": [], "totalMessages": 0 } }))
                }
                _ => Ok(json!({ "success": false, "error": "no" })),
            },
            _ => Ok(Value::Null),
        }
    }
}

async fn run(control: &AgentControl, tool: &str, args: Value) -> (String, bool) {
    let outcome = control.run("main0001", tool, args, None).await;
    (outcome.text, outcome.is_error)
}

#[tokio::test]
async fn compare_gives_each_branch_its_facts_its_answer_and_runs_no_tests() {
    let (control, asked) = rig(
        201,
        family(),
        Caps::default(),
        main_of(|method, args| match method {
            "branchFacts" if branch_of(args) == "omp/agent/b" => Some(facts("omp/agent/b", 3)),
            _ => None,
        }),
    );
    let (text, is_error) = run(&control, "ompdesk_compare", json!({})).await;
    assert!(!is_error, "{text}");
    assert!(text.contains("- alpha001 \"Alpha\""), "{text}");
    assert!(
        text.contains("branch omp/agent/a → main: 2 commit(s) ahead, 2 file(s) changed (+15 −2)"),
        "{text}"
    );
    assert!(
        text.contains("files: src/a.ts +10 −2, src/b.ts +5 −0"),
        "{text}"
    );
    assert!(
        text.contains("final answer: Alpha is done: tests pass"),
        "{text}"
    );
    assert!(text.contains("ready to merge with ompdesk_merge"), "{text}");
    assert!(
        text.contains("cannot merge yet: omp/agent/b has 3 uncommitted file(s)"),
        "{text}"
    );
    assert!(text.contains("Compare runs no tests"), "{text}");
    // Reading them counts as collecting their answers.
    assert!(control.mem().collected.contains("alpha001"));
    assert!(
        asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "branchEvidence")
    );
}

#[tokio::test]
async fn compare_says_when_no_session_has_a_worktree_and_names_a_judge_that_failed() {
    let state = json!({
        "enabled": true,
        "tabs": [tab("main0001", json!({})), tab("plain002", json!({ "title": "Plain" }))],
        "windowOf": { "main0001": "w", "plain002": "w" },
    });
    let (control, _) = rig(202, state, Caps::default(), main_of(|_, _| None));
    let (text, is_error) = run(&control, "ompdesk_compare", json!({})).await;
    assert!(is_error);
    assert!(text.contains("No worktree sessions to compare"), "{text}");
    let (text, _) = run(
        &control,
        "ompdesk_compare",
        json!({ "sessions": ["plain002"], "criteria": ["it works"] }),
    )
    .await;
    assert!(
        text.starts_with("Verdict: unavailable (Judging failed: no)."),
        "{text}"
    );
    assert!(text.contains("no worktree: no branch to diff"), "{text}");
}

#[tokio::test]
async fn compare_names_the_judge_and_ranks_the_sessions_it_knows() {
    let verdict = json!({
        "ranking": [
            { "session": "beta0002", "score": 40, "criteria": [{ "criterion": "ok", "met": "no", "why": "no hunk" }], "reasons": "weak" },
            { "session": "alpha001", "score": 90, "criteria": [{ "criterion": "ok", "met": "yes" }], "reasons": "strong" },
            { "session": "ghost999", "score": 99, "criteria": [], "reasons": "unknown id" },
        ],
        "winner": "alpha001",
        "why": "it did the work",
    });
    let (control, asked) = rig(
        203,
        family(),
        Caps::default(),
        main_of(move |method, args| {
            (method == "command" && args["command"]["type"] == "agent_control_judge").then(|| {
                json!({ "success": true, "data": { "text": verdict.to_string(), "model": "m/x", "role": "slow", "family": "openai", "mainFamily": "anthropic", "crossFamily": true, "usd": 0.01234 } })
            })
        }),
    );
    let (text, is_error) = run(&control, "ompdesk_compare", json!({ "criteria": ["ok"] })).await;
    assert!(!is_error, "{text}");
    assert!(
        text.starts_with(
            "Verdict by m/x (slow role, openai family; your model is anthropic), $0.0123:\n1. alpha001: 90/100. strong\n   - yes: ok\n2. beta0002: 40/100. weak\n   - no: ok (no hunk)\nWinner: alpha001. it did the work\n\nEvidence:\n"
        ),
        "{text}"
    );
    let judged = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(_, args)| args["command"]["type"] == "agent_control_judge")
        .map(|(_, args)| args.clone())
        .expect("the judge was asked");
    assert_eq!(judged["timeoutMs"], json!(180_000));
    let user = judged["command"]["user"].as_str().unwrap();
    assert!(
        user.starts_with("Acceptance criteria:\n1. ok\n\n<session id=\"alpha001\">"),
        "{user}"
    );
}

#[tokio::test]
async fn merge_asks_first_merges_and_never_pushes() {
    let (control, asked) = rig(
        204,
        family(),
        Caps::default(),
        main_of(|method, _| {
            (method == "mergeBranch")
                .then(|| json!({ "merged": true, "sha": "abc1234", "summary": "2 files changed" }))
        }),
    );
    let (text, is_error) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(!is_error, "{text}");
    assert_eq!(
        text,
        "Merged omp/agent/a into /repo (abc1234: 2 files changed). Nothing was pushed."
    );
    let asked = asked.lock().unwrap();
    let card = asked
        .iter()
        .find(|(method, _)| method == "confirm")
        .expect("a card");
    assert_eq!(card.1["title"], "Merge?");
    assert_eq!(
        card.1["message"],
        "Boss merges Alpha (omp/agent/a into main in /repo)"
    );
    drop(asked);
    // Merged: its review item is settled and its conflict gone.
    assert!(control.mem().reviewed.contains("alpha001"));
}

#[tokio::test]
async fn merge_declined_conflicting_and_hooked() {
    let declined = Arc::new(Mutex::new(false));
    let seen = declined.clone();
    let result = Arc::new(Mutex::new(json!(null)));
    let outcome = result.clone();
    let (control, asked) = rig(
        205,
        family(),
        Caps::default(),
        main_of(move |method, args| match method {
            "confirm" => Some(json!(!*seen.lock().unwrap())),
            "mergeBranch" => Some(outcome.lock().unwrap().clone()),
            "branchFacts" if branch_of(args) == "omp/agent/b" => Some(facts("omp/agent/b", 2)),
            _ => None,
        }),
    );
    *declined.lock().unwrap() = true;
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(
        text.contains("The user declined the merge of omp/agent/a. Do not ask again"),
        "{text}"
    );
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "mergeBranch")
    );
    *declined.lock().unwrap() = false;

    *result.lock().unwrap() =
        json!({ "merged": false, "reason": "conflict", "files": ["src/a.ts"], "predicted": false });
    let (text, is_error) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(is_error);
    assert!(
        text.contains("Merge conflict in src/a.ts: the merge was aborted and /repo is unchanged."),
        "{text}"
    );
    assert_eq!(
        control.mem().conflicts.get("alpha001"),
        Some(&vec!["src/a.ts".to_owned()])
    );

    *result.lock().unwrap() = json!({ "merged": false, "reason": "conflict", "files": ["README.md", "src/a.ts"], "predicted": true });
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(text.contains("Merging omp/agent/a would conflict in README.md, src/a.ts (predicted by git merge-tree): no merge was attempted and /repo is unchanged."), "{text}");

    let report = json!({ "script": ".ompdesk/worktree-pre-merge", "ok": false, "exitCode": 3, "timedOut": false, "durationMs": 900, "logPath": "/repo/.git/x.log", "outputTail": "lint failed: src/a.ts" });
    *result.lock().unwrap() = json!({ "merged": false, "reason": "hook", "hook": report });
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(text.contains("Pre-merge hook .ompdesk/worktree-pre-merge failed (exit 3) in /wt/omp/agent/a; the merge was not started. Output tail:\nlint failed: src/a.ts\nLog: /repo/.git/x.log"), "{text}");

    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "beta0002" })).await;
    assert!(text.contains("uncommitted file"), "{text}");

    let post = json!({ "script": ".ompdesk/worktree-post-merge", "ok": false, "exitCode": null, "timedOut": true, "durationMs": 120000, "logPath": "/l", "outputTail": "t" });
    *result.lock().unwrap() =
        json!({ "merged": true, "sha": "abc1234", "summary": "", "postMerge": post });
    let (text, is_error) = run(&control, "ompdesk_merge", json!({ "session": "alpha001" })).await;
    assert!(!is_error);
    assert!(text.starts_with("Merged omp/agent/a into /repo (abc1234). Nothing was pushed. Post-merge hook .ompdesk/worktree-post-merge failed (timed out after 120s); the merge stays."), "{text}");
}

#[tokio::test]
async fn merge_refuses_a_session_without_a_branch_or_still_working() {
    let mut state = family();
    state["tabs"][2]["busy"] = json!(true);
    state["tabs"]
        .as_array_mut()
        .unwrap()
        .push(tab("plain003", json!({})));
    state["windowOf"]["plain003"] = json!("w");
    let (control, _) = rig(206, state, Caps::default(), main_of(|_, _| None));
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "plain003" })).await;
    assert!(text.contains("has no worktree branch to merge"), "{text}");
    let (text, _) = run(&control, "ompdesk_merge", json!({ "session": "beta0002" })).await;
    assert!(
        text.contains("is still working or waiting; collect its result first."),
        "{text}"
    );
}

fn scheduled(id: &str, name: &str, frequency: Value) -> Value {
    json!({ "id": id, "createdAt": "2026-01-01T00:00:00.000Z", "name": name, "prompt": "p", "cwd": "/repo", "frequency": frequency, "model": null, "autoApprove": false, "enabled": true })
}

#[tokio::test]
async fn schedule_creates_after_a_card_lists_and_changes_only_the_agent_s_own() {
    let mut state = family();
    state["scheduleDevices"] = json!([""]);
    let saved = Arc::new(Mutex::new(Vec::<Value>::new()));
    let book = saved.clone();
    let (control, asked) = rig(
        207,
        state,
        Caps::default(),
        main_of(move |method, args| match method {
            "schedules.create" => {
                let draft = args["draft"].clone();
                let made = scheduled(
                    "sch00001",
                    draft["name"].as_str().unwrap(),
                    draft["frequency"].clone(),
                );
                book.lock().unwrap().push(made);
                Some(
                    json!({ "id": "sch00001", "state": { "schedules": book.lock().unwrap().clone(), "nextRuns": { "sch00001": "2026-01-02T09:00:00.000Z" } } }),
                )
            }
            "schedules.command" => {
                let mut schedules = book.lock().unwrap().clone();
                schedules.push(scheduled(
                    "user0001",
                    "Mine",
                    json!({ "kind": "interval", "minutes": 5 }),
                ));
                if args["request"]["action"].as_str() == Some("delete") {
                    schedules.retain(|row| row["id"] != args["request"]["id"]);
                }
                Some(
                    json!({ "schedules": schedules, "runs": [], "nextRuns": { "sch00001": "2026-01-02T09:00:00.000Z" } }),
                )
            }
            _ => None,
        }),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "nightly", "prompt": "do it", "daily_at": "09:00", "days": [3, 1, 3], "folder": "/repo" }),
    )
    .await;
    assert!(!is_error, "{text}");
    assert!(text.starts_with("Scheduled “[agent] nightly” "), "{text}");
    assert!(text.contains("id sch00001; next run 2026-01-02T09:00:00.000Z. It runs only while OMPdesk is open on this computer, never with auto-approve; cancel it with ompdesk_schedule {\"action\":\"cancel\",\"id\":\"sch00001\"}."), "{text}");
    let asked_now = asked.lock().unwrap().clone();
    let card = asked_now
        .iter()
        .find(|(method, _)| method == "confirm")
        .unwrap();
    assert_eq!(card.1["title"], "Schedule?");
    let create = asked_now
        .iter()
        .find(|(method, _)| method == "schedules.create")
        .unwrap();
    assert_eq!(create.1["draft"]["name"], "[agent] nightly");
    assert_eq!(create.1["draft"]["autoApprove"], false);
    assert_eq!(
        create.1["draft"]["frequency"],
        json!({ "kind": "daily", "time": "09:00", "days": [1, 3] })
    );

    let (text, _) = run(&control, "ompdesk_schedule", json!({ "action": "list" })).await;
    assert!(
        text.starts_with("Scheduled runs on this computer:\n- sch00001 “[agent] nightly” "),
        "{text}"
    );
    assert!(
        text.contains("[made by an agent: you can change it]"),
        "{text}"
    );
    assert!(
        text.contains("- user0001 “Mine” every 5 min in /repo; next —"),
        "{text}"
    );
    assert!(
        text.ends_with("[the user's own: leave it]") || text.contains("[the user's own: leave it]"),
        "{text}"
    );

    let (text, is_error) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "cancel", "id": "user0001" }),
    )
    .await;
    assert!(is_error);
    assert!(
        text.contains(
            "is the user's own schedule; only the user changes it (Settings › Schedules)."
        ),
        "{text}"
    );
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "cancel", "id": "sch0" }),
    )
    .await;
    assert_eq!(text, "Cancelled “[agent] nightly” on this computer.");
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "runs", "id": "nope" }),
    )
    .await;
    assert!(
        text.contains("No scheduled run \"nope\" on this computer."),
        "{text}"
    );
}

#[tokio::test]
async fn schedule_says_so_without_a_service_and_needs_one_start() {
    let (control, _) = rig(208, family(), Caps::default(), main_of(|_, _| None));
    let (text, _) = run(&control, "ompdesk_schedule", json!({ "action": "list" })).await;
    assert_eq!(text, "Scheduled runs are not available on this computer.");
    let mut state = family();
    state["scheduleDevices"] = json!([""]);
    let (control, _) = rig(
        209,
        state,
        Caps::default(),
        main_of(|method, _| (method == "schedules.command").then(|| json!({ "schedules": [] }))),
    );
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "x" }),
    )
    .await;
    assert_eq!(
        text,
        "create needs exactly one of every_minutes, daily_at, at, in_minutes or on."
    );
    let (text, _) = run(
        &control,
        "ompdesk_schedule",
        json!({ "action": "create", "name": "x", "every_minutes": 5, "folder": "repo" }),
    )
    .await;
    assert_eq!(text, "folder must be an absolute path.");
    let (text, _) = run(&control, "ompdesk_schedule", json!({ "action": "list" })).await;
    assert_eq!(text, "No scheduled runs on this computer.");
}

fn autopilot_status(state: &str) -> Value {
    json!({ "state": state, "active": true, "role": "parent", "cycle": 2, "branch": "autopilot/x", "tabId": "run00001" })
}

#[tokio::test]
async fn autopilot_starts_from_the_callers_folder_reads_and_stops_a_run() {
    let mut state = family();
    state["fullEnabled"] = json!(true);
    let stopped = Arc::new(Mutex::new(false));
    let was_stopped = stopped.clone();
    let caps = Caps {
        autopilot: true,
        ..Caps::default()
    };
    let (control, asked) = rig(
        210,
        state,
        caps,
        main_of(move |method, _| match method {
            "autopilot.plan" => Some(json!({ "defaultBranch": "main" })),
            "autopilot.start" => Some(autopilot_status("running")),
            "autopilot.status" => Some(if *was_stopped.lock().unwrap() {
                autopilot_status("stopping")
            } else {
                autopilot_status("running")
            }),
            "autopilot.stop" => {
                *was_stopped.lock().unwrap() = true;
                Some(autopilot_status("stopping"))
            }
            _ => None,
        }),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "ship": "push" }),
    )
    .await;
    assert!(!is_error, "{text}");
    assert!(
        text.starts_with("Started Autopilot in session run00001."),
        "{text}"
    );
    assert!(
        text.contains(
            "read it with ompdesk_autopilot {\"action\":\"status\",\"session\":\"run00001\"}"
        ),
        "{text}"
    );
    let started = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "autopilot.start")
        .cloned()
        .unwrap();
    assert_eq!(started.1["callerTabId"], "main0001");
    assert_eq!(started.1["sourceTabId"], "main0001");
    assert_eq!(started.1["options"]["preset"], "push");
    // Full control: no card.
    assert!(
        !asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "confirm")
    );
    // The run counts among what the caller opened.
    assert!(
        control
            .mem()
            .opened
            .get("main0001")
            .is_some_and(|ids| ids.contains(&"run00001".to_owned()))
    );
    let (text, _) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "ship": "commit", "advanced": { "cadence": 3 } }),
    )
    .await;
    assert_eq!(
        text,
        "advanced.cadence goes with ship release (it is the release rhythm)."
    );
    let (text, _) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "folder": "relative" }),
    )
    .await;
    assert_eq!(text, "folder must be an absolute path.");
    let (text, _) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "start", "folder": "/elsewhere" }),
    )
    .await;
    assert!(
        text.starts_with("/elsewhere is not open in a session of this window on this computer."),
        "{text}"
    );
}

#[tokio::test]
async fn autopilot_stop_ends_a_run_after_its_cycle_and_refuses_what_is_no_run() {
    let mut state = family();
    state["tabs"]
        .as_array_mut()
        .unwrap()
        .push(tab("run00001", json!({ "title": "Run" })));
    state["windowOf"]["run00001"] = json!("w");
    state["parents"]["run00001"] = json!({ "callerTabId": "main0001" });
    let caps = Caps {
        autopilot: true,
        ..Caps::default()
    };
    let (control, asked) = rig(
        211,
        state,
        caps,
        main_of(|method, args| match method {
            "autopilot.status" if args["tabId"] == "run00001" => Some(autopilot_status("running")),
            "autopilot.status" => Some(json!({ "active": false })),
            "autopilot.stop" => Some(autopilot_status("stopping")),
            _ => None,
        }),
    );
    let (text, is_error) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "stop", "session": "run00001" }),
    )
    .await;
    assert!(!is_error, "{text}");
    assert!(text.ends_with("Ending: it finishes the cycle in flight, then closes its children and stops. It will not continue by itself."), "{text}");
    let stop = asked
        .lock()
        .unwrap()
        .iter()
        .find(|(method, _)| method == "autopilot.stop")
        .cloned()
        .unwrap();
    assert_eq!(stop.1, json!({ "tabId": "run00001", "now": false }));
    // Nothing stays marked as closing once it returned.
    assert!(!control.mem().closing.contains("run00001"));
    let (text, is_error) = run(
        &control,
        "ompdesk_autopilot",
        json!({ "action": "status", "session": "alpha001" }),
    )
    .await;
    assert!(is_error);
    assert!(text.contains("is not an Autopilot run."), "{text}");
}

#[tokio::test]
async fn the_review_board_lists_what_waits_and_what_each_session_cost() {
    let mut state = family();
    state["tabs"][2]["busy"] = json!(true);
    state["tabs"][2]["busySince"] = json!(1_700_000_000_000u64);
    let (control, _) = rig(
        212,
        state,
        Caps::default(),
        main_of(|method, args| match method {
            "branchFacts" if branch_of(args) == "omp/agent/b" => Some(facts("omp/agent/b", 1)),
            "command" => match args["command"]["type"].as_str() {
                Some("get_session_stats") => Some(
                    json!({ "success": true, "data": { "cost": 0.5, "history": { "cost": 1.25 } } }),
                ),
                Some("get_session_spend") => Some(
                    json!({ "success": true, "data": { "providers": { "a": { "billing": "metered", "cost": 1 }, "b": { "billing": "subscription", "cost": 0.25 }, "c": { "billing": "metered", "cost": 0 } } } }),
                ),
                _ => None,
            },
            _ => None,
        }),
    );
    let review = control.review("main0001").await.unwrap();
    let items = review["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["tabId"], "alpha001");
    assert_eq!(items[0]["state"], "needs-review");
    assert_eq!(items[0]["branch"], "omp/agent/a");
    assert_eq!(items[0]["commitsAhead"], 2);
    assert_eq!(items[0]["files"], 2);
    assert_eq!(items[0]["added"], 15);
    assert_eq!(items[0]["answer"], "Alpha is done: tests pass");
    assert_eq!(items[1]["state"], "running");
    assert_eq!(items[1]["runningSince"], json!(1_700_000_000_000u64));
    assert_eq!(items[1]["uncommitted"], 1);
    let usage = &review["usage"];
    assert_eq!(usage["/s/a.jsonl"]["cost"], 1.25);
    assert_eq!(
        usage["/s/a.jsonl"]["split"],
        json!({ "charged": 1.0, "estimate": 0.25 })
    );
    // The caller's own journal is part of the family's cost.
    assert_eq!(usage["/s/boss.jsonl"]["cost"], 1.25);
    assert_eq!(
        control.review_items("main0001").await.unwrap(),
        review["items"]
    );

    // A running child's step and cost are read again between full reviews; the rest stays as sent.
    let live = control
        .live_review("main0001", review.clone(), Some(vec!["beta0002".into()]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(live["items"][0], review["items"][0]);
    assert_eq!(live["usage"]["/s/b.jsonl"]["cost"], 1.25);
    assert!(
        control
            .live_review("main0001", review, Some(vec!["alpha001".into()]))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_merged_clean_child_is_no_review_item_but_a_conflict_one_is() {
    let (control, _) = rig(
        213,
        family(),
        Caps::default(),
        main_of(|method, args| {
            (method == "branchFacts").then(|| {
                let mut facts = facts(&branch_of(args), 0);
                facts["merged"] = json!(true);
                facts
            })
        }),
    );
    assert_eq!(
        control.review("main0001").await.unwrap()["items"],
        json!([])
    );
    control
        .mem()
        .conflicts
        .insert("beta0002".into(), vec!["a.ts".into(), "b.ts".into()]);
    let review = control.review("main0001").await.unwrap();
    // Merged and clean: still nothing to review, and its conflict note is dropped.
    assert_eq!(review["items"], json!([]));
    assert!(control.mem().conflicts.is_empty());
}

#[tokio::test]
async fn family_edits_read_each_childs_turn_and_each_closed_childs_file_once() {
    let mut state = family();
    state["tabs"][2]["status"] = json!("asleep");
    state["closedChildren"] = json!([
        { "path": "/s/old.jsonl", "openedBySession": "/s/boss.jsonl", "title": "Old", "cwd": "/repo", "closedAt": 2000 },
        { "path": "/s/older.jsonl", "openedBySession": "/s/boss.jsonl", "title": "Older", "cwd": "/repo", "closedAt": 500 },
        { "path": "/s/a.jsonl", "openedBySession": "/s/boss.jsonl", "title": "Open still", "cwd": "/repo", "closedAt": 3000 },
    ]);
    let edit = |id: &str, at: u64| {
        json!([
            { "role": "user", "content": "go", "timestamp": at },
            { "role": "assistant", "content": [{ "type": "toolCall", "id": id, "name": "edit", "arguments": { "path": "a" } }, { "type": "text", "text": "x" }], "timestamp": at + 1 },
            { "role": "toolResult", "toolCallId": id, "toolName": "edit", "content": [], "timestamp": at + 2 },
        ])
    };
    let stored_reads = Arc::new(Mutex::new(0));
    let reads = stored_reads.clone();
    let (control, _) = rig(
        214,
        state,
        Caps::default(),
        main_of(move |method, args| match method {
            "storedMessages" => {
                *reads.lock().unwrap() += 1;
                Some(if args["session"]["path"] == "/s/old.jsonl" {
                    edit("c1", 100)
                } else {
                    edit("c2", 200)
                })
            }
            "command" => match args["command"]["type"].as_str() {
                Some("get_turn_edits") => Some(
                    json!({ "success": true, "data": { "cwd": "/repo", "startedAt": 1, "endedAt": 2, "messages": [] } }),
                ),
                Some("get_git_unlanded") => Some(
                    json!({ "success": true, "data": { "branch": "b", "target": "main", "files": [], "truncated": false } }),
                ),
                _ => None,
            },
            _ => None,
        }),
    );
    let first = control
        .family_edits("main0001", Some(1000.0))
        .await
        .unwrap();
    let members = first["members"].as_array().unwrap();
    assert_eq!(members.len(), 3, "{first}");
    assert_eq!(members[0]["key"], "/s/a.jsonl");
    assert_eq!(members[0]["live"], false);
    assert_eq!(members[0]["edits"]["cwd"], "/repo");
    assert_eq!(members[0]["unlanded"]["target"], "main");
    // Asleep: read from its saved file, and no git read.
    assert_eq!(members[1]["key"], "/s/b.jsonl");
    assert_eq!(members[1]["edits"]["messages"].as_array().unwrap().len(), 2);
    assert_eq!(members[1]["unlanded"], Value::Null);
    // Closed since `since`: its last turn only; a close before it, or one still open, is left out.
    assert_eq!(members[2]["key"], "/s/old.jsonl");
    assert_eq!(members[2]["edits"]["startedAt"], 100);
    assert_eq!(members[2]["edits"]["endedAt"], 102);
    let before = *stored_reads.lock().unwrap();
    control
        .family_edits("main0001", Some(1000.0))
        .await
        .unwrap();
    // The closed child's turn never changes: read once. The asleep child's file is read again.
    assert_eq!(*stored_reads.lock().unwrap(), before + 1);
    assert_eq!(
        control.family_edits("main0001", None).await.unwrap()["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn an_app_action_runs_a_command_on_another_computer_in_one_background_session() {
    let mut state = family();
    state["devices"] = json!([{ "id": "dev-studio", "name": "Studio", "state": "online" }]);
    // The background session it opens is a tab of that computer main lists but agents never see.
    state["tabs"].as_array_mut().unwrap().push(tab(
        "util0001",
        json!({ "device": "dev-studio", "hidden": true }),
    ));
    state["windowOf"]["util0001"] = json!("w");
    let (control, asked) = rig(
        215,
        state,
        Caps::default(),
        main_of(|method, args| match method {
            "spawn" => Some(json!({ "tabId": "util0001" })),
            "command" => {
                Some(json!({ "success": true, "data": { "echo": args["command"]["type"] } }))
            }
            _ => None,
        }),
    );
    let response = control
        .rpc_on("main0001", "Studio", &json!({ "type": "get_state" }))
        .await
        .unwrap();
    assert_eq!(response.data, Some(json!({ "echo": "get_state" })));
    let asked = asked.lock().unwrap().clone();
    let methods: Vec<&str> = asked.iter().map(|(method, _)| method.as_str()).collect();
    assert_eq!(methods, ["spawn", "command", "deleteSession"], "{asked:?}");
    assert_eq!(
        asked[0].1,
        json!({ "callerTabId": "main0001", "request": { "device": "dev-studio" } })
    );
    assert_eq!(asked[1].1["tabId"], "util0001");
    assert_eq!(asked[1].1["timeoutMs"], 30_000);
    assert_eq!(
        asked[2].1,
        json!({ "callerTabId": "main0001", "tabId": "util0001" })
    );
    assert!(control.mem().utility_tabs.is_empty());
    assert!(control.mem().closing.is_empty());
}

#[tokio::test]
async fn an_app_action_without_app_ports_says_so_and_the_catalog_lists_with_them() {
    let (control, _) = rig(216, family(), Caps::default(), main_of(|_, _| None));
    let (text, is_error) = run(&control, "ompdesk_app", json!({ "action": "settings.get" })).await;
    assert!(is_error);
    assert_eq!(text, "App actions are not available here.");
    assert!(control.mem().app_runs.is_empty());
    let caps = Caps {
        app_ports: true,
        ..Caps::default()
    };
    let (control, _) = rig(217, family(), caps, main_of(|_, _| None));
    let (text, is_error) = run(&control, "ompdesk_app_list", json!({ "area": "settings" })).await;
    assert!(!is_error, "{text}");
    assert!(text.contains("settings.get"), "{text}");
    let (text, is_error) = run(
        &control,
        "ompdesk_app",
        json!({ "action": "no.such.action" }),
    )
    .await;
    assert!(is_error);
    assert!(text.contains("Unknown action"), "{text}");
}

// ---- pure cuts against the TypeScript ---------------------------------------------------------------------------

fn captured(name: &str) -> Vec<Value> {
    let table: Value =
        serde_json::from_str(include_str!("captured.json")).expect("captured.json is JSON");
    table[name]
        .as_array()
        .unwrap_or_else(|| panic!("no table {name}"))
        .clone()
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

#[test]
fn a_turn_s_edit_calls_are_cut_as_the_typescript_cut_them() {
    for (index, case) in captured("turnEdits").iter().enumerate() {
        let messages: Vec<Value> = case["in"][0].as_array().unwrap().clone();
        let got = turn_edits(&messages, case["in"][1].as_str().unwrap());
        assert!(
            same(&got, &case["out"]),
            "turnEdits case {index}\n got  {got}\n want {}",
            case["out"]
        );
    }
}

#[test]
fn spend_is_split_as_the_typescript_split_it() {
    for (index, case) in captured("costSplitOf").iter().enumerate() {
        let got = cost_split_of(case["in"][0].as_object().unwrap());
        assert!(
            same(
                &json!({ "charged": got.charged, "estimate": got.estimate }),
                &case["out"]
            ),
            "costSplitOf case {index}"
        );
    }
}

#[test]
fn commands_get_the_windows_the_typescript_gave_them() {
    for (index, case) in captured("timeoutForCommand").iter().enumerate() {
        let got = command_timeout(case["in"][0].as_str().unwrap());
        assert_eq!(
            got.map(|ms| json!(ms)),
            case["out"].as_u64().map(|ms| json!(ms)),
            "timeoutForCommand case {index}: {}",
            case["in"][0]
        );
    }
}
