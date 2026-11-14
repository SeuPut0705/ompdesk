use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

const READ_BYTES: u64 = 8 * 1024 * 1024;
const CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ContentMatch {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    size: u64,
}

struct Text {
    stamp: Stamp,
    raw: String,
    lower: String,
}

impl Text {
    fn weight(&self) -> usize {
        self.raw.len() + self.lower.len()
    }
}

pub struct ContentCache {
    entries: HashMap<PathBuf, Arc<Text>>,
    order: VecDeque<PathBuf>,
    used: usize,
    capacity: usize,
}

impl Default for ContentCache {
    fn default() -> Self {
        Self::new(CACHE_BYTES)
    }
}

impl ContentCache {
    fn new(capacity: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            used: 0,
            capacity,
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.used = 0;
    }

    pub fn invalidate(&mut self, path: &Path) {
        if let Some(old) = self.entries.remove(path) {
            self.used -= old.weight();
            self.order.retain(|item| item != path);
        }
    }

    fn read(&mut self, path: &Path) -> Option<Arc<Text>> {
        let metadata = path.metadata().ok()?;
        let stamp = Stamp {
            modified: metadata.modified().ok(),
            size: metadata.len(),
        };
        if self
            .entries
            .get(path)
            .is_some_and(|entry| entry.stamp == stamp)
        {
            self.order.retain(|item| item != path);
            self.order.push_back(path.to_owned());
            return self.entries.get(path).cloned();
        }
        self.invalidate(path);
        let mut bytes = Vec::with_capacity(metadata.len().min(READ_BYTES) as usize);
        File::open(path)
            .ok()?
            .take(READ_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let lower = raw.to_lowercase();
        let text = Arc::new(Text { stamp, raw, lower });
        let weight = text.weight();
        if weight > self.capacity {
            return Some(text);
        }
        while self.used + weight > self.capacity {
            let oldest = self.order.pop_front()?;
            if let Some(entry) = self.entries.remove(&oldest) {
                self.used -= entry.weight();
            }
        }
        self.used += weight;
        self.order.push_back(path.to_owned());
        self.entries.insert(path.to_owned(), Arc::clone(&text));
        Some(text)
    }

    pub fn search(&mut self, query: &str, paths: &[PathBuf]) -> Vec<ContentMatch> {
        let lower = query.to_lowercase();
        let tokens: Vec<_> = lower.split_whitespace().collect();
        if tokens.is_empty() {
            return Vec::new();
        }
        paths
            .iter()
            .filter_map(|path| {
                let text = self.read(path)?;
                if !tokens.iter().all(|token| text.lower.contains(token)) {
                    return None;
                }
                Some(ContentMatch {
                    path: path.to_string_lossy().into_owned(),
                    snippet: snippet(&text.raw, &text.lower, tokens[0]),
                })
            })
            .collect()
    }
}

fn containing<'a>(value: &'a Value, token: &str) -> Option<&'a str> {
    match value {
        Value::String(text) if text.to_lowercase().contains(token) => Some(text),
        Value::Array(items) => items.iter().find_map(|item| containing(item, token)),
        Value::Object(items) => items.values().find_map(|item| containing(item, token)),
        _ => None,
    }
}

fn clip(text: &str, token: &str) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = flat.to_lowercase();
    let byte = lower.find(token)?;
    let at = lower[..byte].encode_utf16().count();
    let token_len = token.encode_utf16().count();
    let units: Vec<_> = flat.encode_utf16().collect();
    let start = at.saturating_sub(70);
    let end = (at + token_len + 70).min(units.len());
    let middle = String::from_utf16_lossy(&units[start..end]);
    Some(format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        middle.trim(),
        if end < units.len() { "…" } else { "" }
    ))
}

fn snippet(raw: &str, lower: &str, token: &str) -> Option<String> {
    if raw.encode_utf16().count() != lower.encode_utf16().count() {
        return None;
    }
    let mut fallback = None;
    for (raw_line, _) in raw
        .split('\n')
        .zip(lower.split('\n'))
        .filter(|(_, line)| line.contains(token))
        .take(50)
    {
        let Ok(entry) = serde_json::from_str::<Value>(raw_line) else {
            continue;
        };
        let message = entry.get("message");
        let Some(text) = containing(message.unwrap_or(&entry), token) else {
            continue;
        };
        let excerpt = clip(text, token);
        if message.is_some() {
            return excerpt;
        }
        if fallback.is_none() {
            fallback = excerpt;
        }
    }
    fallback
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
