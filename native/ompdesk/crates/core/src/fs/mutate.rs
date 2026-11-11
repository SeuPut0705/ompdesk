//! `fs.mutate`: the Files panel's writes inside a workspace. Create an empty file or a folder, rename an entry in
//! place, write an edited text file, or say what to move to the trash (main does that through Electron, on the path
//! this answer validated). An existing target is `exists`, never overwritten; a write whose file changed since the
//! editor loaded it is `changed_on_disk` unless forced.

use std::path::MAIN_SEPARATOR;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::disk;
use super::error::{Codes, NodeError};
use super::order::js_trim;
use crate::server::{Call, Fault, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    /// The workspace root as main holds it.
    root: String,
    /// The request as the renderer or a peer sent it; validated here. A `write`'s content is the call's `bin`.
    request: Value,
    /// The request's `parent` (create) or `path` (the rest), resolved and confined by main; `null` when it escapes
    /// the workspace or is not a string.
    resolved: Option<String>,
    /// The most a write may save (`FS_WRITE_MAX_BYTES`).
    max_write_bytes: u64,
}

/// `IpcFsMutation`, as its zod schema accepted it.
enum Mutation {
    /// A new file or folder `name` in the resolved `parent`.
    Create { folder: bool, name: String },
    /// An operation on the existing entry the resolved `path` names.
    Existing(Existing),
}

enum Existing {
    Rename { name: String },
    Trash,
    Write { expected_mtime_ms: f64, force: bool },
}

/// The zod schema's verdict: an object whose `op` names a variant with the right field types (unknown keys are
/// ignored, `force` is absent or a boolean, `content` is the call's `bin`).
fn parse(request: &Value, has_content: bool) -> Option<Mutation> {
    let request = request.as_object()?;
    let string = |key: &str| request.get(key)?.as_str().map(str::to_owned);
    Some(match request.get("op")?.as_str()? {
        op @ ("createFile" | "createFolder") => {
            string("parent")?;
            Mutation::Create {
                folder: op == "createFolder",
                name: string("name")?,
            }
        }
        "rename" => {
            string("path")?;
            Mutation::Existing(Existing::Rename {
                name: string("name")?,
            })
        }
        "trash" => {
            string("path")?;
            Mutation::Existing(Existing::Trash)
        }
        "write" => {
            string("path")?;
            let force = match request.get("force") {
                None => false,
                Some(Value::Bool(force)) => *force,
                Some(_) => return None,
            };
            if !has_content {
                return None;
            }
            Mutation::Existing(Existing::Write {
                expected_mtime_ms: request.get("expectedMtimeMs")?.as_f64()?,
                force,
            })
        }
        _ => return None,
    })
}

/// One path segment a person typed: no separators, no `.`/`..`, no control characters, nothing to trim, at most
/// 255 UTF-16 units.
fn valid_entry_name(name: &str) -> bool {
    let units = name.encode_utf16().count();
    js_trim(name) == name
        && units > 0
        && units <= 255
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
}

fn is_separator(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// `path.join(dir, name)` for a resolved folder and a valid entry name.
fn join(dir: &str, name: &str) -> String {
    if dir.ends_with(is_separator) {
        format!("{dir}{name}")
    } else {
        format!("{dir}{MAIN_SEPARATOR}{name}")
    }
}

/// `path.join(path.dirname(entry), name)`: the sibling `name` of a resolved entry that is not a root.
fn sibling(entry: &str, name: &str) -> String {
    let parent = entry.rfind(is_separator).map_or(0, |at| at + 1);
    format!("{}{name}", &entry[..parent])
}

/// Whether canonical `path` is `root` or lies under it, by whole components: `/ab` is not under `/a`, and every
/// path of the volume is under a root that is the volume's own (`/`, `C:\`), whose spelling already ends in a
/// separator (the TypeScript appended one more and so refused every save in such a workspace).
fn within(root: &std::path::Path, path: &std::path::Path) -> bool {
    path.starts_with(root)
}

/// A canonical path as node's `realpath` spells it (libuv drops Windows' `\\?\` prefix), for messages.
fn spelled(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Done {
    /// The created, renamed, written or to-be-trashed entry.
    abs: String,
    /// Main moves `abs` to the trash.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    trash: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<f64>,
}

fn done(abs: String) -> Result<Reply, Fault> {
    Reply::json(&Done {
        abs,
        trash: false,
        mtime_ms: None,
    })
}

fn escapes() -> Fault {
    Fault::new("path_escapes_workspace", "Path escapes the workspace")
}

fn invalid_name() -> Fault {
    Fault::new("invalid_name", "Invalid name")
}

fn fs_fault(error: NodeError) -> Fault {
    error.fault(Codes::Fs)
}

/// An empty file (never over an existing one) or a folder named `name` in `parent`.
fn create(parent: Option<String>, folder: bool, name: &str) -> Result<Reply, Fault> {
    if !valid_entry_name(name) {
        return Err(invalid_name());
    }
    let dir = parent.ok_or_else(escapes)?;
    if !disk::stat(&dir).map_err(fs_fault)?.is_dir() {
        return Err(Fault::new("not_a_directory", "Not a directory"));
    }
    let abs = join(&dir, name);
    if folder {
        std::fs::create_dir(&abs)
            .map_err(|error| fs_fault(NodeError::new(&error, "mkdir", Some(&abs))))?;
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&abs)
            .map_err(|error| fs_fault(NodeError::new(&error, "open", Some(&abs))))?;
    }
    done(abs)
}

pub fn mutate(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let Some(mutation) = parse(&params.request, call.bin.is_some()) else {
        return Err(Fault::new("invalid_path", "Invalid file operation"));
    };
    let existing = match mutation {
        Mutation::Create { folder, name } => return create(params.resolved, folder, &name),
        Mutation::Existing(existing) => existing,
    };
    let source = params.resolved.ok_or_else(escapes)?;
    if source == params.root {
        return Err(Fault::new(
            "invalid_path",
            "The project folder itself can't change here",
        ));
    }
    if disk::lstat(&source).is_err() {
        return Err(Fault::new("file_not_found", "File not found"));
    }
    match existing {
        Existing::Trash => Reply::json(&Done {
            abs: source,
            trash: true,
            mtime_ms: None,
        }),
        Existing::Write {
            expected_mtime_ms,
            force,
        } => {
            // Through a symlink only when its target is inside the project too.
            let real_root = disk::realpath(&params.root).map_err(fs_fault)?;
            let real_source = disk::realpath(&source).map_err(fs_fault)?;
            if !within(&real_root, &real_source) {
                return Err(escapes());
            }
            let real = spelled(&real_source);
            let before = std::fs::metadata(&real_source)
                .map_err(|error| fs_fault(NodeError::new(&error, "stat", Some(&real))))?;
            if !before.is_file() {
                return Err(Fault::new("not_a_file", "Not a file"));
            }
            let content = call.bin.unwrap_or_default();
            if content.len() as u64 > params.max_write_bytes {
                return Err(Fault::new(
                    "file_too_large",
                    "The file is too large to save here",
                ));
            }
            if !force && disk::mtime_ms(&before) != expected_mtime_ms {
                return Err(Fault::new(
                    "changed_on_disk",
                    "The file changed on disk since it was opened",
                ));
            }
            // In place, so the file keeps its mode, owner, links and any open handles.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&real_source)
                .map_err(|error| fs_fault(NodeError::new(&error, "open", Some(&real))))?;
            std::io::Write::write_all(&mut file, &content)
                .map_err(|error| fs_fault(NodeError::new(&error, "write", None)))?;
            drop(file);
            let after = std::fs::metadata(&real_source)
                .map_err(|error| fs_fault(NodeError::new(&error, "stat", Some(&real))))?;
            Reply::json(&Done {
                abs: source,
                trash: false,
                mtime_ms: Some(disk::mtime_ms(&after)),
            })
        }
        Existing::Rename { name } => {
            if !valid_entry_name(&name) {
                return Err(invalid_name());
            }
            let target = sibling(&source, &name);
            if target == source {
                return done(source);
            }
            // A case-only rename finds the source itself on a case-insensitive disk; anything else there is taken.
            if disk::lstat(&target).is_ok() {
                let from = disk::lstat(&source).map_err(fs_fault)?;
                let to = disk::lstat(&target).map_err(fs_fault)?;
                if !disk::same_entry(&from, &to, &source, &target) {
                    return Err(Fault::new("exists", "A file with that name already exists"));
                }
            }
            std::fs::rename(&source, &target).map_err(|error| {
                fs_fault(NodeError::with_dest(
                    &error,
                    "rename",
                    Some(&source),
                    Some(&target),
                ))
            })?;
            done(target)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names_as_the_typescript_did() {
        for good in ["a.ts", "...", "a b", "é", "😀", &"x".repeat(255)] {
            assert!(valid_entry_name(good), "{good:?}");
        }
        for bad in [
            "",
            ".",
            "..",
            " x",
            "x\u{feff}",
            "a/b",
            "a\\b",
            "a\u{7}",
            "a\u{85}b",
            &"x".repeat(256),
            &"😀".repeat(128),
        ] {
            assert!(!valid_entry_name(bad), "{bad:?}");
        }
        assert!(valid_entry_name(&"😀".repeat(127)));
    }

    #[test]
    fn accepts_what_the_schema_accepted() {
        let ok = |request: Value, content: bool| parse(&request, content).is_some();
        assert!(ok(
            serde_json::json!({"op": "createFile", "parent": "", "name": "x", "extra": 1}),
            false
        ));
        assert!(ok(serde_json::json!({"op": "trash", "path": "a"}), false));
        assert!(ok(
            serde_json::json!({"op": "write", "path": "a", "expectedMtimeMs": 1.5}),
            true
        ));
        assert!(!ok(
            serde_json::json!({"op": "write", "path": "a", "expectedMtimeMs": 1.5}),
            false
        ));
        assert!(!ok(
            serde_json::json!({"op": "write", "path": "a", "expectedMtimeMs": 1, "force": null}),
            true
        ));
        assert!(!ok(serde_json::json!({"op": "rename", "path": "a"}), false));
        assert!(!ok(serde_json::json!({"op": "delete", "path": "a"}), false));
        assert!(!ok(serde_json::json!(["op"]), false));
        assert!(!ok(
            serde_json::json!({"op": "createFile", "parent": 1, "name": "x"}),
            false
        ));
    }

    #[cfg(unix)]
    #[test]
    fn joins_as_node_path_does() {
        assert_eq!(join("/w", "a"), "/w/a");
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(sibling("/w/src/a.ts", "b.ts"), "/w/src/b.ts");
        assert_eq!(sibling("/a", "b"), "/b");
    }

    #[test]
    fn a_write_stays_within_the_workspace_by_whole_components() {
        use std::path::Path;
        #[cfg(unix)]
        let cases = [
            ("/w", "/w", true),
            ("/w", "/w/a.txt", true),
            ("/w", "/w/src/a.txt", true),
            ("/w", "/wide/a.txt", false),
            ("/w", "/a.txt", false),
            ("/w/src", "/w/a.txt", false),
            // A workspace that is the volume's root: its spelling ends in the separator already.
            ("/", "/a.txt", true),
            ("/", "/etc/hosts", true),
        ];
        #[cfg(windows)]
        let cases = [
            (r"C:\w", r"C:\w\a.txt", true),
            (r"C:\w", r"C:\wide\a.txt", false),
            (r"C:\w", r"D:\w\a.txt", false),
            (r"C:\", r"C:\a.txt", true),
            (r"\\?\C:\", r"\\?\C:\Users\a.txt", true),
            (r"\\?\C:\w", r"\\?\C:\wide\a.txt", false),
        ];
        for (root, path, expected) in cases {
            assert_eq!(
                within(Path::new(root), Path::new(path)),
                expected,
                "{root} {path}"
            );
        }
    }
}
