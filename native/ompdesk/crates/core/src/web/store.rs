//! The paired devices, the blocks and the serve secret as files (was `src/main/web/devices-store.ts`,
//! `blocks-store.ts`, `serve-secret.ts`): `<userData>/web-devices.json`, `web-blocked.json` and
//! `web-serve-secret.json`, each 0600, replaced atomically, in the format the TypeScript wrote.
//!
//! One `Stores` per `userData` and core process (`FileDevices::open`, `FileBlocks::open`): the edge's `Devices` and
//! `Blocks` and main's requests change the very same objects. A change is applied under the store's lock, its new
//! content handed to an ordered writer thread (`Writer`: the newest content in a queue, one atomic replace at a
//! time, so a rename Windows holds back never holds a request or the read loop) and the whole list sent to main as
//! an event, all in that one step, so the file, the events and the answers keep the order of the changes.
//!
//! Main keeps a copy it reads synchronously (`web-stores-client.ts`) and changes with ordered pushes
//! (`web.devices.revoke`, `rename`, `setGrants`, `setUiPrefs`, `setPush`, `forgetPush`, `dropAllPush`, `update`,
//! `web.blocks.add`, `remove`). Each carries `seq`, main's number for it; every push is answered by an event with
//! `ack`, the highest `seq` applied, so main ignores a snapshot that does not hold its own latest change yet.
//! The events, all with `userData`:
//!
//! - `web.devices.changed` `{devices: [record], version, ack, notify}`: the whole list after a change. `version`
//!   counts the store's changes (a snapshot older than one seen is dropped); `notify` is true for a change the
//!   TypeScript announced through `onChanged` that main did not make itself (a device paired, or expired).
//! - `web.devices.revoked` `{deviceId}`: a device was removed (revoked, or expired by the edge); sent before the
//!   `changed` that carries the list without it.
//! - `web.blocks.changed` `{blocks: [entry], version, ack}`.
//!
//! Requests: `web.devices.open` `{userData}` → `{devices: {list, version, ack}, blocks: {list, version, ack}}`
//! (the snapshot a client starts from, and where it sends its events from); `web.devices.flush` `{userData}`
//! answers once every earlier write is on disk; `web.secret` `{userData}` → `{secret}`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, mpsc};
use std::thread::JoinHandle;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};
use tokio::sync::watch;

use super::auth::base64url;
use super::devices::{
    AuthResult, BlockBook, BlockScope, Blocks, Book, Device, Devices, Effect, NewDevice, Patch,
    PushSettings, Verdict,
};
use crate::disk::saves::write_kept;
use crate::disk::tree::write_atomic_if;
use crate::server::{Call, Events, Fault, PushCall, Registry, Reply};

const DEVICES_FILE: &str = "web-devices.json";
const BLOCKS_FILE: &str = "web-blocked.json";
const SECRET_FILE: &str = "web-serve-secret.json";
const FILE_MODE: u32 = 0o600;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `JSON.stringify(value, null, "\t") + "\n"`, which `writeSecureJson` wrote.
fn document_text(document: &Value) -> String {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    // A `Value` holds only what JSON can spell, and a `Vec` takes every write.
    let _ = document.serialize(&mut serializer);
    out.push(b'\n');
    String::from_utf8(out).unwrap_or_default()
}

/// A file's JSON, or `null` when it is missing or not JSON (`readJson`).
fn read_document(file: &Path) -> Value {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok())
        .unwrap_or(Value::Null)
}

/// Where the events go: the output the core serves main on, and the spelling of `userData` main uses for it.
#[derive(Default)]
struct Hub {
    sink: Mutex<Option<(String, Events)>>,
}

impl Hub {
    fn attach(&self, user_data: &str, events: &Events) {
        *locked(&self.sink) = Some((user_data.to_owned(), events.clone()));
    }

    /// Sends `data` with `userData` added; nothing while main has not opened these stores.
    fn tell(&self, event: &str, mut data: Value) {
        if let Some((user_data, events)) = &*locked(&self.sink) {
            if let Some(object) = data.as_object_mut() {
                object.insert("userData".into(), user_data.clone().into());
            }
            events.send(event, &data);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Done {
    /// The highest content number on disk (or given up on).
    upto: u64,
    /// Why the last attempt failed, until one succeeds.
    failed: Option<String>,
}

/// The ordered writer of one file. Only the newest content queued is written; a number says how far it has got.
struct Writer {
    queue: Mutex<Option<mpsc::Sender<(u64, String)>>>,
    submitted: AtomicU64,
    done: Arc<watch::Sender<Done>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Writer {
    fn new(file: PathBuf, what: &'static str) -> Writer {
        let (queue, texts) = mpsc::channel::<(u64, String)>();
        let done = Arc::new(
            watch::channel(Done {
                upto: 0,
                failed: None,
            })
            .0,
        );
        let thread = std::thread::spawn({
            let done = Arc::clone(&done);
            move || {
                while let Ok((mut number, mut text)) = texts.recv() {
                    while let Ok((newer, newest)) = texts.try_recv() {
                        (number, text) = (newer, newest);
                    }
                    let failed = write_kept(&file, text.as_bytes(), Some(FILE_MODE), 0o777)
                        .err()
                        .map(|fault| {
                            eprintln!("ompdesk-core: couldn't save the {what}: {}", fault.message);
                            fault.message
                        });
                    done.send_modify(|done| {
                        done.upto = number;
                        done.failed = failed;
                    });
                }
            }
        });
        Writer {
            queue: Mutex::new(Some(queue)),
            submitted: AtomicU64::new(0),
            done,
            thread: Mutex::new(Some(thread)),
        }
    }

    /// Queues `text` as the newest content; its number. Called under the store's lock, so numbers follow changes.
    fn submit(&self, text: String) -> u64 {
        let number = self.submitted.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(queue) = &*locked(&self.queue) {
            let _ = queue.send((number, text));
        }
        number
    }

    /// Resolves once content number `upto` (or a newer one) is on disk; fails when its write did.
    async fn flush(&self, upto: u64) -> Result<(), Fault> {
        let mut progress = self.done.subscribe();
        let failed = progress
            .wait_for(|done| done.upto >= upto)
            .await
            .map_err(|_| Fault::new("internal", "The writer of the web stores ended"))?
            .failed
            .clone();
        match failed {
            Some(message) => Err(Fault::new("save_failed", message)),
            None => Ok(()),
        }
    }
}

impl Drop for Writer {
    /// What is queued is written before the writer thread ends.
    fn drop(&mut self) {
        locked(&self.queue).take();
        if let Some(thread) = locked(&self.thread).take() {
            let _ = thread.join();
        }
    }
}

/// What a store counts: its changes (`version`), the highest push of main applied (`ack`), and the number of the
/// content last queued to its writer.
#[derive(Default)]
struct Lane {
    version: u64,
    ack: u64,
    saved: u64,
}

#[derive(Serialize)]
struct Snapshot {
    list: Vec<Value>,
    version: u64,
    ack: u64,
}

struct DevicesState {
    book: Book,
    lane: Lane,
}

/// The paired devices: the edge's `Devices`, and everything main changes.
pub struct FileDevices {
    hub: Arc<Hub>,
    state: Mutex<DevicesState>,
    writer: Writer,
}

impl FileDevices {
    /// The one list of this `userData` in this process.
    pub fn open(user_data: &Path) -> Arc<FileDevices> {
        Arc::clone(&stores(user_data).devices)
    }

    fn load(dir: &Path, hub: Arc<Hub>) -> FileDevices {
        let file = dir.join(DEVICES_FILE);
        FileDevices {
            hub,
            state: Mutex::new(DevicesState {
                book: Book::parse(&read_document(&file)),
                // One more than the empty count: a snapshot taken at open is newer than none.
                lane: Lane {
                    version: 1,
                    ..Lane::default()
                },
            }),
            writer: Writer::new(file, "paired web devices"),
        }
    }

    /// One change: `op` under the lock, then what it left to do (queue the file, tell main), in that order, so that
    /// every observer sees the changes in the order they were made. A push of main (`seq`) is always answered with
    /// the list, even when it changed nothing, because the answer carries the `ack` main waits for.
    pub fn apply<T>(&self, seq: Option<u64>, op: impl FnOnce(&mut Book) -> (T, Effect)) -> T {
        let mut state = locked(&self.state);
        let state = &mut *state;
        let (out, effect) = op(&mut state.book);
        if let Some(seq) = seq {
            state.lane.ack = state.lane.ack.max(seq);
        }
        if effect.saved {
            state.lane.saved = self.writer.submit(document_text(&state.book.document()));
        }
        if effect.saved || seq.is_some() {
            state.lane.version += 1;
            if let Some(device_id) = &effect.revoked {
                self.hub
                    .tell("web.devices.revoked", json!({ "deviceId": device_id }));
            }
            self.hub.tell(
                "web.devices.changed",
                json!({
                    "devices": state.book.records(),
                    "version": state.lane.version,
                    "ack": state.lane.ack,
                    "notify": effect.announce && seq.is_none(),
                }),
            );
        }
        out
    }

    fn snapshot(&self) -> Snapshot {
        let state = locked(&self.state);
        Snapshot {
            list: state.book.records(),
            version: state.lane.version,
            ack: state.lane.ack,
        }
    }

    /// Resolves once every change made before this call is on disk.
    pub async fn flush(&self) -> Result<(), Fault> {
        let upto = locked(&self.state).lane.saved;
        self.writer.flush(upto).await
    }

    pub fn get(&self, device_id: &str) -> Option<Device> {
        locked(&self.state).book.get(device_id).cloned()
    }

    pub fn list(&self) -> Vec<Device> {
        locked(&self.state).book.devices().to_vec()
    }
}

impl Devices for FileDevices {
    fn authenticate(&self, cookie: &str, now: i64) -> AuthResult {
        self.apply(None, |book| book.authenticate(cookie, now))
    }

    fn create(&self, device: NewDevice, now: i64) -> (Device, String) {
        self.apply(None, |book| book.create(device, now))
    }

    fn create_checked(
        &self,
        device: NewDevice,
        now: i64,
        blocks: &dyn Blocks,
    ) -> Option<(Device, String)> {
        self.apply(None, |book| {
            if blocks
                .check(device.node_id.as_deref(), device.tailscale_login.as_deref())
                .is_some()
            {
                (None, Effect::default())
            } else {
                let (created, effect) = book.create(device, now);
                (Some(created), effect)
            }
        })
    }

    fn set_push(&self, device_id: &str, push: PushSettings) -> bool {
        self.apply(None, |book| book.set_push(device_id, push))
    }
}

struct BlocksState {
    book: BlockBook,
    lane: Lane,
}

/// The blocks: the edge's `Blocks`, and what main adds and lifts.
pub struct FileBlocks {
    hub: Arc<Hub>,
    state: Mutex<BlocksState>,
    writer: Writer,
}

impl FileBlocks {
    pub fn open(user_data: &Path) -> Arc<FileBlocks> {
        Arc::clone(&stores(user_data).blocks)
    }

    fn load(dir: &Path, hub: Arc<Hub>) -> FileBlocks {
        let file = dir.join(BLOCKS_FILE);
        FileBlocks {
            hub,
            state: Mutex::new(BlocksState {
                book: BlockBook::parse(&read_document(&file)),
                lane: Lane {
                    version: 1,
                    ..Lane::default()
                },
            }),
            writer: Writer::new(file, "blocked web devices"),
        }
    }

    /// A push of main: `op`, then the file and the list, as `FileDevices::apply`.
    pub fn apply<T>(&self, seq: u64, op: impl FnOnce(&mut BlockBook) -> (T, bool)) -> T {
        let mut state = locked(&self.state);
        let state = &mut *state;
        let (out, changed) = op(&mut state.book);
        state.lane.ack = state.lane.ack.max(seq);
        if changed {
            state.lane.saved = self.writer.submit(document_text(&state.book.document()));
        }
        state.lane.version += 1;
        self.hub.tell(
            "web.blocks.changed",
            json!({
                "blocks": state.book.records(),
                "version": state.lane.version,
                "ack": state.lane.ack,
            }),
        );
        out
    }

    fn snapshot(&self) -> Snapshot {
        let state = locked(&self.state);
        Snapshot {
            list: state.book.records(),
            version: state.lane.version,
            ack: state.lane.ack,
        }
    }

    pub fn list(&self) -> Vec<Value> {
        locked(&self.state).book.records()
    }

    pub async fn flush(&self) -> Result<(), Fault> {
        let upto = locked(&self.state).lane.saved;
        self.writer.flush(upto).await
    }
}

impl Blocks for FileBlocks {
    fn active(&self) -> bool {
        locked(&self.state).book.active()
    }

    fn check(&self, node_id: Option<&str>, login: Option<&str>) -> Option<Verdict> {
        locked(&self.state).book.check(node_id, login)
    }
}

/// Both stores of one `userData`, and the events' way to main.
pub struct Stores {
    pub devices: Arc<FileDevices>,
    pub blocks: Arc<FileBlocks>,
    hub: Arc<Hub>,
}

impl Stores {
    pub fn attach_events(&self, user_data: &str, events: &Events) {
        self.hub.attach(user_data, events);
    }

    /// Reads the two files. A missing or unreadable one is an empty list.
    fn load(dir: &Path) -> Stores {
        let hub = Arc::new(Hub::default());
        Stores {
            devices: Arc::new(FileDevices::load(dir, Arc::clone(&hub))),
            blocks: Arc::new(FileBlocks::load(dir, Arc::clone(&hub))),
            hub,
        }
    }
}

static STORES: LazyLock<Mutex<HashMap<PathBuf, Arc<Stores>>>> = LazyLock::new(Default::default);

/// The stores of `user_data`: the same ones for the same folder, for the life of the process. A second instance over
/// one file would write over the first's changes.
pub fn stores(user_data: &Path) -> Arc<Stores> {
    let key = std::path::absolute(user_data).unwrap_or_else(|_| user_data.to_path_buf());
    let mut all = locked(&STORES);
    Arc::clone(
        all.entry(key)
            .or_insert_with_key(|dir| Arc::new(Stores::load(dir))),
    )
}

/// Waits for every store's writes to reach the disk. `serve` calls it when its input ended: a push is applied the
/// moment it is read, but its write is another thread's, and the process ends right after.
pub async fn flush_all() {
    let all: Vec<Arc<Stores>> = locked(&STORES).values().cloned().collect();
    for stores in all {
        // A failed write was reported by its writer.
        let _ = stores.devices.flush().await;
        let _ = stores.blocks.flush().await;
    }
}

/// The per-install secret path of `tailscale serve`'s target: read from its file, or made (256 bits, base64url) and
/// saved on first use or when the file is unusable. A made secret is on disk before it is returned. One at a time,
/// so two first calls never make two secrets.
pub fn serve_secret(user_data: &Path) -> Result<String, Fault> {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _one = locked(&ONE_AT_A_TIME);
    let file = user_data.join(SECRET_FILE);
    let stored = read_document(&file);
    if stored.get("v").and_then(Value::as_f64) == Some(1.0)
        && let Some(secret) = stored.get("secret").and_then(Value::as_str)
        && secret.len() == 43
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Ok(secret.to_owned());
    }
    let mut bytes = [0u8; 32];
    crate::sys::random(&mut bytes).map_err(|error| {
        Fault::new(
            "internal",
            format!("the system's random generator failed: {error}"),
        )
    })?;
    let secret = base64url(&bytes);
    let mut document = Map::new();
    document.insert("v".into(), 1.into());
    document.insert("secret".into(), secret.clone().into());
    write_atomic_if(
        &file,
        document_text(&document.into()).as_bytes(),
        Some(FILE_MODE),
        0o777,
        &|| true,
    )?;
    Ok(secret)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Of {
    user_data: String,
}

/// A push of main: its `userData`, its number, and what the push itself says.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sent<P> {
    user_data: String,
    seq: u64,
    #[serde(flatten)]
    rest: P,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Id {
    device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rename {
    device_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grants {
    device_id: String,
    grants: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiPrefs {
    device_id: String,
    ui_prefs: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPush {
    device_id: String,
    push: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForgetPush {
    device_id: String,
    endpoint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Update {
    device_id: String,
    patch: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Block {
    scope: String,
    key: String,
    name: String,
    tailscale_login: Option<String>,
    /// Main's clock: the time the block was asked at.
    now: Number,
}

#[derive(Deserialize)]
struct Lift {
    id: String,
}

/// Reads a push and runs it on the stores of its `userData`. It runs on the read loop: the change is applied under
/// the lock and its write is queued, nothing waits for the disk.
fn pushed<P: DeserializeOwned>(call: &PushCall, method: &str, run: impl FnOnce(&Stores, u64, P)) {
    match serde_json::from_str::<Sent<P>>(call.params.get()) {
        Ok(sent) => {
            let stores = stores(Path::new(&sent.user_data));
            stores.hub.attach(&sent.user_data, &call.events);
            run(&stores, sent.seq, sent.rest);
        }
        Err(error) => eprintln!("ompdesk-core: skipped a malformed {method}: {error}"),
    }
}

async fn open(call: Call) -> Result<Reply, Fault> {
    let params: Of = call.params()?;
    let dir = PathBuf::from(&params.user_data);
    let stores = tokio::task::spawn_blocking(move || stores(&dir))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?;
    stores.hub.attach(&params.user_data, &call.events);
    Reply::json(&json!({
        "devices": stores.devices.snapshot(),
        "blocks": stores.blocks.snapshot(),
    }))
}

async fn flush(call: Call) -> Result<Reply, Fault> {
    let params: Of = call.params()?;
    let dir = PathBuf::from(params.user_data);
    let stores = tokio::task::spawn_blocking(move || stores(&dir))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?;
    stores.devices.flush().await?;
    stores.blocks.flush().await?;
    Reply::json(&json!({}))
}

async fn secret(call: Call) -> Result<Reply, Fault> {
    let params: Of = call.params()?;
    let secret = tokio::task::spawn_blocking(move || serve_secret(Path::new(&params.user_data)))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))??;
    Reply::json(&json!({ "secret": secret }))
}

pub fn register(registry: &mut Registry) {
    registry.add("web.devices.open", |call| Box::pin(open(call)));
    registry.add("web.devices.flush", |call| Box::pin(flush(call)));
    registry.add("web.secret", |call| Box::pin(secret(call)));
    registry.add_push("web.devices.revoke", |call| {
        pushed(&call, "web.devices.revoke", |s, seq, id: Id| {
            s.devices
                .apply(Some(seq), |book| book.revoke(&id.device_id));
        });
    });
    registry.add_push("web.devices.rename", |call| {
        pushed(&call, "web.devices.rename", |s, seq, rename: Rename| {
            s.devices.apply(Some(seq), |book| {
                book.rename(&rename.device_id, &rename.name)
            });
        });
    });
    registry.add_push("web.devices.setGrants", |call| {
        pushed(&call, "web.devices.setGrants", |s, seq, set: Grants| {
            s.devices.apply(Some(seq), |book| {
                book.set_grants(&set.device_id, &set.grants)
            });
        });
    });
    registry.add_push("web.devices.setUiPrefs", |call| {
        pushed(&call, "web.devices.setUiPrefs", |s, seq, set: UiPrefs| {
            s.devices.apply(Some(seq), |book| {
                book.set_ui_prefs(&set.device_id, set.ui_prefs)
            });
        });
    });
    registry.add_push("web.devices.setPush", |call| {
        pushed(&call, "web.devices.setPush", |s, seq, set: SetPush| {
            s.devices
                .apply(Some(seq), |book| match PushSettings::from_json(&set.push) {
                    Some(push) => book.set_push(&set.device_id, push),
                    None => {
                        eprintln!(
                            "ompdesk-core: skipped web.devices.setPush: push settings do not read"
                        );
                        (false, Effect::default())
                    }
                });
        });
    });
    registry.add_push("web.devices.forgetPush", |call| {
        pushed(
            &call,
            "web.devices.forgetPush",
            |s, seq, forget: ForgetPush| {
                s.devices.apply(Some(seq), |book| {
                    book.forget_push(&forget.device_id, &forget.endpoint)
                });
            },
        );
    });
    registry.add_push("web.devices.dropAllPush", |call| {
        pushed(
            &call,
            "web.devices.dropAllPush",
            |s, seq, _: Map<String, Value>| {
                s.devices.apply(Some(seq), |book| book.drop_all_push());
            },
        );
    });
    registry.add_push("web.devices.update", |call| {
        pushed(&call, "web.devices.update", |s, seq, update: Update| {
            s.devices
                .apply(Some(seq), |book| match Patch::from_json(&update.patch) {
                    Some(patch) => book.update(&update.device_id, patch),
                    None => {
                        eprintln!(
                            "ompdesk-core: skipped web.devices.update: limits or usage do not read"
                        );
                        (false, Effect::default())
                    }
                });
        });
    });
    registry.add_push("web.blocks.add", |call| {
        pushed(&call, "web.blocks.add", |s, seq, block: Block| {
            let scope = match block.scope.as_str() {
                "node" => BlockScope::Node,
                "login" => BlockScope::Login,
                other => {
                    eprintln!("ompdesk-core: skipped web.blocks.add: no scope {other:?}");
                    return;
                }
            };
            s.blocks.apply(seq, |book| {
                (
                    book.add(
                        scope,
                        &block.key,
                        &block.name,
                        block.tailscale_login,
                        block.now,
                    ),
                    true,
                )
            });
        });
    });
    registry.add_push("web.blocks.remove", |call| {
        pushed(&call, "web.blocks.remove", |s, seq, lift: Lift| {
            s.blocks.apply(seq, |book| {
                let removed = book.remove(&lift.id);
                (removed, removed)
            });
        });
    });
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
