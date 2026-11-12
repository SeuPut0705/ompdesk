//! Tests of the message tools against a fake main: what an agent reads back from a send, a report, an answer and a
//! card, and what main is asked or told meanwhile.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::host::{Caps, HostState};
use super::super::tuning::Tuning;
use super::super::{AgentControl, Files};
use crate::agentctl::journal::system_clock;
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

fn rig(
    id: u64,
    state: Value,
    tuning: Tuning,
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
    let control = AgentControl::new(
        port,
        Caps::default(),
        &Files::default(),
        tuning,
        system_clock(),
    );
    (control, asked)
}

fn main_replies(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "command" => match args["command"]["type"].as_str() {
            Some("prompt") => Ok(json!({ "success": true })),
            Some("get_state") => Ok(json!({ "success": true, "data": { "isStreaming": false } })),
            _ => Ok(json!({ "success": false, "error": "no" })),
        },
        "mail" | "answer" | "markAnswered" => Ok(Value::Null),
        other => Err(format!("fake main has no {other}")),
    }
}

fn tab(id: &str) -> Value {
    json!({ "tabId": id, "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false, "sessionPath": format!("/s/{id}_1.jsonl") })
}

fn state(tabs: Vec<Value>) -> Value {
    let windows: Map<String, Value> = tabs
        .iter()
        .map(|tab| (tab["tabId"].as_str().unwrap().to_owned(), json!("w")))
        .collect();
    json!({
        "enabled": true,
        "approveEnabled": true,
        "tabs": tabs,
        "windowOf": windows,
        "parents": { "b": { "callerTabId": "a" } },
    })
}

fn asked_with(asked: &Asked, method: &str) -> Vec<Value> {
    asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == method)
        .map(|(_, args)| args.clone())
        .collect()
}

#[tokio::test]
async fn a_send_to_an_idle_child_hands_over_a_numbered_dispatch_and_repeats_its_receipt() {
    let tuning = Tuning {
        turn_start_wait_ms: 40,
        ..Tuning::default()
    };
    let (control, asked) = rig(9_301, state(vec![tab("a"), tab("b")]), tuning, main_replies);
    let args = json!({ "session": "b", "message": "do it", "request_id": "r1" });
    let first = control
        .run("a", "ompdesk_session_send", args.clone(), None)
        .await;
    assert!(!first.is_error, "{}", first.text);
    assert_eq!(
        first.text,
        "Sent to \"b\" (saved id 1): accepted; it was idle, but no turn started within 0.04 s: see ompdesk_session_result before sending it again. Dispatch d1: it reports back with ompdesk_report."
    );
    let prompts: Vec<Value> = asked_with(&asked, "command")
        .into_iter()
        .filter(|args| args["command"]["type"] == "prompt")
        .collect();
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["command"]["streamingBehavior"], "steer");
    assert!(
        prompts[0]["command"]["message"]
            .as_str()
            .unwrap()
            .contains("[ompdesk dispatch d1:")
    );
    let again = control.run("a", "ompdesk_session_send", args, None).await;
    assert_eq!(
        again.text,
        format!(
            "{} (request r1 was already delivered; nothing sent again)",
            first.text
        )
    );
    let to_itself = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({ "session": "a", "message": "x" }),
            None,
        )
        .await;
    // The tool resolves its target first, and that refuses the caller's own session (`#sendTarget`), as the
    // TypeScript did before `#send` could say it.
    assert_eq!(
        to_itself.text,
        "You cannot send to your own session with this tool."
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_report_reaches_the_opener_once_and_says_what_to_do_next() {
    let (control, asked) = rig(
        9_302,
        state(vec![tab("a"), tab("b")]),
        Tuning::default(),
        main_replies,
    );
    let args = json!({ "kind": "question", "text": "which one?" });
    let first = control.run("b", "ompdesk_report", args.clone(), None).await;
    assert_eq!(
        first.text,
        "Delivered. Wait for the answer: it comes as a message (between your steps while this turn runs); do not guess the decision meanwhile."
    );
    let mails = asked_with(&asked, "mail");
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0]["tabId"], "a");
    assert!(mails[0]["content"].as_str().unwrap().contains("which one?"));
    let again = control.run("b", "ompdesk_report", args, None).await;
    assert!(
        again.text.starts_with("Report ")
            && again
                .text
                .contains("was already delivered; nothing sent again."),
        "{}",
        again.text
    );
    assert_eq!(asked_with(&asked, "mail").len(), 1);
    // A session nobody opened has no one to report to.
    let alone = control
        .run(
            "a",
            "ompdesk_report",
            json!({ "kind": "done", "text": "x" }),
            None,
        )
        .await;
    assert!(
        alone.is_error
            && alone
                .text
                .starts_with("ompdesk_report goes to the session that opened you")
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_answer_picks_the_option_and_a_tool_approval_needs_the_user_s_leave() {
    let mut card = tab("b");
    card["asks"] = json!([{ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Pick", "options": ["Red", "Blue"] } }]);
    let (control, asked) = rig(
        9_303,
        state(vec![tab("a"), card.clone()]),
        Tuning::default(),
        main_replies,
    );
    let done = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "choice": "blue" }),
            None,
        )
        .await;
    assert_eq!(
        done.text,
        "Answered \"b\": \"Blue\" to \"Pick\". It continues now."
    );
    assert_eq!(asked_with(&asked, "answer")[0]["response"]["value"], "Blue");
    let missing = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b" }),
            None,
        )
        .await;
    assert_eq!(
        missing.text,
        "No choice given: pass `choice` with one of: \"Red\" | \"Blue\"."
    );
    control.host.port().close();

    let mut approval = tab("b");
    approval["asks"] = json!([{ "id": "r2", "request": { "id": "r2", "method": "select", "title": "Allow tool: bash\nrm", "options": ["Approve", "Deny"] } }]);
    let mut off = state(vec![tab("a"), approval]);
    off["approveEnabled"] = json!(false);
    let (control, _) = rig(9_304, off, Tuning::default(), main_replies);
    let refused = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "approve": true }),
            None,
        )
        .await;
    assert!(
        refused.is_error && refused.text.starts_with("사용자 승인이 필요해요:"),
        "{}",
        refused.text
    );
    let denied = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "approve": false }),
            None,
        )
        .await;
    assert!(!denied.is_error, "{}", denied.text);
    control.host.port().close();
}

#[tokio::test]
async fn a_child_s_card_reaches_its_opener_once_and_focus_and_notify_tell_main() {
    let mut card = tab("b");
    card["asks"] =
        json!([{ "id": "r1", "request": { "id": "r1", "method": "confirm", "title": "Go on?" } }]);
    let (control, asked) = rig(
        9_305,
        state(vec![tab("a"), card]),
        Tuning::default(),
        main_replies,
    );
    control.child_asked("a", "b", "r1").await.unwrap();
    control.child_asked("a", "b", "r1").await.unwrap();
    let mails = asked_with(&asked, "mail");
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0]["tabId"], "a");
    assert_eq!(mails[0]["details"]["kind"], "question");
    let shown = control
        .run("a", "ompdesk_tab_focus", json!({ "session": "b" }), None)
        .await;
    assert_eq!(shown.text, "Showing \"b\" (focus).");
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(asked_with(&asked, "view")[0]["event"]["tabId"], "b");
    control.host.port().close();
}
