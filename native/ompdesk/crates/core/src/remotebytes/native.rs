//! Typed callers of the existing bounded caches. Fetch closures reach an authenticated native remote link;
//! journal segmentation, content hashes, per-key turns and eviction remain the original primitives.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

pub use super::callback::{LoopbackCallback, Page};
pub use super::signin::{Forward, ListenState, NativeRelay, Words};
use super::{blobs, blocking, folder, transcripts};
use crate::server::Fault;

const TRANSCRIPTS: u64 = 128 * 1024 * 1024;
const IMAGES: u64 = 256 * 1024 * 1024;

pub struct ContentCache {
    transcripts: Arc<folder::Folder>,
    blobs: Arc<folder::Folder>,
}
impl ContentCache {
    pub fn new(user_data: PathBuf) -> Self {
        Self {
            transcripts: folder::folder(&user_data.join("remote-transcripts")),
            blobs: folder::folder(&user_data.join("remote-image-blobs")),
        }
    }
    pub async fn page(&self, key: &str) -> Option<Value> {
        let path = transcripts::file(&self.transcripts.dir, "p", key);
        blocking(move || transcripts::load_page(&path))
            .await
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
    }
    pub async fn keep_page(&self, key: &str, version: &str, page: &Value) {
        let _turn = self.transcripts.turn(&format!("p\0{key}")).await;
        let path = transcripts::file(&self.transcripts.dir, "p", key);
        let text = json!({"version":version,"page":page}).to_string();
        let folder = Arc::clone(&self.transcripts);
        let _ = blocking(move || folder.write(&path, text.as_bytes(), TRANSCRIPTS)).await;
    }
    pub async fn journal<F, R>(&self, key: &str, from_byte: Value, fetch: F) -> Result<Value, Fault>
    where
        F: FnOnce(Value, Option<Value>) -> R,
        R: Future<Output = Result<Value, Fault>>,
    {
        let _turn = self.transcripts.turn(key).await;
        let path = transcripts::file(&self.transcripts.dir, "j", key);
        let from_byte = serde_json::value::to_raw_value(&from_byte)
            .map_err(|error| Fault::new("invalid_params", error.to_string()))?;
        let mut response = None;
        let captured = &mut response;
        let held = transcripts::read_journal_with(
            &self.transcripts,
            path,
            from_byte,
            TRANSCRIPTS,
            |wanted| async move {
                let from = serde_json::from_str(wanted.from_byte.get()).unwrap_or(Value::Null);
                let tail = wanted
                    .known_tail
                    .as_ref()
                    .and_then(|tail| serde_json::from_str(tail.get()).ok());
                let fetched = fetch(from, tail).await?;
                let data = if fetched["success"] == true {
                    Some(
                        serde_json::value::to_raw_value(&fetched["data"])
                            .map_err(|error| Fault::new("invalid_json", error.to_string()))?,
                    )
                } else {
                    None
                };
                *captured = Some(fetched);
                Ok(data)
            },
        )
        .await?;
        let mut response = response
            .ok_or_else(|| Fault::new("internal", "The transcript cache asked the host nothing"))?;
        if let Some(held) = held
            && response["success"] == true
        {
            let mut messages: Vec<Value> = serde_json::from_str(&held)
                .map_err(|error| Fault::new("invalid_json", error.to_string()))?;
            if let Some(current) = response["data"]["messages"].as_array_mut() {
                messages.append(current);
            }
            response["data"]["messages"] = Value::Array(messages);
            response["data"]["fromByte"] = 0.into();
            response["data"]["reset"] = false.into();
        }
        Ok(response)
    }
    pub async fn pictures<F, R>(&self, messages: &mut Value, fetch: F)
    where
        F: Fn(String) -> R,
        R: Future<Output = Option<String>>,
    {
        let mut references = Vec::new();
        let mut seen = HashSet::new();
        sites(messages, None, &mut |reference| {
            if seen.insert(reference) {
                references.push(reference);
            }
        });
        let mut found = HashMap::new();
        for reference in references {
            let data = blobs::shared_with(&self.blobs, reference.to_owned(), IMAGES, || {
                fetch(reference.to_owned())
            })
            .await;
            if let Some(data) = data {
                found.insert(reference.to_owned(), data);
            }
        }
        replace(messages, None, &found);
    }
}

fn image_site<'a>(value: &'a Value, key: Option<&str>) -> Option<&'a str> {
    let image = match key {
        Some("content") => value["type"] == "image",
        Some("images") => {
            value["type"] == "image"
                || value["mimeType"]
                    .as_str()
                    .is_some_and(|mime| mime.starts_with("image/"))
        }
        _ => false,
    };
    image
        .then(|| value["data"].as_str())
        .flatten()
        .filter(|reference| {
            reference.strip_prefix("blob:sha256:").is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        })
}
fn sites<'a>(value: &'a Value, key: Option<&str>, visit: &mut impl FnMut(&'a str)) {
    if let Some(reference) = image_site(value, key) {
        visit(reference);
        return;
    }
    match value {
        Value::Array(values) => {
            for value in values {
                sites(value, key, visit);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                sites(value, Some(key), visit);
            }
        }
        _ => {}
    }
}
fn replace(value: &mut Value, key: Option<&str>, found: &HashMap<String, String>) {
    if let Some(data) = image_site(value, key)
        .and_then(|reference| found.get(reference))
        .cloned()
    {
        value["data"] = data.into();
        return;
    }
    match value {
        Value::Array(values) => {
            for value in values {
                replace(value, key, found);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                replace(value, Some(key), found);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
pub(crate) mod tests;
