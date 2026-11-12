//! A files trigger's reads (was `scanPath` of `src/main/routines/ports.ts` and `changedNames`/`parseMark` of
//! `files.ts`): the listing of what is under the watched path, which is the trigger's mark, and the names that changed
//! between the last launch's listing and the first one of this launch. The watch and the burst's timers stay main's.
//!
//! A listing is each file's name (`/`-separated, relative; `""` for the path itself when it is a file) and
//! `<modified ms>:<size>`, at most `max` files in name order; folders named in `ignored` are passed over, folders that
//! cannot be read and files gone meanwhile too, and a link is listed, never followed. The names are compared as the
//! TypeScript's objects held them: `name in entries` also found `Object.prototype`'s members, and a file named
//! `__proto__` was never kept (an assignment to it sets no property).

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::control::js::number;
use crate::disk::tree::entry_size;
use crate::fs::disk::{self, Kind};
use crate::server::Fault;

/// `Object.prototype`'s own names, which `in` finds in every object.
const PROTOTYPE_NAMES: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// What is under a path; `complete` is false when the listing stopped at its cap.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct Listing {
    pub entries: Map<String, Value>,
    pub complete: bool,
}

/// The listing of `path`, `None` when nothing is there (`ENOENT`, `ENOTDIR`); fails as node's `lstat` did otherwise.
pub fn scan(path: &str, ignored: &[String], max: usize) -> Result<Option<Listing>, Fault> {
    let top = match disk::lstat(path) {
        Ok(top) => top,
        Err(error) if matches!(error.code, "ENOENT" | "ENOTDIR") => return Ok(None),
        Err(error) => return Err(error.fault(crate::fs::error::Codes::None)),
    };
    let mut listing = Listing {
        entries: Map::new(),
        complete: true,
    };
    if !top.is_dir() {
        let size = entry_size(Path::new(path), &top)?;
        listing
            .entries
            .insert(String::new(), Value::String(stamp(&top, size)));
        return Ok(Some(listing));
    }
    let mut count = 0;
    walk(Path::new(path), "", ignored, max, &mut listing, &mut count);
    Ok(Some(listing))
}

fn walk(
    dir: &Path,
    prefix: &str,
    ignored: &[String],
    max: usize,
    listing: &mut Listing,
    count: &mut usize,
) {
    let mut items = disk::entries(dir).unwrap_or_default();
    // `a.name < b.name`: UTF-16 units.
    items.sort_by(|a, b| a.name.encode_utf16().cmp(b.name.encode_utf16()));
    for item in items {
        if !listing.complete {
            return;
        }
        let name = if prefix.is_empty() {
            item.name.clone()
        } else {
            format!("{prefix}/{}", item.name)
        };
        // Node read a name the system holds in no Unicode as a lossy text that names nothing: its folder read empty
        // and its `lstat` failed.
        let readable = item.raw.to_str().is_some();
        if item.kind == Kind::Dir {
            if readable && !ignored.contains(&item.name) {
                walk(&dir.join(&item.raw), &name, ignored, max, listing, count);
            }
            continue;
        }
        if *count >= max {
            listing.complete = false;
            return;
        }
        if !readable {
            continue;
        }
        let path = dir.join(&item.raw);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let Ok(size) = entry_size(&path, &meta) else {
            continue;
        };
        if name != "__proto__" {
            listing
                .entries
                .insert(name, Value::String(stamp(&meta, size)));
        }
        *count += 1;
    }
}

/// `<Math.trunc(mtimeMs)>:<size>`.
fn stamp(meta: &std::fs::Metadata, size: u64) -> String {
    format!(
        "{}:{}",
        number(disk::mtime_ms(meta).trunc()),
        number(size as f64)
    )
}

/// The last launch's listing from its mark (JSON from disk): `None` when there is none it can read.
pub fn parse_mark(mark: Option<&Value>) -> Option<Option<Listing>> {
    let Some(Value::Object(mark)) = mark else {
        return None;
    };
    let listing = mark.get("listing")?;
    let fields = match listing {
        Value::Null => return Some(None),
        Value::Object(fields) => fields,
        _ => return None,
    };
    let Some(Value::Bool(complete)) = fields.get("complete") else {
        return None;
    };
    let pairs: Vec<(String, &Value)> = match fields.get("entries")? {
        Value::Object(entries) => entries.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        _ => return None,
    };
    let entries = pairs
        .into_iter()
        .filter(|(name, stamp)| stamp.is_string() && name != "__proto__")
        .map(|(name, stamp)| (name, stamp.clone()))
        .collect();
    Some(Some(Listing {
        entries,
        complete: *complete,
    }))
}

/// What `entries[name]` read: an own entry, a member of `Object.prototype`, or nothing.
#[derive(PartialEq)]
enum Lookup<'a> {
    Own(&'a Value),
    Prototype(&'a str),
    Absent,
}

fn lookup<'a>(listing: &'a Listing, name: &'a str) -> Lookup<'a> {
    match listing.entries.get(name) {
        Some(value) => Lookup::Own(value),
        None if PROTOTYPE_NAMES.contains(&name) => Lookup::Prototype(name),
        None => Lookup::Absent,
    }
}

/// `name in entries`.
fn holds(listing: &Listing, name: &str) -> bool {
    !matches!(lookup(listing, name), Lookup::Absent)
}

/// `entries[a] !== entries[b]` for one name.
fn differs(before: &Listing, after: &Listing, name: &str) -> bool {
    match (lookup(before, name), lookup(after, name)) {
        (Lookup::Own(a), Lookup::Own(b)) => !same_value(a, b),
        (a, b) => a != b,
    }
}

/// `===` of two stamps (strings in every listing this code makes).
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(_) | Value::Array(_), _) | (_, Value::Object(_) | Value::Array(_)) => false,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => a == b,
    }
}

/// `toSorted()`: UTF-16 units.
fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
}

/// Names added, changed or removed between two listings; `""` alone when only "something" can be said.
pub fn changed_names(before: Option<&Listing>, after: Option<&Listing>) -> Vec<String> {
    let (before, after) = match (before, after) {
        (None, None) => return Vec::new(),
        (Some(before), Some(after)) => (before, after),
        (one, other) => {
            let names: Vec<String> = one.or(other).map_or_else(Vec::new, |listing| {
                listing.entries.keys().cloned().collect()
            });
            return if names.is_empty() {
                vec![String::new()]
            } else {
                sorted(names)
            };
        }
    };
    if before.complete && after.complete {
        let mut names: Vec<String> = before.entries.keys().cloned().collect();
        names.extend(
            after
                .entries
                .keys()
                .filter(|name| !before.entries.contains_key(*name))
                .cloned(),
        );
        return sorted(
            names
                .into_iter()
                .filter(|name| differs(before, after, name))
                .collect(),
        );
    }
    let changed: Vec<String> = before
        .entries
        .keys()
        .filter(|name| holds(after, name) && differs(before, after, name))
        .cloned()
        .collect();
    if !changed.is_empty() {
        return sorted(changed);
    }
    let same_names = before.entries.len() == after.entries.len()
        && before.entries.keys().all(|name| holds(after, name));
    if same_names {
        Vec::new()
    } else {
        vec![String::new()]
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;
    use crate::routines::captured;

    #[test]
    fn compares_listings_as_the_typescript_did() {
        let rows = captured("changed");
        assert_eq!(rows.len(), 350);
        for row in rows {
            let mark =
                if row[0].get("undefined").is_some() && row[0].as_object().unwrap().len() == 1 {
                    None
                } else {
                    Some(&row[0])
                };
            let after: Option<Listing> = serde_json::from_value(row[1].clone()).unwrap();
            let answer =
                parse_mark(mark).map(|before| changed_names(before.as_ref(), after.as_ref()));
            let expected: Option<Vec<String>> = serde_json::from_value(row[2].clone()).unwrap();
            assert_eq!(answer, expected, "{} / {}", row[0], row[1]);
        }
    }

    /// Builds each captured tree (sizes and modified times as the capture set them) and lists it.
    #[test]
    fn lists_each_captured_tree_as_the_typescript_did() {
        let trees = captured("scans");
        assert_eq!(trees.len(), 6);
        let base =
            std::env::temp_dir().join(format!("ompdesk-routines-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        for tree in trees {
            let name = tree["name"].as_str().unwrap();
            let dir = base.join(name.replace(' ', "-"));
            fs::create_dir_all(&dir).unwrap();
            for item in tree["items"].as_array().unwrap() {
                let path = dir.join(item["path"].as_str().unwrap());
                if item["dir"].as_bool() == Some(true) {
                    fs::create_dir_all(&path).unwrap();
                    continue;
                }
                let size = item["size"].as_u64().unwrap_or(0) as usize;
                fs::write(&path, "x".repeat(size)).unwrap();
                let seconds = item["mtime"].as_f64().unwrap_or(0.0);
                let file = File::options().write(true).open(&path).unwrap();
                file.set_modified(UNIX_EPOCH + Duration::from_secs_f64(seconds))
                    .unwrap();
            }
            let root = dir.join(tree["root"].as_str().unwrap());
            let ignored = [".git".to_owned(), "node_modules".to_owned()];
            let listing = scan(&root.to_string_lossy(), &ignored, 2_000).unwrap();
            let expected: Option<Listing> =
                serde_json::from_value(tree["listing"].clone()).unwrap();
            assert_eq!(listing, expected, "{name}");
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lists_a_link_as_itself_and_never_follows_it() {
        let base =
            std::env::temp_dir().join(format!("ompdesk-routines-links-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("inside")).unwrap();
        fs::write(base.join("inside/a"), "abc").unwrap();
        std::os::unix::fs::symlink(base.join("inside"), base.join("to-dir")).unwrap();
        std::os::unix::fs::symlink("inside/a", base.join("to-file")).unwrap();
        let listing = scan(&base.to_string_lossy(), &[], 2_000).unwrap().unwrap();
        let names: Vec<&String> = listing.entries.keys().collect();
        assert_eq!(names, ["inside/a", "to-dir", "to-file"]);
        let size = |name: &str| {
            listing.entries[name]
                .as_str()
                .unwrap()
                .split(':')
                .nth(1)
                .unwrap()
                .to_owned()
        };
        // A link's own size: the length of the path it holds.
        assert_eq!(size("to-file"), "8");
        assert_eq!(
            size("to-dir"),
            base.join("inside").to_string_lossy().len().to_string()
        );
        fs::remove_dir_all(&base).unwrap();
    }
}
