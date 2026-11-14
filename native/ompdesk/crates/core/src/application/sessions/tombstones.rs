use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{absolute, lock};
use crate::server::Fault;

const MAX_TOMBSTONES: usize = 2000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Tombstone {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default)]
    pub at: f64,
}

#[derive(Default)]
struct Entries {
    by_key: HashMap<String, Tombstone>,
    order: VecDeque<String>,
}

pub struct Tombstones {
    file: Option<PathBuf>,
    entries: Mutex<Entries>,
}

fn key(path: &Path, device: Option<&str>) -> String {
    let device = device.filter(|device| !device.is_empty()).unwrap_or("");
    let path = if device.is_empty() {
        absolute(path)
    } else {
        path.to_owned()
    };
    format!("{device}\0{}", path.to_string_lossy())
}

impl Tombstones {
    pub fn open(file: Option<PathBuf>) -> Self {
        let entries: Vec<serde_json::Value> = file
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let mut unique = Entries::default();
        for value in entries {
            let Some(path) = value
                .get("path")
                .and_then(serde_json::Value::as_str)
                .filter(|path| !path.is_empty())
            else {
                continue;
            };
            let entry = Tombstone {
                path: path.to_owned(),
                device: value
                    .get("device")
                    .and_then(serde_json::Value::as_str)
                    .filter(|device| !device.is_empty())
                    .map(str::to_owned),
                at: value
                    .get("at")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
            };
            let entry_key = key(Path::new(path), entry.device.as_deref());
            if !unique.by_key.contains_key(&entry_key) {
                unique.order.push_back(entry_key.clone());
            }
            unique.by_key.insert(entry_key, entry);
        }
        Self {
            file,
            entries: Mutex::new(unique),
        }
    }

    pub fn has(&self, path: &Path, device: Option<&str>) -> bool {
        lock(&self.entries).by_key.contains_key(&key(path, device))
    }

    pub fn list(&self) -> Vec<Tombstone> {
        let entries = lock(&self.entries);
        entries
            .order
            .iter()
            .filter_map(|key| entries.by_key.get(key).cloned())
            .collect()
    }

    pub fn at(&self, path: &str, device: Option<&str>) -> Option<f64> {
        lock(&self.entries)
            .by_key
            .get(&key(Path::new(path), device))
            .map(|entry| entry.at)
    }

    pub fn at_of_id(&self, id: &str) -> Option<f64> {
        if id.is_empty() || id.contains(['/', '\\']) {
            return None;
        }
        let tail = format!("_{id}.jsonl");
        let entries = lock(&self.entries);
        entries
            .order
            .iter()
            .filter_map(|key| entries.by_key.get(key))
            .find(|entry| entry.path.ends_with(&tail))
            .map(|entry| entry.at)
    }

    pub fn add(&self, path: &str, device: Option<&str>, at: f64) -> Result<(), Fault> {
        let device = device.filter(|value| !value.is_empty()).map(str::to_owned);
        let path = if device.is_some() {
            path.to_owned()
        } else {
            absolute(Path::new(path)).to_string_lossy().into_owned()
        };
        let entry_key = key(Path::new(&path), device.as_deref());
        let mut entries = lock(&self.entries);
        if entries.by_key.remove(&entry_key).is_some() {
            entries.order.retain(|key| key != &entry_key);
        }
        entries.order.push_back(entry_key.clone());
        entries
            .by_key
            .insert(entry_key, Tombstone { path, device, at });
        while entries.order.len() > MAX_TOMBSTONES {
            if let Some(oldest) = entries.order.pop_front() {
                entries.by_key.remove(&oldest);
            }
        }
        if let Some(file) = &self.file {
            let ordered: Vec<_> = entries
                .order
                .iter()
                .filter_map(|key| entries.by_key.get(key))
                .collect();
            let bytes = serde_json::to_vec(&ordered)
                .map_err(|error| Fault::new("json", error.to_string()))?;
            crate::disk::saves::write_kept(file, &bytes, Some(0o600), 0o700)?;
        }
        Ok(())
    }
}
