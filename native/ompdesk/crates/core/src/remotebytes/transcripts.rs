//! What a paired device read of its hosts' transcripts, kept on its disk so each read crosses the link once per
//! change (was `src/main/remote/transcript-cache.ts`; `RemoteSidecar` is its caller through main's `TranscriptCache`).
//!
//! - A subagent journal (`get_subagent_messages`, `get_subagent_transcript`) is kept as the segments the host
//!   answered, each from the byte offset the last ended at, with the journal's `tail` there (a hash of the bytes
//!   before the offset). A read from the start, or from where this device stopped, asks the host from the kept offset
//!   with that tail; a host whose journal no longer has it reads it from the start again (`reset`), and the kept copy
//!   is replaced. An unchanged journal costs one small request.
//! - A tail page (`get_transcript_page` from the end) is kept with its `version`.
//!
//! Files: `j-<40 hex>` (one JSON segment per line: `{"from","next","tail","messages"}`) and `p-<40 hex>`
//! (`{"version","page"}`), named by the SHA-256 of the caller's key, as the TypeScript wrote them. Numbers, tails and
//! messages are kept as the JSON text main sent (`JSON.stringify`'s), never re-encoded, so a file is byte for byte
//! the one the TypeScript wrote. A file that cannot be read whole (a crash mid-append) is dropped and read from the
//! host again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::folder::{self, Folder};
use super::{Unanswered, ask, blocking, js};
use crate::server::{Call, Fault, Reply};

/// A JSON object as `JSON.parse` keeps it: each key's value as written, a repeated key's last.
type Fields = HashMap<String, Box<RawValue>>;

pub(super) fn file(dir: &Path, kind: &str, key: &str) -> PathBuf {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    dir.join(format!("{kind}-{}", &hex[..40]))
}

/// The journal kept: where it ends, the tail there, its messages (each segment's array text, in order).
pub(super) struct Held {
    next: Box<RawValue>,
    tail: Box<RawValue>,
    messages: Vec<Box<RawValue>>,
}

impl Held {
    fn next(&self) -> f64 {
        js::number(&self.next).unwrap_or(f64::NAN)
    }
}

/// A journal read's answer as stock and the gui-bridge send it (`readRpcSubagentTranscript`), with the host's tail.
pub(super) struct JournalRead {
    from_byte: Box<RawValue>,
    next_byte: Box<RawValue>,
    reset: bool,
    messages: Box<RawValue>,
    /// Present (any value, `null` too) or not: `read.tail !== undefined`.
    tail: Option<Box<RawValue>>,
}

impl JournalRead {
    /// `journalRead(data)`: an object with a number `fromByte` and `nextByte` and an array `messages`.
    fn parse(data: &RawValue) -> Option<JournalRead> {
        let mut fields: Fields = serde_json::from_str(data.get()).ok()?;
        let from_byte = fields.remove("fromByte").filter(|raw| js::is_number(raw))?;
        let next_byte = fields.remove("nextByte").filter(|raw| js::is_number(raw))?;
        let messages = fields.remove("messages").filter(|raw| js::is_array(raw))?;
        Some(JournalRead {
            from_byte,
            next_byte,
            reset: fields.get("reset").is_some_and(|raw| raw.get() == "true"),
            messages,
            tail: fields.remove("tail"),
        })
    }

    /// Where the read starts (`read.fromByte`).
    fn start(&self) -> f64 {
        js::number(&self.from_byte).unwrap_or(f64::NAN)
    }
}

/// One segment's line, as `JSON.stringify({from, next, tail, messages})` wrote it.
fn segment(from: &str, next: &RawValue, tail: &RawValue, messages: &RawValue) -> String {
    format!(
        "{{\"from\":{from},\"next\":{},\"tail\":{},\"messages\":{}}}\n",
        next.get(),
        tail.get(),
        messages.get()
    )
}

/// The journal kept in `file`: its segments in order from byte 0, each starting where the last ended. A file with a
/// line that is no such segment is dropped.
pub(super) fn load_journal(file: &Path) -> Option<Held> {
    let bytes = std::fs::read(file).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut messages = Vec::new();
    let mut next: Option<Box<RawValue>> = None;
    let mut tail = None;
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Some(segment) = kept_segment(line) else {
            folder::remove(file);
            return None;
        };
        let expected = next.as_deref().and_then(js::number).unwrap_or(0.0);
        if js::number(&segment.from) != Some(expected) {
            folder::remove(file);
            return None;
        }
        messages.push(segment.messages);
        next = Some(segment.next);
        tail = Some(segment.tail);
    }
    let (next, tail) = (next?, tail?);
    folder::touch(file);
    Some(Held {
        next,
        tail,
        messages,
    })
}

/// One kept line: `isSegment`'s number `from` and `next`, string `tail`, array `messages`.
struct Segment {
    from: Box<RawValue>,
    next: Box<RawValue>,
    tail: Box<RawValue>,
    messages: Box<RawValue>,
}

fn kept_segment(line: &str) -> Option<Segment> {
    let mut fields: Fields = serde_json::from_str(line).ok()?;
    Some(Segment {
        from: fields.remove("from").filter(|raw| js::is_number(raw))?,
        next: fields.remove("next").filter(|raw| js::is_number(raw))?,
        tail: fields.remove("tail").filter(|raw| js::is_string(raw))?,
        messages: fields.remove("messages").filter(|raw| js::is_array(raw))?,
    })
}

/// What the host was asked: from `fromByte`, with the tail this device kept there.
pub(super) struct Fetch {
    pub from_byte: Box<RawValue>,
    pub known_tail: Option<Box<RawValue>>,
}

/// The messages to put before the host's answer (`{...read, fromByte: 0, reset: false, messages: [...held, ...]}`),
/// or None when the answer is the host's own as it came.
pub(super) type Merge = Option<String>;

/// A journal read from `from_byte` as the renderer asked it (`readJournal`): from the start, the messages kept here
/// and what the host added since; from where this device stopped, what the host added. Any other offset (a renderer
/// ahead of a trimmed copy) goes to the host as asked. `fetch` asks the host and answers its read's `data` (None for
/// a failed read). The caller holds the key's turn.
pub(super) async fn read_journal_with<F, R>(
    folder: &Arc<Folder>,
    file: PathBuf,
    from_byte: Box<RawValue>,
    limit: u64,
    fetch: F,
) -> Result<Merge, Fault>
where
    F: FnOnce(Fetch) -> R,
    R: Future<Output = Result<Option<Box<RawValue>>, Fault>>,
{
    let from = js::number(&from_byte).unwrap_or(f64::NAN);
    let loaded = file.clone();
    let held = blocking(move || load_journal(&loaded)).await?;
    let held = match held {
        Some(held) if from == 0.0 || from == held.next() => held,
        _ => {
            let data = fetch(Fetch {
                from_byte,
                known_tail: None,
            })
            .await?;
            // Only a whole journal read from its start, with a tail to check it by, is kept.
            if let Some(read) = data.as_deref().and_then(JournalRead::parse)
                && read.start() == 0.0
                && let Some(tail) = read.tail
            {
                let line = segment("0", &read.next_byte, &tail, &read.messages);
                let folder = folder.clone();
                blocking(move || folder.write(&file, line.as_bytes(), limit)).await?;
            }
            return Ok(None);
        }
    };
    let data = fetch(Fetch {
        from_byte: held.next.clone(),
        known_tail: Some(held.tail.clone()),
    })
    .await?;
    let Some(read) = data.as_deref().and_then(JournalRead::parse) else {
        return Ok(None);
    };
    let folder = folder.clone();
    let Some(tail) = read
        .tail
        .as_ref()
        .filter(|_| !read.reset && read.start() == held.next())
    else {
        // The host's journal is not the one kept (rewritten, or a host that does not check): kept anew from it.
        let restart = read
            .tail
            .as_ref()
            .filter(|_| read.start() == 0.0)
            .map(|tail| segment("0", &read.next_byte, tail, &read.messages));
        blocking(move || match restart {
            Some(line) => {
                folder.write(&file, line.as_bytes(), limit);
            }
            None => {
                folder::remove(&file);
            }
        })
        .await?;
        return Ok(None);
    };
    let grew = js::number(&read.next_byte) != Some(held.next());
    let line = grew.then(|| segment(held.next.get(), &read.next_byte, tail, &read.messages));
    blocking(move || match line {
        Some(line) => {
            if !folder.append(&file, line.as_bytes(), limit) {
                folder::remove(&file);
            }
        }
        None => folder::touch(&file),
    })
    .await?;
    if from != 0.0 {
        return Ok(None);
    }
    let parts: Vec<&str> = held
        .messages
        .iter()
        .map(|messages| js::elements(messages))
        .filter(|part| !part.is_empty())
        .collect();
    Ok(Some(format!("[{}]", parts.join(","))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalParams {
    dir: PathBuf,
    limit: u64,
    key: String,
    from_byte: Box<RawValue>,
    asker: u64,
}

/// `remotebytes.readJournal {dir, limit, key, fromByte, asker}` → `{held}`: the messages kept here to put before the
/// host's answer, or null when main answers the renderer with the host's read as it came. The host is asked through
/// main (`journal` ask: `fromByte`, `knownTail`), which answers the read's `{data}` (none when it failed).
pub async fn read_journal(call: Call) -> Result<Reply, Fault> {
    let params: JournalParams = call.params()?;
    let folder = folder::folder(&params.dir);
    let _turn = folder.turn(&params.key).await;
    let path = file(&params.dir, "j", &params.key);
    let events = call.events.clone();
    let scope = call.scope.clone();
    let merge = read_journal_with(
        &folder,
        path,
        params.from_byte,
        params.limit,
        |fetch| async move {
            let mut data = Map::new();
            data.insert("fromByte".into(), raw_value(&fetch.from_byte));
            if let Some(tail) = fetch.known_tail {
                data.insert("knownTail".into(), raw_value(&tail));
            }
            let answer = ask(&events, Some(&scope), params.asker, "journal", data)
                .await
                .map_err(|Unanswered| Unanswered::fault())?;
            let mut fields: Fields = serde_json::from_str(answer.get()).unwrap_or_default();
            Ok(fields.remove("data"))
        },
    )
    .await?;
    let held = merge.unwrap_or_else(|| "null".into());
    Ok(Reply {
        result: RawValue::from_string(format!("{{\"held\":{held}}}"))
            .map_err(|error| Fault::new("internal", error.to_string()))?,
        bin: None,
    })
}

fn raw_value(raw: &RawValue) -> Value {
    serde_json::from_str(raw.get()).unwrap_or(Value::Null)
}

#[derive(Deserialize)]
struct PageParams {
    dir: PathBuf,
    key: String,
}

/// The tail page kept: `{version, page}` when its version is a string and its page an object.
pub(super) fn load_page(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    let mut fields: Fields = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let version = fields.remove("version").filter(|raw| js::is_string(raw))?;
    let page = fields.remove("page").filter(|raw| js::is_object(raw))?;
    folder::touch(file);
    Some(format!(
        "{{\"version\":{},\"page\":{}}}",
        version.get(),
        page.get()
    ))
}

/// `remotebytes.page {dir, key}` → the tail page kept for `key` with the version it was read at, or null.
pub async fn page(call: Call) -> Result<Reply, Fault> {
    let params: PageParams = call.params()?;
    let path = file(&params.dir, "p", &params.key);
    let kept = blocking(move || load_page(&path))
        .await?
        .unwrap_or_else(|| "null".into());
    Ok(Reply {
        result: RawValue::from_string(kept)
            .map_err(|error| Fault::new("internal", error.to_string()))?,
        bin: None,
    })
}

#[derive(Deserialize)]
struct KeepPageParams {
    dir: PathBuf,
    limit: u64,
    key: String,
    version: Box<RawValue>,
    page: Box<RawValue>,
}

/// `remotebytes.keepPage {dir, limit, key, version, page}`: keeps the tail page read at `version`, replacing the
/// last. A disk that refuses it changes nothing: the page is read from the host again next time.
pub async fn keep_page(call: Call) -> Result<Reply, Fault> {
    let params: KeepPageParams = call.params()?;
    let folder = folder::folder(&params.dir);
    let _turn = folder.turn(&format!("p\0{}", params.key)).await;
    let path = file(&params.dir, "p", &params.key);
    let text = format!(
        "{{\"version\":{},\"page\":{}}}",
        params.version.get(),
        params.page.get()
    );
    blocking(move || folder.write(&path, text.as_bytes(), params.limit)).await?;
    Reply::json(&Value::Null)
}

#[cfg(test)]
pub(super) fn held_for_test(held: &Held) -> (Value, Value) {
    let messages: Vec<Value> = held
        .messages
        .iter()
        .flat_map(|part| serde_json::from_str::<Vec<Value>>(part.get()).unwrap())
        .collect();
    (raw_value(&held.next), Value::Array(messages))
}

#[cfg(test)]
pub(super) fn file_for_test(dir: &Path, kind: &str, key: &str) -> PathBuf {
    file(dir, kind, key)
}
