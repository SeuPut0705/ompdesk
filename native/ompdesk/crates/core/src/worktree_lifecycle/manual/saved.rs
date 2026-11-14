use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::disk::{facts, saved, saves, tree};
use crate::git::{read, run::Git};
use crate::local_dispatch::protocol::CommandError;
use crate::run::Runner;
use crate::server::{Cancellation, Fault, Scope};

use super::{prepare, privacy};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub path: String,
    pub repo: String,
    pub branch: Option<String>,
    pub head: String,
    pub saved_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<String>,
    pub removed_at: f64,
    pub archived_files: usize,
    pub archived_bytes: u64,
}
struct Pending {
    records: Vec<Record>,
    cancellation: Cancellation,
}

pub struct SavedStore {
    dir: PathBuf,
    state: Arc<Mutex<Vec<Pending>>>,
}

impl SavedStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            state: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn archive_dir(&self, id: &str) -> String {
        self.dir
            .join("saved")
            .join(id)
            .to_string_lossy()
            .into_owned()
    }
    fn read(&self) -> Vec<Record> {
        std::fs::read(self.dir.join("saved.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
    pub fn list(&self) -> Vec<Record> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .iter()
            .rev()
            .find(|pending| !pending.cancellation.cancelled())
            .map(|pending| pending.records.clone())
            .unwrap_or_else(|| self.read())
    }
    async fn update(
        &self,
        scope: Scope,
        change: impl FnOnce(&mut Vec<Record>) + Send + 'static,
    ) -> Result<(), Fault> {
        let state = Arc::clone(&self.state);
        let file = self.dir.join("saved.json");
        let held = scope.clone();
        read::blocking(move || {
            tree::live(&held)?;
            let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
            tree::live(&held)?;
            let mut records = state
                .iter()
                .rev()
                .find(|pending| !pending.cancellation.cancelled())
                .map(|pending| pending.records.clone())
                .unwrap_or_else(|| {
                    std::fs::read(&file)
                        .ok()
                        .and_then(|b| serde_json::from_slice(&b).ok())
                        .unwrap_or_default()
                });
            change(&mut records);
            let mut bytes = serde_json::to_vec_pretty(&records)
                .map_err(|e| Fault::new("json", e.to_string()))?;
            bytes.push(b'\n');
            let check = held.cancellation();
            let result = saves::write_kept_if(
                &file,
                &bytes,
                Some(0o600),
                0o700,
                Arc::new(move || !check.cancelled()),
            );
            match &result {
                Ok(true) => state.clear(),
                Err(fault) if saves::disk_full(fault) && !held.cancelled() => {
                    state.retain(|pending| !pending.cancellation.cancelled());
                    state.push(Pending {
                        records,
                        cancellation: held.cancellation(),
                    });
                }
                _ => {}
            }
            match result {
                Ok(true) => Ok(()),
                Ok(false) => Err(Fault::cancelled()),
                Err(error) => Err(error),
            }
        })
        .await?
    }
}

fn new_id() -> Result<(String, f64), Fault> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| Fault::new("clock", e.to_string()))?
        .as_millis() as u64;
    let mut n = ms;
    let mut digits = [b'0'; 13];
    let mut start = digits.len() - 1;
    while n > 0 {
        digits[start] = b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize];
        n /= 36;
        if n > 0 {
            start -= 1;
        }
    }
    let mut random = [0u8; 4];
    crate::sys::random(&mut random).map_err(|e| Fault::new("random", e.to_string()))?;
    let mut id = String::with_capacity(digits.len() - start + 9);
    id.push_str(std::str::from_utf8(&digits[start..]).expect("base36 is ASCII"));
    id.push('-');
    for byte in random {
        id.push(b"0123456789abcdef"[(byte >> 4) as usize] as char);
        id.push(b"0123456789abcdef"[(byte & 15) as usize] as char);
    }
    Ok((id, ms as f64))
}

pub async fn archive_before_remove(
    store: &SavedStore,
    runner: Runner,
    scope: Scope,
    path: &str,
    repo: &str,
    branch: Option<&str>,
) -> Result<Option<Record>, Fault> {
    tree::live(&scope)?;
    let git = Git::new(runner, scope.clone());
    if let Some(operation) = facts::in_progress(&git, path).await? {
        return Err(saved::keep(format!(
            "a git operation is half done ({operation})"
        )));
    }
    let files = facts::files(&git, path).await?;
    let root = path.to_owned();
    let held = scope.clone();
    let entries = read::blocking(move || {
        let mut entries: Vec<String> = files
            .ignored
            .into_iter()
            .filter(|entry| entry.regenerable.is_none())
            .map(|entry| entry.path)
            .collect();
        for candidate in files.untracked_files.iter().chain(files.changed.iter()) {
            tree::live(&held)?;
            let file = Path::new(&root).join(candidate);
            if std::fs::symlink_metadata(file).is_ok_and(|meta| meta.is_file())
                && privacy::looks_secret(&root, candidate)
            {
                entries.push(candidate.clone());
            }
        }
        Ok::<_, Fault>(entries)
    })
    .await??;
    if entries.is_empty() {
        return Ok(None);
    }
    let (id, _) = new_id()?;
    let Some((archived_files, archived_bytes, head)) = saved::archive(
        &git,
        path.to_owned(),
        entries,
        store.archive_dir(&id),
        &scope,
    )
    .await?
    else {
        return Ok(None);
    };
    let removed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| Fault::new("clock", e.to_string()))?
        .as_millis() as f64;
    Ok(Some(Record {
        id,
        path: path.to_owned(),
        repo: repo.to_owned(),
        branch: branch.map(str::to_owned),
        head,
        saved_branch: None,
        staged: None,
        removed_at,
        archived_files,
        archived_bytes,
    }))
}

pub async fn settle(
    store: &SavedStore,
    scope: Scope,
    record: Record,
    removed: bool,
) -> Result<(), Fault> {
    if !removed {
        let path = record.path.clone();
        let dir = store.archive_dir(&record.id);
        let held = scope.clone();
        if read::blocking(move || saved::settle(&path, &dir, &held)).await?? {
            return Ok(());
        }
    }
    store
        .update(scope, move |records| records.insert(0, record))
        .await
}

fn real_folder(path: &str) -> String {
    if let Ok(resolved) = crate::fs::disk::realpath(path) {
        return crate::fs::disk::spelled(&resolved);
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    read::resolve(&cwd.to_string_lossy(), path)
}

async fn records_for_repo(store: &SavedStore, git: &Git, cwd: &str) -> Result<Vec<Record>, Fault> {
    let root = real_folder(&read::primary_root(git, cwd).await?);
    let mut records: Vec<_> = store
        .list()
        .into_iter()
        .filter(|record| real_folder(&record.repo) == root)
        .collect();
    records.sort_by(|a, b| {
        b.removed_at
            .partial_cmp(&a.removed_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(records)
}

pub async fn list_for_repo(
    store: &SavedStore,
    runner: Runner,
    scope: Scope,
    cwd: &str,
) -> Result<Value, CommandError> {
    let git = Git::new(runner, scope);
    Ok(json!({"worktrees": records_for_repo(store, &git, cwd).await?}))
}

pub async fn restore(
    store: &SavedStore,
    runner: Runner,
    config: &prepare::Config,
    scope: Scope,
    cwd: &str,
    id: &str,
) -> Result<Value, CommandError> {
    let git = Git::new(runner.clone(), scope.clone());
    let record = records_for_repo(store, &git, cwd)
        .await?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| {
            CommandError::local(
                "not_saved",
                format!("No saved worktree {id} in this repository."),
            )
        })?;
    let checkout = saved::Checkout {
        path: record.path.clone(),
        repo: record.repo.clone(),
        branch: record.branch.clone(),
        head: record.head.clone(),
        saved_branch: record.saved_branch.clone(),
        staged: record.staged.clone(),
    };
    let on_branch = saved::checkout(&git, checkout).await.map_err(|fault| {
        if fault.code == "path_exists" {
            CommandError::local("path_exists", fault.message)
        } else {
            fault.into()
        }
    })?;
    prepare::prepare(&runner, config, scope.clone(), &record.repo, &record.path).await?;
    let dir = store.archive_dir(&record.id);
    let (restored, skipped) = if record.archived_files > 0 {
        let path = record.path.clone();
        let dir = dir.clone();
        let held = scope.clone();
        read::blocking(move || saved::restore(&path, &dir, &held)).await??
    } else {
        (0, 0)
    };
    if skipped == 0 {
        let id = record.id.clone();
        store
            .update(scope.clone(), move |records| {
                records.retain(|entry| entry.id != id)
            })
            .await?;
        let held = scope.clone();
        read::blocking(move || saved::forget(&dir, &held)).await??;
    }
    Ok(
        json!({"path": record.path, "branch": if on_branch { record.branch } else { None }, "archive": {"restored": restored, "skipped": skipped}}),
    )
}

#[cfg(test)]
#[path = "saved_tests.rs"]
mod tests;
