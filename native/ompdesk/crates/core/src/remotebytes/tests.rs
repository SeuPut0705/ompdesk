//! Rows captured from the TypeScript before it was deleted (`captured.json`): the cache folders it wrote (a device
//! updating keeps its cache), what it asked the host and wrote at each step, node's base64, and the sign-in
//! listener's reading of Host headers and request targets and its failure page.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::Value;
use serde_json::value::RawValue;

use super::folder::folder;
use super::{blobs, signin, transcripts};
use crate::server::Fault;

fn captured() -> Value {
    serde_json::from_str(include_str!("captured.json")).unwrap()
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let mut salt = [0u8; 8];
    crate::sys::random(&mut salt).unwrap();
    let dir = std::env::temp_dir().join(format!(
        "ompdesk-remotebytes-{name}-{}-{}",
        std::process::id(),
        u64::from_le_bytes(salt)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn files(dir: &std::path::Path) -> BTreeMap<String, String> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                std::fs::read_to_string(entry.path()).unwrap(),
            )
        })
        .collect()
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.to_owned()).unwrap()
}

#[tokio::test]
async fn asks_and_writes_a_journal_byte_for_byte_as_the_typescript_did() {
    let rows = captured();
    let transcripts_rows = &rows["transcripts"];
    let key = transcripts_rows["journalKey"].as_str().unwrap();
    let dir = temp_dir("journal");
    let kept = folder(&dir);
    for step in transcripts_rows["steps"].as_array().unwrap() {
        let answers = step["answers"].as_array().unwrap();
        let asked = Mutex::new(Vec::new());
        let file = transcripts::file_for_test(&dir, "j", key);
        let answer: Value = serde_json::from_str(answers[0].as_str().unwrap()).unwrap();
        let merge =
            transcripts::read_journal_with(&kept, file, raw("0"), 128 * 1024 * 1024, |fetch| {
                let mut question = serde_json::Map::new();
                question.insert(
                    "fromByte".into(),
                    serde_json::from_str(fetch.from_byte.get()).unwrap(),
                );
                if let Some(tail) = fetch.known_tail {
                    question.insert(
                        "knownTail".into(),
                        serde_json::from_str(tail.get()).unwrap(),
                    );
                }
                asked.lock().unwrap().push(Value::Object(question));
                // The answer's text as main sent it: never through `Value`, which spells a large number its own way.
                let mut fields: std::collections::HashMap<String, Box<RawValue>> =
                    serde_json::from_str(answers[0].as_str().unwrap()).unwrap();
                let data = fields.remove("data").unwrap();
                async move { Ok::<_, Fault>(Some(data)) }
            })
            .await
            .unwrap();
        assert_eq!(Value::Array(asked.into_inner().unwrap()), step["asked"]);
        let written: BTreeMap<String, String> =
            serde_json::from_value(step["files"].clone()).unwrap();
        assert_eq!(files(&dir), written);
        let mut shown: Vec<Value> = match merge {
            Some(held) => serde_json::from_str(&held).unwrap(),
            None => Vec::new(),
        };
        shown.extend(
            answer["data"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        assert_eq!(Value::Array(shown), step["messages"]);
    }
}

#[test]
fn reads_the_journal_and_tail_page_the_typescript_kept() {
    let rows = captured();
    let transcripts_rows = &rows["transcripts"];
    let dir = temp_dir("kept");
    for (name, text) in transcripts_rows["files"].as_object().unwrap() {
        std::fs::write(dir.join(name), text.as_str().unwrap()).unwrap();
    }
    let journal =
        transcripts::file_for_test(&dir, "j", transcripts_rows["journalKey"].as_str().unwrap());
    let held = transcripts::load_journal(&journal).expect("the journal loads");
    let (next, messages) = transcripts::held_for_test(&held);
    assert_eq!(next, transcripts_rows["next"]);
    assert_eq!(messages, transcripts_rows["held"]);
    let page = transcripts::file_for_test(&dir, "p", transcripts_rows["pageKey"].as_str().unwrap());
    let kept: Value = serde_json::from_str(&transcripts::load_page(&page).unwrap()).unwrap();
    assert_eq!(kept, transcripts_rows["page"]);
}

#[test]
fn drops_a_journal_a_crash_cut_mid_append() {
    let dir = temp_dir("cut");
    let file = dir.join("j-cut");
    std::fs::write(
        &file,
        "{\"from\":0,\"next\":10,\"tail\":\"t\",\"messages\":[1]}\n{\"from\":10,\"next\":2",
    )
    .unwrap();
    assert!(transcripts::load_journal(&file).is_none());
    assert!(!file.exists());
}

#[test]
fn reads_the_pictures_the_typescript_kept() {
    let rows = captured();
    let dir = temp_dir("blobs");
    for (name, data) in rows["blobs"]["files"].as_object().unwrap() {
        std::fs::write(dir.join(name), blobs::node_base64(data.as_str().unwrap())).unwrap();
    }
    let kept = folder(&dir);
    for reference in rows["blobs"]["refs"].as_array().unwrap() {
        let hash = reference
            .as_str()
            .unwrap()
            .strip_prefix("blob:sha256:")
            .unwrap();
        assert_eq!(
            blobs::kept(&kept, hash).as_deref(),
            rows["blobs"]["files"][hash].as_str()
        );
    }
}

#[test]
fn decodes_base64_as_node_does() {
    for row in captured()["base64"].as_array().unwrap() {
        let bytes = blobs::node_base64(row["input"].as_str().unwrap());
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, row["hex"].as_str().unwrap(), "{}", row["input"]);
    }
}

#[test]
fn reads_host_headers_and_callback_targets_as_node_did() {
    let rows = captured();
    for row in rows["hosts"].as_array().unwrap() {
        assert_eq!(
            signin::host_name(row["header"].as_str().unwrap()),
            row["hostname"].as_str().unwrap(),
            "{}",
            row["header"]
        );
    }
    for row in rows["targets"].as_array().unwrap() {
        let target = signin::target(row["input"].as_str().unwrap()).unwrap();
        assert_eq!(
            target.path,
            row["pathname"].as_str().unwrap(),
            "{}",
            row["input"]
        );
        assert_eq!(
            target.state.as_deref(),
            row["state"].as_str(),
            "{}",
            row["input"]
        );
        assert_eq!(
            target.query,
            row["query"].as_str().unwrap(),
            "{}",
            row["input"]
        );
    }
}

#[test]
fn writes_the_failure_page_as_the_typescript_did() {
    for row in captured()["failurePages"].as_array().unwrap() {
        assert_eq!(
            signin::failure_page(
                row["title"].as_str().unwrap(),
                row["message"].as_str().unwrap()
            ),
            row["html"].as_str().unwrap()
        );
    }
}
