use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::types::Item;

pub const BACKOFF_MS: f64 = 86_400_000.0;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    failures: f64,
    last_attempt: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    app: Option<String>,
}

pub struct Ledger {
    file: PathBuf,
    app: Option<String>,
    records: BTreeMap<Item, Attempt>,
    attempted: BTreeSet<Item>,
    installing: Option<Item>,
}

impl Ledger {
    pub fn open(file: PathBuf, app: Option<String>) -> Self {
        let value = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        let mut records = BTreeMap::new();
        if let Some(object) = value.as_ref().and_then(serde_json::Value::as_object) {
            for (name, value) in object {
                let Some(id) = Item::ALL.into_iter().find(|item| item.name() == name) else {
                    continue;
                };
                let Ok(record) = serde_json::from_value::<Attempt>(value.clone()) else {
                    continue;
                };
                if app.is_none() || record.app == app {
                    records.insert(id, record);
                }
            }
        }
        Self {
            file,
            app,
            records,
            attempted: BTreeSet::new(),
            installing: None,
        }
    }

    pub fn may_attempt(&self, id: Item, now: f64) -> bool {
        !self.attempted.contains(&id)
            && self.records.get(&id).is_none_or(|record| {
                record.failures < 3.0 || now - record.last_attempt >= BACKOFF_MS
            })
    }

    pub fn begin(&mut self, id: Item, now: f64, fallback: bool) {
        self.installing = Some(id);
        if !id.automatic() || fallback {
            return;
        }
        self.attempted.insert(id);
        let failures = self
            .records
            .get(&id)
            .map_or(1.0, |record| record.failures + 1.0);
        self.records.insert(
            id,
            Attempt {
                failures,
                last_attempt: now,
                app: self.app.clone(),
            },
        );
        self.save();
    }

    pub fn settle(&mut self) {
        self.installing = None;
    }

    pub fn cancel(&mut self) {
        let Some(id) = self.installing.take() else {
            return;
        };
        let Some(record) = self.records.get_mut(&id) else {
            return;
        };
        if record.failures <= 1.0 {
            self.records.remove(&id);
        } else {
            record.failures -= 1.0;
        }
        self.save();
    }

    pub fn clear(&mut self, id: Item) {
        if self.records.remove(&id).is_some() {
            self.save();
        }
    }

    fn save(&self) {
        if let Ok(mut bytes) = serde_json::to_vec_pretty(&self.records) {
            bytes.push(b'\n');
            // Backoff is advisory; memory remains authoritative if disk space is exhausted.
            let _ = crate::disk::saves::write_kept(&self.file, &bytes, Some(0o600), 0o700);
        }
    }
}
