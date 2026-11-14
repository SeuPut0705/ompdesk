//! Shared by orphan removal and every native pool/host acquire. The hub reads its actual
//! open folders and calls `try_claim` in the same admission step; no folder registry lives here.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::fs::disk;
use crate::git::read;
use crate::server::Fault;

pub(crate) fn strictly_inside(root: &Path, child: &Path) -> bool {
    let lowered;
    let (root, child) = if cfg!(windows) {
        lowered = (root.to_string_lossy().to_lowercase(), child.to_string_lossy().to_lowercase());
        (Path::new(&lowered.0), Path::new(&lowered.1))
    } else { (root, child) };
    child.strip_prefix(root).ok().is_some_and(|relative| {
        relative.components().next().is_some_and(|first| {
            !first.as_os_str().to_string_lossy().starts_with("..")
        })
    })
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Folder(String);

impl Folder {
    /// Missing folders retain Node's lexical absolute spelling.
    /// Base calls this only inside the atomic current-folder/claim admission.
    pub(crate) fn resolve_now(path: &str) -> Result<Self, Fault> {
        match disk::realpath(path).map(|path| disk::spelled(&path)) {
            Ok(path) => Ok(Self(path)),
            Err(_) => {
                let cwd = std::env::current_dir()
                    .map_err(|error| Fault::new("io", error.to_string()))?;
                Ok(Self(read::resolve(&disk::spelled(&cwd), path)))
            }
        }
    }

    pub async fn resolve(path: String) -> Result<Self, Fault> {
        read::blocking(move || Self::resolve_now(&path)).await?
    }

    pub fn path(&self) -> &str { &self.0 }

    fn covers(&self, other: &Self) -> bool {
        self == other || strictly_inside(Path::new(&self.0), Path::new(&other.0))
    }
}

#[derive(Default)]
pub struct RemovalClaims { paths: Mutex<HashSet<Folder>> }

impl RemovalClaims {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    fn lock(&self) -> MutexGuard<'_, HashSet<Folder>> {
        self.paths.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Native acquire and host-open call this under the same hub admission as `try_claim`.
    pub fn holds(&self, cwd: &Folder) -> bool {
        self.lock().iter().any(|path| path.covers(cwd))
    }

    /// `open_folders` must be the current canonical pool snapshot, not a cached page payload.
    pub fn try_claim(self: &Arc<Self>, path: Folder, open_folders: &[Folder]) -> Result<RemovalGuard, Fault> {
        let mut paths = self.lock();
        if paths.contains(&path) || open_folders.iter().any(|folder| path.covers(folder)) {
            return Err(Fault::new("in_use", format!(
                "{} is in use by an open session; nothing was removed.", path.path()
            )));
        }
        paths.insert(path.clone());
        Ok(RemovalGuard { claims: Arc::clone(self), path })
    }
}

pub struct RemovalGuard { claims: Arc<RemovalClaims>, path: Folder }

impl Drop for RemovalGuard {
    fn drop(&mut self) { self.claims.lock().remove(&self.path); }
}

#[cfg(test)]
#[path = "claims_tests.rs"]
mod tests;
