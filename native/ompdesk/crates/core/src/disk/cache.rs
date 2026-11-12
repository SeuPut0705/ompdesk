//! Clearing a cache its tool fills again (`src/main/disk/caches.ts` is the table: where each one is, its bound and
//! whether it is in use). The core takes only what the tool's own layout names inside the folder main resolved, so a
//! folder that is not that cache (a variable pointing somewhere else) loses nothing else:
//! - Bun's runtime transpiler cache: the `<hash>.pile` files directly in it (`RuntimeTranspilerCache.zig`
//!   `getCacheFilePath`; its temp files carry the same extension). Bun reads a missing entry as a miss and makes the
//!   folder again on its next write, so a running Bun loses nothing.
//! - npm's cache: cacache's `content-v<n>`, `index-v<n>` and `tmp` folders of a folder named `_cacache`, which is all
//!   `npm cache clean --force` removes; `_npx`, `_logs` and the rest of npm's cache folder are outside it.
//!
//! An entry that cannot go (Windows: a file a running process holds open) is counted and left; the others still go.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::tree::{fault, live, remove};
use crate::server::{Fault, Scope};

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    BunTranspiler,
    Npm,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Cleared {
    removed: u64,
    /// Entries of the cache that could not be removed.
    left: u64,
}

/// `content-v2`, `index-v5`: the prefix and a version number.
fn versioned(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|version| {
        !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// Whether the entry directly in the cache folder is the tool's own (a link is never one).
fn clears(kind: Kind, name: &str, meta: &fs::Metadata) -> bool {
    match kind {
        Kind::BunTranspiler => meta.is_file() && name.ends_with(".pile"),
        Kind::Npm => {
            meta.is_dir()
                && (name == "tmp" || versioned(name, "content-v") || versioned(name, "index-v"))
        }
    }
}

pub fn clear(kind: Kind, dir: &str, scope: &Scope) -> Result<Cleared, Fault> {
    live(scope)?;
    let dir = Path::new(dir);
    if matches!(kind, Kind::Npm) && dir.file_name().is_none_or(|name| name != "_cacache") {
        return Err(Fault::new(
            "invalid_entry",
            format!(
                "\"{}\" is not npm's _cacache folder; nothing was done.",
                dir.display()
            ),
        ));
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Cleared::default()),
        Err(error) => return Err(fault(&error, "scandir", dir)),
    };
    let mut cleared = Cleared::default();
    for entry in entries {
        live(scope)?;
        let entry = entry.map_err(|error| fault(&error, "scandir", dir))?;
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !clears(kind, &entry.file_name().to_string_lossy(), &meta) {
            continue;
        }
        match remove(&path, matches!(kind, Kind::Npm), scope) {
            Ok(()) => cleared.removed += 1,
            Err(_) if scope.cancelled() => return Err(Fault::cancelled()),
            Err(_) => cleared.left += 1,
        }
    }
    Ok(cleared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ompdesk-core-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(file: &Path) {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "x").unwrap();
    }

    #[test]
    fn takes_bun_s_pile_files_and_nothing_else_of_the_folder() {
        let dir = temp("cache-pile");
        put(&dir.join("13d26ba104094bb1.pile"));
        put(&dir.join(".tmp-9ac5.pile"));
        put(&dir.join("notes.txt"));
        put(&dir.join("folder.pile/inner.pile"));
        let cleared = clear(
            Kind::BunTranspiler,
            &dir.to_string_lossy(),
            &Scope::detached(),
        )
        .unwrap();
        assert_eq!(
            cleared,
            Cleared {
                removed: 2,
                left: 0
            }
        );
        assert!(!dir.join("13d26ba104094bb1.pile").exists());
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("folder.pile/inner.pile").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn takes_cacache_s_folders_of_a_cacache_folder_only() {
        let root = temp("cache-npm");
        let cache = root.join("_cacache");
        put(&cache.join("content-v2/sha512/aa/bb/cc"));
        put(&cache.join("index-v5/aa/bb/cc"));
        put(&cache.join("tmp/half"));
        put(&cache.join("content-v2x/mine"));
        put(&cache.join("content-v2.txt"));
        put(&root.join("_npx/abc/package.json"));
        let scope = Scope::detached();
        let refused = clear(Kind::Npm, &root.to_string_lossy(), &scope);
        assert!(
            refused.is_err(),
            "a folder that is not _cacache is not cleared"
        );
        assert!(root.join("_npx/abc/package.json").exists());
        let cleared = clear(Kind::Npm, &cache.to_string_lossy(), &scope).unwrap();
        assert_eq!(
            cleared,
            Cleared {
                removed: 3,
                left: 0
            }
        );
        assert!(!cache.join("content-v2").exists());
        assert!(!cache.join("index-v5").exists());
        assert!(!cache.join("tmp").exists());
        assert!(cache.join("content-v2x/mine").exists());
        assert!(cache.join("content-v2.txt").exists());
        assert!(root.join("_npx/abc/package.json").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_folder_is_already_clear_and_a_cancelled_request_takes_nothing() {
        let dir = temp("cache-cancel");
        let scope = Scope::detached();
        let missing = dir.join("none");
        assert_eq!(
            clear(Kind::BunTranspiler, &missing.to_string_lossy(), &scope).unwrap(),
            Cleared::default()
        );
        put(&dir.join("a.pile"));
        scope.cancel();
        assert!(clear(Kind::BunTranspiler, &dir.to_string_lossy(), &scope).is_err());
        assert!(dir.join("a.pile").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
