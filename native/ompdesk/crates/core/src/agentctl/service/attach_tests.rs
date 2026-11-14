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
use crate::agentctl::runtime::tests::native_rig;
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
fn native_state(tabs: Vec<Value>) -> Value {
    let mut state = state(tabs);
    state["deviceId"] = json!("test-host");
    for tab in state["tabs"].as_array_mut().unwrap() {
        tab["runtimeInstance"] = json!(format!("runtime-{}", tab["tabId"].as_str().unwrap()));
    }
    state
}

async fn delivered(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
        .await
        .expect("native delivery timed out")
        .expect("native delivery channel closed")
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
    let (control, asked, mut deliveries, _fixture) = native_rig(
        9_401,
        native_state(vec![tab("a"), tab("b")]),
        Caps::default(),
        &files_in(&dir),
        Tuning::default(),
        omp,
    );
    let args = json!({ "session": "b", "message": "look", "attachments": [
        { "image": 1 }, { "path": "/w/shot.png" }, { "path": "/w/doc.pdf" }, { "path": "/w/same.pdf" } ] });
    let sent = control.run("a", "ompdesk_session_send", args, None).await;
    assert!(!sent.is_error, "{}", sent.text);
    let delivery = delivered(&mut deliveries).await;
    let transfers = asked_with(&asked, "inbox");
    assert_eq!(transfers.len(), 1);
    let transfer = &transfers[0]["transfer"];
    let attachments = &transfer["entries"][0]["attachments"];
    assert_eq!(attachments["images"].as_array().unwrap().len(), 1);
    assert_eq!(attachments["files"].as_array().unwrap().len(), 1);
    assert_eq!(attachments["images"][0]["name"], "shot.png");
    assert_eq!(attachments["files"][0]["name"], "doc.pdf");
    assert_eq!(transfer["uploads"].as_array().unwrap().len(), 2);
    for reference in [&attachments["images"][0], &attachments["files"][0]] {
        assert_eq!(
            transfer["uploads"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|upload| upload["sha256"] == reference["sha256"])
                .count(),
            1
        );
    }
    let source_path = attachments["files"][0]["path"].as_str().unwrap();
    let entries = delivery["request"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["kind"], "prompt");
    let blocks = entries[0]["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["type"], "text");
    let text = blocks[0]["text"].as_str().unwrap();
    let path = text.rsplit("Attached: ").next().unwrap().trim();
    assert!(text.contains("look"));
    assert!(text.contains("\n\nAttached: "));
    assert_eq!(std::fs::read(path).unwrap(), PDF);
    assert_eq!(
        std::path::Path::new(path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
        attachments["files"][0]["sha256"].as_str().unwrap()
    );
    assert_eq!(blocks[1]["type"], "image");
    assert_eq!(blocks[1]["data"], b64(PNG));
    let image_sha = attachments["images"][0]["sha256"].as_str().unwrap();
    assert_eq!(
        std::fs::read(std::path::Path::new(path).with_file_name(image_sha)).unwrap(),
        PNG
    );
    assert!(
        sent.text.ends_with(&format!(
            "attached: 2 (1 image inline, 1 file at {source_path})."
        )),
        "{}",
        sent.text
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
    let (control, asked, mut deliveries, _fixture) = native_rig(
        9_404,
        native_state(vec![tab("a"), tab("b")]),
        Caps::default(),
        &files_in(&dir),
        Tuning::default(),
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
    let delivery = delivered(&mut deliveries).await;
    let transfers = asked_with(&asked, "inbox");
    assert_eq!(transfers.len(), 1);
    let transfer = &transfers[0]["transfer"];
    let attachments = &transfer["entries"][0]["attachments"];
    assert_eq!(attachments["images"].as_array().unwrap().len(), 1);
    assert_eq!(attachments["files"].as_array().unwrap().len(), 1);
    assert_eq!(attachments["files"][0]["name"], "doc.pdf");
    assert_eq!(transfer["uploads"].as_array().unwrap().len(), 2);
    let source_path = attachments["files"][0]["path"].as_str().unwrap();
    let entries = delivery["request"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["kind"], "report");
    let content = entries[0]["content"].as_array().unwrap();
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["data"], b64(PNG));
    let path = entries[0]["details"]["attachments"][1]["path"]
        .as_str()
        .unwrap();
    assert!(
        content[0]["text"]
            .as_str()
            .unwrap()
            .contains(&format!("Attached: {path}"))
    );
    assert_eq!(std::fs::read(path).unwrap(), PDF);
    let image_sha = attachments["images"][0]["sha256"].as_str().unwrap();
    assert_eq!(
        std::fs::read(std::path::Path::new(path).with_file_name(image_sha)).unwrap(),
        PNG
    );
    assert!(
        done.text.contains(&format!(
            "attached: 2 (1 image inline, 1 file at {source_path})."
        )),
        "{}",
        done.text
    );
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
        let mut host_state = native_state(vec![tab("a"), device]);
        host_state["devices"] = json!([{ "id": "dev-1", "name": "paired", "state": "online" }]);
        let (control, asked, mut deliveries, _fixture) = native_rig(
            9_420 + inline as u64,
            host_state,
            Caps::default(),
            &files_in(&dir),
            Tuning::default(),
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
        let delivery = delivered(&mut deliveries).await;
        let transfers = asked_with(&asked, "inbox");
        assert_eq!(transfers.len(), 1);
        let wire = &transfers[0];
        assert!(
            wire.to_string().len() < FRAME_CAP,
            "the inbox transfer exceeds the link frame cap"
        );
        let transfer = &wire["transfer"];
        let attachments = &transfer["entries"][0]["attachments"];
        assert_eq!(attachments["images"].as_array().unwrap().len(), inline);
        assert_eq!(attachments["files"].as_array().unwrap().len(), 2 - inline);
        assert_eq!(transfer["uploads"].as_array().unwrap().len(), 2);
        let entries = delivery["request"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["kind"], "prompt");
        let content = &entries[0]["content"];
        let (text, images) = if let Some(blocks) = content.as_array() {
            assert_eq!(blocks[0]["type"], "text");
            (blocks[0]["text"].as_str().unwrap(), &blocks[1..])
        } else {
            (content.as_str().unwrap(), &[][..])
        };
        assert_eq!(images.len(), inline);
        let paths: Vec<_> = text
            .lines()
            .filter_map(|line| line.strip_prefix("Attached: "))
            .collect();
        assert_eq!(paths.len(), 2 - inline);
        for (index, source) in [first, second].iter().enumerate() {
            let size = if inline == 0 { 10 } else { 7 } * 1024 * 1024;
            let mut expected = vec![7u8; size];
            expected[..PNG.len()].copy_from_slice(PNG);
            expected[PNG.len()] = source.as_bytes()[source.len() - 5];
            if index < inline {
                assert_eq!(images[index]["type"], "image");
                assert_eq!(
                    base64::engine::general_purpose::STANDARD
                        .decode(images[index]["data"].as_str().unwrap())
                        .unwrap(),
                    expected
                );
            } else {
                let file_index = index - inline;
                assert_eq!(
                    attachments["files"][file_index]["name"],
                    source.rsplit('/').next().unwrap()
                );
                assert_eq!(std::fs::read(paths[file_index]).unwrap(), expected);
            }
        }
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

#[tokio::test]
async fn two_revisions_of_a_plan_with_the_same_title_and_files_are_two_steps_with_their_own_note() {
    let step_of = |generation: u64| {
        let mut plan = tab("b");
        plan["plan"] =
            json!({ "title": "Ship it", "planFilePath": "/p/plan.md", "generation": generation });
        plan
    };
    let args = json!({ "session": "b", "approve": false, "text": "no", "attachments": [{ "path": "/w/doc.pdf" }] });
    let mut keys = Vec::new();
    for (port, generation) in [(9_440_u64, 3_u64), (9_441, 4)] {
        let (control, asked) = rig(
            port,
            state(vec![tab("a"), step_of(generation)]),
            Caps::default(),
            &Files::default(),
            omp,
        );
        let done = control
            .run("a", "ompdesk_session_answer", args.clone(), None)
            .await;
        assert!(!done.is_error, "{}", done.text);
        let steps = commands(&asked, "agent_control_answer");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["planGeneration"], generation);
        keys.push((
            steps[0]["requestId"].clone(),
            steps[0]["companion"]["details"]["id"].clone(),
        ));
        control.host.port().close();
    }
    assert_ne!(keys[0].0, keys[1].0, "the replay keys differ");
    assert_ne!(keys[0].1, keys[1].1, "the notes differ");
    assert!(keys[0].0.as_str().unwrap().ends_with("|plan:3"));
}

#[tokio::test]
async fn a_report_retry_or_conflict_does_not_land_or_restore_source_bytes_after_receiver_disk_acceptance()
 {
    let dir = temp("report-lookup-before-landing");
    let mut parent = tab("a");
    parent["device"] = json!("dev-1");
    let mut host_state = native_state(vec![parent, tab("b")]);
    host_state["devices"] = json!([{ "id": "dev-1", "name": "paired", "state": "online" }]);
    let (control, asked, mut deliveries, _fixture) = native_rig(
        9_419,
        host_state,
        Caps::default(),
        &files_in(&dir),
        Tuning::default(),
        omp,
    );
    let args = json!({
        "id": "stable-file-report", "kind": "note", "text": "original report",
        "attachments": [{ "path": "/w/doc.pdf" }],
    });
    let first = control.run("b", "ompdesk_report", args.clone(), None).await;
    assert!(!first.is_error, "{}", first.text);
    let delivery = delivered(&mut deliveries).await;
    let entry = &delivery["request"]["entries"][0];
    let receiver_path = entry["details"]["attachments"][0]["path"].as_str().unwrap();
    assert_eq!(std::fs::read(receiver_path).unwrap(), PDF);
    let sha = crate::agentctl::journal::attachments::sha256_hex(PDF);
    let source_blob = dir.join("agent-attachments").join(&sha);
    std::fs::remove_file(&source_blob).unwrap();
    std::fs::create_dir(&source_blob).unwrap();
    control
        .host
        .landed
        .set(Some("dev-1"), &sha, "/expired/source-landing", 0.0);
    let landed_before_retry = asked_with(&asked, "land").len();
    use crate::agentctl::inbox::{
        InboxLogicalAttachments, InboxSourceExecution, NativeInboxLookupEntry,
        NativeInboxTransferEntry,
    };
    let original: NativeInboxTransferEntry =
        serde_json::from_value(asked_with(&asked, "inbox")[0]["transfer"]["entries"][0].clone())
            .unwrap();
    let query = NativeInboxLookupEntry {
        key: original.entry.key(),
        logical: original.logical,
        attachments: original
            .attachments
            .as_ref()
            .map(|set| InboxLogicalAttachments {
                images: set.images.clone(),
                files: set.files.iter().map(|landed| landed.file.clone()).collect(),
            }),
    };
    let execution = InboxSourceExecution {
        tab_id: "b".into(),
        runtime_instance: control
            .host
            .state()
            .tabs
            .iter()
            .find(|tab| tab.tab_id == "b")
            .unwrap()
            .runtime_instance
            .clone(),
    };
    let (query, first_ownership) = crate::agentctl::runtime::inbox_source::lookup(
        control.host.port().id(),
        "a",
        vec![query],
        &execution,
    )
    .await
    .unwrap();
    let repeated = control.run("b", "ompdesk_report", args.clone(), None).await;
    assert!(!repeated.is_error, "{}", repeated.text);
    assert_eq!(asked_with(&asked, "land").len(), landed_before_retry);
    assert!(source_blob.is_dir());
    assert_eq!(std::fs::read(receiver_path).unwrap(), PDF);
    let mut changed = args;
    changed["text"] = json!("conflicting logical report");
    let conflict = control.run("b", "ompdesk_report", changed, None).await;
    assert!(conflict.is_error, "{}", conflict.text);
    assert_eq!(asked_with(&asked, "land").len(), landed_before_retry);
    assert!(source_blob.is_dir());
    let (_, retained_ownership) = crate::agentctl::runtime::inbox_source::lookup(
        control.host.port().id(),
        "a",
        query.entries,
        &execution,
    )
    .await
    .unwrap();
    assert_eq!(retained_ownership.entries, first_ownership.entries);
    assert_eq!(std::fs::read(receiver_path).unwrap(), PDF);
    control.host.port().close();
}

async fn an_attached_report_shares_its_held_receiver_result(kind: &str, port: u64) {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    use crate::agentctl::inbox::{InboxKind, NativeInboxTransfer};

    let dir = temp(&format!("held-{kind}-attachment"));
    let mut snapshot = native_state(vec![tab("a"), tab("b")]);
    snapshot["tabs"][1]["busySince"] = json!(1.0);
    let (control, asked, mut deliveries, fixture) = native_rig(
        port,
        snapshot.clone(),
        Caps::default(),
        &files_in(&dir),
        Tuning::default(),
        omp,
    );
    let receiver = control
        .host
        .inbox_status("a", "/s/a_1.jsonl", None)
        .await
        .unwrap()
        .receiver;
    let inbox = control.receiving_inbox.as_ref().unwrap();
    let held = inbox.lane(&receiver).await;
    let args = json!({
        "id": format!("held-{kind}-file"), "kind": kind, "text": "original attached report",
        "blocking": false, "attachments": [{ "path": "/w/doc.pdf" }],
    });
    let first = control.run("b", "ompdesk_report", args.clone(), None);
    tokio::pin!(first);
    let request = tokio::select! {
        result = &mut first => panic!("{kind} completed before receiver acceptance: {}", result.text),
        request = fixture.until_told(&asked, "inbox") => request,
    };
    assert_eq!(request["tabId"], "a");
    let transfer: NativeInboxTransfer =
        serde_json::from_value(request["transfer"].clone()).unwrap();
    assert_eq!(transfer.receiver, receiver);
    assert_eq!(transfer.entries.len(), 1);
    let original = &transfer.entries[0];
    let key = original.entry.key();
    assert_eq!(key.kind, InboxKind::Report);
    let original_files = &original.attachments.as_ref().unwrap().files;
    assert_eq!(original_files.len(), 1);
    assert_eq!(original_files[0].file.name, "doc.pdf");
    assert!(
        inbox
            .ledger
            .known(&receiver, std::slice::from_ref(original))
            .unwrap()
            .is_empty()
    );
    assert!(inbox.ledger.pending(&receiver).unwrap().1.is_empty());

    // The selected delivery has already carried its bytes. A second carry cannot repair this poisoned source.
    let sha = crate::agentctl::journal::attachments::sha256_hex(PDF);
    let source_blob = dir.join("agent-attachments").join(&sha);
    assert_eq!(std::fs::read(&source_blob).unwrap(), PDF);
    std::fs::remove_file(&source_blob).unwrap();
    std::fs::create_dir(&source_blob).unwrap();
    control
        .host
        .landed
        .set(None, &sha, "/expired/source-landing", 0.0);
    let first_lands = asked_with(&asked, "land");
    assert_eq!(
        first_lands,
        vec![json!({ "tabId": "a", "name": "doc.pdf", "dataBase64": b64(PDF) })]
    );
    assert_eq!(original_files[0].file.sha256, sha);
    assert_eq!(original_files[0].file.size, PDF.len() as u64);
    assert_eq!(transfer.uploads.len(), 1);
    assert_eq!(transfer.uploads[0].sha256, sha);
    assert_eq!(transfer.uploads[0].path, original_files[0].path);
    let landed_before_join = first_lands.len();

    snapshot["tabs"][1]["busySince"] = json!(2.0);
    crate::ports::apply_state(control.host.port(), 1, &snapshot.to_string()).unwrap();
    let repeated = control.run("b", "ompdesk_report", args.clone(), None);
    tokio::pin!(repeated);
    // This marker is set immediately before polling the real Mailbox post, after its actual lookup completed.
    poll_fn(|cx| match repeated.as_mut().poll(cx) {
        Poll::Ready(result) => {
            panic!(
                "{kind} retry did not await the first receiver result: {}",
                result.text
            )
        }
        Poll::Pending if control.mem().mailed_in.get("b\na") == Some(&Some(2.0)) => Poll::Ready(()),
        Poll::Pending => Poll::Pending,
    })
    .await;
    let mut changed = args;
    changed["text"] = json!("conflicting attached report");
    let conflict = control.run("b", "ompdesk_report", changed, None).await;
    assert!(conflict.is_error, "{}", conflict.text);
    assert!(
        conflict.text.to_ascii_lowercase().contains("conflict"),
        "{}",
        conflict.text
    );
    assert_eq!(asked_with(&asked, "land").len(), landed_before_join);
    assert_eq!(asked_with(&asked, "inbox").len(), 1);
    assert!(source_blob.is_dir());
    assert!(
        inbox
            .ledger
            .known(&receiver, std::slice::from_ref(original))
            .unwrap()
            .is_empty()
    );

    std::fs::remove_dir(&source_blob).unwrap();
    std::fs::write(&source_blob, PDF).unwrap();
    drop(held);
    let (first, repeated) = tokio::join!(first, repeated);
    assert!(!first.is_error, "{}", first.text);
    assert!(!repeated.is_error, "{}", repeated.text);
    let delivery = delivered(&mut deliveries).await;
    assert_eq!(
        delivery["request"]["entries"][0]["deliveryId"],
        key.delivery_id
    );
    let file = &delivery["request"]["entries"][0]["details"]["attachments"][0];
    assert_eq!(file["name"], "doc.pdf");
    assert_eq!(std::fs::read(file["path"].as_str().unwrap()).unwrap(), PDF);
    let pending = inbox.ledger.pending(&receiver).unwrap().1;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].entry.key(), key);
    assert_eq!(pending[0].logical, original.logical);
    assert_eq!(asked_with(&asked, "land").len(), landed_before_join);
    assert_eq!(asked_with(&asked, "inbox").len(), 1);
    assert!(deliveries.try_recv().is_err());
    let summary = format!("attached: 1 (1 file at {})", original_files[0].path);
    assert!(first.text.contains(&summary), "{}", first.text);
    assert!(repeated.text.contains(&summary), "{}", repeated.text);
    assert_eq!(repeated.text, first.text);
    control.host.port().close();
}

#[tokio::test(start_paused = true)]
async fn attached_done_joins_its_active_receiver_acceptance_without_preparing_again() {
    an_attached_report_shares_its_held_receiver_result("done", 9_420).await;
}

#[tokio::test(start_paused = true)]
async fn attached_question_joins_its_active_receiver_acceptance_without_preparing_again() {
    an_attached_report_shares_its_held_receiver_result("question", 9_421).await;
}

#[tokio::test(start_paused = true)]
async fn attached_progress_joins_its_selected_receiver_acceptance_without_preparing_again() {
    an_attached_report_shares_its_held_receiver_result("progress", 9_422).await;
}

#[tokio::test(start_paused = true)]
async fn attached_progress_joins_before_selection_without_preparing_either_waiter() {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    use crate::agentctl::inbox::{InboxKind, NativeInboxTransfer};

    let dir = temp("pending-progress-attachment");
    let mut snapshot = native_state(vec![tab("a"), tab("b")]);
    snapshot["tabs"][1]["busySince"] = json!(1.0);
    let (control, asked, mut deliveries, fixture) = native_rig(
        9_423,
        snapshot.clone(),
        Caps::default(),
        &files_in(&dir),
        Tuning::default(),
        omp,
    );
    let receiver = control
        .host
        .inbox_status("a", "/s/a_1.jsonl", None)
        .await
        .unwrap()
        .receiver;
    let inbox = control.receiving_inbox.as_ref().unwrap();
    let held = inbox.lane(&receiver).await;
    let args = json!({
        "id": "pending-file-progress", "kind": "progress", "text": "original progress",
        "blocking": false, "attachments": [{ "path": "/w/doc.pdf" }],
    });
    let first = control.run("b", "ompdesk_report", args.clone(), None);
    tokio::pin!(first);
    poll_fn(|cx| match first.as_mut().poll(cx) {
        Poll::Ready(result) => panic!("progress completed before selection: {}", result.text),
        Poll::Pending if control.mem().mailed_in.get("b\na") == Some(&Some(1.0)) => Poll::Ready(()),
        Poll::Pending => Poll::Pending,
    })
    .await;
    snapshot["tabs"][1]["busySince"] = json!(2.0);
    crate::ports::apply_state(control.host.port(), 1, &snapshot.to_string()).unwrap();
    let repeated = control.run("b", "ompdesk_report", args, None);
    tokio::pin!(repeated);
    poll_fn(|cx| match repeated.as_mut().poll(cx) {
        Poll::Ready(result) => panic!("pending progress retry completed early: {}", result.text),
        Poll::Pending if control.mem().mailed_in.get("b\na") == Some(&Some(2.0)) => Poll::Ready(()),
        Poll::Pending => Poll::Pending,
    })
    .await;
    assert!(asked_with(&asked, "land").is_empty());
    assert!(asked_with(&asked, "inbox").is_empty());
    let sha = crate::agentctl::journal::attachments::sha256_hex(PDF);
    assert!(!dir.join("agent-attachments").join(&sha).exists());
    assert!(inbox.ledger.pending(&receiver).unwrap().1.is_empty());

    // Only the coalescer's selected Deliver can now materialize and reach the real held receiver.
    let request = tokio::select! {
        result = &mut first => panic!("progress completed before receiver acceptance: {}", result.text),
        result = &mut repeated => panic!("joined progress completed before receiver acceptance: {}", result.text),
        request = fixture.until_told(&asked, "inbox") => request,
    };
    let transfer: NativeInboxTransfer =
        serde_json::from_value(request["transfer"].clone()).unwrap();
    assert_eq!(transfer.receiver, receiver);
    assert_eq!(transfer.entries.len(), 1);
    let original = &transfer.entries[0];
    let key = original.entry.key();
    assert_eq!(key.kind, InboxKind::Report);
    assert_eq!(
        asked_with(&asked, "land"),
        vec![json!({ "tabId": "a", "name": "doc.pdf", "dataBase64": b64(PDF) })]
    );
    let original_file = &original.attachments.as_ref().unwrap().files[0].file;
    assert_eq!(original_file.sha256, sha);
    assert_eq!(original_file.size, PDF.len() as u64);
    assert_eq!(transfer.uploads.len(), 1);
    assert_eq!(transfer.uploads[0].sha256, sha);
    assert_eq!(
        transfer.uploads[0].path,
        original.attachments.as_ref().unwrap().files[0].path
    );
    assert_eq!(
        std::fs::read(dir.join("agent-attachments").join(&sha)).unwrap(),
        PDF
    );
    assert!(
        inbox
            .ledger
            .known(&receiver, std::slice::from_ref(original))
            .unwrap()
            .is_empty()
    );
    drop(held);
    let (first, repeated) = tokio::join!(first, repeated);
    assert!(!first.is_error, "{}", first.text);
    assert!(!repeated.is_error, "{}", repeated.text);
    let delivery = delivered(&mut deliveries).await;
    assert_eq!(
        delivery["request"]["entries"][0]["deliveryId"],
        key.delivery_id
    );
    let file = &delivery["request"]["entries"][0]["details"]["attachments"][0];
    assert_eq!(file["name"], "doc.pdf");
    assert_eq!(std::fs::read(file["path"].as_str().unwrap()).unwrap(), PDF);
    let pending = inbox.ledger.pending(&receiver).unwrap().1;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].entry.key(), key);
    assert_eq!(asked_with(&asked, "land").len(), 1);
    assert_eq!(asked_with(&asked, "inbox").len(), 1);
    let summary = format!(
        "attached: 1 (1 file at {})",
        original.attachments.as_ref().unwrap().files[0].path
    );
    assert!(first.text.contains(&summary), "{}", first.text);
    assert!(repeated.text.contains(&summary), "{}", repeated.text);
    assert_eq!(repeated.text, first.text);
    control.host.port().close();
}
