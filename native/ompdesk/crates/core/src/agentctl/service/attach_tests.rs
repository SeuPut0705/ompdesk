//! What a send, a report and an answer carry besides text, against a fake main: the caller's omp reads each one, pictures
//! go inline, files land on the receiver's computer, and a replay that cannot keep its promise delivers nothing.

use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::super::host::{Caps, HostState};
use super::super::tuning::Tuning;
use super::super::{AgentControl, Files, JournalFile};
use crate::agentctl::journal::system_clock;
use crate::ports::Port;

type Asked = Arc<Mutex<Vec<(String, Value)>>>;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn rig(
    id: u64,
    state: Value,
    caps: Caps,
    files: &Files,
    reply: impl Fn(&str, &Value) -> Result<Value, String> + Send + 'static,
) -> (AgentControl, Asked) {
    let (writer, reader) = tokio::io::duplex(1 << 24);
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
        caps,
        files,
        Tuning {
            turn_start_wait_ms: 20,
            ..Tuning::default()
        },
        system_clock(),
    );
    (control, asked)
}

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const PDF: &[u8] = b"%PDF-1.4 a report";

/// A caller's omp: `/w/shot.png` and `image 1` are the picture, `/w/doc.pdf` the file, `/w/same.pdf` the same bytes
/// again, `/w/big.bin` is over the limit, anything else is missing.
fn omp(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "args.parse" => Ok(json!({ "ok": true, "args": args["args"] })),
        "command" => {
            let command = &args["command"];
            match command["type"].as_str() {
                Some("agent_control_attachment") => {
                    let png = |name: &str| json!({ "success": true, "data": { "name": name, "mimeType": "image/png", "dataBase64": b64(PNG) } });
                    let pdf = |name: &str| json!({ "success": true, "data": { "name": name, "mimeType": "application/pdf", "dataBase64": b64(PDF) } });
                    Ok(
                        match (command["path"].as_str(), command["image"].as_u64()) {
                            (Some("/w/shot.png"), _) | (_, Some(1)) => png("shot.png"),
                            (Some("/w/doc.pdf"), _) => pdf("doc.pdf"),
                            (Some("/w/same.pdf"), _) => pdf("same.pdf"),
                            (Some(path), _)
                                if path.starts_with("/w/p") || path.starts_with("/w/s") =>
                            {
                                // Distinct pictures: 10 MiB each (`/w/p*`) or 7 MiB each (`/w/s*`).
                                let size =
                                    if path.starts_with("/w/p") { 10 } else { 7 } * 1024 * 1024;
                                let mut bytes = vec![7u8; size];
                                bytes[..PNG.len()].copy_from_slice(PNG);
                                bytes[PNG.len()] = path.as_bytes()[path.len() - 5];
                                json!({ "success": true, "data": { "name": path.rsplit('/').next().unwrap(), "mimeType": "image/png", "dataBase64": b64(&bytes) } })
                            }
                            (Some("/w/big.bin"), _) => {
                                json!({ "success": true, "data": { "name": "big.bin", "mimeType": "application/octet-stream", "dataBase64": b64(&vec![0u8; 10 * 1024 * 1024 + 1]) } })
                            }
                            _ => json!({ "success": false, "error": "ENOENT: no such file" }),
                        },
                    )
                }
                Some("prompt") => Ok(json!({ "success": true })),
                Some("get_state") => {
                    Ok(json!({ "success": true, "data": { "isStreaming": false } }))
                }
                Some("agent_control_answer") => Ok(json!({ "success": true })),
                _ => Ok(json!({ "success": false, "error": "no" })),
            }
        }
        "land" => {
            Ok(json!({ "ok": true, "path": format!("/up/{}", args["name"].as_str().unwrap()) }))
        }
        "sentMarks" => Ok(json!({ "instance": "omp-1", "journaled": [] })),
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

fn commands(asked: &Asked, kind: &str) -> Vec<Value> {
    asked_with(asked, "command")
        .into_iter()
        .map(|args| args["command"].clone())
        .filter(|command| command["type"] == kind)
        .collect()
}

fn files_in(dir: &std::path::Path) -> Files {
    Files {
        send_outbox: Some(JournalFile {
            file: Some(dir.join("send-outbox.json")),
        }),
        mail_outbox: Some(JournalFile {
            file: Some(dir.join("mail-outbox.json")),
        }),
        attachments: Some(dir.join("agent-attachments")),
        ..Files::default()
    }
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("attach-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn a_send_carries_a_picture_inline_and_a_file_by_path_and_the_same_bytes_once() {
    let dir = temp("send");
    let (control, asked) = rig(
        9_401,
        state(vec![tab("a"), tab("b")]),
        Caps::default(),
        &files_in(&dir),
        omp,
    );
    let args = json!({ "session": "b", "message": "look", "attachments": [
        { "image": 1 }, { "path": "/w/shot.png" }, { "path": "/w/doc.pdf" }, { "path": "/w/same.pdf" } ] });
    let sent = control.run("a", "ompdesk_session_send", args, None).await;
    assert!(!sent.is_error, "{}", sent.text);
    assert!(
        sent.text
            .ends_with("attached: 2 (1 image inline, 1 file at /up/doc.pdf)."),
        "{}",
        sent.text
    );
    let prompts = commands(&asked, "prompt");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["images"].as_array().unwrap().len(), 1);
    assert_eq!(prompts[0]["images"][0]["data"], b64(PNG));
    assert!(
        prompts[0]["message"]
            .as_str()
            .unwrap()
            .contains("look\n\nAttached: /up/doc.pdf")
    );
    let landed = asked_with(&asked, "land");
    assert_eq!(landed.len(), 1);
    assert_eq!(landed[0]["name"], "doc.pdf");
    // The outbox keeps references, and the bytes are in the content-addressed store.
    let kept: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("send-outbox.json")).unwrap())
            .unwrap();
    let entry = &kept[0];
    assert_eq!(entry["attachments"]["images"].as_array().unwrap().len(), 1);
    assert_eq!(entry["attachments"]["files"][0]["path"], "/up/doc.pdf");
    let sha = entry["attachments"]["images"][0]["sha256"]
        .as_str()
        .unwrap();
    assert_eq!(
        std::fs::read(dir.join("agent-attachments").join(sha)).unwrap(),
        PNG
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_attachment_that_cannot_be_read_or_is_too_big_refuses_the_whole_send() {
    let dir = temp("refuse");
    let (control, asked) = rig(
        9_402,
        state(vec![tab("a"), tab("b")]),
        Caps::default(),
        &files_in(&dir),
        omp,
    );
    let missing = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({ "session": "b", "message": "x", "attachments": [{ "path": "/w/doc.pdf" }, { "path": "/w/nope" }] }),
            None,
        )
        .await;
    assert!(missing.is_error);
    assert_eq!(
        missing.text,
        "Not sent: attachment 2 (/w/nope) could not be read: ENOENT: no such file. Nothing was delivered."
    );
    let big = control
        .run(
            "a",
            "ompdesk_session_send",
            json!({ "session": "b", "message": "x", "attachments": [{ "path": "/w/big.bin" }] }),
            None,
        )
        .await;
    assert_eq!(
        big.text,
        "Not sent: attachment 1 (/w/big.bin) is over 10 MiB, the most one attachment may be. Nothing was delivered."
    );
    assert!(commands(&asked, "prompt").is_empty());
    assert!(asked_with(&asked, "land").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn a_caller_outside_the_app_carries_no_attachments() {
    let mut open = state(vec![tab("b")]);
    open["outsideCallers"] = json!({ "outside:cli#1": { "tabId": "outside:cli#1", "title": "cli", "cwd": "/w", "status": "ready", "busy": false, "asks": [], "hidden": false } });
    open["outsideWindow"] = json!("w");
    let (control, asked) = rig(9_403, open, Caps::default(), &Files::default(), omp);
    let refused = control
        .run(
            "outside:cli#1",
            "ompdesk_session_send",
            json!({ "session": "b", "message": "x", "attachments": [{ "path": "/w/doc.pdf" }] }),
            None,
        )
        .await;
    assert!(
        refused.is_error && refused.text.starts_with("A caller outside OMPdesk"),
        "{}",
        refused.text
    );
    assert!(commands(&asked, "prompt").is_empty());
    control.host.port().close();
}

#[tokio::test]
async fn a_report_carries_its_pictures_as_content_blocks_and_keeps_references() {
    let dir = temp("report");
    let (control, asked) = rig(
        9_404,
        state(vec![tab("a"), tab("b")]),
        Caps::default(),
        &files_in(&dir),
        omp,
    );
    let done = control
        .run(
            "b",
            "ompdesk_report",
            json!({ "kind": "done", "text": "shot", "attachments": [{ "image": 1 }, { "path": "/w/doc.pdf" }] }),
            None,
        )
        .await;
    assert!(!done.is_error, "{}", done.text);
    assert!(
        done.text
            .contains("attached: 2 (1 image inline, 1 file at /up/doc.pdf)."),
        "{}",
        done.text
    );
    let mails = asked_with(&asked, "mail");
    assert_eq!(mails.len(), 1);
    let content = mails[0]["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "text");
    assert!(
        content[0]["text"]
            .as_str()
            .unwrap()
            .contains("Attached: /up/doc.pdf")
    );
    assert_eq!(content[1]["type"], "image");
    assert_eq!(mails[0]["details"]["attachments"][1]["path"], "/up/doc.pdf");
    let kept: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("mail-outbox.json")).unwrap())
            .unwrap();
    assert_eq!(kept[0]["attachments"]["files"][0]["path"], "/up/doc.pdf");
    assert_eq!(kept[0]["from"], "/s/b_1.jsonl");
    control.host.port().close();
}

#[tokio::test]
async fn a_replay_that_cannot_keep_its_promise_delivers_nothing_and_tells_the_sender_once() {
    let dir = temp("replay");
    let entry = |mark: &str, attachments: Value| {
        json!({
            "mark": mark, "dispatch": 1, "sessionPath": "/s/b_1.jsonl", "from": "/s/a_1.jsonl",
            "body": "look", "message": format!("[ompdesk dispatch d1: {mark}] look"),
            "attachments": attachments, "streamingBehavior": "steer", "at": system_clock()(),
        })
    };
    // A damaged record, and a picture whose bytes the store never held.
    let gone = json!({ "images": [{ "sha256": "a".repeat(64), "name": "x.png", "mimeType": "image/png", "size": 3 }], "files": [] });
    std::fs::write(
        dir.join("send-outbox.json"),
        Value::Array(vec![
            entry("[ompdesk dispatch d1:", json!("garbage")),
            entry("[ompdesk dispatch d2:", gone),
        ])
        .to_string(),
    )
    .unwrap();
    let caps = Caps {
        sent_marks: true,
        ..Caps::default()
    };
    let (control, asked) = rig(
        9_405,
        state(vec![tab("a"), tab("b")]),
        caps,
        &files_in(&dir),
        omp,
    );
    control.redeliver_sends().await.unwrap();
    control.redeliver_sends().await.unwrap();
    assert!(
        commands(&asked, "prompt").is_empty(),
        "nothing is handed over"
    );
    let notes = asked_with(&asked, "mail");
    assert_eq!(notes.len(), 1, "the sender is told once per cause");
    assert_eq!(notes[0]["tabId"], "a");
    assert!(
        notes[0]["content"]
            .as_str()
            .unwrap()
            .contains("was NOT delivered"),
        "{}",
        notes[0]["content"]
    );
    // Both stay queued, with the damaged record still marked.
    let kept: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("send-outbox.json")).unwrap())
            .unwrap();
    assert_eq!(kept.as_array().unwrap().len(), 2);
    control.host.port().close();
}

#[tokio::test]
async fn an_answer_with_attachments_is_one_step_where_the_session_runs_and_a_resend_names_the_same_step()
 {
    let mut card = tab("b");
    card["asks"] = json!([{ "id": "r1", "request": { "id": "r1", "method": "select", "title": "Pick", "options": ["Red", "Blue"] } }]);
    let (control, asked) = rig(
        9_406,
        state(vec![tab("a"), card]),
        Caps::default(),
        &Files::default(),
        omp,
    );
    let args = json!({ "session": "b", "choice": "blue", "attachments": [{ "image": 1 }, { "path": "/w/doc.pdf" }] });
    let first = control
        .run("a", "ompdesk_session_answer", args.clone(), None)
        .await;
    assert!(!first.is_error, "{}", first.text);
    assert!(
        first
            .text
            .starts_with("Answered \"b\": \"Blue\" to \"Pick\".")
    );
    // No separate note and no separate answer: one command, the note and the answer together.
    assert!(asked_with(&asked, "mail").is_empty());
    assert!(asked_with(&asked, "answer").is_empty());
    let steps = commands(&asked, "agent_control_answer");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["askId"], "r1");
    assert_eq!(steps[0]["response"]["value"], "Blue");
    assert_eq!(steps[0]["companion"]["content"][1]["type"], "image");
    assert!(
        steps[0]["companion"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Attached: /up/doc.pdf")
    );
    let again = control.run("a", "ompdesk_session_answer", args, None).await;
    assert!(!again.is_error, "{}", again.text);
    let steps = commands(&asked, "agent_control_answer");
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["requestId"], steps[1]["requestId"]);
    assert_eq!(
        steps[0]["companion"]["details"]["id"],
        steps[1]["companion"]["details"]["id"]
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_answer_the_target_refuses_or_loses_says_so_and_never_claims_success() {
    let mut card = tab("b");
    card["asks"] =
        json!([{ "id": "r1", "request": { "id": "r1", "method": "confirm", "title": "Go?" } }]);
    let args =
        json!({ "session": "b", "approve": true, "attachments": [{ "path": "/w/doc.pdf" }] });
    let closed = |method: &str, args: &Value| {
        if method == "command" && args["command"]["type"] == "agent_control_answer" {
            return Ok(
                json!({ "success": false, "error": "That question is not open any more: nothing was added to the session and nothing answered." }),
            );
        }
        omp(method, args)
    };
    let (control, _) = rig(
        9_407,
        state(vec![tab("a"), card.clone()]),
        Caps::default(),
        &Files::default(),
        closed,
    );
    let refused = control
        .run("a", "ompdesk_session_answer", args.clone(), None)
        .await;
    assert!(refused.is_error);
    assert!(
        refused
            .text
            .starts_with("Not answered: That question is not open any more"),
        "{}",
        refused.text
    );
    control.host.port().close();

    let lost = |method: &str, args: &Value| {
        if method == "command" && args["command"]["type"] == "agent_control_answer" {
            return Err("RPC timeout (60000ms)".to_owned());
        }
        omp(method, args)
    };
    let (control, _) = rig(
        9_408,
        state(vec![tab("a"), card]),
        Caps::default(),
        &Files::default(),
        lost,
    );
    let unknown = control.run("a", "ompdesk_session_answer", args, None).await;
    assert!(unknown.is_error);
    assert!(
        unknown
            .text
            .starts_with("The answer may or may not have arrived"),
        "{}",
        unknown.text
    );
    control.host.port().close();
}

fn owed_with_old_file(dir: &std::path::Path, held: bool) -> String {
    let sha = crate::agentctl::journal::attachments::sha256_hex(PDF);
    if held {
        std::fs::create_dir_all(dir.join("agent-attachments")).unwrap();
        std::fs::write(dir.join("agent-attachments").join(&sha), PDF).unwrap();
    }
    let old = system_clock()() - 2.0 * 24.0 * 60.0 * 60_000.0;
    std::fs::write(
        dir.join("send-outbox.json"),
        json!([{
            "mark": "[ompdesk dispatch d1:", "dispatch": 1, "sessionPath": "/s/b_1.jsonl", "from": "/s/a_1.jsonl",
            "body": "read", "message": "[ompdesk dispatch d1:] read\n\nAttached: /old/doc.pdf",
            "attachments": { "images": [], "files": [{ "sha256": sha, "name": "doc.pdf", "mimeType": "application/pdf", "size": PDF.len(), "path": "/old/doc.pdf", "landedAt": old }] },
            "streamingBehavior": "steer", "at": system_clock()(),
        }])
        .to_string(),
    )
    .unwrap();
    sha
}

#[tokio::test]
async fn an_expired_upload_lands_again_from_the_store_and_the_text_names_the_new_path() {
    let dir = temp("reland");
    owed_with_old_file(&dir, true);
    let caps = Caps {
        sent_marks: true,
        ..Caps::default()
    };
    let (control, asked) = rig(
        9_409,
        state(vec![tab("a"), tab("b")]),
        caps,
        &files_in(&dir),
        omp,
    );
    control.redeliver_sends().await.unwrap();
    let prompts = commands(&asked, "prompt");
    assert_eq!(prompts.len(), 1);
    assert!(
        prompts[0]["message"]
            .as_str()
            .unwrap()
            .ends_with("Attached: /up/doc.pdf"),
        "{}",
        prompts[0]["message"]
    );
    let kept = std::fs::read_to_string(dir.join("send-outbox.json")).unwrap();
    assert!(
        kept.contains("/up/doc.pdf") && !kept.contains("/old/doc.pdf"),
        "{kept}"
    );
    control.host.port().close();
}

#[tokio::test]
async fn an_expired_upload_that_cannot_land_again_keeps_the_message_queued_and_tells_the_sender() {
    for held in [false, true] {
        let dir = temp(if held { "refused" } else { "bytes-gone" });
        owed_with_old_file(&dir, held);
        let caps = Caps {
            sent_marks: true,
            ..Caps::default()
        };
        let reply = |method: &str, args: &Value| {
            if method == "land" {
                return Ok(json!({ "ok": false, "error": "offline" }));
            }
            omp(method, args)
        };
        let (control, asked) = rig(
            9_410 + u64::from(held),
            state(vec![tab("a"), tab("b")]),
            caps,
            &files_in(&dir),
            reply,
        );
        control.redeliver_sends().await.unwrap();
        assert!(commands(&asked, "prompt").is_empty());
        let notes = asked_with(&asked, "mail");
        assert_eq!(notes.len(), 1);
        assert!(
            notes[0]["content"]
                .as_str()
                .unwrap()
                .contains("doc.pdf was put on that computer long ago")
        );
        assert_eq!(control.send_outbox.as_ref().unwrap().pending().len(), 1);
        control.host.port().close();
    }
}

#[test]
fn the_store_keeps_what_an_entry_names_and_sweeps_the_rest_once_it_is_old() {
    use crate::agentctl::journal::attachments::AttachmentStore;
    let dir = temp("store");
    let now = Arc::new(Mutex::new(1_000_000_000.0_f64));
    let clock = {
        let now = now.clone();
        Arc::new(move || *now.lock().unwrap()) as crate::agentctl::journal::Clock
    };
    let store = AttachmentStore::with_clock(Some(dir.clone()), clock);
    let kept = store.put_now(&Arc::new(b"kept".to_vec())).unwrap();
    let dropped = store.put_now(&Arc::new(b"dropped".to_vec())).unwrap();
    assert_eq!(store.get_now(&kept).unwrap().as_slice(), b"kept");
    // A file that no longer hashes to its name reads as gone.
    std::fs::write(dir.join(&dropped), b"tampered").unwrap();
    assert!(store.get_now(&dropped).is_none());
    // Young files stay whatever names them; the file's own age is real time, so compare against the clock's now.
    let keep: std::collections::HashSet<String> = [kept.clone()].into();
    assert_eq!(store.sweep(&keep), 0);
    *now.lock().unwrap() = 1_000_000_000.0 + 1e15;
    assert_eq!(store.sweep(&keep), 1);
    assert!(store.get_now(&kept).is_some());
}

/// The link refuses a message past 16 MiB, so what crosses it to a paired device's tab is bounded: at most 8 MiB of
/// pictures inline (about 10.7 MiB as base64), every other picture lands as a file there and is named by its path.
#[tokio::test]
async fn pictures_for_a_paired_device_stay_under_the_links_frame_cap() {
    const FRAME_CAP: usize = 16 * 1024 * 1024;
    for (first, second, inline) in [("/w/p1.png", "/w/p2.png", 0), ("/w/s1.png", "/w/s2.png", 1)] {
        let dir = temp(&format!("device-{inline}"));
        let mut device = tab("b");
        device["device"] = json!("dev-1");
        let (control, asked) = rig(
            9_420 + inline as u64,
            state(vec![tab("a"), device]),
            Caps::default(),
            &files_in(&dir),
            omp,
        );
        let sent = control
            .run(
                "a",
                "ompdesk_session_send",
                json!({ "session": "b", "message": "look", "attachments": [{ "path": first }, { "path": second }] }),
                None,
            )
            .await;
        assert!(!sent.is_error, "{}", sent.text);
        let prompts = asked_with(&asked, "command")
            .into_iter()
            .filter(|args| args["command"]["type"] == "prompt")
            .collect::<Vec<_>>();
        assert_eq!(prompts.len(), 1);
        let command = &prompts[0]["command"];
        assert_eq!(command["images"].as_array().map_or(0, Vec::len), inline);
        assert!(
            command.to_string().len() < FRAME_CAP,
            "the command over the link is {} bytes",
            command.to_string().len()
        );
        // Whatever did not go inline landed on that computer and is named in the message.
        assert_eq!(asked_with(&asked, "land").len(), 2 - inline);
        assert_eq!(
            command["message"]
                .as_str()
                .unwrap()
                .matches("Attached: /up/")
                .count(),
            2 - inline
        );
        control.host.port().close();
    }
}

#[tokio::test]
async fn a_plan_answer_with_attachments_names_the_plan_it_was_about() {
    let mut plan = tab("b");
    plan["plan"] = json!({ "title": "Ship it", "planFilePath": "/p/plan-1.md", "generation": 7 });
    let (control, asked) = rig(
        9_430,
        state(vec![tab("a"), plan]),
        Caps::default(),
        &Files::default(),
        omp,
    );
    let done = control
        .run(
            "a",
            "ompdesk_session_answer",
            json!({ "session": "b", "approve": false, "text": "no", "attachments": [{ "path": "/w/doc.pdf" }] }),
            None,
        )
        .await;
    assert!(!done.is_error, "{}", done.text);
    let steps = commands(&asked, "agent_control_answer");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["planFile"], "/p/plan-1.md");
    assert_eq!(steps[0]["planGeneration"], 7);
    assert_eq!(steps[0]["plan"]["type"], "plan_approval");
    control.host.port().close();
}
