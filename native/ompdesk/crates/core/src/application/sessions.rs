use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use crate::remote::session_feed::{self, Row, SessionDelta, SessionList};
use crate::server::{Fault, Scope};
use crate::sessions::{NativeIndex, NativeReport};
use crate::stock::native::Service as Stock;

mod pace;
mod search;
mod tombstones;
pub use search::ContentMatch;
pub use tombstones::{Tombstone, Tombstones};

const STOCK_TIMEOUT: Duration = Duration::from_secs(30);

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn absolute(path: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part.as_os_str()),
        }
    }
    result
}

struct State {
    generation: u64,
    copy_generation: Option<u64>,
    copy: Option<SessionList>,
    next: u64,
    started: bool,
    watching: bool,
    watch_generation: u64,
    lifecycle: u64,
    reading: Option<watch::Receiver<Option<Result<(), Fault>>>>,
}

pub struct SessionIndex {
    stock: Arc<Stock>,
    root: PathBuf,
    cwd: PathBuf,
    tombstones: Arc<Tombstones>,
    kinds_file: PathBuf,
    chats: Mutex<HashSet<String>>,
    engine: Mutex<NativeIndex>,
    cache: Mutex<search::ContentCache>,
    pace_cache: Mutex<pace::PaceCache>,
    state: Mutex<State>,
    epoch: String,
    changes: broadcast::Sender<Option<SessionDelta>>,
    paths: broadcast::Sender<Option<PathBuf>>,
}

impl SessionIndex {
    pub fn new(
        stock: Arc<Stock>,
        root: PathBuf,
        cwd: PathBuf,
        tombstones: Arc<Tombstones>,
        kinds_file: PathBuf,
    ) -> Arc<Self> {
        let (changes, _) = broadcast::channel(128);
        let (paths, _) = broadcast::channel(128);
        let kinds: Value = std::fs::read(&kinds_file)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or(Value::Null);
        let chats = kinds
            .get("chat")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        Arc::new(Self {
            stock,
            root: absolute(&root),
            cwd: absolute(&cwd),
            tombstones,
            kinds_file,
            chats: Mutex::new(chats),
            engine: Mutex::new(NativeIndex::new()),
            cache: Mutex::new(search::ContentCache::default()),
            pace_cache: Mutex::new(pace::PaceCache::default()),
            state: Mutex::new(State {
                generation: 0,
                copy_generation: None,
                copy: None,
                next: 0,
                started: false,
                watching: false,
                watch_generation: 0,
                lifecycle: 0,
                reading: None,
            }),
            epoch: crate::remote::crypto::random_device_id(),
            changes,
            paths,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Option<SessionDelta>> {
        self.changes.subscribe()
    }
    pub fn subscribe_paths(&self) -> broadcast::Receiver<Option<PathBuf>> {
        self.paths.subscribe()
    }
    pub fn sessions_dir(&self) -> &Path {
        &self.root
    }

    pub fn start(self: &Arc<Self>) {
        let mut engine = lock(&self.engine);
        let lifecycle = {
            let mut state = lock(&self.state);
            if state.started {
                return;
            }
            state.started = true;
            state.lifecycle += 1;
            state.lifecycle
        };
        let weak = Arc::downgrade(self);
        engine.watch(self.root.clone(), move |report| {
            if let Some(index) = weak.upgrade() {
                index.watch_report(lifecycle, report);
            }
        });
    }

    fn watch_report(self: &Arc<Self>, lifecycle: u64, report: NativeReport) {
        let state = lock(&self.state);
        if !state.started || state.lifecycle != lifecycle {
            return;
        }
        drop(state);
        match report {
            NativeReport::Watching { missed } => {
                let generation = {
                    let mut state = lock(&self.state);
                    if !state.started || state.lifecycle != lifecycle {
                        return;
                    }
                    state.watching = true;
                    state.watch_generation += 1;
                    state.watch_generation
                };
                let weak = Arc::downgrade(self);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if let Some(index) = weak.upgrade() {
                        let warm = {
                            let mut state = lock(&index.state);
                            if state.started
                                && state.watching
                                && state.watch_generation == generation
                                && state.copy.is_some()
                            {
                                state.generation += 1;
                                true
                            } else {
                                false
                            }
                        };
                        if warm {
                            let _ = index.current().await;
                        }
                    }
                });
                if missed {
                    self.notify_all();
                }
            }
            NativeReport::Unwatched => {
                let mut state = lock(&self.state);
                if !state.started || state.lifecycle != lifecycle {
                    return;
                }
                state.watching = false;
                state.watch_generation += 1;
                drop(state);
                self.notify_all();
            }
            NativeReport::Anything => {
                lock(&self.cache).clear();
                lock(&self.pace_cache).clear();
                self.notify_all();
            }
            NativeReport::Changed(names) => {
                let mut cache = lock(&self.cache);
                for entry in names {
                    let path = self.root.join(entry.name);
                    cache.invalidate(&path);
                    lock(&self.pace_cache).invalidate(&path);
                    let _ = self.paths.send(Some(path));
                }
                drop(cache);
                self.changed();
            }
        }
    }

    fn notify_all(self: &Arc<Self>) {
        let _ = self.paths.send(None);
        self.changed();
    }

    pub fn stop(&self) {
        let mut engine = lock(&self.engine);
        let mut state = lock(&self.state);
        state.started = false;
        state.watching = false;
        state.watch_generation += 1;
        state.lifecycle += 1;
        drop(state);
        *engine = NativeIndex::new();
        lock(&self.cache).clear();
        lock(&self.pace_cache).clear();
    }

    pub fn stale(&self) {
        lock(&self.state).generation += 1;
    }
    pub fn held(&self) -> Option<SessionList> {
        lock(&self.state).copy.clone()
    }

    pub fn changed(self: &Arc<Self>) {
        let held = {
            let mut state = lock(&self.state);
            state.generation += 1;
            state.copy.is_some()
        };
        if !held {
            let _ = self.changes.send(None);
            return;
        }
        let index = Arc::clone(self);
        tokio::spawn(async move {
            let _ = index.current().await;
        });
    }

    pub fn relist(self: &Arc<Self>) {
        self.changed();
    }

    pub fn set(&self, rows: Vec<Row>) {
        let generation = lock(&self.state).copy_generation;
        self.publish(rows, generation);
    }

    fn publish(&self, rows: Vec<Row>, generation: Option<u64>) {
        let mut state = lock(&self.state);
        state.copy_generation = state.copy_generation.max(generation);
        let delta = state
            .copy
            .as_ref()
            .map(|before| session_feed::diff(&before.sessions, &rows));
        if delta
            .as_ref()
            .is_some_and(|(set, remove)| set.is_empty() && remove.is_empty())
        {
            return;
        }
        state.next += 1;
        let version = format!("{}.{}", self.epoch, state.next);
        let before = state.copy.replace(SessionList {
            version: version.clone(),
            sessions: rows,
        });
        if let (Some(before), Some((set, remove))) = (before, delta) {
            let _ = self.changes.send(Some(SessionDelta {
                base: before.version,
                version,
                set,
                remove,
            }));
        }
    }

    pub async fn current(self: &Arc<Self>) -> Result<SessionList, Fault> {
        let wanted = {
            let mut state = lock(&self.state);
            if !state.started || !state.watching {
                state.generation += 1;
            }
            state.generation
        };
        loop {
            let mut waiting = {
                let mut state = lock(&self.state);
                if state
                    .copy_generation
                    .is_some_and(|generation| generation >= wanted)
                    && let Some(copy) = &state.copy
                {
                    return Ok(copy.clone());
                }
                if state.reading.is_none() {
                    let generation = state.generation;
                    let (answer, waiting) = watch::channel(None);
                    state.reading = Some(waiting);
                    let index = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = index
                            .read_all()
                            .await
                            .map(|rows| index.publish(rows, Some(generation)));
                        lock(&index.state).reading = None;
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
                waiting.changed().await.map_err(|_| {
                    Fault::new("session_read", "Session read ended without an answer")
                })?;
            }
        }
    }

    pub async fn list_shared(self: &Arc<Self>) -> Result<SessionList, Fault> {
        match self.current().await {
            Err(error) if error.code == "omp_unavailable" => Ok(SessionList {
                version: String::new(),
                sessions: Vec::new(),
            }),
            result => result,
        }
    }

    pub async fn list_known(self: &Arc<Self>) -> Result<Option<Vec<Row>>, Fault> {
        let list = self.list_shared().await?;
        if list.version.is_empty() {
            return Ok(None);
        }
        Ok(Some(
            list.sessions
                .into_iter()
                .filter(|row| !self.tombstones.has(Path::new(row.path()), None))
                .collect(),
        ))
    }

    async fn request(&self, method: &str, extra: Value) -> Result<Value, Fault> {
        let mut params = extra;
        params["sessionsRoot"] = self.root.to_string_lossy().into_owned().into();
        self.stock
            .request(method, &params, STOCK_TIMEOUT, Scope::detached())
            .await
    }

    fn chats(&self) -> HashSet<String> {
        lock(&self.chats).clone()
    }

    pub fn is_chat(&self, id: &str) -> bool {
        lock(&self.chats).contains(id)
    }

    pub fn mark_chat(self: &Arc<Self>, id: &str) -> Result<(), Fault> {
        let mut chats = lock(&self.chats);
        if !chats.insert(id.to_owned()) {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&json!({ "chat": &*chats }))
            .map_err(|error| Fault::new("json", error.to_string()))?;
        let saved = crate::disk::saves::write_kept(&self.kinds_file, &bytes, None, 0o700);
        drop(chats);
        self.changed();
        saved.map(|_| ())
    }

    async fn read_all(&self) -> Result<Vec<Row>, Fault> {
        let value = self.request("sessions.list", json!({})).await?;
        let values = value
            .as_array()
            .ok_or_else(|| Fault::new("stock_json", "Invalid session list"))?;
        let mut rows = Vec::with_capacity(values.len());
        for value in values {
            let mut row = value
                .as_object()
                .cloned()
                .ok_or_else(|| Fault::new("stock_json", "Invalid session row"))?;
            for field in ["path", "id", "cwd", "created", "modified", "firstMessage"] {
                if !row.get(field).is_some_and(Value::is_string) {
                    return Err(Fault::new("stock_json", format!("Invalid session {field}")));
                }
            }
            for field in ["messageCount", "size"] {
                if !row.get(field).is_some_and(Value::is_number) {
                    return Err(Fault::new("stock_json", format!("Invalid session {field}")));
                }
            }
            if row
                .get("title")
                .is_some_and(|value| !value.is_null() && !value.is_string())
            {
                return Err(Fault::new("stock_json", "Invalid session title"));
            }
            row.entry("title").or_insert(Value::Null);
            row.entry("status")
                .or_insert_with(|| Value::String("unknown".into()));
            if !row
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| {
                    matches!(
                        status,
                        "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown"
                    )
                })
            {
                return Err(Fault::new("stock_json", "Invalid session status"));
            }
            for field in ["parentSessionPath", "promptOriginDevice", "autoTitle"] {
                if row.get(field).is_some_and(|value| !value.is_string()) {
                    return Err(Fault::new("stock_json", format!("Invalid session {field}")));
                }
            }
            row.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "path"
                        | "id"
                        | "title"
                        | "cwd"
                        | "created"
                        | "modified"
                        | "messageCount"
                        | "size"
                        | "status"
                        | "firstMessage"
                        | "parentSessionPath"
                        | "promptOriginDevice"
                        | "autoTitle"
                )
            });
            rows.push(
                Row::parse(Value::Object(row)).map_err(|error| Fault::new("stock_json", error))?,
            );
        }
        rows.retain(|row| !self.tombstones.has(Path::new(row.path()), None));
        session_feed::sort(&mut rows);
        let ids: Vec<_> = rows
            .iter()
            .map(|row| {
                (
                    row.path().to_owned(),
                    row.value()["id"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let kept = lock(&self.engine).listed(&ids);
        let chats = self.chats();
        Ok(kept
            .into_iter()
            .filter_map(|(at, chat)| {
                let mut row = rows.get(at)?.clone();
                if chat || chats.contains(row.value()["id"].as_str().unwrap_or_default()) {
                    row.set_kind("chat");
                }
                Some(row)
            })
            .collect())
    }

    pub async fn list(
        self: &Arc<Self>,
        local: bool,
        cwd: Option<&Path>,
    ) -> Result<Vec<Row>, Fault> {
        let cwd = cwd.map(absolute).unwrap_or_else(|| self.cwd.clone());
        Ok(self
            .list_shared()
            .await?
            .sessions
            .into_iter()
            .filter(|row| {
                !self.tombstones.has(Path::new(row.path()), None)
                    && (!local
                        || row.value()["cwd"]
                            .as_str()
                            .is_some_and(|path| absolute(Path::new(path)) == cwd))
            })
            .collect())
    }

    fn target(&self, path: &Path) -> Result<PathBuf, Fault> {
        let path = absolute(path);
        if path == self.root
            || !path.starts_with(&self.root)
            || path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
        {
            return Err(Fault::new("invalid_session_path", "Invalid session path"));
        }
        Ok(path)
    }

    pub async fn delete(self: &Arc<Self>, path: &Path) -> Result<(), Fault> {
        let path = self.target(path)?;
        self.request("sessions.delete", json!({"sessionPath":path}))
            .await?;
        lock(&self.cache).invalidate(&path);
        lock(&self.pace_cache).invalidate(&path);
        self.notify_all();
        Ok(())
    }

    pub async fn move_session(self: &Arc<Self>, path: &Path, cwd: &Path) -> Result<PathBuf, Fault> {
        let source = self.target(path)?;
        let cwd = absolute(cwd);
        if !cwd.is_dir() {
            return Err(Fault::new(
                "not_a_directory",
                format!("Not a directory: {}", cwd.display()),
            ));
        }
        let result = self
            .request("sessions.move", json!({"sessionPath":source,"cwd":cwd}))
            .await?;
        let moved = result["sessionPath"]
            .as_str()
            .ok_or_else(|| Fault::new("stock_json", "Missing moved session path"))?;
        let moved = PathBuf::from(moved);
        let mut cache = lock(&self.cache);
        cache.invalidate(&source);
        cache.invalidate(&moved);
        drop(cache);
        lock(&self.pace_cache).invalidate(&source);
        lock(&self.pace_cache).invalidate(&moved);
        self.notify_all();
        Ok(moved)
    }

    pub async fn messages(&self, path: &Path) -> Result<Value, Fault> {
        let path = self.target(path)?;
        let result = self
            .request("sessions.messages", json!({"sessionPath":path}))
            .await?;
        Ok(if result.is_array() { result } else { json!([]) })
    }

    pub async fn owned(&self, path: &Path) -> Result<bool, Fault> {
        let Ok(path) = self.target(path) else {
            return Ok(false);
        };
        Ok(self
            .request("sessions.owned", json!({"sessionPath":path}))
            .await?
            == Value::Bool(true))
    }

    pub async fn recorded_cwd(&self, path: &Path) -> Result<Option<String>, Fault> {
        let path = absolute(path);
        let rows = self
            .request("sessions.list_directory", json!({"sessionPath":path}))
            .await?;
        Ok(rows
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| {
                row["path"]
                    .as_str()
                    .is_some_and(|p| absolute(Path::new(p)) == path)
            })
            .and_then(|row| row["cwd"].as_str())
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned))
    }

    pub async fn kind_for(&self, path: &Path) -> &'static str {
        let path = absolute(path);
        let Ok(rows) = self
            .request("sessions.list_directory", json!({"sessionPath":path}))
            .await
        else {
            return "agent";
        };
        let Some(row) = rows.as_array().into_iter().flatten().find(|row| {
            row["path"]
                .as_str()
                .is_some_and(|p| absolute(Path::new(p)) == path)
        }) else {
            return "agent";
        };
        if self
            .chats()
            .contains(row["id"].as_str().unwrap_or_default())
            || NativeIndex::kind(&path.to_string_lossy()) == Some(true)
        {
            "chat"
        } else {
            "agent"
        }
    }

    pub fn pace(&self, path: &Path) -> Result<Option<Value>, Fault> {
        let path = self.target(path)?;
        Ok(lock(&self.pace_cache).read(&path))
    }

    pub fn search_content(&self, query: &str, paths: &[PathBuf]) -> Vec<ContentMatch> {
        let paths: Vec<_> = paths
            .iter()
            .filter_map(|path| self.target(path).ok())
            .collect();
        lock(&self.cache).search(query, &paths)
    }
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
