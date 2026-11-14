//! The application-wide cache from git-fingerprints.ts. Git computes the fingerprint; the existing native
//! sessions source supplies OS events on macOS/Windows. Other platforms perform the original uncached read.

use serde_json::Value;

use crate::git::{read, run::Git};
use crate::run::Runner;
use crate::server::{Fault, Scope};

pub struct Service {
    runner: Option<Runner>,
    #[cfg(any(windows, target_os = "macos"))]
    cache: cached::Cache,
}

impl Service {
    pub fn new(runner: Option<Runner>) -> Self {
        Self {
            runner,
            #[cfg(any(windows, target_os = "macos"))]
            cache: cached::Cache::default(),
        }
    }

    pub async fn read(&self, cwd: &str, known: Option<&str>, scope: Scope) -> Result<Value, Fault> {
        let runner = self.runner.as_ref().ok_or_else(|| Fault::new("git_missing", "git is not installed or not on PATH"))?;
        if scope.cancelled() { return Err(Fault::cancelled()); }
        #[cfg(any(windows, target_os = "macos"))]
        { self.cache.read(runner, cwd, known, scope).await }
        #[cfg(not(any(windows, target_os = "macos")))]
        { fingerprint(runner, cwd, known, scope).await }
    }

    pub fn dispose(&self) {
        #[cfg(any(windows, target_os = "macos"))]
        self.cache.dispose();
    }
}

async fn fingerprint(runner: &Runner, cwd: &str, known: Option<&str>, scope: Scope) -> Result<Value, Fault> {
    let value = read::fingerprint(&Git::new(runner.clone(), scope), cwd, known).await?;
    serde_json::to_value(value).map_err(|error| Fault::new("internal", error.to_string()))
}

#[cfg(any(windows, target_os = "macos"))]
mod cached {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::{Arc, Mutex, MutexGuard, Weak};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Duration;

    use tokio::sync::{OnceCell, watch};
    use tokio::time::Instant;

    use crate::agentctl::service::host::node_resolve;
    use crate::git::checkout;
    use crate::sessions::source::{self, Raw, Source};

    use super::*;

    const MAX_AGE: Duration = Duration::from_secs(30);
    const IDLE: Duration = Duration::from_secs(15);
    type Answer = Result<Value, Fault>;
    type Pending = watch::Receiver<Option<Answer>>;
    type Entries = Arc<Mutex<HashMap<String, Arc<Entry>>>>;

    struct Cached {
        generation: u64,
        at: Instant,
        value: Value,
    }

    struct Reading {
        id: u64,
        generation: u64,
        answer: Pending,
    }

    struct State {
        root: Option<String>,
        watchers: Vec<Source>,
        touched: Instant,
        cached: Option<Cached>,
        reading: Option<Reading>,
        next: u64,
    }

    struct Entry {
        ready: OnceCell<()>,
        generation: AtomicU64,
        watching: AtomicBool,
        active: AtomicBool,
        state: Mutex<State>,
        #[cfg(test)]
        changed: watch::Sender<()>,
    }

    impl Entry {
        fn new() -> Self {
            Self {
                ready: OnceCell::new(), generation: AtomicU64::new(0),
                watching: AtomicBool::new(false), active: AtomicBool::new(true),
                #[cfg(test)]
                changed: watch::channel(()).0,
                state: Mutex::new(State {
                    root: None, watchers: Vec::new(), touched: Instant::now(),
                    cached: None, reading: None, next: 0,
                }),
            }
        }

        fn stop_watching(&self) {
            self.watching.store(false, Ordering::Release);
            let watchers = {
                let mut state = locked(&self.state);
                state.cached = None;
                std::mem::take(&mut state.watchers)
            };
            // A Windows Source joins its event thread on drop. Never hold State while joining, and never
            // call this from that event thread itself.
            drop(watchers);
        }

        async fn prepare(self: &Arc<Self>, runner: &Runner, key: &str, life: Scope) {
            self.ready.get_or_init(|| async {
                let Ok(Some(dirs)) = checkout::dirs(&Git::new(runner.clone(), life), key).await else { return; };
                if !self.active.load(Ordering::Acquire) { return; }
                let root = dirs.first().cloned();
                let roots: Vec<_> = dirs.iter().enumerate().filter(|(index, dir)| {
                    !dirs[..*index].iter().any(|earlier| Path::new(dir).starts_with(earlier))
                }).map(|(_, dir)| dir.clone()).collect();
                let entry = Arc::downgrade(self);
                let runtime = tokio::runtime::Handle::current();
                self.watching.store(true, Ordering::Release);
                let opened = tokio::task::spawn_blocking(move || {
                    let mut watchers = Vec::with_capacity(roots.len());
                    for root in roots {
                        let weak = entry.clone();
                        let runtime = runtime.clone();
                        let watcher = source::start(Path::new(&root), move |event| {
                            let Some(entry) = weak.upgrade() else { return; };
                            entry.generation.fetch_add(1, Ordering::AcqRel);
                            #[cfg(test)]
                            entry.changed.send_replace(());
                            if matches!(event, Raw::Ended(_)) && entry.watching.swap(false, Ordering::AcqRel) {
                                let weak = Arc::downgrade(&entry);
                                runtime.spawn_blocking(move || {
                                    if let Some(entry) = weak.upgrade() { entry.stop_watching(); }
                                });
                            }
                        })?;
                        watchers.push(watcher);
                    }
                    Ok::<_, std::io::Error>(watchers)
                }).await;
                match opened {
                    Ok(Ok(watchers)) => {
                        let mut state = locked(&self.state);
                        if self.active.load(Ordering::Acquire) && self.watching.load(Ordering::Acquire) {
                            state.root = root;
                            state.watchers = watchers;
                        } else {
                            drop(state);
                            drop(watchers);
                        }
                    }
                    _ => self.stop_watching(),
                }
            }).await;
        }
    }

    pub struct Cache {
        entries: Entries,
        life: Scope,
    }

    impl Default for Cache {
        fn default() -> Self {
            Self { entries: Arc::default(), life: Scope::detached() }
        }
    }

    fn locked<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
        value.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl Cache {
        fn entry(&self, key: &str) -> Arc<Entry> {
            let mut entries = locked(&self.entries);
            if let Some(entry) = entries.get(key) {
                locked(&entry.state).touched = Instant::now();
                return Arc::clone(entry);
            }
            let entry = Arc::new(Entry::new());
            entries.insert(key.to_owned(), Arc::clone(&entry));
            tokio::spawn(expire(Arc::downgrade(&self.entries), Arc::downgrade(&entry), key.to_owned()));
            entry
        }

        pub async fn read(&self, runner: &Runner, cwd: &str, known: Option<&str>, scope: Scope) -> Answer {
            if self.life.cancelled() { return Err(Fault::cancelled()); }
            let key = node_resolve(cwd);
            let entry = self.entry(&key);
            let prepare = entry.prepare(runner, &key, self.life.clone());
            tokio::select! {
                _ = scope.on_cancel() => return Err(Fault::cancelled()),
                _ = prepare => {}
            }
            if self.life.cancelled() { return Err(Fault::cancelled()); }
            if !entry.watching.load(Ordering::Acquire) {
                return fingerprint(runner, cwd, known, scope).await;
            }
            let generation = entry.generation.load(Ordering::Acquire);
            let mut answer = {
                let mut state = locked(&entry.state);
                if let Some(cached) = state.cached.as_ref().filter(|cached| cached.generation == generation && cached.at.elapsed() < MAX_AGE) {
                    return Ok(cached.value.clone());
                }
                if let Some(reading) = state.reading.as_ref().filter(|reading| reading.generation == generation) {
                    reading.answer.clone()
                } else {
                    let (send, receive) = watch::channel(None);
                    state.next = state.next.wrapping_add(1);
                    let id = state.next;
                    state.reading = Some(Reading { id, generation, answer: receive.clone() });
                    let known = known.map(str::to_owned).or_else(|| state.root.clone());
                    let (runner, cwd, entry, life) = (runner.clone(), cwd.to_owned(), Arc::clone(&entry), self.life.clone());
                    tokio::spawn(async move {
                        let result = fingerprint(&runner, &cwd, known.as_deref(), life).await;
                        {
                            let mut state = locked(&entry.state);
                            if entry.active.load(Ordering::Acquire) && entry.watching.load(Ordering::Acquire)
                                && entry.generation.load(Ordering::Acquire) == generation {
                                if let Ok(value) = &result {
                                    state.cached = Some(Cached { generation, at: Instant::now(), value: value.clone() });
                                }
                            }
                            if state.reading.as_ref().is_some_and(|reading| reading.id == id) { state.reading = None; }
                        }
                        send.send_replace(Some(result));
                    });
                    receive
                }
            };
            tokio::select! {
                _ = scope.on_cancel() => Err(Fault::cancelled()),
                result = answer.wait_for(|answer| answer.is_some()) => result
                    .map_err(|_| Fault::new("internal", "Git fingerprint reader ended without an answer"))?
                    .as_ref().expect("waited for a fingerprint answer").clone(),
            }
        }

        pub fn dispose(&self) {
            self.life.cancel();
            let entries = std::mem::take(&mut *locked(&self.entries));
            for entry in entries.into_values() {
                entry.active.store(false, Ordering::Release);
                entry.stop_watching();
            }
        }
    }

    impl Drop for Cache {
        fn drop(&mut self) { self.dispose(); }
    }

    async fn expire(entries: Weak<Mutex<HashMap<String, Arc<Entry>>>>, entry: Weak<Entry>, key: String) {
        loop {
            let Some(held) = entry.upgrade() else { return; };
            let deadline = locked(&held.state).touched + IDLE;
            drop(held);
            tokio::time::sleep_until(deadline).await;
            let (Some(entries), Some(entry)) = (entries.upgrade(), entry.upgrade()) else { return; };
            let mut entries = locked(&entries);
            if locked(&entry.state).touched.elapsed() < IDLE { continue; }
            if entries.get(&key).is_none_or(|current| !Arc::ptr_eq(current, &entry)) { return; }
            entries.remove(&key);
            entry.active.store(false, Ordering::Release);
            drop(entries);
            entry.stop_watching();
            return;
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::git::session_lifecycle::test_support::{repo_at, runner};

        #[tokio::test]
        async fn real_watch_invalidates_a_cached_fingerprint_and_dispose_ends_watchers() {
            let folder = super::super::tests::Folder::new();
            repo_at(&folder.0);
            let cwd = folder.0.to_str().unwrap();
            let runner = runner();
            let cache = Cache::default();
            let before = cache.read(&runner, cwd, None, Scope::detached()).await.unwrap();
            let entry = cache.entry(&node_resolve(cwd));
            assert!(entry.watching.load(Ordering::Acquire));
            let mut changed = entry.changed.subscribe();
            std::fs::write(folder.0.join("README.md"), "a changed tracked file\n").unwrap();
            tokio::time::timeout(Duration::from_secs(10), changed.changed()).await
                .expect("the real OS watcher reports the edit").unwrap();
            let after = cache.read(&runner, cwd, None, Scope::detached()).await.unwrap();
            assert_ne!(before, after);
            cache.dispose();
            assert!(!entry.watching.load(Ordering::Acquire));
            assert!(locked(&entry.state).watchers.is_empty());
            assert_eq!(cache.read(&runner, cwd, None, Scope::detached()).await.unwrap_err().code, "cancelled");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::git::session_lifecycle::test_support::{repo_at, runner};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    pub(super) struct Folder(pub(super) PathBuf);

    impl Folder {
        pub(super) fn new() -> Self {
            let root = std::env::temp_dir().join(format!("local-fingerprint-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn a_folder_that_becomes_a_repository_is_read_again_without_a_trusted_watch() {
        let folder = Folder::new();
        let service = Service::new(Some(runner()));
        let cwd = folder.0.to_str().unwrap();
        let before = service.read(cwd, None, Scope::detached()).await.unwrap();
        repo_at(&folder.0);
        let after = service.read(cwd, None, Scope::detached()).await.unwrap();
        assert_ne!(before, after);
        service.dispose();
    }
}
