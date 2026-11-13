//! Where a repository's ledger is kept: `<dir>/<owner>__<name>.json`, one file per repository, saved through
//! `write_kept` (a full disk keeps the old file and the save waits for room, as every store of the core).
//!
//! A file that cannot be read as a ledger starts an empty one: what is lost is history (a quarantined test is
//! found again at its next flake, a median builds again in days), never a result.

use std::path::{Path, PathBuf};

use super::ledger::Ledger;
use crate::disk::saves::write_kept;
use crate::server::Fault;

pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// `dir`: the hub's folder for test history (under the app's user data).
    pub fn new(dir: impl Into<PathBuf>) -> Store {
        Store { dir: dir.into() }
    }

    pub fn file(&self, repo: &str) -> PathBuf {
        let name: String = repo
            .replace('/', "__")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        self.dir.join(format!("{name}.json"))
    }

    pub fn load(&self, repo: &str) -> Ledger {
        read(&self.file(repo))
    }

    pub fn save(&self, repo: &str, ledger: &Ledger) -> Result<(), Fault> {
        let bytes = serde_json::to_vec(ledger)
            .map_err(|e| Fault::new("checks_ledger", format!("the test history of {repo}: {e}")))?;
        write_kept(&self.file(repo), &bytes, Some(0o600), 0o700).map(|_| ())
    }
}

fn read(file: &Path) -> Ledger {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::ledger::tests::quarantine;
    use super::*;

    #[test]
    fn a_ledger_is_kept_per_repository_and_a_damaged_file_starts_over() {
        let dir = std::env::temp_dir().join(format!("ompdesk-ledger-{}", std::process::id()));
        let store = Store::new(&dir);
        assert!(
            store
                .file("SeuPut0705/ompdesk")
                .ends_with("SeuPut0705__ompdesk.json")
        );
        assert!(store.file("a/../b c").ends_with("a__..__b-c.json"));
        assert!(store.load("o/r").flaky.tests.is_empty());
        let mut ledger = Ledger::default();
        let key = quarantine(&mut ledger);
        store.save("o/r", &ledger).unwrap();
        assert!(store.load("o/r").flaky.quarantined(&key));
        assert!(store.load("o/other").flaky.tests.is_empty());
        std::fs::write(store.file("o/r"), b"{ not json").unwrap();
        assert!(store.load("o/r").flaky.tests.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
