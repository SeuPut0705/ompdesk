use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::agentctl::service::host::node_resolve;
use crate::server::{Fault, Scope};

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
    inflight: HashMap<String, usize>,
    stored: HashMap<String, usize>,
    lanes: HashMap<String, Weak<AsyncMutex<()>>>,
}

pub struct SessionAuthority {
    file: Option<PathBuf>,
    entries: Mutex<Entries>,
}

pub struct DeletionGuard {
    authority: Arc<SessionAuthority>,
    key: String,
    path: String,
    device: Option<String>,
}

struct StoredGuard {
    authority: Arc<SessionAuthority>,
    key: String,
}

struct ClaimState {
    permit: Mutex<Option<OwnedMutexGuard<()>>>,
    lane: Arc<AsyncMutex<()>>,
    guard: ClaimGuard,
}

enum ClaimGuard {
    Delete(DeletionGuard),
    Stored(StoredGuard),
}

pub struct DeletionClaim(Arc<ClaimState>);
pub struct StoredClaim(Arc<ClaimState>);
pub struct ReadyDeletionClaim(Arc<ClaimState>);
pub struct ReadyStoredClaim {
    _claim: Arc<ClaimState>,
}

#[derive(Debug)]
pub enum Persistence {
    MemoryOnly,
    Durable,
    Queued(Fault),
    Failed(Fault),
}

#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionRefusal {
    Deleted,
    Deleting,
    Mutating,
}

fn key(path: &Path, device: Option<&str>) -> String {
    let device = device.filter(|device| !device.is_empty()).unwrap_or("");
    let path = if device.is_empty() {
        PathBuf::from(node_resolve(&path.to_string_lossy()))
    } else {
        path.to_owned()
    };
    format!("{device}\0{}", path.to_string_lossy())
}

impl SessionAuthority {
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

    pub fn read(&self, path: &Path, device: Option<&str>) -> Option<Tombstone> {
        lock(&self.entries).by_key.get(&key(path, device)).cloned()
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

    pub fn in_progress(&self, path: &Path, device: Option<&str>) -> bool {
        lock(&self.entries)
            .inflight
            .contains_key(&key(path, device))
    }

    pub fn any_in_progress(&self) -> bool {
        !lock(&self.entries).inflight.is_empty()
    }

    /// The closure must only register a native holder synchronously. It must not call this authority.
    pub fn admit<T>(
        &self,
        path: &Path,
        device: Option<&str>,
        register: impl FnOnce() -> T,
    ) -> Result<T, AdmissionRefusal> {
        let entries = lock(&self.entries);
        let key = key(path, device);
        if entries.by_key.contains_key(&key) {
            return Err(AdmissionRefusal::Deleted);
        }
        if entries.inflight.contains_key(&key) {
            return Err(AdmissionRefusal::Deleting);
        }
        if entries.stored.contains_key(&key) {
            return Err(AdmissionRefusal::Mutating);
        }
        Ok(register())
    }

    pub fn begin_delete(self: &Arc<Self>, path: &Path, device: Option<&str>) -> DeletionGuard {
        let device = device.filter(|value| !value.is_empty()).map(str::to_owned);
        let path = if device.is_some() {
            path.to_string_lossy().into_owned()
        } else {
            node_resolve(&path.to_string_lossy())
        };
        let key = key(Path::new(&path), device.as_deref());
        *lock(&self.entries).inflight.entry(key.clone()).or_default() += 1;
        DeletionGuard {
            authority: Arc::clone(self),
            key,
            path,
            device,
        }
    }

    /// Reserve deletion before capture. Await `ready` before any capture or stored mutation.
    /// The retained claim must not contain a clone of `scope`.
    pub fn begin_delete_scoped(
        self: &Arc<Self>,
        path: &Path,
        device: Option<&str>,
        scope: &Scope,
    ) -> DeletionClaim {
        let guard = self.begin_delete(path, device);
        let lane = self.lane(&guard.key);
        let claim = Arc::new(ClaimState {
            permit: Mutex::new(None),
            lane,
            guard: ClaimGuard::Delete(guard),
        });
        scope.retain(Arc::clone(&claim));
        DeletionClaim(claim)
    }

    /// Reserve admission before capture/open. Await `ready` and check its result before touching storage.
    pub fn claim_stored(
        self: &Arc<Self>,
        path: &Path,
        device: Option<&str>,
        scope: &Scope,
    ) -> StoredClaim {
        let key = key(path, device);
        let lane = {
            let mut entries = lock(&self.entries);
            *entries.stored.entry(key.clone()).or_default() += 1;
            Self::lane_locked(&mut entries, &key)
        };
        let claim = Arc::new(ClaimState {
            permit: Mutex::new(None),
            lane,
            guard: ClaimGuard::Stored(StoredGuard {
                authority: Arc::clone(self),
                key,
            }),
        });
        scope.retain(Arc::clone(&claim));
        StoredClaim(claim)
    }

    fn lane(&self, key: &str) -> Arc<AsyncMutex<()>> {
        Self::lane_locked(&mut lock(&self.entries), key)
    }

    fn lane_locked(entries: &mut Entries, key: &str) -> Arc<AsyncMutex<()>> {
        if let Some(lane) = entries.lanes.get(key).and_then(Weak::upgrade) {
            return lane;
        }
        let lane = Arc::new(AsyncMutex::new(()));
        entries.lanes.insert(key.to_owned(), Arc::downgrade(&lane));
        lane
    }
}

impl DeletionClaim {
    pub async fn ready(self) -> ReadyDeletionClaim {
        let permit = Arc::clone(&self.0.lane).lock_owned().await;
        *lock(&self.0.permit) = Some(permit);
        ReadyDeletionClaim(self.0)
    }
}

impl ReadyDeletionClaim {
    pub fn commit(&self, at: f64) -> Persistence {
        match &self.0.guard {
            ClaimGuard::Delete(guard) => guard.commit(at),
            ClaimGuard::Stored(_) => unreachable!(),
        }
    }
}

impl StoredClaim {
    pub async fn ready(self) -> Result<ReadyStoredClaim, AdmissionRefusal> {
        let permit = Arc::clone(&self.0.lane).lock_owned().await;
        let ClaimGuard::Stored(guard) = &self.0.guard else {
            unreachable!();
        };
        if lock(&guard.authority.entries)
            .by_key
            .contains_key(&guard.key)
        {
            return Err(AdmissionRefusal::Deleted);
        }
        *lock(&self.0.permit) = Some(permit);
        Ok(ReadyStoredClaim { _claim: self.0 })
    }
}

impl ReadyStoredClaim {
    /// Registers this claim's temporary holder under the same authority lock.
    /// Other openers remain refused while the stored mutation owns the key.
    pub fn admit<T>(&self, register: impl FnOnce() -> T) -> Result<T, AdmissionRefusal> {
        let ClaimGuard::Stored(guard) = &self._claim.guard else {
            unreachable!();
        };
        let entries = lock(&guard.authority.entries);
        if entries.by_key.contains_key(&guard.key) {
            return Err(AdmissionRefusal::Deleted);
        }
        Ok(register())
    }
}

impl Drop for ClaimState {
    fn drop(&mut self) {
        drop(lock(&self.permit).take());
        let (authority, key) = match &self.guard {
            ClaimGuard::Delete(guard) => (&guard.authority, &guard.key),
            ClaimGuard::Stored(guard) => (&guard.authority, &guard.key),
        };
        let mut entries = lock(&authority.entries);
        if Arc::strong_count(&self.lane) == 1 {
            entries.lanes.remove(key);
        }
    }
}

impl Drop for StoredGuard {
    fn drop(&mut self) {
        let mut entries = lock(&self.authority.entries);
        if let Some(count) = entries.stored.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                entries.stored.remove(&self.key);
            }
        }
    }
}

impl DeletionGuard {
    pub fn commit(&self, at: f64) -> Persistence {
        let mut entries = lock(&self.authority.entries);
        if entries.by_key.remove(&self.key).is_some() {
            entries.order.retain(|key| key != &self.key);
        }
        entries.order.push_back(self.key.clone());
        entries.by_key.insert(
            self.key.clone(),
            Tombstone {
                path: self.path.clone(),
                device: self.device.clone(),
                at,
            },
        );
        while entries.order.len() > MAX_TOMBSTONES {
            if let Some(oldest) = entries.order.pop_front() {
                entries.by_key.remove(&oldest);
            }
        }
        let Some(file) = &self.authority.file else {
            return Persistence::MemoryOnly;
        };
        let ordered: Vec<_> = entries
            .order
            .iter()
            .filter_map(|key| entries.by_key.get(key))
            .collect();
        let bytes = match serde_json::to_vec(&ordered) {
            Ok(bytes) => bytes,
            Err(error) => return Persistence::Failed(Fault::new("json", error.to_string())),
        };
        match crate::disk::saves::write_kept(file, &bytes, Some(0o600), 0o700) {
            Ok(_) => Persistence::Durable,
            Err(error) if crate::disk::saves::disk_full(&error) => Persistence::Queued(error),
            Err(error) => Persistence::Failed(error),
        }
    }
}

impl Drop for DeletionGuard {
    fn drop(&mut self) {
        let mut entries = lock(&self.authority.entries);
        if let Some(count) = entries.inflight.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                entries.inflight.remove(&self.key);
            }
        }
    }
}

#[cfg(test)]
#[path = "session_authority_tests.rs"]
mod tests;
