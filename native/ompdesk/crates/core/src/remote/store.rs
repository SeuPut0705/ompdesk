//! The two paired-device lists of computer sharing (was `src/main/remote/{trust-store,peers-store,hosts-store}.ts`
//! and the file half of `secure-file.ts`): `remote-peers.json` (the devices that use this computer, key `peers`) and
//! `remote-hosts.json` (the computers this one connected to, key `hosts`), each `{ "v": 1, [key]: entry[] }`,
//! written with `JSON.stringify(value, null, "\t") + "\n"`, atomically, mode 0600.
//!
//! Entries are validated one by one when the file is first read (the zod schemas `StoredPeer` and `StoredHost`: a
//! corrupt entry drops alone, unknown keys are stripped, the keys come out in the schema's order, `nodeId` and
//! `login` default to null), and not again: `put` and `update` store what they are given, as the TypeScript did.
//! One copy of each file is shared by every caller in the process (the devices instance, the test methods), read
//! the first time it is used.
//!
//! The TypeScript objects were JavaScript objects, so an entry here keeps what a JavaScript object keeps: its keys in
//! the order they were first set, a key set to `undefined` (a patch that says `limits: undefined` leaves the key
//! in place for a later set, and leaves it out of the file). `None` is `undefined`; over the core's methods it is
//! the marker `{"~undefined": true}`.
//!
//! Methods (params `{userData, kind: "peers"|"hosts", deviceId?, entry?, patch?, nodeId?, address?}`, answering the
//! JavaScript-shaped value, `null` for `undefined`): `remote.store.list`, `.get`, `.put`, `.update`, `.remove`,
//! `.byNode`, `.rememberAddress` and `.reload` (forgets what was read, so the next call reads the file again, as a
//! new store object did). They exist for the tests; production code calls [`open`].
//!
//! Differences from the TypeScript: a file holding a number JavaScript reads as Infinity (`1e999`) or a lone
//! surrogate escape (`"\ud800"`) is not JSON here and loads as no entries; `put` of an entry without a string
//! `deviceId` (or, for hosts, an `addresses` array) is an error where JavaScript used `undefined` as the key or
//! threw a TypeError.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::{Map, Value};

use super::crypto::is_raw_key;
use crate::disk::tree::write_atomic_if;
use crate::git::parse::js_number;
use crate::server::{Call, Fault, Registry, Reply};

/// Addresses kept per host; older ones fall off the end (`MAX_HOST_ADDRESSES`).
pub const MAX_HOST_ADDRESSES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Peers,
    Hosts,
}

impl Kind {
    fn file(self) -> &'static str {
        match self {
            Kind::Peers => "remote-peers.json",
            Kind::Hosts => "remote-hosts.json",
        }
    }

    /// The key the entries sit under in the file.
    fn key(self) -> &'static str {
        match self {
            Kind::Peers => "peers",
            Kind::Hosts => "hosts",
        }
    }
}

/// An entry's keys in the order they were first set; `None` is a key holding `undefined`.
type Fields = Vec<(String, Option<Value>)>;

/// One entry under the `deviceId` it is kept by (what `Map.set` was given: a patch that changes the entry's own
/// `deviceId` does not move it).
struct Row {
    id: String,
    fields: Fields,
}

pub struct Store {
    file: PathBuf,
    kind: Kind,
    rows: Option<Vec<Row>>,
}

static STORES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<Store>>>>> = LazyLock::new(Mutex::default);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The store of `kind` under `user_data`, shared by every caller in the process and read on first use.
pub fn open(user_data: &Path, kind: Kind) -> Arc<Mutex<Store>> {
    let file = user_data.join(kind.file());
    lock(&STORES)
        .entry(file.clone())
        .or_insert_with(|| Arc::new(Mutex::new(Store::new(file, kind))))
        .clone()
}

/// `{"~undefined": true}`: how a value that was `undefined` crosses JSON.
fn is_marker(value: &Value) -> bool {
    matches!(value, Value::Object(object) if object.len() == 1 && object.get("~undefined") == Some(&Value::Bool(true)))
}

fn slot(value: Value) -> Option<Value> {
    (!is_marker(&value)).then_some(value)
}

/// What a reader of the entry sees: its keys without the `undefined` ones.
fn view(fields: &Fields) -> Map<String, Value> {
    fields
        .iter()
        .filter_map(|(key, value)| Some((key.clone(), value.clone()?)))
        .collect()
}

/// `fields[key] = value` as a JavaScript object does it: an existing key keeps its place, a new one is added last.
fn set(fields: &mut Fields, key: String, value: Option<Value>) {
    match fields.iter_mut().find(|(existing, _)| *existing == key) {
        Some(field) => field.1 = value,
        None => fields.push((key, value)),
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// `z.number().int().nonnegative()`.
fn count(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= 0.0)
}

/// `z.string().nullable().default(null)`, with `.min(1)` when `non_empty`; None when the value does not parse.
fn nullable_string(raw: &Map<String, Value>, key: &str, non_empty: bool) -> Option<Value> {
    match raw.get(key) {
        None | Some(Value::Null) => Some(Value::Null),
        Some(Value::String(text)) if !non_empty || !text.is_empty() => {
            Some(Value::String(text.clone()))
        }
        _ => None,
    }
}

fn string<'a>(raw: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    raw.get(key)?.as_str()
}

fn number(raw: &Map<String, Value>, key: &str) -> Option<Value> {
    let value = raw.get(key)?;
    value.is_number().then(|| value.clone())
}

/// The entry `StoredPeer` or `StoredHost` makes of `raw`, in the schema's key order; None when it does not parse.
fn parse_entry(kind: Kind, raw: &Value) -> Option<Fields> {
    let Value::Object(raw) = raw else {
        return None;
    };
    let mut fields: Fields = Vec::new();
    let mut add = |key: &str, value: Value| fields.push((key.to_owned(), Some(value)));
    add(
        "deviceId",
        Value::String(
            string(raw, "deviceId")
                .filter(|id| !id.is_empty())?
                .to_owned(),
        ),
    );
    add("name", Value::String(string(raw, "name")?.to_owned()));
    add(
        "staticPub",
        Value::String(
            string(raw, "staticPub")
                .filter(|key| is_raw_key(key))?
                .to_owned(),
        ),
    );
    add("nodeId", nullable_string(raw, "nodeId", true)?);
    match kind {
        Kind::Peers => {
            add("login", nullable_string(raw, "login", false)?);
            add("pairedAt", number(raw, "pairedAt")?);
            match raw.get("lastSeenAt") {
                None => {}
                Some(value) if value.is_number() => add("lastSeenAt", value.clone()),
                Some(_) => return None,
            }
            if let Some(limits) = raw.get("limits") {
                let Value::Object(limits) = limits else {
                    return None;
                };
                let mut kept = Map::new();
                for key in ["requestsPerDay", "tokensPerDay"] {
                    match limits.get(key) {
                        None => {}
                        Some(value) if count(value) => {
                            kept.insert(key.to_owned(), value.clone());
                        }
                        Some(_) => return None,
                    }
                }
                add("limits", Value::Object(kept));
            }
            if let Some(usage) = raw.get("usage") {
                let Value::Object(usage) = usage else {
                    return None;
                };
                let mut kept = Map::new();
                kept.insert(
                    "day".into(),
                    Value::String(string(usage, "day")?.to_owned()),
                );
                for key in ["requests", "tokens"] {
                    let value = usage.get(key).filter(|value| count(value))?;
                    kept.insert(key.to_owned(), value.clone());
                }
                add("usage", Value::Object(kept));
            }
        }
        Kind::Hosts => {
            let Some(Value::Array(addresses)) = raw.get("addresses") else {
                return None;
            };
            if !addresses.iter().all(Value::is_string) {
                return None;
            }
            add("addresses", Value::Array(addresses.clone()));
            add("pairedAt", number(raw, "pairedAt")?);
        }
    }
    Some(fields)
}

/// `Map.set`: the row of `id` takes the entry, keeping its place, or the entry goes last.
fn upsert(rows: &mut Vec<Row>, id: String, fields: Fields) {
    match rows.iter_mut().find(|row| row.id == id) {
        Some(row) => row.fields = fields,
        None => rows.push(Row { id, fields }),
    }
}

/// What the file holds: no entries when it is missing, not JSON, not `v` 1 or has no array under the key.
fn read(file: &Path, kind: Kind) -> Vec<Row> {
    let mut rows = Vec::new();
    let Ok(bytes) = std::fs::read(file) else {
        return rows;
    };
    let Ok(Value::Object(top)) = serde_json::from_str(&String::from_utf8_lossy(&bytes)) else {
        return rows;
    };
    if top.get("v").and_then(Value::as_f64) != Some(1.0) {
        return rows;
    }
    let Some(Value::Array(raws)) = top.get(kind.key()) else {
        return rows;
    };
    for raw in raws {
        if let Some(fields) = parse_entry(kind, raw) {
            let id = string(&view(&fields), "deviceId")
                .unwrap_or_default()
                .to_owned();
            upsert(&mut rows, id, fields);
        }
    }
    rows
}

fn quote(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(value, null, "\t")`: numbers spelled as JavaScript spells them, `[]` and `{}` for empty ones.
pub(crate) fn stringify(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n.as_f64().unwrap_or(0.0))),
        Value::String(text) => quote(text, out),
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Object(object) if object.is_empty() => out.push_str("{}"),
        Value::Array(items) => {
            out.push_str("[\n");
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push_str(",\n");
                }
                out.extend(std::iter::repeat_n('\t', depth + 1));
                stringify(item, depth + 1, out);
            }
            out.push('\n');
            out.extend(std::iter::repeat_n('\t', depth));
            out.push(']');
        }
        Value::Object(object) => {
            out.push_str("{\n");
            for (at, (key, item)) in object.iter().enumerate() {
                if at > 0 {
                    out.push_str(",\n");
                }
                out.extend(std::iter::repeat_n('\t', depth + 1));
                quote(key, out);
                out.push_str(": ");
                stringify(item, depth + 1, out);
            }
            out.push('\n');
            out.extend(std::iter::repeat_n('\t', depth));
            out.push('}');
        }
    }
}

impl Store {
    fn new(file: PathBuf, kind: Kind) -> Store {
        Store {
            file,
            kind,
            rows: None,
        }
    }

    fn rows(&mut self) -> &mut Vec<Row> {
        self.rows.get_or_insert_with(|| read(&self.file, self.kind))
    }

    /// The file's bytes: `{ v: 1, [key]: entries }`. A change is kept in memory even when this fails, as before.
    fn save(&mut self) -> io::Result<()> {
        let kind = self.kind;
        let entries: Vec<Value> = self
            .rows()
            .iter()
            .map(|row| Value::Object(view(&row.fields)))
            .collect();
        let mut document = Map::new();
        document.insert("v".into(), 1.into());
        document.insert(kind.key().into(), Value::Array(entries));
        let mut text = String::new();
        stringify(&Value::Object(document), 0, &mut text);
        text.push('\n');
        write_atomic_if(&self.file, text.as_bytes(), Some(0o600), 0o777, &|| true)
            .map(|_| ())
            .map_err(|fault| io::Error::other(fault.message))
    }

    /// Forgets what was read: the next call reads the file again.
    pub fn reload(&mut self) {
        self.rows = None;
    }

    pub fn list(&mut self) -> Vec<Map<String, Value>> {
        self.rows().iter().map(|row| view(&row.fields)).collect()
    }

    pub fn get(&mut self, device_id: &str) -> Option<Map<String, Value>> {
        self.rows()
            .iter()
            .find(|row| row.id == device_id)
            .map(|row| view(&row.fields))
    }

    /// Adds an entry or replaces it (a re-pair), and saves. A value that is the `undefined` marker is `undefined`.
    pub fn put(&mut self, entry: Map<String, Value>) -> io::Result<()> {
        let Some(Value::String(id)) = entry.get("deviceId") else {
            return Err(invalid("an entry needs a deviceId"));
        };
        let id = id.clone();
        let fields: Fields = entry
            .into_iter()
            .map(|(key, value)| (key, slot(value)))
            .collect();
        if self.kind == Kind::Hosts
            && !fields
                .iter()
                .any(|(key, value)| key == "addresses" && matches!(value, Some(Value::Array(_))))
        {
            return Err(invalid("a host needs an addresses array"));
        }
        upsert(self.rows(), id, fields);
        self.save()
    }

    /// The patch's keys over the entry's (`{...current, ...patch}`), saved; the entry as a reader sees it, None when
    /// there is no such device. A host's addresses are cut to [`MAX_HOST_ADDRESSES`].
    pub fn update(
        &mut self,
        device_id: &str,
        mut patch: Vec<(String, Option<Value>)>,
    ) -> io::Result<Option<Map<String, Value>>> {
        let kind = self.kind;
        let rows = self.rows();
        let Some(at) = rows.iter().position(|row| row.id == device_id) else {
            return Ok(None);
        };
        if kind == Kind::Hosts {
            // `(patch.addresses ?? current.addresses).slice(0, MAX_HOST_ADDRESSES)`
            let given = patch
                .iter()
                .position(|(key, _)| key == "addresses")
                .and_then(|index| patch.remove(index).1)
                .filter(|value| !value.is_null());
            let current = rows[at]
                .fields
                .iter()
                .find(|(key, _)| key == "addresses")
                .and_then(|(_, value)| value.clone());
            let Some(Value::Array(mut addresses)) = given.or(current) else {
                return Err(invalid("a host needs an addresses array"));
            };
            addresses.truncate(MAX_HOST_ADDRESSES);
            patch.push(("addresses".into(), Some(Value::Array(addresses))));
        }
        for (key, value) in patch {
            set(&mut rows[at].fields, key, value);
        }
        let next = view(&rows[at].fields);
        self.save()?;
        Ok(Some(next))
    }

    pub fn remove(&mut self, device_id: &str) -> io::Result<bool> {
        let rows = self.rows();
        let Some(at) = rows.iter().position(|row| row.id == device_id) else {
            return Ok(false);
        };
        rows.remove(at);
        self.save()?;
        Ok(true)
    }

    /// The entry pinned to a Tailscale node; a node holds at most one.
    pub fn by_node(&mut self, node_id: &str) -> Option<Map<String, Value>> {
        self.rows()
            .iter()
            .map(|row| view(&row.fields))
            .find(|entry| entry.get("nodeId").and_then(Value::as_str) == Some(node_id))
    }

    /// Moves (or adds) a working address to a host's front; no write when it already leads.
    pub fn remember_address(
        &mut self,
        device_id: &str,
        address: &str,
    ) -> io::Result<Option<Map<String, Value>>> {
        let Some(current) = self.get(device_id) else {
            return Ok(None);
        };
        let Some(Value::Array(addresses)) = current.get("addresses") else {
            return Err(invalid("a host needs an addresses array"));
        };
        if addresses.first().and_then(Value::as_str) == Some(address) {
            return Ok(Some(current));
        }
        let mut next = vec![Value::String(address.to_owned())];
        next.extend(
            addresses
                .iter()
                .filter(|a| a.as_str() != Some(address))
                .cloned(),
        );
        self.update(
            device_id,
            vec![("addresses".into(), Some(Value::Array(next)))],
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    user_data: PathBuf,
    kind: Kind,
    device_id: Option<String>,
    entry: Option<Map<String, Value>>,
    patch: Option<Map<String, Value>>,
    node_id: Option<String>,
    address: Option<String>,
}

#[derive(Clone, Copy)]
enum Method {
    List,
    Get,
    Put,
    Update,
    Remove,
    ByNode,
    RememberAddress,
    Reload,
}

fn need<T>(value: Option<T>, name: &str) -> Result<T, Fault> {
    value.ok_or_else(|| Fault::new("invalid_params", format!("{name} is missing")))
}

fn entry_or_null(entry: Option<Map<String, Value>>) -> Value {
    entry.map_or(Value::Null, Value::Object)
}

fn run(params: Params, method: Method) -> Result<Value, Fault> {
    let shared = open(&params.user_data, params.kind);
    let mut store = lock(&shared);
    let io = |error: io::Error| Fault::new("io", error.to_string());
    Ok(match method {
        Method::List => Value::Array(store.list().into_iter().map(Value::Object).collect()),
        Method::Get => entry_or_null(store.get(&need(params.device_id, "deviceId")?)),
        Method::Put => {
            store.put(need(params.entry, "entry")?).map_err(io)?;
            Value::Null
        }
        Method::Update => {
            let patch = need(params.patch, "patch")?
                .into_iter()
                .map(|(key, value)| (key, slot(value)))
                .collect();
            entry_or_null(
                store
                    .update(&need(params.device_id, "deviceId")?, patch)
                    .map_err(io)?,
            )
        }
        Method::Remove => Value::Bool(
            store
                .remove(&need(params.device_id, "deviceId")?)
                .map_err(io)?,
        ),
        Method::ByNode => entry_or_null(store.by_node(&need(params.node_id, "nodeId")?)),
        Method::RememberAddress => entry_or_null(
            store
                .remember_address(
                    &need(params.device_id, "deviceId")?,
                    &need(params.address, "address")?,
                )
                .map_err(io)?,
        ),
        Method::Reload => {
            store.reload();
            Value::Null
        }
    })
}

async fn call(call: Call, method: Method) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let answer = tokio::task::spawn_blocking(move || run(params, method))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))??;
    Reply::json(&answer)
}

pub fn register(registry: &mut Registry) {
    registry.add("remote.store.list", |c| Box::pin(call(c, Method::List)));
    registry.add("remote.store.get", |c| Box::pin(call(c, Method::Get)));
    registry.add("remote.store.put", |c| Box::pin(call(c, Method::Put)));
    registry.add("remote.store.update", |c| Box::pin(call(c, Method::Update)));
    registry.add("remote.store.remove", |c| Box::pin(call(c, Method::Remove)));
    registry.add("remote.store.byNode", |c| Box::pin(call(c, Method::ByNode)));
    registry.add("remote.store.rememberAddress", |c| {
        Box::pin(call(c, Method::RememberAddress))
    });
    registry.add("remote.store.reload", |c| Box::pin(call(c, Method::Reload)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ompdesk-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn text(value: &Value) -> String {
        let mut out = String::new();
        stringify(value, 0, &mut out);
        out
    }

    fn object(value: &Value) -> Map<String, Value> {
        match value {
            Value::Object(object) => object.clone(),
            other => panic!("not an object: {other}"),
        }
    }

    fn patch(value: &Value) -> Vec<(String, Option<Value>)> {
        object(value)
            .into_iter()
            .map(|(key, value)| (key, slot(value)))
            .collect()
    }

    fn answer(entry: Option<Map<String, Value>>) -> Value {
        entry_or_null(entry)
    }

    fn mode(file: &Path) -> Option<u32> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(file)
                .ok()
                .map(|meta| meta.permissions().mode() & 0o777)
        }
        #[cfg(not(unix))]
        {
            let _ = file;
            None
        }
    }

    fn captured() -> Value {
        serde_json::from_str(include_str!("store-captured.json")).unwrap()
    }

    /// Replays every captured scenario: each step's returned value, and after a change the file's exact bytes and
    /// (where the OS has them) its mode.
    #[test]
    fn replays_what_the_typescript_stores_did() {
        let captured = captured();
        let scenarios = captured["scenarios"].as_array().unwrap();
        assert!(scenarios.len() > 250, "{} scenarios", scenarios.len());
        let mut steps = 0;
        for (number, scenario) in scenarios.iter().enumerate() {
            let name = scenario["name"].as_str().unwrap();
            let kind = match scenario["kind"].as_str().unwrap() {
                "peers" => Kind::Peers,
                _ => Kind::Hosts,
            };
            let dir = scratch(&format!("replay{number}"));
            let file = dir.join(kind.file());
            let mut store = Store::new(file.clone(), kind);
            for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                steps += 1;
                let here = format!("{name} (step {index}: {})", step["op"]);
                let id = step["id"].as_str().unwrap_or_default();
                let result = match step["op"].as_str().unwrap() {
                    "write" => {
                        let bytes = match step["hex"].as_str() {
                            Some(hex) => (0..hex.len())
                                .step_by(2)
                                .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
                                .collect(),
                            None => step["text"].as_str().unwrap().as_bytes().to_vec(),
                        };
                        std::fs::write(&file, bytes).unwrap();
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644))
                                .unwrap();
                        }
                        continue;
                    }
                    "fresh" => {
                        store = Store::new(file.clone(), kind);
                        continue;
                    }
                    "list" => Value::Array(store.list().into_iter().map(Value::Object).collect()),
                    "get" => answer(store.get(id)),
                    "byNode" => answer(store.by_node(step["node"].as_str().unwrap())),
                    "put" => {
                        let done = store.put(object(&step["entry"]));
                        assert_eq!(done.is_ok(), step["result"] == "ok", "{here}");
                        Value::Null
                    }
                    "update" => answer(store.update(id, patch(&step["patch"])).unwrap()),
                    "remove" => Value::Bool(store.remove(id).unwrap()),
                    "remember" => answer(
                        store
                            .remember_address(id, step["address"].as_str().unwrap())
                            .unwrap(),
                    ),
                    other => panic!("{here}: unknown op {other}"),
                };
                if step["op"] != "put" {
                    assert_eq!(text(&result), text(&step["result"]), "{here}");
                }
                if step.get("file").is_some() {
                    let bytes = std::fs::read(&file).ok();
                    let wrote = bytes
                        .as_ref()
                        .map(|bytes| String::from_utf8_lossy(bytes).into_owned());
                    assert_eq!(wrote.as_deref(), step["file"].as_str(), "{here}: the file");
                    if let (Some(want), Some(got)) = (step["mode"].as_u64(), mode(&file)) {
                        assert_eq!(u64::from(got), want, "{here}: the mode");
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        assert!(steps > 1_000, "{steps} steps");
    }

    #[test]
    fn one_copy_per_file_is_shared_and_reload_reads_the_file_again() {
        let dir = scratch("shared");
        let first = open(&dir, Kind::Peers);
        let second = open(&dir, Kind::Peers);
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &open(&dir, Kind::Hosts)));
        let entry = serde_json::json!({
            "deviceId": "a", "name": "A", "staticPub": "A".repeat(43), "nodeId": null, "login": null, "pairedAt": 1
        });
        lock(&first).put(object(&entry)).unwrap();
        assert_eq!(lock(&second).list().len(), 1);
        std::fs::remove_file(dir.join("remote-peers.json")).unwrap();
        assert_eq!(
            lock(&second).list().len(),
            1,
            "memory is kept until reloaded"
        );
        lock(&second).reload();
        assert!(lock(&first).list().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_makes_the_folder() {
        let dir = scratch("folder").join("a").join("b");
        let entry = serde_json::json!({
            "deviceId": "a", "name": "A", "staticPub": "A".repeat(43), "nodeId": null, "login": null, "pairedAt": 1
        });
        let mut store = Store::new(dir.join("remote-peers.json"), Kind::Peers);
        store.put(object(&entry)).unwrap();
        assert!(dir.join("remote-peers.json").exists());
        if cfg!(unix) {
            assert_eq!(mode(&dir.join("remote-peers.json")), Some(0o600));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_save_keeps_the_change_in_memory() {
        let dir = scratch("failed");
        // A folder where the file belongs: the rename cannot replace it.
        std::fs::create_dir_all(dir.join("remote-peers.json").join("x")).unwrap();
        let mut store = Store::new(dir.join("remote-peers.json"), Kind::Peers);
        let entry = serde_json::json!({
            "deviceId": "a", "name": "A", "staticPub": "A".repeat(43), "nodeId": null, "login": null, "pairedAt": 1
        });
        assert!(store.put(object(&entry)).is_err());
        assert_eq!(store.list().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
