use std::path::Path;

use serde_json::{Map, Value, json};

use crate::git::{read, repo_lock, run::Git, worktree};
use crate::local_dispatch::{protocol::CommandError, session::Session};
use crate::pool::application::Sidecar;
use crate::run::Runner;
use crate::server::{Fault, Scope};

fn local_fault(error: Fault) -> CommandError {
    match error.code.as_ref() {
        "not_a_repo"
        | "invalid_base"
        | "invalid_name"
        | "worktree_create_failed"
        | "not_a_worktree"
        | "worktree_dirty"
        | "worktree_remove_failed" => CommandError::local(error.code.to_string(), error.message),
        _ => error.into(),
    }
}

fn slug(raw: &str) -> Option<String> {
    if !raw
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-')
    {
        return None;
    }
    let mut out = String::new();
    let mut dash = false;
    for ch in raw.trim().bytes() {
        if ch == b' ' || ch == b'-' {
            dash = !out.is_empty();
        } else {
            if dash {
                out.push('-');
                dash = false;
            }
            out.push((ch as char).to_ascii_lowercase());
        }
    }
    (!out.is_empty() && out.len() <= 41).then_some(out)
}

fn prefix(raw: &str) -> Option<&str> {
    let p = crate::fs::order::js_trim(raw);
    if p.is_empty()
        || p.len() > 40
        || p.starts_with('-')
        || p.contains("..")
        || !p.ends_with(['/', '_', '-'])
        || !p
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
    {
        return None;
    }
    let mut parts = p.split('/').peekable();
    while let Some(part) = parts.next() {
        if part.starts_with('.')
            || (parts.peek().is_some() && (part.is_empty() || part.ends_with(".lock")))
        {
            return None;
        }
    }
    Some(p)
}

pub(super) struct Location {
    pub root: String,
    pub hash: String,
}

pub(super) async fn location<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    session: &Session<S>,
    primary: &str,
) -> Result<Location, CommandError> {
    let value = session
        .bridge("git.worktree_location", json!({"primaryRoot":primary}))
        .await?;
    let root = value
        .get("root")
        .and_then(Value::as_str)
        .filter(|p| Path::new(p).is_absolute());
    let hash = value.get("hash").and_then(Value::as_str).filter(|h| {
        h.len() == 7
            && h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    match (root, hash) {
        (Some(root), Some(hash)) => Ok(Location {
            root: root.to_owned(),
            hash: hash.to_owned(),
        }),
        _ => Err(CommandError::Other(
            "omp returned an invalid worktree location".into(),
        )),
    }
}

pub async fn create<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    session: &Session<S>,
    runner: Runner,
    prepare: &super::prepare::Config,
    scope: Scope,
    params: &Map<String, Value>,
) -> Result<Value, CommandError> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let slug = slug(name).ok_or_else(|| CommandError::local("invalid_name", format!("Invalid worktree name \"{name}\" — use 1-41 chars of [a-z0-9-], starting with a letter or digit.")))?;
    let raw_prefix = params.get("branchPrefix");
    let branch_prefix = match raw_prefix {
        Some(Value::String(value)) => prefix(value).ok_or_else(|| {
            CommandError::local(
                "invalid_name",
                format!("Invalid worktree branch prefix \"{value}\"."),
            )
        })?,
        _ => "omp/gui/",
    }
    .to_owned();
    let cwd = session.cwd();
    let base = params
        .get("baseCwd")
        .and_then(Value::as_str)
        .unwrap_or(&cwd)
        .to_owned();
    let directory = base.clone();
    if !read::blocking(move || std::fs::metadata(directory).is_ok_and(|meta| meta.is_dir())).await?
    {
        return Err(CommandError::local(
            "file_not_found",
            format!("The folder \"{base}\" does not exist."),
        ));
    }
    let git = Git::new(runner.clone(), scope.clone());
    let base_ref = params
        .get("baseRef")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let plan = worktree::plan(&git, &base, base_ref)
        .await
        .map_err(local_fault)?;
    let primary = plan.primary;
    let (given, main_path) = (base.clone(), primary.clone());
    let main = read::blocking(move || {
        match (
            crate::fs::disk::realpath(&given),
            crate::fs::disk::realpath(&main_path),
        ) {
            (Ok(a), Ok(b))
                if if cfg!(windows) {
                    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
                } else {
                    a == b
                } =>
            {
                std::env::current_dir()
                    .map(|cwd| read::resolve(&crate::fs::disk::spelled(&cwd), &given))
                    .map_err(|error| Fault::new("io", error.to_string()))
            }
            _ => Ok(main_path),
        }
    })
    .await??;
    let Location { root, hash } = location(session, &primary).await?;
    let branch = params.get("branch").and_then(|value| {
        let name = value.get("name")?.as_str()?;
        let mode = value.get("mode")?.as_str()?;
        if name.is_empty() || !["new", "local", "remote"].contains(&mode) {
            return None;
        }
        if mode == "remote"
            && !value
                .get("remote")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty() && !s.starts_with('-'))
        {
            return None;
        }
        if value.get("from").is_some_and(|v| {
            !v.as_str()
                .is_some_and(|s| !s.is_empty() && !s.starts_with('-'))
        }) {
            return None;
        }
        let source = worktree::Source {
            name: name.to_owned(),
            mode: match mode {
                "new" => worktree::Mode::New,
                "local" => worktree::Mode::Local,
                _ => worktree::Mode::Remote,
            },
            remote: value
                .get("remote")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
            from: value
                .get("from")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
        };
        Some((source, name.to_owned()))
    });
    let primary_for_lock = primary.clone();
    let locked_runner = runner.clone();
    let result = repo_lock::run(&primary, scope.clone(), move |locked| async move {
        let git = Git::new(locked_runner, locked.clone());
        for suffix in 1..=100 {
            if locked.cancelled() {
                return Err(Fault::cancelled());
            }
            let candidate = if suffix == 1 {
                slug.clone()
            } else {
                format!("{slug}-{suffix}")
            };
            let path = Path::new(&root).join(format!("gui-{candidate}-{hash}"));
            let check = path.clone();
            if read::blocking(move || std::fs::metadata(check).is_ok()).await? {
                continue;
            }
            let path = path.to_string_lossy().into_owned();
            let (directory, held) = (root.clone(), locked.clone());
            read::blocking(move || {
                if held.cancelled() {
                    return Err(Fault::cancelled());
                }
                std::fs::create_dir_all(directory).map_err(|error| {
                    Fault::new(
                        "worktree_create_failed",
                        format!("Failed to create worktree: {error}"),
                    )
                })
            })
            .await??;
            let made_branch = if let Some((source, name)) = &branch {
                worktree::add_named(&git, &primary_for_lock, &base, &path, source, 300_000)
                    .await
                    .map(|_| name.clone())
            } else {
                let name = format!("{branch_prefix}{candidate}");
                match worktree::add(
                    &git,
                    &primary_for_lock,
                    &base,
                    &path,
                    &name,
                    &plan.start_point,
                    300_000,
                )
                .await
                {
                    Ok(added) if added.taken => continue,
                    Ok(_) => Ok(name),
                    Err(error) => Err(error),
                }
            };
            return made_branch.map(|branch| (path, branch)).map_err(|error| {
                if matches!(
                    error.code.as_ref(),
                    "invalid_name" | "worktree_create_failed" | "cancelled"
                ) {
                    error
                } else {
                    Fault::new(
                        "worktree_create_failed",
                        format!("Failed to create worktree: {}", error.message),
                    )
                }
            });
        }
        Err(Fault::new(
            "worktree_create_failed",
            "No available worktree name after 100 attempts",
        ))
    })
    .await
    .map_err(local_fault)?;
    let prepared = super::prepare::prepare(&runner, prepare, scope, &primary, &result.0)
        .await
        .map_err(CommandError::from)?;
    let mut response = json!({"path":result.0,"branch":result.1,"baseCwd":main});
    let preparation =
        serde_json::to_value(prepared).map_err(|error| CommandError::Other(error.to_string()))?;
    if let (Some(response), Some(preparation)) = (response.as_object_mut(), preparation.as_object())
    {
        response.extend(preparation.clone());
    }
    Ok(response)
}

pub async fn remove<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    session: &Session<S>,
    runner: Runner,
    scope: Scope,
    params: &Map<String, Value>,
) -> Result<Value, CommandError> {
    let cwd = session.cwd();
    let cwd = read::blocking(move || {
        std::env::current_dir()
            .map(|base| read::resolve(&crate::fs::disk::spelled(&base), &cwd))
            .map_err(|error| Fault::new("io", error.to_string()))
    })
    .await??;
    let Location { root, .. } = location(session, &cwd).await?;
    let path = params.get("path").and_then(Value::as_str).unwrap_or("");
    let (root_to_check, path_to_check) = (root.clone(), path.to_owned());
    let real = read::blocking(move || {
        if !Path::new(&path_to_check).is_absolute() {
            return None;
        }
        match (
            crate::fs::disk::realpath(&root_to_check),
            crate::fs::disk::realpath(&path_to_check),
        ) {
            (Ok(root), Ok(path)) if super::claims::strictly_inside(&root, &path) => Some(path),
            _ => None,
        }
    })
    .await?;
    let path = real.ok_or_else(|| CommandError::local("worktree_outside_root", format!("Refusing to remove {}: only registered linked worktrees under {root} can be removed (check worktree.base).", if path.is_empty() { "(no path)" } else { path })))?;
    let path = crate::fs::disk::spelled(&path);
    let git = Git::new(runner.clone(), scope.clone());
    let primary = worktree::removal(&git, &path, params.get("force") == Some(&Value::Bool(true)))
        .await
        .map_err(local_fault)?
        .primary;
    let key = primary.clone();
    repo_lock::run(&key, scope, move |scope| async move {
        worktree::remove(&Git::new(runner, scope), &primary, &path, 120_000)
            .await
            .map(|_| ())
    })
    .await
    .map_err(local_fault)?;
    Ok(json!({"removed":true}))
}

#[cfg(test)]
#[path = "checkout_tests.rs"]
pub(super) mod tests;
