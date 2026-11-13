//! Tests of the service skeleton: the pure functions replayed against tables captured from the TypeScript
//! (`captured.json`: `service.ts`, `branches.ts`, `shared/agent-control.ts`, `shared/schedules.ts` and `fill-text.ts` run
//! over the inputs of `service.test.ts` and edge cases: emoji at cut points, every white space, every shape), the
//! snapshot lookups, the waiters over pushed snapshots and the call pipeline against a fake main.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::fail::Fail;
use super::host::{Caps, HostState, fill_text};
use super::js::one_line;
use super::text::*;
use super::tuning::Tuning;
use super::types::*;
use super::wrap::*;
use super::{AgentControl, Files, JournalFile};
use crate::agentctl::journal::system_clock;
use crate::git::branches::{bound_diff, merge_problem};
use crate::ports::Port;

// ---- captured tables ------------------------------------------------------------------------------------------------

struct Case {
    args: Vec<Value>,
    out: Result<Value, String>,
}

fn cases(name: &str) -> Vec<Case> {
    let table: Value =
        serde_json::from_str(include_str!("captured.json")).expect("captured.json is JSON");
    table[name]
        .as_array()
        .unwrap_or_else(|| panic!("no captured table {name}"))
        .iter()
        .map(|case| Case {
            args: case["in"].as_array().cloned().unwrap_or_default(),
            out: match case.get("throws") {
                Some(message) => Err(message.as_str().unwrap_or("").to_owned()),
                None => Ok(case["out"].clone()),
            },
        })
        .collect()
}

/// Numbers compare as numbers: `1700000000000` and `1700000000000.0` are the same one.
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

/// Replays `name`: `f` maps one case's arguments to its result.
fn replay(name: &str, f: impl Fn(&[Value]) -> Result<Value, String>) {
    for (index, case) in cases(name).into_iter().enumerate() {
        let got = f(&case.args);
        let ok = match (&got, &case.out) {
            (Ok(got), Ok(want)) => same(got, want),
            (Err(got), Err(want)) => got == want,
            _ => false,
        };
        assert!(
            ok,
            "{name} case {index}: in {:?}\n got  {got:?}\n want {:?}",
            case.args, case.out
        );
    }
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn opt(value: &Value) -> Option<&str> {
    value.as_str()
}

fn n(value: &Value) -> usize {
    value.as_u64().unwrap_or(0) as usize
}

fn text(value: String) -> Result<Value, String> {
    Ok(Value::String(value))
}

fn tab(value: &Value) -> ControlTab {
    let mut fields = value.as_object().cloned().unwrap_or_default();
    fields.entry("tabId").or_insert(json!("x"));
    fields.entry("status").or_insert(json!("ready"));
    serde_json::from_value(Value::Object(fields)).expect("a tab")
}

fn row(value: &Value) -> StoredSession {
    let mut fields = value.as_object().cloned().unwrap_or_default();
    fields.entry("id").or_insert(json!("id"));
    fields.entry("path").or_insert(json!("/p"));
    serde_json::from_value(Value::Object(fields)).expect("a stored session")
}

fn from<T: serde::de::DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{error}: {value}"))
}

fn messages(value: &Value) -> Vec<AgentMessage> {
    from(value)
}

fn json_or_null<T: serde::Serialize>(value: Option<T>) -> Result<Value, String> {
    Ok(value.map_or(Value::Null, |value| {
        serde_json::to_value(value).expect("serializes")
    }))
}

#[test]
fn strings_cut_where_javascript_cut_them() {
    replay("oneLine", |a| text(one_line(s(&a[0]), n(&a[1]))));
    replay("head", |a| text(super::js::head(s(&a[0]), n(&a[1]))));
    replay("cut", |a| text(super::js::cut(s(&a[0]), n(&a[1]))));
    replay("outputTail", |a| text(output_tail(s(&a[0]))));
    replay("elapsedText", |a| {
        text(elapsed_text(a[0].as_f64().unwrap_or(0.0)))
    });
}

#[test]
fn ids_names_and_paths() {
    replay("savedIdOfPath", |a| {
        json_or_null(saved_id_of_path(opt(&a[0])))
    });
    replay("unquoted", |a| text(unquoted(s(&a[0]))));
    replay("folderKey", |a| text(folder_key(s(&a[0]))));
    replay("trimSeparators", |a| text(trim_separators(s(&a[0]))));
    replay("label", |a| text(label(&tab(&a[0]))));
    replay("named", |a| text(named(&tab(&a[0]))));
    replay("idsOf", |a| Ok(json!(ids_of(&tab(&a[0])))));
    replay("byCaller", |a| text(by_caller(&tab(&a[0]))));
    replay("cleanupCaller", |a| text(cleanup_caller(&tab(&a[0]))));
    replay("waits", |a| Ok(json!(waits(&tab(&a[0])))));
    replay("storedTitle", |a| text(stored_title(&row(&a[0]))));
    replay("openInText", |a| text(open_in_text(s(&a[0]), opt(&a[1]))));
    replay("openElsewhereText", |a| {
        text(open_elsewhere_text(&row(&a[0]), opt(&a[1])))
    });
    replay("unreachedText", |a| {
        text(unreached_text(&from::<Vec<String>>(&a[0])))
    });
    replay("pickOption", |a| {
        pick_option(&from::<Vec<String>>(&a[0]), s(&a[1]))
            .map(Value::String)
            .map_err(|error| error.message())
    });
}

fn flags(value: &Value) -> StopFlags {
    StopFlags {
        close: value["close"].as_bool().unwrap_or(false),
        delete: value["delete"].as_bool().unwrap_or(false),
    }
}

#[test]
fn cleanups_and_refusals() {
    replay("cleanupOf", |a| {
        Ok(cleanup_of(&tab(&a[0]), &tab(&a[1]), flags(&a[2]), 1_700_000_000_000.0).to_json())
    });
    replay("inUseRefusal", |a| {
        text(in_use_refusal(&tab(&a[0]), flags(&a[1])))
    });
    replay("startFailure", |a| text(start_failure(&tab(&a[0]))));
    replay("hookFailure", |a| text(hook_failure(&from(&a[0]))));
    replay("unanswered", |a| {
        let error = match &a[0] {
            Value::Object(fields) => Fail::Other {
                message: String::new(),
                code: fields
                    .get("code")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
            Value::String(message) => Fail::other(message.clone()),
            _ => Fail::other(""),
        };
        Ok(json!(error.unanswered()))
    });
    replay("unansweredText", |a| {
        Ok(json!(Fail::other(s(&a[0])).unanswered()))
    });
    replay("withDispatch", |a| {
        text(with_dispatch(s(&a[0]), opt(&a[1]), opt(&a[2])))
    });
}

#[test]
fn wrapped_messages_and_titles() {
    replay("wrapAgentMessage", |a| {
        text(wrap_agent_message(
            s(&a[0]),
            s(&a[1]),
            a.get(2).and_then(opt),
        ))
    });
    replay("parseAgentMessage", |a| {
        Ok(
            parse_agent_message(s(&a[0])).map_or(Value::Null, |wrapped| {
                let mut fields = Map::new();
                fields.insert("from".into(), json!(wrapped.from));
                if let Some(session) = wrapped.session {
                    fields.insert("session".into(), json!(session));
                }
                fields.insert("body".into(), json!(wrapped.body));
                Value::Object(fields)
            }),
        )
    });
    replay("agentTaskTitle", |a| {
        json_or_null(agent_task_title(s(&a[0])))
    });
    replay("dispatchMark", |a| text(dispatch_mark(s(&a[0]))));
    replay("requestMark", |a| text(request_mark(s(&a[0]))));
}

#[test]
fn schedules_and_autopilot() {
    replay("describeFrequency", |a| {
        text(describe_frequency(&from(&a[0])))
    });
    replay("scheduleState", |a| text(schedule_state(&from(&a[0]))));
    replay("webhookLine", |a| text(webhook_line(&from(&a[0]))));
    replay("scheduleRunsText", |a| {
        text(schedule_runs_text(
            &from(&a[0]),
            &from::<Vec<ScheduleRun>>(&a[1]),
        ))
    });
    replay("startOptions", |a| {
        Ok(Value::Object(start_options(&from(&a[0]), s(&a[1]))))
    });
    replay("describeRun", |a| {
        text(describe_run(
            s(&a[0]["tabId"]),
            s(&a[0]["title"]),
            &from(&a[1]),
        ))
    });
}

#[test]
fn transcripts() {
    replay("renderMessage", |a| {
        json_or_null(render_message(&from(&a[0])))
    });
    replay("contentText", |a| {
        let content: Option<Content> = if a[0].is_null() {
            None
        } else {
            Some(from(&a[0]))
        };
        text(content_text(content.as_ref()))
    });
    replay("renderPage", |a| {
        text(render_page(
            s(&a[0]),
            s(&a[1]),
            &messages(&a[2]),
            n(&a[3]),
            opt(&a[4]),
            a.get(5).and_then(opt),
        ))
    });
    replay("staleCursorNote", |a| text(stale_cursor_note(opt(&a[0]))));
    replay("transcriptPage", |a| {
        // The TypeScript answers the payload itself; what matters is which payloads are pages.
        Ok(match transcript_page(&a[0]) {
            Some(_) => a[0].clone(),
            None => Value::Null,
        })
    });
    replay("currentStep", |a| {
        json_or_null(current_step(&messages(&a[0])))
    });
    replay("checksRun", |a| Ok(json!(checks_run(&messages(&a[0])))));
    replay("isDoneReport", |a| {
        Ok(json!(is_done_report(s(&a[0]), &a[1])))
    });
    replay("transcriptEnding", |a| {
        let ending = transcript_ending(&messages(&a[0]));
        Ok(json!({
            "last": ending.last,
            "stopReason": ending.stop_reason,
            "reportedDone": ending.reported_done,
            "personPrompted": ending.person_prompted,
        }))
        .map(|mut value| {
            if ending.stop_reason.is_none() {
                value
                    .as_object_mut()
                    .map(|fields| fields.remove("stopReason"));
            }
            value
        })
    });
    replay("journalMarks", |a| {
        let marks = journal_marks(&messages(&a[0]));
        let mut requests: Vec<String> = marks.requests.into_iter().collect();
        requests.sort();
        Ok(json!({ "dispatch": marks.dispatch, "requests": requests }))
    });
}

#[test]
fn cards_verdicts_and_branches() {
    replay("askTitle", |a| text(ask_title(&from(&a[0]))));
    replay("cardText", |a| text(card_text(&from(&a[0]))));
    replay("predictionLine", |a| {
        text(prediction_line(&from(&a[0]), opt(&a[1])))
    });
    replay("judgeLabel", |a| {
        let reply: Option<JudgeReply> = if a[0].is_null() {
            None
        } else {
            Some(from(&a[0]))
        };
        text(judge_label(reply.as_ref()))
    });
    replay("parseVerdict", |a| json_or_null(parse_verdict(s(&a[0]))));
    replay("mergeProblem", |a| {
        json_or_null(merge_problem(&from(&a[0]), &from(&a[1])))
    });
    replay("boundDiff", |a| {
        let (text, omitted) = bound_diff(s(&a[0]), n(&a[1]));
        Ok(json!([text, omitted]))
    });
}

#[test]
fn calls_that_change_something_are_recorded() {
    replay("mutates", |a| {
        let tool = Tool::from_name(s(&a[0])).expect("a tool");
        Ok(json!(mutates(tool, &a[1])))
    });
    replay("callIntent", |a| {
        let tool = Tool::from_name(s(&a[0])).expect("a tool");
        Ok(
            call_intent(tool, &a[1], &tab(&a[2])).map_or(Value::Null, |intent| {
                let mut fields = Map::new();
                if let Some(open) = intent.open {
                    fields.insert("open".into(), json!(open));
                }
                if let Some(schedule) = intent.schedule {
                    let mut inner = Map::new();
                    inner.insert("name".into(), json!(schedule.name));
                    if let Some(device) = schedule.device {
                        inner.insert("device".into(), json!(device));
                    }
                    fields.insert("schedule".into(), Value::Object(inner));
                }
                Value::Object(fields)
            }),
        )
    });
}

#[test]
fn host_texts_fill_as_the_typescript_fills_them() {
    replay("fillText", |a| {
        let params: HashMap<String, String> = a[1]
            .as_object()
            .map(|fields| {
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), s(value).to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        text(fill_text(s(&a[0]), &params))
    });
}

// ---- the snapshot ----------------------------------------------------------------------------------------------------

fn tab_json(id: &str, window: &str) -> (Value, (String, Value)) {
    let mut tab = json!({ "tabId": id, "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false });
    if id == "a" {
        tab["sessionPath"] = json!("/s/x_1.jsonl");
    }
    (tab, (id.to_owned(), json!(window)))
}

fn state_json(tabs: &[(&str, &str)]) -> Value {
    let (list, windows): (Vec<Value>, Vec<(String, Value)>) =
        tabs.iter().map(|(id, window)| tab_json(id, window)).unzip();
    json!({
        "enabled": true,
        "tabs": list,
        "windowOf": windows.into_iter().collect::<Map<String, Value>>(),
        "outsideCallers": { "outside:cli#1": { "tabId": "outside:cli#1", "title": "cli", "cwd": "/", "status": "ready", "busy": false, "asks": [], "hidden": false } },
        "outsideWindow": "w2",
        "parents": { "b": { "callerTabId": "a", "tag": "autopilot-child" } },
        "summaries": { "": [{ "sessionPath": "/s/x_1.jsonl", "tabId": "a", "status": "running", "agents": [{ "status": "running" }, { "status": "done" }] }, { "sessionPath": "tab:b", "tabId": "b", "status": "ready" }],
                       "dev1": [{ "sessionPath": "/s/y_2.jsonl", "status": "ready" }] },
        "deleted": { "byPath": [{ "path": super::host::node_resolve("/s/z_3.jsonl"), "at": 5.0 }, { "path": "/s/z_3.jsonl", "device": "dev1", "at": 6.0 }], "byId": { "z3": 7.0 } },
        "scheduleDevices": ["", "dev1"],
        "stopping": ["a"],
        "texts": { "stopTitle": "Stop {count} session{plural}?" },
    })
}

#[test]
fn every_synchronous_read_is_a_lookup_in_one_snapshot() {
    let state: HostState =
        serde_json::from_value(state_json(&[("a", "w1"), ("b", "w2"), ("c", "w1")])).unwrap();
    // The caller's window first, then the rest, each in the pool's order; `here` says which is which.
    let tabs = state.tabs("b").unwrap();
    assert_eq!(
        tabs.iter()
            .map(|t| (t.tab_id.as_str(), t.here))
            .collect::<Vec<_>>(),
        [("b", true), ("a", false), ("c", false)]
    );
    let tabs = state.tabs("a").unwrap();
    assert_eq!(
        tabs.iter()
            .map(|t| (t.tab_id.as_str(), t.here))
            .collect::<Vec<_>>(),
        [("a", true), ("c", true), ("b", false)]
    );
    // A caller that is no tab is gone; a process outside OMPdesk acts through its window.
    assert!(state.tabs("nope").is_none());
    let outside = state.tabs("outside:cli#1").unwrap();
    assert_eq!(
        outside
            .iter()
            .map(|t| (t.tab_id.as_str(), t.here))
            .collect::<Vec<_>>(),
        [("b", true), ("a", false), ("c", false)]
    );
    assert_eq!(state.outside_caller("outside:cli#1").unwrap().title, "cli");
    assert_eq!(state.parent_of("b"), Some("a"));
    assert_eq!(state.parent_of("a"), None);
    assert!(state.is_stopping("a") && !state.is_stopping("b"));
    // `summaryOf`: the tab's session file, else `tab:<id>`, on the computer that runs it.
    let a = &tabs[0];
    assert_eq!(running_agent_count(state.summary_of(a)), 1);
    assert!(state.summary_of(&state.tabs("b").unwrap()[0]).is_some());
    assert_eq!(state.summaries(Some("dev1")).len(), 1);
    assert_eq!(state.deleted_at_path("/s/z_3.jsonl", None), Some(5.0));
    assert_eq!(
        state.deleted_at_path("/s/z_3.jsonl", Some("dev1")),
        Some(6.0)
    );
    assert_eq!(state.deleted_at_id("z3"), Some(7.0));
    assert!(
        state.has_schedules(None)
            && state.has_schedules(Some("dev1"))
            && !state.has_schedules(Some("dev2"))
    );
    assert_eq!(
        state.text("stopTitle", &[("count", "2")]),
        "Stop 2 sessions?"
    );
    assert_eq!(
        state.text("stopTitle", &[("count", "1")]),
        "Stop 1 session?"
    );
    // No window for an outside caller: the call is refused.
    let mut none = state.clone();
    none.outside_window = None;
    assert!(none.tabs("outside:cli#1").is_none());
}

fn port_for(
    id: u64,
    state: Value,
) -> (
    Arc<Port<HostState>>,
    tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
) {
    let (writer, reader) = tokio::io::duplex(1 << 20);
    let (tx, _task) = crate::wire::spawn_writer(writer);
    let events = crate::server::test_events(&tx);
    // The writer holds the sender weakly through `Events`: keep it for the test's life.
    std::mem::forget(tx);
    let port =
        Port::<HostState>::open(&events, id, serde_json::from_value(state).unwrap()).unwrap();
    (port, BufReader::new(reader).lines())
}

#[tokio::test]
async fn a_waiter_sees_a_state_that_held_between_two_pushes() {
    let (port, _lines) = port_for(7_101, state_json(&[("a", "w1")]));
    let host = super::host::Host::new(port.clone(), Caps::default());
    let waiter = {
        let host = host.clone();
        tokio::spawn(async move {
            host.wait_for(Some(5_000), |state| {
                state
                    .tabs("a")
                    .filter(|tabs| tabs.len() == 2)
                    .map(|_| "seen")
            })
            .await
        })
    };
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    // The transient state (two tabs) is pushed and replaced at once: only the second is `state()` when the waiter runs.
    crate::ports::apply_state(
        &port,
        1,
        &state_json(&[("a", "w1"), ("b", "w1")]).to_string(),
    )
    .unwrap();
    crate::ports::apply_state(&port, 2, &state_json(&[("a", "w1")]).to_string()).unwrap();
    assert_eq!(port.state().tabs.len(), 1);
    assert_eq!(waiter.await.unwrap(), Some("seen"));
    port.close();
}

#[tokio::test(start_paused = true)]
async fn a_wait_that_finds_nothing_ends_with_a_fresh_read() {
    let (port, mut lines) = port_for(7_102, state_json(&[("a", "w1")]));
    let host = super::host::Host::new(port.clone(), Caps::default());
    let waiting = tokio::spawn({
        let host = host.clone();
        async move {
            host.wait_for(Some(100), |state| {
                state.tabs("a").filter(|tabs| tabs.len() == 3).map(|_| ())
            })
            .await
        }
    });
    // After its time passed it asks main for the state (`fresh`), as the TypeScript read after its timer.
    let line = lines.next_line().await.unwrap().unwrap();
    let event: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(event["data"]["method"], "state");
    crate::ports::apply_answer(&port, event["data"]["ask"].as_u64().unwrap(), Ok("null"));
    assert_eq!(waiting.await.unwrap(), None);
    port.close();
}

// ---- the pipeline against a fake main ------------------------------------------------------------------------------------

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

/// The args of every `method` main was asked or told so far.
fn names(asked: &Asked, method: &str) -> Vec<Value> {
    asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == method)
        .map(|(_, args)| args.clone())
        .collect()
}

/// Plays main: answers each ask with `reply(method, args)` and records it.
fn play_main(
    port: Arc<Port<HostState>>,
    mut lines: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> Asked {
    let asked: Asked = Arc::default();
    let record = asked.clone();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let event: Value = serde_json::from_str(&line).unwrap();
            let data = &event["data"];
            let (method, args) = (s(&data["method"]).to_owned(), data["args"].clone());
            record.lock().unwrap().push((method.clone(), args.clone()));
            if let Some(ask) = data["ask"].as_u64() {
                match reply(&method, &args) {
                    Ok(value) => crate::ports::apply_answer(&port, ask, Ok(&value.to_string())),
                    Err(message) => crate::ports::apply_answer(&port, ask, Err((&message, None))),
                }
            }
        }
    });
    asked
}

fn plain_main(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "stored" => Ok(json!([])),
        other => Err(format!("fake main has no {other}")),
    }
}

fn session_tab(id: &str, path: &str) -> Value {
    json!({ "tabId": id, "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false, "sessionPath": path })
}

fn rig(
    id: u64,
    state: Value,
    files: Files,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    let (port, lines) = port_for(id, state);
    let asked = play_main(port.clone(), lines, reply);
    (
        AgentControl::new(
            port,
            Caps::default(),
            &files,
            Tuning::default(),
            system_clock(),
        ),
        asked,
    )
}

fn state_with(tabs: Vec<Value>, windows: &[(&str, &str)]) -> Value {
    json!({
        "enabled": true,
        "tabs": tabs,
        "windowOf": windows.iter().map(|(id, w)| ((*id).to_owned(), json!(w))).collect::<Map<String, Value>>(),
    })
}

#[tokio::test]
async fn a_call_is_refused_while_the_tools_are_off_or_the_tab_is_gone() {
    let mut off = state_with(vec![session_tab("a", "/s/x_1.jsonl")], &[("a", "w")]);
    off["enabled"] = json!(false);
    let (control, asked) = rig(7_201, off, Files::default(), plain_main);
    let outcome = control.run("a", "ompdesk_sessions", json!({}), None).await;
    assert_eq!(
        outcome.text,
        "OMPdesk control tools are turned off (Settings › Tools & extensions). Ask the user to turn them on."
    );
    assert!(outcome.is_error && asked.lock().unwrap().is_empty());
    control.host.port().close();
    let (control, _) = rig(7_202, state_with(vec![], &[]), Files::default(), plain_main);
    assert_eq!(
        control
            .run("a", "ompdesk_sessions", json!({}), None)
            .await
            .text,
        "This session's tab is gone."
    );
    let unknown = control.run("a", "nope", json!({}), None).await;
    assert!(unknown.is_error);
    control.host.port().close();
}

#[tokio::test]
async fn an_invalid_call_is_answered_with_main_s_validation_and_a_valid_one_runs_its_family_body() {
    let state = state_with(vec![session_tab("a", "/s/x_1.jsonl")], &[("a", "w")]);
    let (control, asked) = rig(
        7_203,
        state,
        Files::default(),
        |method, args| match method {
            "args.parse"
                if args["tool"] == "ompdesk_notify"
                    && args["args"].as_object().is_some_and(Map::is_empty) =>
            {
                Ok(
                    json!({ "ok": false, "error": "Invalid arguments for ompdesk_notify: title: Required" }),
                )
            }
            other => plain_main(other, args),
        },
    );
    let bad = control.run("a", "ompdesk_notify", json!({}), None).await;
    assert_eq!(
        bad.text,
        "Invalid arguments for ompdesk_notify: title: Required"
    );
    let good = control
        .run("a", "ompdesk_notify", json!({ "title": "hi" }), None)
        .await;
    assert_eq!(
        good,
        ToolOutcome {
            text: "Notification shown.".into(),
            is_error: false
        }
    );
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(
        asked
            .lock()
            .unwrap()
            .iter()
            .any(|(method, args)| method == "notify" && args["title"] == "hi")
    );
    let listing = control.run("a", "ompdesk_sessions", json!({}), None).await;
    assert!(
        listing.text.starts_with("1 session in this window:\n- a "),
        "{}",
        listing.text
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_call_that_changes_something_runs_once_under_its_id() {
    let state = state_with(vec![session_tab("a", "/s/x_1.jsonl")], &[("a", "w")]);
    let files = Files {
        calls: Some(JournalFile { file: None }),
        ..Files::default()
    };
    let (control, asked) = rig(7_204, state, files, plain_main);
    let call = || {
        Some(super::CallId {
            id: "call-1".into(),
            resent: false,
        })
    };
    let first = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": "ghost" }),
            call(),
        )
        .await;
    assert!(
        first.is_error && first.text.starts_with("No session \"ghost\""),
        "{}",
        first.text
    );
    let again = control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": "ghost" }),
            call(),
        )
        .await;
    assert_eq!(again, first);
    let parses = asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "args.parse")
        .count();
    assert_eq!(
        parses, 1,
        "the repeat is answered from the journal and runs nothing"
    );
    // A call without an id is not recorded and runs each time.
    control
        .run(
            "a",
            "ompdesk_session_stop",
            json!({ "session": "ghost" }),
            None,
        )
        .await;
    let parses = asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "args.parse")
        .count();
    assert_eq!(parses, 2);
    control.host.port().close();
}

#[tokio::test]
async fn a_resent_call_with_no_record_is_reconciled_never_run() {
    let state = state_with(vec![session_tab("a", "/s/x_1.jsonl")], &[("a", "w")]);
    let files = Files {
        calls: Some(JournalFile { file: None }),
        ..Files::default()
    };
    let (control, asked) = rig(7_205, state, files, plain_main);
    let call = Some(super::CallId {
        id: "call-9".into(),
        resent: true,
    });
    let outcome = control
        .run(
            "a",
            "ompdesk_session_open",
            json!({ "message": "Title: Work\nbody" }),
            call,
        )
        .await;
    assert!(outcome.is_error);
    assert!(outcome.text.starts_with("This ompdesk_session_open call was started before OMPdesk restarted, and its outcome is unknown"), "{}", outcome.text);
    assert!(
        outcome
            .text
            .contains("Check ompdesk_sessions {\"mine\":true}")
    );
    assert!(
        asked
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| method != "args.parse" && method != "spawn")
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_name_finds_a_session_every_way_the_tools_read_one() {
    let mut a = session_tab("tab-aaaa", "/s/2026_sid-aaaa.jsonl");
    a["formerIds"] = json!(["old-tab"]);
    a["title"] = json!("Fix the Parser");
    let mut b = session_tab("tab-bbbb", "/s/2026_sid-bbbb.jsonl");
    b["title"] = json!("Fix the Printer");
    let mut c = session_tab("caller", "/s/2026_sid-cccc.jsonl");
    c["title"] = json!("Boss");
    let mut hidden = session_tab("tab-hid", "/s/2026_sid-hhhh.jsonl");
    hidden["title"] = json!("Secret plan");
    hidden["hidden"] = json!(true);
    let mut state = state_with(
        vec![a, b, c, hidden],
        &[
            ("tab-aaaa", "w"),
            ("tab-bbbb", "w"),
            ("caller", "w"),
            ("tab-hid", "w"),
        ],
    );
    state["closedChildren"] = json!([{ "path": "/s/2026_gone-1.jsonl", "openedBySession": "/s/2026_sid-cccc.jsonl", "title": "Old child", "cwd": "/w", "tabIds": ["tab-closed"], "closedAt": 5.0 }]);
    state["deleted"] = json!({ "byId": { "dead-id": 9.0 } });
    let (control, _) = rig(7_206, state, Files::default(), plain_main);
    let tabs = control.host.state().tabs("caller").unwrap();
    let id = |name: &'static str| {
        let control = control.clone();
        let tabs = tabs.clone();
        async move {
            match control.find(&tabs, name, None).await {
                Ok(found) => match found.target {
                    Some(Target::Tab(tab)) => format!("tab {}", tab.tab_id),
                    Some(Target::Stored(row)) => format!("stored {}", row.path),
                    None => found.gone.map_or("none".to_owned(), |fate| {
                        format!("gone {}", fate.session.ids.join(","))
                    }),
                },
                Err(error) => format!("error {}", error.message()),
            }
        }
    };
    assert_eq!(id("tab-aaaa").await, "tab tab-aaaa");
    assert_eq!(id("old-tab").await, "tab tab-aaaa");
    assert_eq!(id("sid-bbbb").await, "tab tab-bbbb");
    assert_eq!(id("tab-bb").await, "tab tab-bbbb");
    assert_eq!(id("\"sid-aaaa\"").await, "tab tab-aaaa");
    assert_eq!(id("fix the parser").await, "tab tab-aaaa");
    assert_eq!(id("fix the pa").await, "tab tab-aaaa");
    assert!(id("fix the").await.starts_with("error \"fix the\" matches several sessions: tab-aaaa \"Fix the Parser\" (saved id sid-aaaa); tab-bbbb"));
    assert!(
        id("tab-")
            .await
            .starts_with("error \"tab-\" matches several sessions")
    );
    // A hidden session's title is private: no match by title, but its ids still name it.
    assert_eq!(id("secret plan").await, "none");
    assert_eq!(id("tab-hid").await, "tab tab-hid");
    // The id of a tab that closed names the saved session it held; a tombstoned saved id names a deleted session.
    assert_eq!(id("tab-closed").await, "stored /s/2026_gone-1.jsonl");
    assert_eq!(id("dead-id").await, "gone dead-id");
    assert_eq!(id("nothing-like-it").await, "none");
    control.host.port().close();
}

#[tokio::test]
async fn a_closed_tab_s_id_keeps_naming_its_session_and_a_delete_says_so() {
    let state = state_with(
        vec![session_tab("caller", "/s/2026_sid-cccc.jsonl")],
        &[("caller", "w")],
    );
    let (control, _) = rig(7_207, state, Files::default(), plain_main);
    control.released(
        "tab-gone",
        Some(&ReleasedSession {
            path: "/s/2026_sid-gone.jsonl".into(),
            device: None,
            title: "Done work".into(),
            cwd: "/w".into(),
            former_ids: vec!["older".into()],
            hidden: false,
            opened_by_session: None,
        }),
    );
    let tabs = control.host.state().tabs("caller").unwrap();
    let found = control.find(&tabs, "older", None).await.unwrap();
    assert!(
        matches!(found.target, Some(Target::Stored(row)) if row.path == "/s/2026_sid-gone.jsonl" && row.title == "Done work")
    );
    let caller = tabs[0].clone();
    // A tombstone turns the closed session into a deleted one.
    let mut deleted = state_with(
        vec![session_tab("caller", "/s/2026_sid-cccc.jsonl")],
        &[("caller", "w")],
    );
    deleted["deleted"] = json!({ "byPath": [{ "path": super::host::node_resolve("/s/2026_sid-gone.jsonl"), "at": 1_700_000_000_000.0 }] });
    crate::ports::apply_state(control.host.port(), 5, &deleted.to_string()).unwrap();
    let error = control
        .resolve_any(&tabs, "tab-gone", &caller, "read", None)
        .await
        .unwrap_err();
    assert!(error.message().starts_with("Session \"tab-gone\" (\"Done work\") was deleted on 2023-11-14 22:13 UTC by someone in OMPdesk"), "{}", error.message());
    assert!(error.is_tool());
    control.host.port().close();
}

#[tokio::test]
async fn a_device_is_found_by_id_name_or_a_unique_part_and_waited_for_while_it_connects() {
    let mut state = state_with(vec![], &[]);
    state["devices"] = json!([{ "id": "d1", "name": "Mac mini", "state": "connecting" }, { "id": "d2", "name": "Macbook", "state": "online" }]);
    let (control, _) = rig(
        7_208,
        state.clone(),
        Files { ..Files::default() },
        plain_main,
    );
    assert!(control.device("local").unwrap().is_none());
    assert_eq!(control.device("d2").unwrap().unwrap().name, "Macbook");
    assert_eq!(control.device("MAC MINI").unwrap().unwrap().id, "d1");
    assert_eq!(control.device("mini").unwrap().unwrap().id, "d1");
    assert_eq!(
        control.device("mac").unwrap_err().message(),
        "No paired device \"mac\". Paired: Mac mini (d1), Macbook (d2); \"local\" is this computer."
    );
    let connecting = control.device("d1").unwrap().unwrap();
    let waiting = tokio::spawn({
        let control = control.clone();
        async move { control.reach(connecting).await.map(|device| device.state) }
    });
    tokio::task::yield_now().await;
    state["devices"][0]["state"] = json!("online");
    crate::ports::apply_state(control.host.port(), 3, &state.to_string()).unwrap();
    assert_eq!(waiting.await.unwrap().unwrap(), DeviceState::Online);
    // One that stays away fails after the wait, naming what to do.
    let short = Tuning {
        link_wait_ms: 40,
        link_poll_ms: 10,
        ..Tuning::default()
    };
    let (port, lines) = port_for(7_209, state_json(&[]));
    let _asked = play_main(port.clone(), lines, plain_main);
    let impatient = AgentControl::new(
        port,
        Caps::default(),
        &Files::default(),
        short,
        system_clock(),
    );
    let away = ControlDevice {
        id: "d9".into(),
        name: "Laptop".into(),
        state: DeviceState::Offline,
    };
    let error = impatient.reach(away).await.unwrap_err();
    assert!(
        error.message().starts_with("Laptop is no longer paired")
            || error
                .message()
                .starts_with("Laptop is offline (waited 0.04 s for its link)"),
        "{}",
        error.message()
    );
    control.host.port().close();
    impatient.host.port().close();
}

// ---- ompdesk_checks ------------------------------------------------------------------------------------------------

/// A service on port `id` whose `ompdesk_checks` asks the fake hub opened as the same id; main answers mail.
fn checks_rig(id: u64) -> (AgentControl, Asked, Arc<crate::checks::fake::FakeHub>) {
    let state = state_with(
        vec![
            session_tab("a", "/s/2026-11-14_a1b2c3d4.jsonl"),
            session_tab("b", "/s/2026-11-14_e5f6a7b8.jsonl"),
        ],
        &[("a", "w"), ("b", "w")],
    );
    let (control, asked) = rig(id, state, Files::default(), |method, args| match method {
        "mail" => Ok(json!({})),
        other => plain_main(other, args),
    });
    let hub = crate::checks::open_fake(id);
    control.checks.set(id).unwrap();
    (control, asked, hub)
}

fn red_result(run: &str, session: &str) -> crate::checks::contract::RunResult {
    use crate::checks::contract::*;
    RunResult {
        run_id: run.into(),
        origin: Origin::Session {
            session: session.into(),
            device: "local".into(),
            goal: None,
        },
        answer: Answer {
            run_id: run.into(),
            verdict: AnswerVerdict::Red,
            as_of: 1_794_000_000_000,
            counts: Counts {
                passed: 41,
                failed: 1,
            },
            failed: vec![{
                let record = TestRecord {
                    os: Os::Linux,
                    fails_7d: 1,
                    runs_7d: 9,
                    state: TestState::Active,
                    clean_runs: 0,
                    clear_after: 5,
                };
                FailedTest {
                    test: "src/a.test.ts > saves once".into(),
                    first_error: "AssertionError: expected 1 to be 2".into(),
                    known_flaky: false,
                    history: record.english(),
                    record,
                }
            }],
            blocks_release: Some(BlocksRelease {
                gate: "gate-mac".into(),
            }),
            expected_wait_min: None,
            reused: None,
            next: Next::Fix,
            notes: vec![],
            said: vec![],
        },
    }
}

#[tokio::test]
async fn a_start_asks_the_hub_as_the_calling_session_and_says_how_to_wait() {
    let (control, _, hub) = checks_rig(7_951);
    let started = control
        .run(
            "a",
            "ompdesk_checks",
            json!({ "op": "start", "purpose": "release" }),
            None,
        )
        .await;
    assert!(!started.is_error, "{}", started.text);
    assert!(
        started.text.starts_with("Checks started: run fake-1.")
            && started
                .text
                .contains(r#"ompdesk_checks {"op":"wait","run":"fake-1"}"#),
        "{}",
        started.text
    );
    let calls = hub.apply(crate::checks::fake::FakeOp::Calls);
    assert_eq!(calls[0]["op"], "start");
    // Who asks is the service's word: the session's saved id, never an argument.
    assert_eq!(
        calls[0]["origin"],
        json!({ "kind": "session", "session": "a1b2c3d4", "device": "local" })
    );
    assert_eq!(calls[0]["request"]["purpose"], "release");
    assert_eq!(calls[0]["request"]["cwd"], "/w");
    crate::checks::close_fake(7_951);
    control.host.port().close();
}

#[tokio::test]
async fn a_wait_ends_with_the_judgment_and_tells_no_one_twice() {
    let (control, asked, hub) = checks_rig(7_952);
    let waiting = {
        let control = control.clone();
        tokio::spawn(async move {
            control
                .run(
                    "a",
                    "ompdesk_checks",
                    json!({ "op": "wait", "run": "fake-1" }),
                    None,
                )
                .await
        })
    };
    while !control.is_blocked("a") {
        tokio::task::yield_now().await;
    }
    hub.apply(crate::checks::fake::FakeOp::Finish {
        result: red_result("fake-1", "a1b2c3d4"),
    });
    let answer = waiting.await.unwrap();
    assert!(!answer.is_error, "{}", answer.text);
    for part in [
        "Run fake-1: red",
        "41 passed, 1 failed.",
        "- src/a.test.ts > saves once\n  AssertionError: expected 1 to be 2\n  (not known flaky: on linux: failed 1 of 9 runs in 7 days)",
        "Blocks the release gate gate-mac.",
        "Next: fix the failures",
    ] {
        assert!(
            answer.text.contains(part),
            "{part:?} not in {}",
            answer.text
        );
    }
    // The wait delivered it: no waking note follows.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(names(&asked, "mail").is_empty());
    crate::checks::close_fake(7_952);
    control.host.port().close();
}

#[tokio::test]
async fn a_message_ends_a_checks_wait_early() {
    let (control, _, _hub) = checks_rig(7_953);
    let waiting = {
        let control = control.clone();
        tokio::spawn(async move {
            control
                .run(
                    "a",
                    "ompdesk_checks",
                    json!({ "op": "wait", "run": "fake-1", "timeout_seconds": 600 }),
                    None,
                )
                .await
        })
    };
    while !control.is_blocked("a") {
        tokio::task::yield_now().await;
    }
    control.arrive("a");
    let answer = waiting.await.unwrap();
    assert!(
        answer
            .text
            .starts_with("Returned early: a message reached you"),
        "{}",
        answer.text
    );
    assert!(!control.is_blocked("a"));
    crate::checks::close_fake(7_953);
    control.host.port().close();
}

#[tokio::test]
async fn a_result_wakes_the_session_that_started_it_when_it_does_not_wait() {
    let (control, asked, hub) = checks_rig(7_954);
    // The first call follows the hub's results.
    let status = control
        .run("b", "ompdesk_checks", json!({ "op": "status" }), None)
        .await;
    assert!(status.text.starts_with("Checks as of "), "{}", status.text);
    hub.apply(crate::checks::fake::FakeOp::Finish {
        result: red_result("fake-9", "e5f6a7b8"),
    });
    let mut mails = Vec::new();
    for _ in 0..200 {
        mails = names(&asked, "mail");
        if !mails.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(mails.len(), 1, "one waking note");
    assert_eq!(mails[0]["tabId"], "b");
    let text = mails[0]["content"].as_str().unwrap_or_default();
    assert!(
        text.contains("The checks you started have a result") && text.contains("Run fake-9: red"),
        "{text}"
    );
    assert_eq!(mails[0]["delivery"]["triggerTurn"], true);
    // The same result again tells nobody again.
    hub.apply(crate::checks::fake::FakeOp::Finish {
        result: red_result("fake-9", "e5f6a7b8"),
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(names(&asked, "mail").len(), 1);
    crate::checks::close_fake(7_954);
    control.host.port().close();
}

#[tokio::test]
async fn without_a_hub_the_tool_says_check_control_is_unavailable() {
    let state = state_with(vec![session_tab("a", "/s/x_1.jsonl")], &[("a", "w")]);
    let (control, _) = rig(7_955, state, Files::default(), plain_main);
    let outcome = control
        .run("a", "ompdesk_checks", json!({ "op": "status" }), None)
        .await;
    assert!(outcome.is_error);
    assert!(
        outcome.text.starts_with("Check control is not available"),
        "{}",
        outcome.text
    );
    control.host.port().close();
}
