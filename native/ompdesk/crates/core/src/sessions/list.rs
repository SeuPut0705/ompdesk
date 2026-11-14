//! The same numbered list data and diff rules serve the local index and authenticated host receiver.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    value: Value,
    modified_ms: i64,
}
impl Row {
    pub fn path(&self) -> &str {
        self.value["path"].as_str().expect("validated session row")
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub(crate) fn parse(value: Value) -> Result<Self, String> {
        if !value["path"].is_string() || !value["modified"].is_string() {
            return Err("Invalid host session row".into());
        }
        let modified_ms = crate::schedules::rules::date_parse(
            value["modified"].as_str().unwrap_or_default(),
            &crate::schedules::rules::Local,
        )
        .unwrap_or(0);
        Ok(Self { value, modified_ms })
    }
    pub(crate) fn set_kind(&mut self, kind: &str) {
        self.value["kind"] = Value::String(kind.to_owned());
    }
    pub(crate) fn own(mut self, device: &str) -> Self {
        self.value["device"] = device.into();
        self
    }
}
impl Serialize for Row {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for Row {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::parse(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionList {
    pub version: String,
    pub sessions: Vec<Row>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionDelta {
    pub base: String,
    pub version: String,
    pub set: Vec<Row>,
    pub remove: Vec<String>,
}
pub(crate) fn sort(rows: &mut [Row]) {
    rows.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.path().encode_utf16().cmp(b.path().encode_utf16()))
    });
}
fn same_row(a: &Row, b: &Row) -> bool {
    let a = a.value.as_object().expect("validated session row");
    let b = b.value.as_object().expect("validated session row");
    a.len() == b.len()
        && a.iter().all(|(key, value)| {
            b.get(key).is_some_and(|other| match (value, other) {
                (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
                _ => value == other,
            })
        })
}
pub(crate) fn diff(before: &[Row], after: &[Row]) -> (Vec<Row>, Vec<String>) {
    let mut old: HashMap<_, _> = before.iter().map(|row| (row.path(), row)).collect();
    let mut set = Vec::new();
    for row in after {
        if !old
            .remove(row.path())
            .is_some_and(|prior| same_row(prior, row))
        {
            set.push(row.clone());
        }
    }
    let mut removed = HashSet::new();
    let remove = before
        .iter()
        .filter(|row| old.contains_key(row.path()) && removed.insert(row.path()))
        .map(|row| row.path().to_owned())
        .collect();
    (set, remove)
}
