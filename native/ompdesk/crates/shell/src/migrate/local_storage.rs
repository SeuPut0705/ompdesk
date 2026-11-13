//! Electron loaded the page from `file://…/index.html`, so its Local Storage (composer drafts, the outbox, snapshots)
//! lives under the origin `file://`. The shell serves the page from `app://ompdesk`, a new origin: this exports the old
//! origin's entries once, and the injected preload copies them into the new origin before any page script runs.
//! Chromium's Local Storage is a LevelDB; it is read from a copy of the folder, so Electron's files stay as they were.

use std::path::Path;

use rusty_leveldb::LdbIterator;
use serde_json::{Map, Value};

/// A LevelDB key of Chromium's Local Storage: `_` + origin + `\0` + `\x01` + the item's name (Latin-1).
fn key_prefix(origin: &str) -> Vec<u8> {
    [b"_", origin.as_bytes(), b"\0\x01"].concat()
}

/// A stored value or name: `\x01` + Latin-1 bytes, or `\x00` + UTF-16LE.
pub fn decode(bytes: &[u8]) -> Option<String> {
    match bytes.split_first()? {
        (1, rest) => Some(rest.iter().map(|&b| b as char).collect()),
        (0, rest) => {
            let units: Vec<u16> = rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

/// Every item of `origin` in the LevelDB folder `dir`.
pub fn export(dir: &Path, origin: &str) -> Result<Map<String, Value>, String> {
    if !dir.is_dir() {
        return Ok(Map::new());
    }
    let copy = std::env::temp_dir().join(format!(
        "shell-migrate-ls-{}-{}",
        std::process::id(),
        origin.len()
    ));
    let _ = std::fs::remove_dir_all(&copy);
    std::fs::create_dir_all(&copy).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name() != "LOCK" {
            std::fs::copy(entry.path(), copy.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
    }
    let result = read_copy(&copy, origin);
    let _ = std::fs::remove_dir_all(&copy);
    result
}

fn read_copy(copy: &Path, origin: &str) -> Result<Map<String, Value>, String> {
    let mut db = rusty_leveldb::DB::open(copy, rusty_leveldb::Options::default())
        .map_err(|e| e.to_string())?;
    let mut iter = db.new_iter().map_err(|e| e.to_string())?;
    let prefix = key_prefix(origin);
    let mut out = Map::new();
    while let Some((key, value)) = iter.next() {
        let Some(name) = key.strip_prefix(prefix.as_slice()) else {
            continue;
        };
        if let (Some(name), Some(value)) = (decode(&[&[1u8][..], name].concat()), decode(&value)) {
            out.insert(name, Value::String(value));
        }
    }
    Ok(out)
}

/// The import file the page's preload asks for once; `done` marks it handled.
pub const IMPORT_FILE: &str = "local-storage-import.json";
pub const DONE_FILE: &str = "local-storage-import.done";

/// Exports Electron's `file://` items to `<web_dir>/local-storage-import.json` unless that was done (or a page took
/// them: `.done`). Returns the item count exported, `None` when skipped.
pub fn prepare(user_data: &Path, web_dir: &Path, log: &mut dyn FnMut(&str, Value)) {
    use serde_json::json;
    let target = web_dir.join(IMPORT_FILE);
    if target.exists() || web_dir.join(DONE_FILE).exists() {
        log(
            "migrate.localStorage",
            json!({ "ok": true, "skipped": "already exported" }),
        );
        return;
    }
    match export(&user_data.join("Local Storage").join("leveldb"), "file://") {
        Ok(items) => {
            let count = items.len();
            let text = Value::Object(items).to_string();
            let _ = std::fs::create_dir_all(web_dir);
            let written = std::fs::write(&target, &text).is_ok();
            log(
                "migrate.localStorage",
                json!({ "ok": written, "keys": count, "bytes": text.len() }),
            );
        }
        Err(error) => log(
            "migrate.localStorage",
            json!({ "ok": false, "error": error }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn latin1(s: &str) -> Vec<u8> {
        [&[1u8][..], s.as_bytes()].concat()
    }

    fn utf16(s: &str) -> Vec<u8> {
        let mut out = vec![0u8];
        for unit in s.encode_utf16() {
            out.extend(unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn values_decode_as_latin1_or_utf16() {
        assert_eq!(decode(&latin1("draft")).as_deref(), Some("draft"));
        assert_eq!(decode(&[1, 0xe9]).as_deref(), Some("é"));
        assert_eq!(decode(&utf16("초안 ✓")).as_deref(), Some("초안 ✓"));
        assert_eq!(decode(&[7, 1]), None);
        assert_eq!(decode(&[]), None);
    }

    #[test]
    fn only_the_wanted_origin_exports_from_a_leveldb_like_chromiums() {
        let root = std::env::temp_dir().join(format!("shell-ls-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let db_dir = root.join("leveldb");
        std::fs::create_dir_all(&db_dir).unwrap();
        {
            let mut db = rusty_leveldb::DB::open(
                &db_dir,
                rusty_leveldb::Options {
                    create_if_missing: true,
                    ..Default::default()
                },
            )
            .unwrap();
            let put = |db: &mut rusty_leveldb::DB, origin: &str, name: &str, value: Vec<u8>| {
                let key = [key_prefix(origin), name.as_bytes().to_vec()].concat();
                db.put(&key, &value).unwrap();
            };
            put(
                &mut db,
                "file://",
                "composer:draft",
                utf16("안녕하세요 draft"),
            );
            put(
                &mut db,
                "file://",
                "omp.prefs",
                latin1("{\"theme\":\"dark\"}"),
            );
            put(&mut db, "https://example.com", "other", latin1("no"));
            db.put(b"META:file://", b"\x08\x01").unwrap();
            db.flush().unwrap();
        }
        let items = export(&db_dir, "file://").unwrap();
        assert_eq!(
            Value::Object(items),
            json!({ "composer:draft": "안녕하세요 draft", "omp.prefs": "{\"theme\":\"dark\"}" })
        );
        assert!(export(&root.join("missing"), "file://").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_import_is_exported_once() {
        let root = std::env::temp_dir().join(format!("shell-ls-once-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let web = root.join("shell-webview");
        let mut events = Vec::new();
        prepare(&root, &web, &mut |name, data| {
            events.push((name.to_string(), data))
        });
        assert_eq!(
            std::fs::read_to_string(web.join(IMPORT_FILE)).unwrap(),
            "{}"
        );
        std::fs::write(web.join(DONE_FILE), "").unwrap();
        std::fs::remove_file(web.join(IMPORT_FILE)).unwrap();
        prepare(&root, &web, &mut |name, data| {
            events.push((name.to_string(), data))
        });
        assert!(
            !web.join(IMPORT_FILE).exists(),
            "a handled import is not exported again"
        );
        assert_eq!(events[1].1["skipped"], "already exported");
        let _ = std::fs::remove_dir_all(&root);
    }
}
