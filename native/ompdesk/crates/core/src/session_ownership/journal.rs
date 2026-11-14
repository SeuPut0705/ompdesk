use std::fs;
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::model::{ScratchRecord, TagRecord, valid_tag};
use super::{Host, State};

fn read<T: DeserializeOwned>(file: &Path, key: &str) -> Vec<T> {
    fs::read(file).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|mut value| value.get_mut(key).and_then(Value::as_array_mut).map(std::mem::take))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect()
}

pub(super) fn tags(file: &Path) -> Vec<TagRecord> {
    read::<TagRecord>(file, "tags").into_iter()
        .filter(|record| valid_tag(&record.tag) && record.since.is_finite()).collect()
}

pub(super) fn scratch(file: &Path) -> Vec<ScratchRecord> {
    read::<ScratchRecord>(file, "scratch").into_iter()
        .filter(|record| valid_tag(&record.tag) && record.since.is_finite()).collect()
}

fn save(file: &Path, value: &impl Serialize, host: &dyn Host) {
    let result = serde_json::to_vec(value)
        .map_err(|error| crate::server::Fault::new("serialize_failed", error.to_string()))
        .and_then(|mut bytes| {
            bytes.push(b'\n');
            crate::disk::saves::write_kept(file, &bytes, Some(0o600), 0o700)
        });
    if let Err(error) = result {
        host.log("records not saved", serde_json::json!({"file": file, "error": error.message}));
    }
}

pub(super) fn save_tags(state: &State, file: &Path, host: &dyn Host) {
    #[derive(Serialize)]
    struct Tags<'a> { tags: Vec<&'a TagRecord> }
    save(file, &Tags { tags: state.entries.iter().map(|entry| &entry.record).collect() }, host);
}

pub(super) fn save_scratch(state: &State, file: &Path, host: &dyn Host) {
    #[derive(Serialize)]
    struct Scratch<'a> { scratch: &'a [ScratchRecord] }
    save(file, &Scratch { scratch: &state.scratch }, host);
}
