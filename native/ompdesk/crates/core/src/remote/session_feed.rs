//! One host list for every local desktop/phone reader. This is the native receiver of HostSessionList and
//! session-list-delta.ts, not a session index: reads still come from the authenticated host's existing index.
use super::requests::{RemoteError, RemoteRequests};
use crate::server::Fault;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

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
pub fn older_version(a: &str, b: &str) -> bool {
    let mut a = a.split('.');
    let mut b = b.split('.');
    a.next() == b.next()
        && a.next().map(crate::ssh::js_to_number).unwrap_or(f64::NAN)
            < b.next().map(crate::ssh::js_to_number).unwrap_or(f64::NAN)
}
fn apply(rows: &[Row], set: Vec<Row>, remove: &[String]) -> Vec<Row> {
    let mut rows: HashMap<_, _> = rows
        .iter()
        .map(|row| (row.path().to_owned(), row.clone()))
        .collect();
    for path in remove {
        rows.remove(path);
    }
    for row in set {
        rows.insert(row.path().to_owned(), row);
    }
    let mut rows: Vec<_> = rows.into_values().collect();
    sort(&mut rows);
    rows
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
type Reading = watch::Receiver<Option<Result<(), RemoteError>>>;
struct State {
    generation: u64,
    copy_generation: Option<u64>,
    copy: Option<Arc<SessionList>>,
    next: u64,
    host_version: Option<String>,
    announced: Option<String>,
    reading: Option<Reading>,
    connection: u64,
    requests: Option<RemoteRequests>,
}
pub struct HostSessionList {
    device: String,
    epoch: String,
    state: Mutex<State>,
    changed: Arc<dyn Fn(Value) + Send + Sync>,
}
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|p| p.into_inner())
}
fn offline() -> RemoteError {
    Fault::new("remote_offline", "The device running this tab is offline").into()
}
impl HostSessionList {
    pub fn new(device: String, changed: Arc<dyn Fn(Value) + Send + Sync>) -> Arc<Self> {
        Arc::new(Self {
            device,
            epoch: super::crypto::random_device_id()[..8].to_owned(),
            changed,
            state: Mutex::new(State {
                generation: 0,
                copy_generation: None,
                copy: None,
                next: 0,
                host_version: None,
                announced: None,
                reading: None,
                connection: 0,
                requests: None,
            }),
        })
    }
    pub fn relink(&self, requests: Option<RemoteRequests>) {
        {
            let mut state = lock(&self.state);
            state.connection += 1;
            state.requests = requests;
            state.generation += 1;
        }
        (self.changed)(json!({"device":self.device}));
    }
    pub fn stale(&self) {
        lock(&self.state).generation += 1;
        (self.changed)(json!({"device":self.device}));
    }
    fn publish(&self, state: &mut State, rows: Vec<Row>, generation: Option<u64>) -> Option<Value> {
        state.copy_generation = state.copy_generation.max(generation);
        let before = state.copy.clone();
        let delta = before.as_ref().map(|before| diff(&before.sessions, &rows));
        if delta
            .as_ref()
            .is_some_and(|(set, remove)| set.is_empty() && remove.is_empty())
        {
            return None;
        }
        state.next += 1;
        let version = format!("{}.{}", self.epoch, state.next);
        state.copy = Some(Arc::new(SessionList {
            version: version.clone(),
            sessions: rows,
        }));
        match (before, delta) {
            (Some(before), Some((set, remove))) => Some(
                json!({"device":self.device,"list":SessionDelta{base:before.version.clone(),version,set,remove}}),
            ),
            _ => None,
        }
    }
    pub fn host_changed(&self, data: Value) {
        let delta = serde_json::from_value::<SessionDelta>(data).ok();
        let change = {
            let mut state = lock(&self.state);
            if let Some(delta) = delta.as_ref()
                && let Some(copy) = state.copy.clone()
                && state.host_version.as_deref() == Some(delta.base.as_str())
            {
                state.host_version = Some(delta.version.clone());
                let rows = apply(
                    &copy.sessions,
                    delta
                        .set
                        .iter()
                        .cloned()
                        .map(|row| row.own(&self.device))
                        .collect(),
                    &delta.remove,
                );
                let generation = state.copy_generation;
                self.publish(&mut state, rows, generation)
            } else if delta
                .as_ref()
                .is_some_and(|delta| state.host_version.as_deref() == Some(delta.version.as_str()))
            {
                return;
            } else if state.reading.is_some() {
                if let Some(delta) = delta {
                    state.announced = Some(delta.version);
                }
                None
            } else {
                state.generation += 1;
                Some(json!({"device":self.device}))
            }
        };
        if let Some(change) = change {
            (self.changed)(change);
        }
    }
    pub async fn current(self: &Arc<Self>) -> Result<Arc<SessionList>, RemoteError> {
        let wanted = lock(&self.state).generation;
        loop {
            let mut waiting = {
                let mut state = lock(&self.state);
                if state
                    .copy_generation
                    .is_some_and(|generation| generation >= wanted)
                    && let Some(copy) = &state.copy
                {
                    return Ok(Arc::clone(copy));
                }
                if state.reading.is_none() {
                    let requests = state
                        .requests
                        .clone()
                        .filter(RemoteRequests::is_online)
                        .ok_or_else(offline)?;
                    let (answer, waiting) = watch::channel(None);
                    let generation = state.generation;
                    let connection = state.connection;
                    state.reading = Some(waiting);
                    let list = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = requests
                            .request(
                                "sessions.list",
                                json!({"scope":"global","versioned":true}),
                                Duration::from_secs(30),
                            )
                            .await;
                        let result = list.finish(connection, generation, result);
                        let _ = answer.send(Some(result));
                    });
                }
                state.reading.as_ref().expect("installed read").clone()
            };
            loop {
                if let Some(result) = waiting.borrow_and_update().clone() {
                    result?;
                    break;
                }
                waiting.changed().await.map_err(|_| offline())?;
            }
        }
    }
    fn finish(
        &self,
        connection: u64,
        generation: u64,
        result: Result<Value, RemoteError>,
    ) -> Result<(), RemoteError> {
        let mut state = lock(&self.state);
        let result = (|| {
            if state.connection != connection {
                return Err(offline());
            }
            let reply = result?;
            let versioned = serde_json::from_value::<SessionList>(reply.clone()).ok();
            if let Some(reply) = &versioned
                && state
                    .host_version
                    .as_ref()
                    .is_some_and(|held| older_version(&reply.version, held))
                && state.copy.is_some()
            {
                state.copy_generation = state.copy_generation.max(Some(generation));
                return Ok(None);
            }
            let (version, rows) = match versioned {
                Some(reply) => (Some(reply.version), reply.sessions),
                None => (
                    None,
                    serde_json::from_value::<Vec<Row>>(reply).map_err(|error| {
                        RemoteError::from(Fault::new("protocol", error.to_string()))
                    })?,
                ),
            };
            state.host_version = version;
            let mut rows: Vec<_> = rows.into_iter().map(|row| row.own(&self.device)).collect();
            sort(&mut rows);
            Ok(self.publish(&mut state, rows, Some(generation)))
        })();
        state.reading = None;
        let announced = state.announced.take();
        let stale = announced
            .as_ref()
            .zip(state.host_version.as_ref())
            .is_some_and(|(announced, version)| older_version(version, announced));
        if stale {
            state.generation += 1;
        }
        drop(state);
        if let Ok(Some(change)) = &result {
            (self.changed)(change.clone());
        }
        if stale {
            (self.changed)(json!({"device":self.device}));
        }
        result.map(|_| ())
    }
}

/// Summary receiver uses the same published version/delta contract, without re-indexing sessions.
pub fn apply_summary_change(held: Option<&Value>, change: Value) -> Option<Value> {
    let version = change["version"].as_str()?;
    if let Some(rows) = change["sessions"].as_array() {
        if !rows.iter().all(valid_summary) {
            return None;
        }
        if let Some(held) = held
            && older_version(version, held["version"].as_str()?)
        {
            return Some(held.clone());
        }
        return Some(json!({"version":version,"sessions":rows}));
    }
    let held = held?;
    if held["version"].as_str() != change["base"].as_str() {
        return None;
    }
    let remove: HashSet<_> = change["remove"]
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect::<Option<_>>()?;
    let set = change["set"].as_array()?;
    if !set.iter().all(valid_summary) {
        return None;
    }
    let mut rows = held["sessions"].as_array()?.clone();
    rows.retain(|row| !remove.contains(row["sessionPath"].as_str().unwrap_or_default()));
    for row in set {
        if let Some(old) = rows
            .iter_mut()
            .find(|old| old["sessionPath"] == row["sessionPath"])
        {
            *old = row.clone();
        } else {
            rows.push(row.clone());
        }
    }
    Some(json!({"version":version,"sessions":rows}))
}
fn valid_summary(row: &Value) -> bool {
    ["sessionPath", "tabId"]
        .iter()
        .all(|key| row[key].as_str().is_some_and(|text| !text.is_empty()))
        && row["cwd"].is_string()
        && matches!(row["kind"].as_str(), Some("agent" | "chat"))
        && matches!(
            row["status"].as_str(),
            Some(
                "asleep"
                    | "starting"
                    | "ready"
                    | "running"
                    | "exited"
                    | "error"
                    | "restarting"
                    | "waiting"
            )
        )
        && row["agents"].as_array().is_some_and(|agents| {
            agents.iter().all(|agent| {
                agent["id"].as_str().is_some_and(|id| !id.is_empty())
                    && agent["index"].is_number()
                    && agent["agent"].is_string()
                    && agent["status"].is_string()
                    && agent["startedAt"].is_number()
            })
        })
}
pub(crate) fn valid_summary_delta(value: &Value) -> bool {
    value["base"].is_string()
        && value["version"].is_string()
        && value["set"]
            .as_array()
            .is_some_and(|rows| rows.iter().all(valid_summary))
        && value["remove"]
            .as_array()
            .is_some_and(|paths| paths.iter().all(Value::is_string))
}
#[cfg(test)]
mod tests;
