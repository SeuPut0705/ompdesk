use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agentctl::service::js::trim;
use crate::pool::application::Sidecar;
use crate::server::Fault;

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "get_transcript", "get_transcript_page", "get_turn_edits", "switch_session", "set_session_pinned",
    "set_entry_label", "get_session_tree", "switch_leaf", "fork_from", "list_foreign_sessions", "import_foreign_session",
    "write_local_paste", "resolve_local_url", "get_copy_targets", "get_last_link", "get_command_arg_completions", "get_session_stats",
];

const MAX_PAGE: u64 = 256;
const PAGE_BUDGET: usize = 256 * 1024;
const MIN_BACKWARD: u64 = 20;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    v: u8,
    leaf_id: Option<String>,
    total: u64,
    offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backward: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    leaf_id: Option<String>,
    total: u64,
    messages: Vec<Value>,
    start_index: Option<u64>,
    version: Option<String>,
}

#[derive(Default)]
struct Tail {
    version: String,
    pages: HashMap<String, Value>,
}

/// One replay cache per canonical omp spawn, reset with the Session and Queue when that generation changes.
#[derive(Default)]
pub struct Transcript {
    tail: Mutex<Tail>,
}

fn cursor_error() -> CommandError { CommandError::Other("Invalid transcript cursor".into()) }
fn stale(message: &str) -> CommandError { CommandError::local("stale_cursor", message) }
fn required<'a>(command: &'a RpcCommand, key: &str, what: &str) -> Result<&'a str, CommandError> {
    command.string(key).map(trim).filter(|value| !value.is_empty()).ok_or_else(|| CommandError::Other(format!("{what} cannot be empty")))
}
fn text<'a>(command: &'a RpcCommand, key: &str) -> Result<&'a str, CommandError> {
    command.string(key).ok_or_else(|| CommandError::Other(format!("Invalid {key}")))
}
fn decode(value: &Value) -> Result<Cursor, CommandError> {
    let value = value.as_str().filter(|value| value.len() <= 2048).ok_or_else(cursor_error)?;
    let bytes = URL_SAFE_NO_PAD.decode(value.trim_end_matches('=')).map_err(|_| cursor_error())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| cursor_error())?;
    if !value.as_object().is_some_and(|value| value.contains_key("leafId")) { return Err(cursor_error()); }
    let cursor: Cursor = serde_json::from_value(value).map_err(|_| cursor_error())?;
    if cursor.v != 1 || cursor.offset > cursor.total { return Err(cursor_error()); }
    Ok(cursor)
}
fn encode(cursor: Cursor) -> Result<String, CommandError> {
    serde_json::to_vec(&cursor).map(|bytes| URL_SAFE_NO_PAD.encode(bytes)).map_err(|error| CommandError::Other(error.to_string()))
}
fn limit(command: &RpcCommand) -> u64 {
    command.params.get("limit").and_then(Value::as_f64).filter(|value| value.is_finite()).map_or(100, |value| value.floor().clamp(1.0, MAX_PAGE as f64) as u64)
}
async fn read<S: Sidecar<Error = Fault> + ?Sized + 'static>(session: &Session<S>, offset: u64, limit: u64, turn: bool, images: bool) -> Result<Page, CommandError> {
    let mut params = json!({"offset":offset,"limit":limit});
    if turn { params["snapToTurn"] = json!(true); }
    if images { params["imageRefs"] = json!(true); }
    let answer = session.bridge("sessions.transcript", params).await?;
    serde_json::from_value(answer).map_err(|error| CommandError::Other(error.to_string()))
}

impl Transcript {
    pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(&self, command: &RpcCommand, session: &Session<S>) -> CommandResult {
        let value = match command.kind.as_str() {
            "get_transcript" => {
                let first = read(session, 0, MAX_PAGE, false, false).await?;
                let total = first.total;
                let leaf = first.leaf_id;
                let mut messages = first.messages;
                while (messages.len() as u64) < total {
                    let page = read(session, messages.len() as u64, MAX_PAGE, false, false).await?;
                    if page.leaf_id != leaf || page.total != total || page.messages.is_empty() { return Err(stale("Transcript changed while it was read")); }
                    messages.extend(page.messages);
                }
                json!({"messages":messages})
            }
            "get_transcript_page" => self.page(command, session).await?,
            "get_turn_edits" => {
                let head = read(session, 0, 0, false, false).await?;
                let mut tail = Vec::new();
                let mut end = head.total;
                while end > 0 {
                    let offset = end.saturating_sub(MAX_PAGE);
                    let page = read(session, offset, end - offset, false, false).await?;
                    if page.leaf_id != head.leaf_id || page.total != head.total { return Err(stale("Transcript changed while it was read")); }
                    let prompted = page.messages.iter().any(crate::agentctl::service::work::is_turn_prompt);
                    tail.push(page.messages);
                    end = offset;
                    if prompted { break; }
                }
                let messages: Vec<_> = tail.into_iter().rev().flatten().collect();
                crate::agentctl::service::work::turn_edits(&messages, &session.cwd())
            }
            "switch_session" => {
                let mut outgoing = json!({"type":"switch_session","sessionPath":required(command,"sessionPath","Session path")?});
                if let (Some(provider), Some(model)) = (command.string("provider"), command.string("modelId")) {
                    outgoing["provider"] = json!(provider); outgoing["modelId"] = json!(model);
                }
                session.stock(outgoing).await?
            }
            "set_session_pinned" => session.bridge("sessions.set_pinned", json!({"sessionId":required(command,"sessionId","Session id")?,"pinned":command.is_true("pinned")})).await?,
            "set_entry_label" => {
                let mut params = json!({"entryId":required(command,"entryId","Entry id")?});
                if let Some(label) = command.params.get("label") { params["label"] = label.clone(); }
                session.bridge("sessions.set_entry_label", params).await?;
                return Ok(None);
            }
            "get_session_tree" => session.bridge("sessions.tree", Value::Null).await?,
            "switch_leaf" => {
                let entry = required(command,"entryId","Entry id")?;
                if session.stock(json!({"type":"get_state"})).await?["isStreaming"] == true { return Err(CommandError::local("busy", "Session is busy (streaming)")); }
                let mut params = json!({"entryId":entry,"summarize":command.is_true("summarize")});
                if let Some(instructions) = command.params.get("customInstructions") { params["customInstructions"] = instructions.clone(); }
                session.bridge("sessions.switch_leaf", params).await?
            }
            "fork_from" => session.bridge("sessions.fork_from", json!({"entryId":required(command,"entryId","Entry id")?})).await?,
            "list_foreign_sessions" | "import_foreign_session" => {
                let source = command.string("source").filter(|source| matches!(*source,"claude"|"codex")).ok_or_else(|| CommandError::Other("Invalid source".into()))?;
                let mut params = json!({"source":source});
                let method = if command.kind == "import_foreign_session" {
                    let id = text(command,"foreignId")?;
                    if id.is_empty() { return Err(CommandError::Other("Invalid foreignId".into())); }
                    params["foreignId"] = json!(id);
                    "sessions.foreign_import"
                } else { "sessions.foreign_list" };
                session.bridge(method, params).await.map_err(|error| match error {
                    CommandError::Other(message) | CommandError::Local {message,..} => CommandError::local("source_unavailable", message),
                })?
            }
            "write_local_paste" => session.bridge("sessions.write_local_paste", json!({"content":text(command,"content")?})).await?,
            "resolve_local_url" => {
                let url = text(command,"url")?;
                if !url.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("local:")) { return Err(CommandError::Other("Invalid url".into())); }
                session.bridge("sessions.resolve_local_url", json!({"url":url})).await?
            }
            "get_copy_targets" => session.bridge("composer.copy_targets", Value::Null).await?,
            "get_last_link" => session.bridge("composer.last_link", Value::Null).await?,
            "get_command_arg_completions" => session.bridge("sessions.arg_completions", json!({"cwd":session.cwd(),"command":text(command,"command")?,"prefix":text(command,"prefix")?})).await?,
            "get_session_stats" => {
                let (stats, history) = tokio::join!(session.stock(json!({"type":"get_session_stats"})), session.bridge("sessions.usage_history", Value::Null));
                let mut stats = stats?;
                stats["history"] = history?;
                stats
            }
            _ => return Err(CommandError::Other(format!("Unknown transcript RPC command {}", command.kind))),
        };
        Ok(Some(value))
    }

    async fn page<S: Sidecar<Error = Fault> + ?Sized + 'static>(&self, command: &RpcCommand, session: &Session<S>) -> Result<Value, CommandError> {
        let limit = limit(command);
        let images = command.is_true("imageRefs");
        let cursor = command.params.get("cursor").map(decode).transpose()?;
        let backward = command.is_true("fromEnd") || cursor.as_ref().is_some_and(|cursor| cursor.backward == Some(true));
        let metadata = if backward && cursor.is_none() { Some(read(session, 0, 0, false, false).await?) } else { None };
        let version = metadata.as_ref().and_then(|metadata| metadata.version.as_deref());
        let key = format!("{limit}{}", if images { ":refs" } else { "" });
        if let Some(version) = version {
            if command.string("ifVersion") == Some(version) { return Ok(json!({"messages":[],"totalMessages":metadata.as_ref().map_or(0,|page|page.total),"version":version,"unchanged":true})); }
            let tail = self.tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if tail.version == version {
                if let Some(page) = tail.pages.get(&key) { return Ok(page.clone()); }
            }
        }
        let end = cursor.as_ref().map(|cursor|cursor.offset).or_else(||metadata.as_ref().map(|page|page.total)).unwrap_or(limit);
        let mut take = if backward { limit.min(end) } else { limit };
        let mut offset = if backward { end - take } else { cursor.as_ref().map_or(0,|cursor|cursor.offset) };
        let mut page = read(session, offset, take, backward, images).await?;
        while backward && take > MIN_BACKWARD && serde_json::to_string(&page.messages).map_err(|error|CommandError::Other(error.to_string()))?.encode_utf16().count() > PAGE_BUDGET {
            take = MIN_BACKWARD.max(take / 2);
            let smaller = read(session, end - take, take, true, images).await?;
            if smaller.start_index.unwrap_or(end - take) == page.start_index.unwrap_or(offset) { break; }
            offset = end - take;
            page = smaller;
        }
        if cursor.as_ref().is_some_and(|cursor|page.leaf_id != cursor.leaf_id || page.total != cursor.total)
            || metadata.as_ref().is_some_and(|metadata|page.leaf_id != metadata.leaf_id || page.total != metadata.total) { return Err(stale("RPC message cursor is stale")); }
        let start = page.start_index.unwrap_or(offset);
        let next = start + page.messages.len() as u64;
        let mut result = json!({"messages":page.messages,"totalMessages":page.total,"startIndex":start});
        if backward && start > 0 {
            result["prevCursor"] = json!(encode(Cursor{v:1,leaf_id:page.leaf_id,total:page.total,offset:start,backward:Some(true)})?);
        } else if !backward && next < page.total {
            result["nextCursor"] = json!(encode(Cursor{v:1,leaf_id:page.leaf_id,total:page.total,offset:next,backward:None})?);
        }
        if let Some(version) = version.filter(|version|page.version.as_deref() == Some(*version)) {
            result["version"] = json!(version);
            let mut tail = self.tail.lock().unwrap_or_else(|poisoned|poisoned.into_inner());
            if tail.version != version { tail.version = version.to_owned(); tail.pages.clear(); }
            tail.pages.insert(key, result.clone());
        }
        Ok(result)
    }
}
