//! Tests of the runtime against a fake main: what it keeps and sends again (reports, a routine's wake-up), how a
//! wake-up ends, which tabs are openers and what a deleted session leaves out of the closed list. What main does with
//! the tells is main's (the vitest suite `host.test.ts` runs the whole through the real core).

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::activity::{Activity, ActivityKind, Outcome};
use super::{Runtime, RuntimeConfig, start};
use crate::agentctl::journal::system_clock;
use crate::agentctl::service::host::{Caps, HostState};
use crate::agentctl::service::tuning::Tuning;
use crate::agentctl::service::{AgentControl, Files, JournalFile};
use crate::ports::Port;

type Told = Arc<Mutex<Vec<(String, Value)>>>;

/// What a fake main replies to hold an ask.
const HOLD: &str = "__hold__";

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

/// Plays main: records every ask and tell, answers an ask with `reply(method, args)`.
fn play_main(
    port: Arc<Port<HostState>>,
    mut lines: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> Told {
    let told: Told = Arc::default();
    let record = told.clone();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let event: Value = serde_json::from_str(&line).unwrap();
            let data = &event["data"];
            let method = data["method"].as_str().unwrap_or("").to_owned();
            let args = data["args"].clone();
            record.lock().unwrap().push((method.clone(), args.clone()));
            if let Some(ask) = data["ask"].as_u64() {
                match reply(&method, &args) {
                    // Main holds the ask: it is answered never (a git that reads for as long as the test runs).
                    Err(message) if message == HOLD => {}
                    Ok(value) => crate::ports::apply_answer(&port, ask, Ok(&value.to_string())),
                    Err(message) => crate::ports::apply_answer(&port, ask, Err((&message, None))),
                }
            }
        }
    });
    told
}

fn tab(id: &str, path: &str) -> Value {
    json!({ "tabId": id, "title": id, "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false, "sessionPath": path })
}

fn state(tabs: Vec<Value>) -> Value {
    let windows: Map<String, Value> = tabs
        .iter()
        .map(|tab| (tab["tabId"].as_str().unwrap().to_owned(), json!("w")))
        .collect();
    json!({ "enabled": true, "tabs": tabs, "windowOf": windows })
}

fn rig(
    id: u64,
    state: Value,
    files: Files,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Arc<Runtime>, Told) {
    let (port, lines) = port_for(id, state);
    let told = play_main(port.clone(), lines, reply);
    let control = AgentControl::new(
        port,
        Caps::default(),
        &files,
        Tuning::default(),
        system_clock(),
    );
    let runtime = start(
        control.clone(),
        id,
        RuntimeConfig {
            sweep_ms: 0,
            ..RuntimeConfig::default()
        },
    );
    (control, runtime, told)
}

fn with_outbox() -> Files {
    Files {
        mail_outbox: Some(JournalFile { file: None }),
        ..Files::default()
    }
}

fn told_of(told: &Told, method: &str) -> Vec<Value> {
    told.lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == method)
        .map(|(_, args)| args.clone())
        .collect()
}

fn mail_details(id: &str) -> Value {
    json!({ "id": id, "from": "kid", "kind": "done" })
}

const DELIVERY: crate::agentctl::rules::mail::MailDelivery =
    crate::agentctl::rules::mail::MailDelivery {
        trigger_turn: true,
        aside: true,
    };

#[tokio::test]
async fn a_report_is_kept_until_the_receiver_s_journal_holds_it() {
    // The bridge says queued, not journaled: the report stays kept.
    let (control, _runtime, _told) = rig(
        7_401,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        with_outbox(),
        |method, _| match method {
            "mail" => Ok(json!({ "duplicate": false })),
            other => Err(format!("no {other}")),
        },
    );
    control
        .host
        .mail("boss", "text", &mail_details("m-1"), DELIVERY)
        .await
        .unwrap();
    let outbox = control.host.outbox().unwrap();
    assert_eq!(outbox.pending().len(), 1);
    assert_eq!(outbox.pending()[0].session_path, "/s/boss.jsonl");
    control.host.port().close();

    // The bridge already holds it in its journal: settled at once.
    let (control, _runtime, _told) = rig(
        7_402,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        with_outbox(),
        |_, _| Ok(json!({ "duplicate": true, "journaled": true })),
    );
    control
        .host
        .mail("boss", "text", &mail_details("m-2"), DELIVERY)
        .await
        .unwrap();
    assert!(control.host.outbox().unwrap().pending().is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn a_report_to_an_outside_caller_or_a_tab_with_no_session_file_is_kept_nowhere() {
    let mut bare = tab("bare", "");
    bare.as_object_mut().unwrap().remove("sessionPath");
    let (control, _runtime, told) = rig(7_403, state(vec![bare]), with_outbox(), |_, _| {
        Ok(Value::Null)
    });
    control
        .host
        .mail("bare", "t", &mail_details("m-3"), DELIVERY)
        .await
        .unwrap();
    control
        .host
        .mail("outside:cli#1", "t", &mail_details("m-4"), DELIVERY)
        .await
        .unwrap();
    assert!(control.host.outbox().unwrap().pending().is_empty());
    // Both still went to main, which sends the first to its omp and the second to its event stream.
    assert_eq!(told_of(&told, "mail").len(), 2);
    control.host.port().close();
}

#[tokio::test]
async fn a_pass_sends_a_kept_report_again_to_the_tab_that_holds_its_session_until_it_is_journaled()
{
    let answers: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(vec![
        json!({ "duplicate": true, "journaled": false }),
        json!({ "duplicate": true, "journaled": true }),
    ]));
    let queue = answers.clone();
    let (control, runtime, told) = rig(
        7_404,
        state(vec![tab("boss9", "/s/boss.jsonl")]),
        with_outbox(),
        move |method, _| match method {
            "mail" => Ok(queue.lock().unwrap().remove(0)),
            other => Err(format!("no {other}")),
        },
    );
    // Kept when the report was accepted by an omp that is gone now.
    control
        .host
        .outbox()
        .unwrap()
        .keep(crate::agentctl::journal::mail_outbox::OutboxMail {
            id: "m-5".into(),
            session_path: "/s/boss.jsonl".into(),
            device: None,
            from: None,
            from_device: None,
            content: "c".into(),
            details: mail_details("m-5"),
            delivery: DELIVERY,
            attachments: None,
            attachments_corrupt: false,
            at: control.now(),
        })
        .unwrap();
    for _ in 0..2 {
        runtime.redeliver_mail();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while runtime.rt().redelivering {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    assert!(control.host.outbox().unwrap().pending().is_empty());
    let sent = told_of(&told, "mail");
    assert_eq!(sent.len(), 2);
    assert!(sent.iter().all(|args| args["tabId"] == "boss9"));
    // Settled: a further pass sends nothing.
    runtime.redeliver_mail();
    tokio::task::yield_now().await;
    assert_eq!(told_of(&told, "mail").len(), 2);
    control.host.port().close();
}

/// The `wakeDone` of `run`, once main was told (a tell reaches the fake main on its own task).
async fn done(told: &Told, run: &str) -> Option<Value> {
    for _ in 0..200 {
        if let Some(found) = told_of(told, "wakeDone")
            .into_iter()
            .find(|args| args["runId"] == run)
        {
            return Some(found);
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    None
}

/// Lets what was told so far reach the fake main.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
}

fn activity(kind: ActivityKind, tab: &str, outcome: Option<(&str, Option<&str>)>) -> Activity {
    Activity {
        kind,
        tab_id: tab.to_owned(),
        request_id: None,
        outcome: outcome.map(|(reason, message)| Outcome {
            stop_reason: Some(reason.to_owned()),
            error_message: message.map(str::to_owned),
        }),
        parent: None,
        announce: false,
        session: None,
    }
}

fn wake_main(method: &str, _args: &Value) -> Result<Value, String> {
    match method {
        "reach" => Ok(json!("boss")),
        "mail" => Ok(Value::Null),
        other => Err(format!("no {other}")),
    }
}

async fn woken(id: u64, run: &str) -> (AgentControl, Arc<Runtime>, Told) {
    let (control, runtime, told) = rig(
        id,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        with_outbox(),
        wake_main,
    );
    runtime
        .wake(run, "/s/boss.jsonl", "check the build", "Look at it", 130)
        .await
        .unwrap();
    (control, runtime, told)
}

#[tokio::test]
async fn a_wake_up_is_kept_and_handed_to_the_tab_that_holds_the_session() {
    let (control, _runtime, told) = woken(7_405, "run-1").await;
    // Kept for the receiver's journal, sent to its tab as a note that starts a turn.
    let kept = control.host.outbox().unwrap().pending();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].id, "wake-run-1");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while told_of(&told, "mail").is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let sent = &told_of(&told, "mail")[0];
    assert_eq!(sent["tabId"], "boss");
    assert_eq!(
        sent["delivery"],
        json!({ "triggerTurn": true, "deliverAs": "aside" })
    );
    assert_eq!(sent["details"]["id"], "wake-run-1");
    assert_eq!(sent["details"]["kind"], "note");
    assert!(sent["content"].as_str().unwrap().contains("Look at it"));
    assert!(
        sent["content"]
            .as_str()
            .unwrap()
            .contains("One of your routines started this turn")
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_wake_up_ends_with_the_turn_it_started() {
    let (control, runtime, told) = woken(7_406, "run-a").await;
    // Another tab's activity ends nothing.
    runtime.activity(activity(ActivityKind::Idle, "other", Some(("stop", None))));
    settle().await;
    assert!(told_of(&told, "wakeDone").is_empty());
    runtime.activity(activity(ActivityKind::Busy, "boss", None));
    runtime.activity(activity(
        ActivityKind::Idle,
        "boss",
        Some(("error", Some("rate limited"))),
    ));
    let ended = done(&told, "run-a").await.unwrap();
    assert_eq!(ended["code"], Value::Null);
    assert_eq!(ended["error"], "rate limited");
    control.host.port().close();
}

#[tokio::test]
async fn a_turn_that_started_and_ended_in_one_batch_ends_the_run_too_and_a_stop_is_its_own_code() {
    let (control, runtime, told) = woken(7_407, "run-q").await;
    runtime.activity(activity(ActivityKind::Idle, "boss", Some(("stop", None))));
    assert_eq!(done(&told, "run-q").await.unwrap()["code"], 0);

    runtime
        .wake("run-s", "/s/boss.jsonl", "t", "p", 130)
        .await
        .unwrap();
    runtime.activity(activity(ActivityKind::Busy, "boss", None));
    let (holder, started) = runtime.wake_stop("run-s");
    assert_eq!((holder.as_deref(), started), (Some("boss"), true));
    assert_eq!(done(&told, "run-s").await.unwrap()["code"], 130);

    runtime
        .wake("run-x", "/s/boss.jsonl", "t", "p", 130)
        .await
        .unwrap();
    runtime.activity(activity(
        ActivityKind::Idle,
        "boss",
        Some(("aborted", None)),
    ));
    assert_eq!(done(&told, "run-x").await.unwrap()["code"], 130);

    runtime
        .wake("run-c", "/s/boss.jsonl", "t", "p", 130)
        .await
        .unwrap();
    runtime.activity(activity(ActivityKind::Released, "boss", None));
    assert_eq!(
        done(&told, "run-c").await.unwrap()["error"],
        "The session's tab closed before its turn ended"
    );
    control.host.port().close();
}

#[tokio::test(start_paused = true)]
async fn a_wake_up_that_starts_no_turn_fails_its_run() {
    let (control, _runtime, told) = woken(7_408, "run-t").await;
    assert!(told_of(&told, "wakeDone").is_empty());
    tokio::time::sleep(std::time::Duration::from_millis(120_001)).await;
    assert_eq!(
        done(&told, "run-t").await.unwrap()["error"],
        "The session started no turn on the wake-up within 2 minutes"
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_wake_up_whose_session_cannot_be_reached_fails_and_keeps_nothing() {
    let (control, runtime, _told) =
        rig(
            7_409,
            state(vec![]),
            with_outbox(),
            |method, _| match method {
                "reach" => Err("No window to open the session in.".into()),
                other => Err(format!("no {other}")),
            },
        );
    let error = runtime
        .wake("run-f", "/s/gone.jsonl", "t", "p", 130)
        .await
        .unwrap_err();
    assert_eq!(error.message(), "No window to open the session in.");
    assert!(control.host.outbox().unwrap().pending().is_empty());
    assert!(runtime.rt().wakes.is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn the_openers_are_the_tabs_that_opened_a_session_the_auto_close_may_close() {
    let mut kid = tab("kid", "/s/kid.jsonl");
    kid["autoClosable"] = json!(true);
    let mut run_child = tab("run-child", "/s/run.jsonl");
    run_child["autoClosable"] = json!(true);
    let mut from_outside = tab("by-outside", "/s/o.jsonl");
    from_outside["autoClosable"] = json!(true);
    let mut people = tab("person", "/s/p.jsonl");
    people["autoClosable"] = json!(false);
    let mut st = state(vec![
        tab("boss", "/s/boss.jsonl"),
        kid,
        run_child,
        from_outside,
        people,
    ]);
    st["parents"] = json!({
        "kid": { "callerTabId": "boss" },
        "run-child": { "callerTabId": "boss", "tag": "autopilot-child" },
        "by-outside": { "callerTabId": "outside:cli#1" },
        "person": { "callerTabId": "boss" },
    });
    let (control, runtime, _told) = rig(7_410, st, Files::default(), |_, _| Ok(Value::Null));
    // An outside caller has no session to collect into, and a tab the rules do not close counts for none. (The
    // Autopilot child's `autoClosable` is false from main; here it is marked on, as main never does, and counts.)
    assert_eq!(runtime.openers(), vec!["boss".to_owned()]);
    control.host.port().close();
}

#[tokio::test]
async fn a_deleted_session_leaves_the_closed_list_and_its_ids_keep_naming_it() {
    let record = |path: &str, device: Option<&str>| {
        let mut row = json!({ "path": path, "openedBySession": "/s/parent.jsonl", "title": path, "cwd": "/repo", "closedAt": 1.0, "tabIds": ["t-1"] });
        if let Some(device) = device {
            row["device"] = json!(device);
        }
        row
    };
    let mut st = state(vec![]);
    st["closedChildren"] = json!([
        record("/s/kid.jsonl", None),
        record("/s/kid.jsonl", Some("dev-1")),
        record("/s/other.jsonl", None)
    ]);
    st["deleted"] = json!({ "byPath": [{ "path": "/s/kid.jsonl", "device": "dev-1", "at": 7.0 }] });
    let (control, runtime, told) = rig(7_411, st, Files::default(), |_, _| Ok(Value::Null));
    runtime.forget_deleted();
    settle().await;
    let rows = told_of(&told, "closedChildren");
    assert_eq!(rows.len(), 1);
    let kept: Vec<&str> = rows[0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["device"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(kept, ["", ""], "only the device's own record went");
    assert!(
        control
            .fates()
            .of("/s/kid.jsonl", Some("dev-1"))
            .is_some_and(|fate| fate.session.ids == ["t-1"])
    );

    // Nothing deleted: main is told nothing.
    let (control, runtime, told) = rig(7_412, state(vec![]), Files::default(), |_, _| {
        Ok(Value::Null)
    });
    runtime.forget_deleted();
    settle().await;
    assert!(told_of(&told, "closedChildren").is_empty());
    control.host.port().close();
}

/// A boss with one child it opened (`autoClosable`), the child running a turn.
fn family() -> Value {
    let mut kid = tab("kid", "/s/kid.jsonl");
    kid["autoClosable"] = json!(true);
    kid["busy"] = json!(true);
    kid["lastRun"] = json!({ "stopReason": "stop" });
    let mut st = state(vec![tab("boss", "/s/boss.jsonl"), kid]);
    st["parents"] = json!({ "kid": { "callerTabId": "boss" } });
    st
}

fn quiet_main(method: &str, _args: &Value) -> Result<Value, String> {
    match method {
        "command" => Ok(json!({ "type": "response", "success": true, "data": {} })),
        other => Err(format!("no {other}")),
    }
}

fn asks_of(told: &Told, method: &str) -> usize {
    told_of(told, method).len()
}

#[tokio::test]
async fn a_timer_review_of_an_opener_never_starts_while_its_last_one_still_reads() {
    let (control, runtime, told) = rig(7_420, family(), Files::default(), |method, _| {
        // Whatever a review asks main for (the child's state, git) never answers.
        if method == "command" {
            Err(HOLD.to_owned())
        } else {
            Err(format!("no {method}"))
        }
    });
    runtime.sweep_all();
    for _ in 0..200 {
        if asks_of(&told, "command") > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let started = asks_of(&told, "command");
    assert!(started > 0, "the review began reading");
    assert!(runtime.rt().sweep_reviews.contains("boss"));
    // The next tick finds the last one still reading: it starts nothing.
    runtime.sweep_all();
    settle().await;
    assert_eq!(asks_of(&told, "command"), started);
    control.host.port().close();
}

#[tokio::test]
async fn a_running_child_is_read_again_only_when_it_moved_and_a_list_went_out() {
    let (control, runtime, told) = rig(7_421, family(), Files::default(), quiet_main);
    // Nothing was sent yet: a board that asks has nothing to compare to.
    runtime.live_review("boss").await;
    assert_eq!(asks_of(&told, "command"), 0);

    runtime.push_review("boss");
    for _ in 0..400 {
        if !told_of(&told, "reviewSent").is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let sent = told_of(&told, "reviewSent");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["tabId"], "boss");
    assert_eq!(sent[0]["review"]["items"][0]["tabId"], "kid");
    // Its running child is told to the opener's prompt suggestions once.
    settle().await;
    assert_eq!(told_of(&told, "nextPromptChildren").len(), 1);
    let after_list = asks_of(&told, "command");

    // The child did nothing since the list went out: a board that asks reads nothing.
    runtime.live_review("boss").await;
    settle().await;
    assert_eq!(asks_of(&told, "command"), after_list);

    // It moved on (a tool call): the next ask reads it again; with nothing moved since, it reads nothing.
    let mut step = activity(ActivityKind::Step, "kid", None);
    step.parent = Some("boss".to_owned());
    runtime.activity(step);
    runtime.live_review("boss").await;
    settle().await;
    let after_live = asks_of(&told, "command");
    assert!(after_live > after_list, "the moved child was read again");
    runtime.live_review("boss").await;
    settle().await;
    assert_eq!(asks_of(&told, "command"), after_live);
    control.host.port().close();
}

fn recipient(path: &str) -> super::wake::MailRecipient {
    super::wake::MailRecipient {
        session_path: path.into(),
        device: None,
    }
}

struct MailDir(std::path::PathBuf);

impl MailDir {
    fn new() -> Self {
        Self(crate::fs::disk::make_temp_dir("ompdesk-runtime-mail-").unwrap())
    }

    fn files(&self) -> Files {
        Files {
            mail_outbox: Some(JournalFile {
                file: Some(self.0.join("mail.json")),
            }),
            ..Files::default()
        }
    }
}

impl Drop for MailDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn failed_wake_storage_removes_tracking_and_sends_no_prompt() {
    let dir = MailDir::new();
    std::fs::create_dir(dir.0.join("mail.json")).unwrap();
    let (control, runtime, told) = rig(
        7_430,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        dir.files(),
        wake_main,
    );
    assert!(
        runtime
            .wake("failed", "/s/boss.jsonl", "routine", "work", 130)
            .await
            .is_err()
    );
    assert!(runtime.rt().wakes.is_empty());
    assert!(told_of(&told, "mail").is_empty());
    assert_eq!(
        control.host.outbox().unwrap().pending()[0].id,
        "wake-failed"
    );
    control.host.port().close();
}

#[tokio::test]
async fn a_wake_without_an_outbox_cannot_send_or_leave_a_watcher() {
    let (control, runtime, told) = rig(
        7_431,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        Files::default(),
        wake_main,
    );
    assert!(
        runtime
            .wake("missing", "/s/boss.jsonl", "routine", "work", 130)
            .await
            .is_err()
    );
    assert!(runtime.rt().wakes.is_empty());
    assert!(told_of(&told, "mail").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn enqueue_memory_and_disk_failure_never_ack_disk_or_start_delivery() {
    use crate::agentctl::journal::Persistence;
    let expected = recipient("/s/boss.jsonl");
    let (control, runtime, told) = rig(
        7_432,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        with_outbox(),
        wake_main,
    );
    assert_eq!(
        runtime
            .enqueue_mail(
                "checks:hub:entry-1:result",
                "boss",
                "Checks",
                "answer",
                &expected
            )
            .unwrap(),
        Persistence::Memory
    );
    assert!(runtime.rt().wakes.is_empty());
    assert!(told_of(&told, "mail").is_empty());
    control.host.port().close();
    let dir = MailDir::new();
    std::fs::create_dir(dir.0.join("mail.json")).unwrap();
    let (control, runtime, told) = rig(
        7_433,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        dir.files(),
        wake_main,
    );
    assert!(
        runtime
            .enqueue_mail(
                "checks:hub:entry-1:result",
                "boss",
                "Checks",
                "answer",
                &expected
            )
            .is_err()
    );
    assert!(told_of(&told, "mail").is_empty());
    assert_eq!(
        control.host.outbox().unwrap().pending()[0].id,
        "system-checks:hub:entry-1:result"
    );
    assert!(runtime.rt().wakes.is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn enqueue_revalidates_resolved_identity_visibility_and_control_before_keep() {
    let expected = recipient("/s/boss.jsonl");
    let mut hidden = tab("boss", "/s/boss.jsonl");
    hidden["hidden"] = json!(true);
    let mut paired = tab("boss", "/s/boss.jsonl");
    paired["device"] = json!("another-device");
    let mut disabled = state(vec![tab("boss", "/s/boss.jsonl")]);
    disabled["enabled"] = json!(false);
    let mut deleted = state(vec![tab("boss", "/s/boss.jsonl")]);
    deleted["deleted"] = json!({ "byPath": [{ "path": "/s/boss.jsonl", "at": 7.0 }] });
    let mut deleting = state(vec![tab("boss", "/s/boss.jsonl")]);
    deleting["mailBlocked"] = json!(["boss"]);
    let states = [
        state(vec![tab("boss", "/s/changed.jsonl")]),
        state(vec![hidden]),
        state(vec![paired]),
        disabled,
        deleted,
        deleting,
    ];
    for (index, state) in states.into_iter().enumerate() {
        let (control, runtime, told) = rig(7_440 + index as u64, state, with_outbox(), wake_main);
        assert!(
            runtime
                .enqueue_mail(
                    "checks:hub:entry-1:result",
                    "boss",
                    "Checks",
                    "answer",
                    &expected
                )
                .is_err()
        );
        assert!(control.host.outbox().unwrap().pending().is_empty());
        assert!(told_of(&told, "mail").is_empty());
        control.host.port().close();
    }
}

#[tokio::test]
async fn disk_enqueue_survives_reload_and_receiver_journal_deduplicates_effect() {
    use crate::agentctl::journal::{Persistence, mail_outbox::MailOutbox};
    let dir = MailDir::new();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let journal = Arc::new(Mutex::new(std::collections::HashSet::new()));
    let receiver = journal.clone();
    let (control, runtime, _) = rig(
        7_450,
        state(vec![tab("boss", "/s/boss.jsonl")]),
        dir.files(),
        move |method, args| {
            if method != "mail" {
                return Err(format!("unexpected {method}"));
            }
            let id = args["details"]["id"].as_str().unwrap().to_owned();
            let duplicate = !receiver.lock().unwrap().insert(id.clone());
            sent.send((id, duplicate)).unwrap();
            Ok(json!({ "duplicate": duplicate, "journaled": duplicate }))
        },
    );
    let expected = recipient("/s/boss.jsonl");
    let delivery = "checks:hub:entry-1:result";
    assert_eq!(
        runtime
            .enqueue_mail(delivery, "boss", "Checks", "answer", &expected)
            .unwrap(),
        Persistence::Disk
    );
    assert_eq!(
        received.recv().await.unwrap(),
        (format!("system-{delivery}"), false)
    );
    let restored = MailOutbox::new(Some(dir.0.join("mail.json")));
    assert_eq!(restored.pending()[0].id, format!("system-{delivery}"));
    assert_eq!(
        runtime
            .enqueue_mail(delivery, "boss", "Checks", "answer", &expected)
            .unwrap(),
        Persistence::Disk
    );
    assert_eq!(
        received.recv().await.unwrap(),
        (format!("system-{delivery}"), true)
    );
    assert_eq!(journal.lock().unwrap().len(), 1);
    assert!(runtime.rt().wakes.is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn paired_mail_acceptance_rechecks_online_pairing_before_keep() {
    use crate::agentctl::journal::Persistence;
    for (index, link) in [None, Some("offline"), Some("connecting"), Some("online")]
        .into_iter()
        .enumerate()
    {
        let mut paired = tab("boss", "/s/boss.jsonl");
        paired["device"] = json!("peer");
        let mut snapshot = state(vec![paired]);
        snapshot["devices"] = link.map_or_else(
            || json!([]),
            |state| json!([{ "id": "peer", "name": "Peer", "state": state }]),
        );
        let (control, runtime, told) =
            rig(7_460 + index as u64, snapshot, with_outbox(), wake_main);
        let expected = super::wake::MailRecipient {
            session_path: "/s/boss.jsonl".into(),
            device: Some("peer".into()),
        };
        let receipt = runtime.enqueue_mail(
            "checks:hub:entry-1:result",
            "boss",
            "Checks",
            "answer",
            &expected,
        );
        if link == Some("online") {
            assert_eq!(receipt.unwrap(), Persistence::Memory);
            assert_eq!(
                control.host.outbox().unwrap().pending()[0]
                    .device
                    .as_deref(),
                Some("peer")
            );
        } else {
            assert!(receipt.is_err());
            assert!(control.host.outbox().unwrap().pending().is_empty());
        }
        assert!(told_of(&told, "mail").is_empty());
        control.host.port().close();
    }
}

#[tokio::test]
async fn authenticated_mail_targets_rebind_by_session_without_reusing_stale_tokens() {
    use crate::agentctl::journal::{Persistence, mail_outbox::RedeliverDeps};
    let mut initial = state(Vec::new());
    initial["mailTargets"] = json!([tab("connection-a:tab:omp-1", "/s/boss.jsonl")]);
    let (control, runtime, told) = rig(7_470, initial, with_outbox(), |method, _| {
        if method == "mail" {
            Ok(json!({ "duplicate": false }))
        } else {
            Err(format!("unexpected {method}"))
        }
    });
    let expected = recipient("/s/boss.jsonl");
    assert_eq!(
        runtime
            .enqueue_mail(
                "checks:hub:entry-1:result",
                "connection-a:tab:omp-1",
                "Checks",
                "answer",
                &expected
            )
            .unwrap(),
        Persistence::Memory
    );
    let entry = control.host.outbox().unwrap().pending().remove(0);
    let routes = super::MailTabs {
        host: &control.host,
    };
    assert_eq!(
        routes.tab_of("/s/boss.jsonl", None).as_deref(),
        Some("connection-a:tab:omp-1")
    );
    let mut reconnected = state(Vec::new());
    reconnected["mailTargets"] = json!([tab("connection-b:tab:omp-2", "/s/boss.jsonl")]);
    crate::ports::apply_state(control.host.port(), 1, &reconnected.to_string()).unwrap();
    assert!(
        runtime
            .enqueue_mail(
                "checks:hub:entry-2:result",
                "connection-a:tab:omp-1",
                "Checks",
                "answer",
                &expected
            )
            .is_err()
    );
    assert_eq!(
        routes.tab_of("/s/boss.jsonl", None).as_deref(),
        Some("connection-b:tab:omp-2")
    );
    assert!(
        routes
            .send("connection-a:tab:omp-1", &entry)
            .await
            .is_none()
    );
    assert!(
        routes
            .send("connection-b:tab:omp-2", &entry)
            .await
            .is_some()
    );
    assert_eq!(told_of(&told, "mail")[0]["tabId"], "connection-b:tab:omp-2");
    reconnected["mailTargets"] = json!([tab("connection-b:tab:omp-2", "/s/changed.jsonl")]);
    crate::ports::apply_state(control.host.port(), 2, &reconnected.to_string()).unwrap();
    assert!(
        routes
            .send("connection-b:tab:omp-2", &entry)
            .await
            .is_none()
    );
    assert!(routes.tab_of("/s/boss.jsonl", None).is_none());
    crate::ports::apply_state(control.host.port(), 3, &state(Vec::new()).to_string()).unwrap();
    assert!(routes.tab_of("/s/changed.jsonl", None).is_none());
    assert_eq!(told_of(&told, "mail").len(), 1);
    assert_eq!(control.host.outbox().unwrap().pending()[0].id, entry.id);
    control.host.port().close();
}

#[tokio::test]
async fn immediate_delivery_rechecks_binding_after_spawn_before_its_first_poll() {
    use crate::agentctl::journal::{Persistence, mail_outbox::OutboxMail};
    for authenticated in [false, true] {
        let dir = MailDir::new();
        let mut initial = state(if authenticated {
            Vec::new()
        } else {
            vec![tab("old-token", "/s/boss.jsonl")]
        });
        if authenticated {
            initial["mailTargets"] = json!([tab("old-token", "/s/boss.jsonl")]);
        }
        let (control, runtime, told) = rig(
            7_480 + u64::from(authenticated),
            initial,
            dir.files(),
            |method, _| {
                if method == "mail" {
                    Ok(json!({ "duplicate": false }))
                } else {
                    Err(format!("unexpected {method}"))
                }
            },
        );
        let outbox = control.host.outbox().unwrap().clone();
        let entry = OutboxMail {
            id: "bound-result".into(),
            session_path: "/s/boss.jsonl".into(),
            device: None,
            from: None,
            from_device: None,
            content: "answer".into(),
            details: mail_details("bound-result"),
            delivery: DELIVERY,
            attachments: None,
            attachments_corrupt: false,
            at: control.now(),
        };
        assert_eq!(outbox.keep(entry.clone()).unwrap(), Persistence::Disk);
        let sending = runtime.send_kept_mail(outbox.clone(), "old-token".into(), entry.clone());
        let mut switched = state(vec![tab("old-token", "/s/different.jsonl")]);
        if authenticated {
            switched = state(Vec::new());
            switched["mailTargets"] = json!([tab("new-token", "/s/boss.jsonl")]);
        }
        crate::ports::apply_state(control.host.port(), 1, &switched.to_string()).unwrap();
        sending.await.unwrap();
        assert!(told_of(&told, "mail").is_empty());
        assert_eq!(outbox.pending(), [entry.clone()]);
        let mut restored = state(if authenticated {
            Vec::new()
        } else {
            vec![tab("new-token", "/s/boss.jsonl")]
        });
        if authenticated {
            restored["mailTargets"] = json!([tab("new-token", "/s/boss.jsonl")]);
        }
        crate::ports::apply_state(control.host.port(), 2, &restored.to_string()).unwrap();
        runtime
            .send_kept_mail(outbox, "new-token".into(), entry)
            .await
            .unwrap();
        assert_eq!(told_of(&told, "mail")[0]["tabId"], "new-token");
        control.host.port().close();
    }
}
