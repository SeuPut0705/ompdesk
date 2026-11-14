use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// Runtime-owned facts from the authenticated caller and tab registry. Never page JSON.
#[derive(Clone, Debug)]
pub struct PathContext {
    pub remote: bool,
    pub cwd: Option<String>,
    pub home: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathRefusal {
    Remote,
    Empty,
    NoWorkspace,
    EscapesWorkspace,
    Missing,
}

#[derive(Serialize)]
pub struct RefusedPath {
    pub ok: bool,
    pub error: &'static str,
    pub code: &'static str,
}

impl PathRefusal {
    pub fn response(self) -> RefusedPath {
        let (error, code) = match self {
            Self::Remote => ("The file is on another device", "remote_path_native"),
            Self::Empty => ("Empty path", "empty_path"),
            Self::NoWorkspace => ("No workspace", "no_workspace"),
            Self::EscapesWorkspace => ("Path escapes the workspace", "path_escapes_workspace"),
            Self::Missing => ("File not found", "file_not_found"),
        };
        RefusedPath {
            ok: false,
            error,
            code,
        }
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other),
        }
    }
    result
}

fn join_workspace(root: &Path, target: &Path) -> PathBuf {
    // Windows' C:relative resolves against the supplied workspace on that drive, not the process's cwd.
    #[cfg(windows)]
    if let Some(Component::Prefix(prefix)) = target.components().next() {
        if !target.has_root()
            && root.components().next().is_some_and(|part| {
                part.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&prefix.as_os_str().to_string_lossy())
            })
        {
            let mut remainder = target.components();
            remainder.next();
            return root.join(remainder.as_path());
        }
    }
    root.join(target)
}

/// `ipc.ts`'s existingLocalPath, before invoking any OS service. Relative paths are lexically confined, as before;
/// symlinks are not canonicalized here because absolute paths outside the workspace are allowed too.
pub fn existing_local_path(target: &Value, context: &PathContext) -> Result<PathBuf, PathRefusal> {
    checked_path(target, context, |path| path.try_exists().unwrap_or(false))
}

fn checked_path(
    target: &Value,
    context: &PathContext,
    exists: impl FnOnce(&Path) -> bool,
) -> Result<PathBuf, PathRefusal> {
    if context.remote {
        return Err(PathRefusal::Remote);
    }
    let target = target
        .as_str()
        .filter(|text| !text.trim_matches(super::js_whitespace).is_empty())
        .ok_or(PathRefusal::Empty)?;
    let mut resolved = match target.strip_prefix("~/") {
        Some(relative) => {
            let mut joined = context.home.clone().into_os_string();
            joined.push(std::path::MAIN_SEPARATOR_STR);
            joined.push(relative);
            normalize(Path::new(&joined))
        }
        None => PathBuf::from(target),
    };
    if !resolved.has_root() {
        let root = context.cwd.as_deref().ok_or(PathRefusal::NoWorkspace)?;
        resolved = normalize(&join_workspace(Path::new(root), &resolved));
        // Keep Node's case-sensitive comparison on Windows too; a different drive is outside the workspace.
        let text = resolved.to_string_lossy();
        let separator = std::path::MAIN_SEPARATOR;
        let prefix = if root.ends_with(separator) {
            root.to_owned()
        } else {
            format!("{root}{separator}")
        };
        if text != root && !text.starts_with(&prefix) {
            return Err(PathRefusal::EscapesWorkspace);
        }
    }
    if !exists(&resolved) {
        return Err(PathRefusal::Missing);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_path_results_match_the_original_handler() {
        let captured: Value = serde_json::from_str(include_str!("boundary-captured.json")).unwrap();
        let platform = if cfg!(windows) { "win32" } else { "posix" };
        for row in captured["localPath"].as_array().unwrap() {
            if row["platform"] != platform {
                continue;
            }
            let facts = &row["context"];
            let context = PathContext {
                remote: facts["remote"].as_bool().unwrap(),
                cwd: facts["cwd"].as_str().map(String::from),
                home: PathBuf::from(facts["home"].as_str().unwrap()),
            };
            let result = checked_path(&row["target"], &context, |path| {
                row["existing"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| Path::new(value.as_str().unwrap()) == path)
            });
            let result = match result {
                Ok(path) => json!({ "ok": true, "path": path }),
                Err(reason) => serde_json::to_value(reason.response()).unwrap(),
            };
            assert_eq!(result, row["result"], "{row}");
        }
    }

    #[test]
    fn remote_refusal_precedes_all_path_processing() {
        let context = PathContext {
            remote: true,
            cwd: None,
            home: PathBuf::new(),
        };
        for target in [Value::Null, json!(""), json!("/etc/passwd")] {
            assert_eq!(
                existing_local_path(&target, &context),
                Err(PathRefusal::Remote)
            );
        }
        assert_eq!(PathRefusal::Remote.response().code, "remote_path_native");
    }

    #[test]
    fn invalid_or_relative_targets_need_a_local_workspace() {
        let context = PathContext {
            remote: false,
            cwd: None,
            home: PathBuf::new(),
        };
        for target in [Value::Null, json!(42), json!(" \n")] {
            assert_eq!(
                existing_local_path(&target, &context),
                Err(PathRefusal::Empty)
            );
        }
        assert_eq!(
            existing_local_path(&json!("readme.md"), &context),
            Err(PathRefusal::NoWorkspace)
        );
    }

    #[test]
    fn relative_escapes_are_refused_before_disk_access() {
        let cwd = std::env::current_dir().unwrap();
        let context = PathContext {
            remote: false,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            home: cwd,
        };
        for target in ["../outside", "a/../../outside", "../sibling/a.txt"] {
            assert_eq!(
                existing_local_path(&json!(target), &context),
                Err(PathRefusal::EscapesWorkspace)
            );
        }
        assert_eq!(
            existing_local_path(&json!("missing\0.txt"), &context),
            Err(PathRefusal::Missing)
        );
        assert_eq!(
            existing_local_path(&json!("."), &context).unwrap(),
            context.home
        );
        assert_eq!(
            existing_local_path(&json!("~/"), &context).unwrap(),
            context.home
        );
    }
}
