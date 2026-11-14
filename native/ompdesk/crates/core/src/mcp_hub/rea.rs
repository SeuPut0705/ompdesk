use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, Notify, OnceCell, mpsc, oneshot, watch};

#[derive(Clone)]
pub struct ReaConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cache_dir: Option<PathBuf>,
    pub version: String,
    pub curated_tools: Vec<String>,
}

#[derive(Clone)]
struct Entry {
    client: String,
    initialize: Value,
    tools: Vec<Value>,
    prompts: Option<Value>,
}

pub struct Cache {
    file: Option<PathBuf>,
    version: String,
    entry: Mutex<Option<Entry>>,
}

impl Cache {
    pub fn new(config: &ReaConfig) -> Self {
        let file = config
            .cache_dir
            .as_ref()
            .map(|dir| dir.join(format!("rea-{}.json", config.version)));
        let entry = file
            .as_ref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                if value.get("version")?.as_str()? != config.version {
                    return None;
                }
                let client = value.get("client")?.as_str()?.to_owned();
                let initialize = value
                    .get("initialize")?
                    .as_object()
                    .map(|_| value["initialize"].clone())?;
                let tools = value.get("tools")?.as_array()?.clone();
                if !tools.iter().all(valid_tool) {
                    return None;
                }
                Some(Entry {
                    client,
                    initialize,
                    tools,
                    prompts: value.get("prompts").cloned(),
                })
            });
        Self {
            file,
            version: config.version.clone(),
            entry: Mutex::new(entry),
        }
    }

    fn get(&self) -> Option<Entry> {
        self.entry.lock().unwrap().clone()
    }

    async fn write(self: &Arc<Self>, entry: Entry) {
        let cache = self.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Some(file) = &cache.file else { return; };
            let mut current = cache.entry.lock().unwrap();
            let mut value = json!({"version": cache.version, "client": entry.client, "initialize": entry.initialize, "tools": entry.tools});
            if let Some(prompts) = &entry.prompts { value["prompts"] = prompts.clone(); }
            let bytes = value.to_string();
            let result = crate::disk::saves::write_kept(file, bytes.as_bytes(), Some(0o600), 0o700);
            if result.is_ok() || result.as_ref().is_err_and(crate::disk::saves::disk_full) {
                *current = Some(entry);
            }
        }).await;
    }

    async fn forget(self: &Arc<Self>) {
        let cache = self.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let mut current = cache.entry.lock().unwrap();
            *current = None;
            if let Some(file) = &cache.file {
                let _ = crate::disk::saves::remove_kept(file);
            }
        })
        .await;
    }
}

#[derive(Clone)]
struct Failure {
    code: i64,
    message: String,
    data: Option<Value>,
}
impl Failure {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    fn response(&self, id: Value) -> Value {
        let mut error = json!({"code": self.code, "message": self.message});
        if let Some(data) = &self.data {
            error["data"] = data.clone();
        }
        json!({"jsonrpc":"2.0", "id": id, "error": error})
    }
}
type RpcResult = Result<Value, Failure>;

struct Request {
    cancelled: bool,
    child_id: Option<String>,
}
struct State {
    cache: Option<Entry>,
    init: Value,
    initialize: Option<Value>,
    tools: Option<Vec<Value>>,
    catalog_generation: u64,
    loaded_generation: u64,
    prompts: Option<Value>,
    ready: bool,
    initialized: Option<Value>,
    early: Vec<Value>,
    writer: Option<mpsc::UnboundedSender<Value>>,
    pending: HashMap<String, oneshot::Sender<RpcResult>>,
    requests: HashMap<String, Request>,
    server_requests: HashMap<String, Value>,
}

struct Inner {
    config: ReaConfig,
    cwd: Option<String>,
    cache: Arc<Cache>,
    state: Mutex<State>,
    lifecycle: Mutex<()>,
    active: AtomicUsize,
    activity_changed: Notify,
    remember_generation: AtomicU64,
    requests_changed: Notify,
    sequence: AtomicU64,
    started: OnceCell<Result<(), Failure>>,
    catalog_lock: AsyncMutex<()>,
    refreshed: AtomicBool,
    running: AtomicBool,
    shutdown: watch::Sender<bool>,
    done: watch::Sender<bool>,
    events: mpsc::UnboundedSender<Value>,
    closed: mpsc::UnboundedSender<()>,
    closing: AtomicBool,
}

struct Work(Arc<Inner>);
impl Drop for Work {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
        self.0.activity_changed.notify_waiters();
    }
}

pub struct Rea {
    inner: Arc<Inner>,
}

impl Rea {
    pub fn new(
        mut config: ReaConfig,
        cwd: Option<String>,
        cache: Arc<Cache>,
        events: mpsc::UnboundedSender<Value>,
        closed: mpsc::UnboundedSender<()>,
    ) -> Arc<Self> {
        super::policy::sanitize_environment(&mut config.env);
        let entry = cache.get();
        let (shutdown, _) = watch::channel(false);
        let (done, _) = watch::channel(false);
        Arc::new(Self {
            inner: Arc::new(Inner {
                config,
                cwd,
                cache,
                sequence: AtomicU64::new(0),
                started: OnceCell::new(),
                catalog_lock: AsyncMutex::new(()),
                lifecycle: Mutex::new(()),
                requests_changed: Notify::new(),
                active: AtomicUsize::new(0),
                activity_changed: Notify::new(),
                remember_generation: AtomicU64::new(0),
                running: AtomicBool::new(false),
                refreshed: AtomicBool::new(false),
                shutdown,
                done,
                events,
                closed,
                closing: AtomicBool::new(false),
                state: Mutex::new(State {
                    tools: entry.as_ref().map(|e| e.tools.clone()),
                    prompts: entry.as_ref().and_then(|e| e.prompts.clone()),
                    cache: entry,
                    init: Value::Null,
                    initialize: None,
                    ready: false,
                    initialized: None,
                    early: Vec::new(),
                    writer: None,
                    pending: HashMap::new(),
                    requests: HashMap::new(),
                    server_requests: HashMap::new(),
                    catalog_generation: 0,
                    loaded_generation: 0,
                }),
            }),
        })
    }

    pub fn receive(&self, message: Value) -> Option<oneshot::Receiver<Value>> {
        let id = message.as_object().and_then(|v| v.get("id")).cloned();
        let method = message.get("method").and_then(Value::as_str);
        if method.is_none() {
            let _guard = self.inner.lifecycle.lock().unwrap();
            if self.inner.closing.load(Ordering::Acquire) {
                return None;
            }
            if let Some(id) = id {
                let mut state = self.inner.state.lock().unwrap();
                if let Some(original) = state.server_requests.remove(&key(&id)) {
                    let mut answer = message;
                    answer["id"] = original;
                    send_child(&state, answer);
                }
            }
            return None;
        }
        if id.is_none() {
            let _guard = self.inner.lifecycle.lock().unwrap();
            if self.inner.closing.load(Ordering::Acquire) {
                return None;
            }
            self.inner.notification(message);
            return None;
        }
        let id = id.unwrap();
        let (tx, rx) = oneshot::channel();
        let Some(work) = self.inner.admit() else {
            let _ = tx.send(Failure::new(-32603, "REA child exited").response(id));
            return Some(rx);
        };
        let request_key = key(&id);
        self.inner.state.lock().unwrap().requests.insert(
            request_key.clone(),
            Request {
                cancelled: false,
                child_id: None,
            },
        );
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let _work = work;
            let result = inner.handle(&message, &request_key).await;
            let answer = match result {
                Ok(value) => json!({"jsonrpc":"2.0", "id":id, "result":value}),
                Err(error) => error.response(id),
            };
            let _ = tx.send(answer);
            inner.state.lock().unwrap().requests.remove(&request_key);
            inner.requests_changed.notify_one();
        });
        Some(rx)
    }

    pub fn running(&self) -> bool {
        self.inner.running.load(Ordering::Acquire)
    }

    pub async fn close(&self) {
        let running = {
            let _guard = self.inner.lifecycle.lock().unwrap();
            self.inner.closing.store(true, Ordering::Release);
            self.inner.shutdown.send_replace(true);
            self.running()
        };
        if running {
            let mut done = self.inner.done.subscribe();
            while !*done.borrow_and_update() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        }
        loop {
            let notified = self.inner.activity_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.active.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
    }
}
impl Drop for Rea {
    fn drop(&mut self) {
        let _guard = self.inner.lifecycle.lock().unwrap();
        self.inner.closing.store(true, Ordering::Release);
        self.inner.shutdown.send_replace(true);
    }
}

fn key(id: &Value) -> String {
    id.to_string()
}
fn valid_tool(tool: &Value) -> bool {
    tool.get("name").and_then(Value::as_str).is_some()
        && tool.get("inputSchema").is_some_and(Value::is_object)
}
fn send_child(state: &State, value: Value) {
    if let Some(writer) = &state.writer {
        let _ = writer.send(value);
    }
}

impl Inner {
    fn admit(self: &Arc<Self>) -> Option<Work> {
        let _guard = self.lifecycle.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return None;
        }
        self.active.fetch_add(1, Ordering::AcqRel);
        Some(Work(self.clone()))
    }

    fn finish_after_replies(self: &Arc<Self>) {
        let inner = self.clone();
        tokio::spawn(async move {
            loop {
                let notified = inner.requests_changed.notified();
                if inner.state.lock().unwrap().requests.is_empty() {
                    break;
                }
                notified.await;
            }
            if !inner.closing.load(Ordering::Acquire) {
                let _ = inner.closed.send(());
            }
        });
    }

    fn notification(&self, message: Value) {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let mut state = self.state.lock().unwrap();
        if method == "notifications/cancelled" {
            if let Some(id) = message.pointer("/params/requestId") {
                let child_id = state.requests.get_mut(&key(id)).and_then(|request| {
                    request.cancelled = true;
                    request.child_id.clone()
                });
                if let Some(child_id) = child_id {
                    let mut forwarded = message;
                    forwarded["params"]["requestId"] = Value::String(child_id);
                    send_child(&state, forwarded);
                }
            }
        } else if state.ready {
            send_child(&state, message);
        } else if method == "notifications/initialized" {
            state.initialized = Some(message);
        } else {
            state.early.push(message);
        }
    }

    fn start(self: &Arc<Self>) -> Pin<Box<dyn Future<Output = Result<(), Failure>> + Send + '_>> {
        Box::pin(async move {
            self.started
                .get_or_init(|| async {
                    if let Err(error) = self.spawn() {
                        if !self.closing.load(Ordering::Acquire) {
                            self.cache.forget().await;
                            self.finish_after_replies();
                        }
                        self.done.send_replace(true);
                        return Err(error);
                    }
                    let init = self.state.lock().unwrap().init.clone();
                    match self.request("initialize", Some(init), None).await {
                        Ok(result) => {
                            let mut state = self.state.lock().unwrap();
                            state.initialize = Some(result);
                            if let Some(notice) = state.initialized.take() {
                                send_child(&state, notice);
                            }
                            for notice in std::mem::take(&mut state.early) {
                                send_child(&state, notice);
                            }
                            state.ready = true;
                            Ok(())
                        }
                        Err(error) => {
                            self.cache.forget().await;
                            self.shutdown.send_replace(true);
                            Err(error)
                        }
                    }
                })
                .await
                .clone()
        })
    }

    fn spawn(self: &Arc<Self>) -> Result<(), Failure> {
        let _guard = self.lifecycle.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return Err(Failure::new(-32603, "REA child exited"));
        }
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("nice");
            command.args(["-n", "10", &self.config.command]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt as _;
            let mut command = if self.config.command.to_ascii_lowercase().ends_with(".cmd") {
                let mut shell =
                    Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned()));
                let mut line = self.config.command.clone();
                for arg in &self.config.args {
                    line.push(' ');
                    line.push_str(arg);
                }
                shell.as_std_mut().raw_arg(format!("/d /s /c \"{line}\""));
                shell
            } else {
                let mut cmd = Command::new(&self.config.command);
                cmd.args(&self.config.args);
                cmd
            };
            command.creation_flags(0x0800_0000 | 0x0000_4000 | 0x0000_0004);
            command
        };
        #[cfg(unix)]
        command.args(&self.config.args);
        command
            .env_clear()
            .envs(&self.config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        #[cfg(unix)]
        crate::sys::new_session(command.as_std_mut());
        let mut child = command
            .spawn()
            .map_err(|error| Failure::new(-32603, format!("Cannot start REA: {error}")))?;
        let pid = child.id();
        #[cfg(windows)]
        let tree = {
            let held = child
                .raw_handle()
                .ok_or_else(|| std::io::Error::other("REA process handle unavailable"))
                .and_then(crate::sys::ProcessTree::of)
                .and_then(|tree| {
                    crate::sys::resume_process(
                        pid.ok_or_else(|| std::io::Error::other("REA pid unavailable"))?,
                    )?;
                    Ok(tree)
                });
            match held {
                Ok(tree) => tree,
                Err(error) => {
                    let _ = child.start_kill();
                    self.active.fetch_add(1, Ordering::AcqRel);
                    let work = Work(self.clone());
                    tokio::spawn(async move {
                        let _work = work;
                        let _ = child.wait().await;
                    });
                    return Err(Failure::new(
                        -32603,
                        format!("Cannot hold REA process tree: {error}"),
                    ));
                }
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Failure::new(-32603, "REA stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Failure::new(-32603, "REA stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Failure::new(-32603, "REA stderr unavailable"))?;
        let (writer, mut messages) = mpsc::unbounded_channel::<Value>();
        self.state.lock().unwrap().writer = Some(writer);
        self.running.store(true, Ordering::Release);
        let inner = self.clone();
        let writer_inner = self.clone();
        let writer_task = tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(message) = messages.recv().await {
                let mut line = message.to_string();
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    writer_inner.shutdown.send_replace(true);
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        });
        let reader = self.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<Value>(&line) {
                    Ok(message)
                        if message.is_object() && message.get("jsonrpc") == Some(&json!("2.0")) =>
                    {
                        reader.from_child(message)
                    }
                    _ => {
                        reader.shutdown.send_replace(true);
                        break;
                    }
                }
            }
        });
        let stderr_task = tokio::spawn(async move {
            let _ = tokio::io::copy(&mut BufReader::new(stderr), &mut tokio::io::sink()).await;
        });
        let mut shutdown = self.shutdown.subscribe();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {},
                _ = async { while !*shutdown.borrow_and_update() { if shutdown.changed().await.is_err() { break; } } } => {
                    #[cfg(windows)]
                    tree.end();
                    inner.state.lock().unwrap().writer = None;
                    #[cfg(unix)]
                    if let Some(pid) = pid { crate::sys::signal_group(pid, false); }
                    if tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await.is_err() {
                        #[cfg(unix)]
                        if let Some(pid) = pid { crate::sys::signal_group(pid, true); }
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                }
            }
            inner.state.lock().unwrap().writer = None;
            #[cfg(unix)]
            if let Some(pid) = pid {
                crate::sys::signal_group(pid, true);
            }
            #[cfg(windows)]
            tree.end();
            #[cfg(windows)]
            while tree.alive() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let _ = stdout_task.await;
            let _ = writer_task.await;
            let _ = stderr_task.await;
            inner.running.store(false, Ordering::Release);
            let pending = {
                let mut state = inner.state.lock().unwrap();
                state.writer = None;
                std::mem::take(&mut state.pending)
            };
            for (_, waiter) in pending {
                let _ = waiter.send(Err(Failure::new(-32603, "REA child exited")));
            }
            inner.done.send_replace(true);
            inner.finish_after_replies();
        });
        Ok(())
    }

    fn from_child(self: &Arc<Self>, mut message: Value) {
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            if method == "notifications/tools/list_changed" && message.get("id").is_none() {
                self.state.lock().unwrap().catalog_generation += 1;
                let Some(work) = self.admit() else {
                    return;
                };
                let inner = self.clone();
                tokio::spawn(async move {
                    let _work = work;
                    if inner.load_catalog(true).await.is_ok() {
                        let _ = inner.events.send(message);
                    } else {
                        inner.shutdown.send_replace(true);
                    }
                });
            } else if let Some(id) = message.get("id").cloned() {
                let relay = format!(
                    "rea-server:{}",
                    self.sequence.fetch_add(1, Ordering::Relaxed)
                );
                self.state
                    .lock()
                    .unwrap()
                    .server_requests
                    .insert(key(&json!(relay)), id);
                message["id"] = json!(relay);
                let _ = self.events.send(message);
            } else {
                let _ = self.events.send(message);
            }
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return;
        };
        if let Some(waiter) = self.state.lock().unwrap().pending.remove(id) {
            let result = if let Some(error) = message.get("error").and_then(Value::as_object) {
                Err(Failure {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("REA error")
                        .to_owned(),
                    data: error.get("data").cloned(),
                })
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = waiter.send(result);
        }
    }

    async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        client: Option<&str>,
    ) -> RpcResult {
        let id = format!("relay:{}", self.sequence.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if let Some(client) = client {
                if let Some(request) = state.requests.get_mut(client) {
                    if request.cancelled {
                        return Err(Failure::new(-32800, "Request cancelled"));
                    }
                    request.child_id = Some(id.clone());
                }
            }
            if state.writer.is_none() {
                return Err(Failure::new(-32603, "REA child exited"));
            }
            state.pending.insert(id.clone(), tx);
            let mut message = json!({"jsonrpc":"2.0", "id":id, "method":method});
            if let Some(params) = params {
                message["params"] = params;
            }
            send_child(&state, message);
        }
        rx.await
            .unwrap_or_else(|_| Err(Failure::new(-32603, "REA child exited")))
    }

    async fn load_catalog(self: &Arc<Self>, refresh: bool) -> Result<Vec<Value>, Failure> {
        let _guard = self.catalog_lock.lock().await;
        let generation = {
            let state = self.state.lock().unwrap();
            if !refresh && state.catalog_generation == state.loaded_generation {
                if let Some(tools) = &state.tools {
                    return Ok(tools.clone());
                }
            }
            state.catalog_generation
        };
        self.start().await?;
        let mut tools: Vec<Value> = Vec::new();
        let mut cursor = None;
        loop {
            let page = self
                .request(
                    "tools/list",
                    Some(
                        cursor
                            .take()
                            .map_or_else(|| json!({}), |cursor| json!({"cursor":cursor})),
                    ),
                    None,
                )
                .await?;
            let page_tools = page
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| Failure::new(-32603, "REA returned an invalid tool catalog"))?;
            if !page_tools.iter().all(valid_tool) {
                return Err(Failure::new(-32603, "REA returned an invalid tool catalog"));
            }
            for tool in page_tools {
                if let Some(existing) = tools.iter_mut().find(|item| item["name"] == tool["name"]) {
                    *existing = tool.clone();
                } else {
                    tools.push(tool.clone());
                }
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        let (initialize, init, old_prompts) = {
            let mut state = self.state.lock().unwrap();
            state.tools = Some(tools.clone());
            state.loaded_generation = generation;
            (
                state.initialize.clone(),
                state.init.clone(),
                state.prompts.clone(),
            )
        };
        if self.cache.file.is_some() {
            if let (Some(initialize), Some(work)) = (initialize, self.admit()) {
                let inner = self.clone();
                let tools = tools.clone();
                let revision = self.remember_generation.fetch_add(1, Ordering::AcqRel) + 1;
                tokio::spawn(async move {
                    let _work = work;
                    let prompts = if initialize
                        .pointer("/capabilities/prompts")
                        .is_some_and(|v| !v.is_null() && v != &json!(false))
                    {
                        match inner.request("prompts/list", Some(json!({})), None).await {
                            Ok(prompts) => Some(prompts),
                            Err(_) => return,
                        }
                    } else {
                        old_prompts.clone()
                    };
                    if inner.remember_generation.load(Ordering::Acquire) != revision {
                        return;
                    }
                    if old_prompts.is_some() && old_prompts != prompts {
                        let _ = inner.events.send(
                            json!({"jsonrpc":"2.0","method":"notifications/prompts/list_changed"}),
                        );
                    }
                    inner.state.lock().unwrap().prompts = prompts.clone();
                    inner
                        .cache
                        .write(Entry {
                            client: init.to_string(),
                            initialize,
                            tools,
                            prompts,
                        })
                        .await;
                });
            }
        }
        Ok(tools)
    }

    async fn handle(self: &Arc<Self>, message: &Value, client: &str) -> RpcResult {
        if message.get("jsonrpc") != Some(&json!("2.0"))
            || !matches!(
                message.get("id"),
                Some(Value::Null | Value::String(_) | Value::Number(_))
            )
        {
            return Err(Failure::new(-32600, "Invalid JSON-RPC request"));
        }
        let method = message["method"].as_str().unwrap_or("");
        let params = message.get("params").cloned();
        if method == "initialize" {
            let init = params.unwrap_or(Value::Null);
            let cached = {
                let mut state = self.state.lock().unwrap();
                state.init = init.clone();
                let cached = state
                    .cache
                    .clone()
                    .filter(|entry| entry.client == init.to_string());
                if cached.is_none() {
                    state.cache = None;
                    state.tools = None;
                    state.prompts = None;
                }
                cached
            };
            let mut result = if let Some(entry) = cached {
                entry.initialize
            } else {
                self.start().await?;
                self.state
                    .lock()
                    .unwrap()
                    .initialize
                    .clone()
                    .unwrap_or(Value::Null)
            };
            if let Some(object) = result.as_object_mut() {
                let caps = object.entry("capabilities").or_insert_with(|| json!({}));
                if !caps.is_object() {
                    *caps = json!({});
                }
                caps["tools"] = json!({"listChanged":true});
            }
            return Ok(result);
        }
        if method == "ping" && !self.running.load(Ordering::Acquire) {
            return Ok(json!({}));
        }
        if method == "prompts/list"
            && !self.running.load(Ordering::Acquire)
            && params
                .as_ref()
                .is_none_or(|p| p.is_object() && p.get("cursor").is_none())
        {
            if let Some(prompts) = &self.state.lock().unwrap().prompts {
                return Ok(prompts.clone());
            }
        }
        if method == "tools/list" {
            if params
                .as_ref()
                .is_some_and(|p| !p.is_object() || p.get("cursor").is_some())
            {
                return Err(Failure::new(-32602, "The relay tool list is not paginated"));
            }
            let all = self.load_catalog(false).await?;
            let mut tools: Vec<Value> = all
                .into_iter()
                .filter(|tool| {
                    self.config
                        .curated_tools
                        .iter()
                        .any(|name| tool["name"] == *name)
                })
                .collect();
            tools.extend(meta_tools());
            return Ok(json!({"tools":tools}));
        }
        if method == "tools/call" {
            let params = params
                .filter(Value::is_object)
                .ok_or_else(|| Failure::new(-32602, "Expected tool name and object arguments"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| Failure::new(-32602, "Expected tool name and object arguments"))?;
            let input = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let input = input
                .as_object()
                .ok_or_else(|| Failure::new(-32602, "Expected tool name and object arguments"))?;
            let all = self.load_catalog(false).await?;
            if name == "rea_catalog" {
                if input
                    .iter()
                    .any(|(k, v)| (k != "query" && k != "name") || !v.is_string())
                {
                    return Err(Failure::new(
                        -32602,
                        "Expected optional query and name strings",
                    ));
                }
                let requested = input.get("name").and_then(Value::as_str);
                if let Some(name) = requested {
                    if !all.iter().any(|tool| tool["name"] == name) {
                        return Err(Failure::new(-32602, format!("Unknown REA tool: {name}")));
                    }
                }
                let query = input
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase();
                let matches: Vec<Value> = all.into_iter().filter(|tool| {
                    let tool_name = tool["name"].as_str().unwrap_or("");
                    let desc = tool.get("description").and_then(Value::as_str).unwrap_or("");
                    requested.is_none_or(|name| name.is_empty() || name == tool_name) && query.split_whitespace().all(|word| format!("{tool_name} {desc}").to_lowercase().contains(word))
                }).map(|tool| if requested.is_some_and(|name| !name.is_empty()) { tool } else { json!({"name":tool["name"], "description":tool.get("description").and_then(Value::as_str).unwrap_or("").lines().next().unwrap_or("")}) }).collect();
                return Ok(
                    json!({"content":[{"type":"text","text":json!({"tools":matches}).to_string()}]}),
                );
            }
            let forwarded = if name == "rea_call" {
                if input.keys().any(|key| key != "name" && key != "arguments")
                    || !input.get("arguments").is_some_and(Value::is_object)
                    || !input.get("name").is_some_and(Value::is_string)
                {
                    return Err(Failure::new(
                        -32602,
                        "Expected REA name and object arguments",
                    ));
                }
                let target = input["name"].as_str().unwrap_or("");
                if !all.iter().any(|tool| tool["name"] == target) {
                    return Err(Failure::new(-32602, format!("Unknown REA tool: {target}")));
                }
                let mut forwarded = params.clone();
                forwarded["name"] = json!(target);
                forwarded["arguments"] = input["arguments"].clone();
                forwarded
            } else {
                if !self.config.curated_tools.iter().any(|item| item == name)
                    || !all.iter().any(|tool| tool["name"] == name)
                {
                    return Err(Failure::new(
                        -32602,
                        format!("Tool is not exposed: {name}; use rea_call"),
                    ));
                }
                params
            };
            self.start().await?;
            self.refresh_background();
            return self
                .request("tools/call", Some(forwarded), Some(client))
                .await;
        }
        self.start().await?;
        self.refresh_background();
        self.request(method, params, Some(client)).await
    }

    fn refresh_background(self: &Arc<Self>) {
        if self.state.lock().unwrap().cache.is_none() || self.refreshed.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let Some(work) = self.admit() else {
            return;
        };
        let inner = self.clone();
        tokio::spawn(async move {
            let _work = work;
            let before = inner.state.lock().unwrap().tools.clone();
            match inner.load_catalog(true).await {
                Ok(after) => {
                    if before.as_ref() != Some(&after) {
                        let _ = inner.events.send(
                            json!({"jsonrpc":"2.0", "method":"notifications/tools/list_changed"}),
                        );
                    }
                }
                Err(_) => {
                    inner.shutdown.send_replace(true);
                }
            }
        });
    }
}

fn meta_tools() -> Vec<Value> {
    vec![
        json!({"name":"rea_catalog", "description":"Search the full REA tool catalog by keyword or target. Request a named tool's input schema before using rea_call.", "inputSchema":{"type":"object", "properties":{"query":{"type":"string","description":"Keywords or target, e.g. JavaScript, Android, native, process."},"name":{"type":"string","description":"Exact tool name whose input schema should be returned."}},"additionalProperties":false}}),
        json!({"name":"rea_call", "description":"Invoke any REA tool by its exact catalog name with its original arguments. Discover its input schema with rea_catalog first.", "inputSchema":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object","additionalProperties":true}},"required":["name","arguments"],"additionalProperties":false}}),
    ]
}

#[cfg(test)]
#[path = "rea_tests.rs"]
mod tests;
