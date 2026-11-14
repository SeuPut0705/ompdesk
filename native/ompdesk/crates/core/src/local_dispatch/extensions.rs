use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::pool::application::Sidecar;
use crate::server::Fault;
use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "get_skills", "get_skill_detail", "set_skill_enabled", "manage_skill", "get_hooks",
    "set_hook_enabled", "get_context_files", "set_context_file_enabled", "get_prompt_templates",
    "get_plugins", "get_marketplaces", "marketplace_action", "set_plugin_enabled", "get_gui_themes",
    "get_plugin_detail", "set_plugin_features", "set_plugin_setting", "delete_plugin_setting",
    "get_agent_definitions", "get_agent_definition", "get_agent_authoring", "revive_subagent",
    "get_theme_colors", "read_image_blob", "abort_subagent", "get_subagent_messages", "get_subagent_transcript",
];

fn journal_tail(file: &str, byte: u64) -> Option<String> {
    if byte == 0 { return Some("0".into()); }
    let start = byte.saturating_sub(64);
    let mut file = std::fs::File::open(file).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = vec![0; (byte - start) as usize];
    file.read_exact(&mut bytes).ok()?;
    let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes));
    Some(format!("{byte}:{}", &hash[..22]))
}

fn tail_for(file: &str, byte: &Value) -> Option<String> {
    let number = byte.as_f64()?;
    if number <= 0.0 { return Some("0".into()); }
    journal_tail(file, byte.as_u64()?)
}

fn image_sites<'a>(value: &'a mut Value, key: Option<&str>, sites: &mut Vec<&'a mut Value>) {
    match value {
        Value::Array(items) => for item in items { image_sites(item, key, sites); },
        Value::Object(record) => {
            let image = match key {
                Some("content") => record.get("type").and_then(Value::as_str) == Some("image"),
                Some("images") => record.get("type").and_then(Value::as_str) == Some("image") || record.get("mimeType").and_then(Value::as_str).is_some_and(|s| s.starts_with("image/")),
                _ => false,
            };
            let reference = record.get("data").and_then(Value::as_str).and_then(|s| s.strip_prefix("blob:sha256:"));
            if image && reference.is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
                if let Some(data) = record.get_mut("data") { sites.push(data); }
                return;
            }
            for (name, child) in record { image_sites(child, Some(name), sites); }
        }
        _ => {}
    }
}

async fn resolve_images<S: Sidecar<Error = Fault> + ?Sized + 'static>(messages: &mut Value, session: &Session<S>) {
    let mut sites = Vec::new();
    image_sites(messages, None, &mut sites);
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    for site in sites {
        let Some(reference) = site.as_str() else { continue };
        if !cache.contains_key(reference) {
            let data = session.bridge("read_image_blob", json!({"ref": reference})).await.ok()
                .and_then(|reply| reply.get("data").and_then(Value::as_str).map(str::to_owned));
            cache.insert(reference.to_owned(), data);
        }
        if let Some(Some(data)) = cache.get(reference) { *site = Value::String(data.clone()); }
    }
}

pub(crate) fn slim(messages: &mut [Value]) {
    for message in messages {
        let Some(message) = message.as_object_mut() else { continue };
        for key in ["inputTransformations", "requestControls", "contextSnapshot"] { message.remove(key); }
        if let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) {
            for block in content {
                if let Some(block) = block.as_object_mut() { block.remove("thinkingSignature"); }
            }
        }
    }
}

async fn read<S: Sidecar<Error = Fault> + ?Sized + 'static>(session: &Session<S>, command: &RpcCommand, params: &serde_json::Map<String, Value>) -> Result<Value, CommandError> {
    let mut answer = if command.kind == "get_subagent_messages" {
        let mut stock = params.clone();
        stock.insert("type".into(), Value::String(command.kind.clone()));
        session.stock(Value::Object(stock)).await?
    } else {
        session.bridge(&command.kind, Value::Object(params.clone())).await?
    };
    if command.is_true("firstPrompt") {
        if let Some(messages) = answer.get("messages").and_then(Value::as_array) {
            let first = messages.iter().find(|m| m.get("role").and_then(Value::as_str) == Some("user")).cloned();
            answer = json!({"messages": first.into_iter().collect::<Vec<_>>()});
        }
    }
    Ok(answer)
}

pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(command: &RpcCommand, session: &Session<S>) -> CommandResult {
    match command.kind.as_str() {
        "abort_subagent" => {
            let agent = command.string("agentId").filter(|s| !s.is_empty()).ok_or_else(|| CommandError::Other("`agentId` must be a non-empty string.".into()))?;
            let response = session.stock(json!({"type":"cancel_subagent", "subagentId":agent})).await?;
            Ok(Some(if response["cancelled"] == true { json!({"ok":true}) } else { json!({"ok":false,"reason":"not_found"}) }))
        }
        "get_subagent_messages" | "get_subagent_transcript" => {
            let mut params = command.params.clone();
            for flag in ["firstPrompt", "imageRefs", "tails", "knownTail"] { params.remove(flag); }
            let mut answer = read(session, command, &params).await?;
            if let (Some(known), Some(file), Some(byte)) = (command.string("knownTail"), answer.get("sessionFile").and_then(Value::as_str), answer.get("fromByte").and_then(Value::as_u64)) {
                if byte > 0 && answer.get("reset") != Some(&Value::Bool(true)) && journal_tail(file, byte).as_deref() != Some(known) {
                    params.insert("fromByte".into(), json!(0));
                    answer = read(session, command, &params).await?;
                    if let Some(object) = answer.as_object_mut() { object.insert("reset".into(), Value::Bool(true)); }
                }
            }
            let tail = if command.is_true("tails") {
                answer.get("sessionFile").and_then(Value::as_str).zip(answer.get("nextByte")).and_then(|(file, byte)| tail_for(file, byte))
            } else { None };
            if let Some(object) = answer.as_object_mut() {
                object.remove("entries");
                if let Some(tail) = tail { object.insert("tail".into(), Value::String(tail)); }
                if let Some(messages) = object.get_mut("messages") {
                    if let Some(array) = messages.as_array_mut() { slim(array); }
                    if messages.is_array() && !command.is_true("imageRefs") { resolve_images(messages, session).await; }
                }
            }
            Ok(Some(answer))
        }
        kind if COMMANDS.contains(&kind) => Ok(Some(session.forward(kind, command).await?)),
        _ => Ok(None),
    }
}

#[cfg(test)]
#[path = "extension_tests.rs"]
mod tests;
