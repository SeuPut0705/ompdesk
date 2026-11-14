use std::sync::Arc;

use ompdesk_app_contract::Owner;
use serde_json::{Value, json};

use crate::fs::disk;
use crate::git::{orphans, read, repo_lock, run::Git};
use crate::local_dispatch::{protocol::CommandError, session::Session};
use crate::pool::application::{
    Sidecar,
    native::{Host, Service as NativePool},
};
use crate::run::Runner;
use crate::server::{Fault, Scope};
use crate::worktree_lifecycle::{Folder, RemovalClaims};

use super::{checkout, saved};

struct Listing {
    root: String,
    worktrees: Vec<orphans::Orphan>,
    in_use: Vec<String>,
}

fn command_fault(fault: Fault) -> CommandError {
    match fault.code.as_ref() {
        "not_a_repo" | "in_use" | "not_orphan" | "not_removable" => {
            CommandError::local(fault.code.to_string(), fault.message)
        }
        _ => fault.into(),
    }
}

async fn primary(runner: &Runner, scope: Scope, cwd: &str) -> Result<String, Fault> {
    let git = Git::new(runner.clone(), scope);
    if read::repo_root(&git, cwd).await?.is_none() {
        return Err(Fault::new(
            "not_a_repo",
            format!("Not a git repository: {cwd}"),
        ));
    }
    read::primary_root(&git, cwd).await
}

async fn listing<S: Sidecar<Error = Fault> + ?Sized + 'static>(
    session: &Session<S>,
    runner: Runner,
    scope: Scope,
    primary: &str,
    folders: Vec<Folder>,
    only: Option<String>,
) -> Result<Listing, Fault> {
    let location = checkout::location(session, primary)
        .await
        .map_err(|error| Fault::new("worktree_bridge", error.to_string()))?;
    let root = location.root;
    let resolve = root.clone();
    let actual_root = read::blocking(move || {
        disk::realpath(&resolve)
            .ok()
            .map(|path| disk::spelled(&path))
    })
    .await?;
    let Some(actual_root) = actual_root else {
        return Ok(Listing {
            root,
            worktrees: Vec::new(),
            in_use: Vec::new(),
        });
    };
    let git = Git::new(runner, scope);
    let candidates = orphans::candidates(
        &git,
        primary,
        Some(actual_root),
        folders
            .into_iter()
            .map(|folder| folder.path().to_owned())
            .collect(),
        only,
    )
    .await?;
    let worktrees = orphans::inspect(&git, primary, &candidates.candidates).await?;
    Ok(Listing {
        root,
        worktrees,
        in_use: candidates.in_use,
    })
}

pub async fn list<H: Host>(
    pool: &NativePool<H>,
    owner: &Owner,
    session: &Session<H::Sidecar>,
    runner: Runner,
    scope: Scope,
) -> Result<Value, CommandError> {
    let primary = primary(&runner, scope.clone(), &session.cwd())
        .await
        .map_err(command_fault)?;
    let folders = pool.worktree_folders(owner).await?;
    let found = listing(session, runner, scope, &primary, folders, None)
        .await
        .map_err(command_fault)?;
    Ok(json!({"root":found.root,"worktrees":found.worktrees}))
}

pub async fn remove<H: Host>(
    pool: Arc<NativePool<H>>,
    owner: Owner,
    session: Session<H::Sidecar>,
    runner: Runner,
    scope: Scope,
    store: Arc<saved::SavedStore>,
    claims: Arc<RemovalClaims>,
    path: String,
) -> Result<Value, CommandError> {
    let primary = primary(&runner, scope.clone(), &session.cwd())
        .await
        .map_err(command_fault)?;
    let locked_primary = primary.clone();
    repo_lock::run(&primary, scope, move |scope| async move {
        let wanted = if path.is_empty() { String::new() } else { Folder::resolve(path.clone()).await?.path().to_owned() };
        let folders = pool.worktree_folders(&owner).await?;
        let found = listing(&session, runner.clone(), scope.clone(), &locked_primary, folders, Some(wanted.clone())).await?;
        let Some(entry) = found.worktrees.into_iter().find(|entry| entry.path == wanted) else {
            if found.in_use.contains(&wanted) {
                return Err(Fault::new("in_use", format!("{wanted} is in use by an open session; nothing was removed.")));
            }
            return Err(Fault::new("not_orphan", format!(
                "{} is not an orphaned worktree of this repository: it is in use, outside the worktree root, not made by OMPdesk, or already gone.",
                if path.is_empty() { "(no path)" } else { &path }
            )));
        };
        if !matches!(&entry.state, orphans::State::Landed | orphans::State::Untouched) {
            let state = if matches!(&entry.state, orphans::State::Dirty) {
                format!("dirty ({} uncommitted or untracked file(s))", entry.dirty_files)
            } else { format!("unlanded ({} commit(s) nothing holds)", entry.commits_ahead) };
            return Err(Fault::new("not_removable", format!(
                "{} is {state}; only a landed or untouched worktree is removed.", entry.path
            )));
        }
        let _claim = pool.claim_worktree(&owner, Folder::resolve(entry.path.clone()).await?, claims).await?;
        let archive = match saved::archive_before_remove(&store, runner.clone(), scope.clone(),
            &entry.path, &entry.repo, entry.branch.as_deref()).await {
            Err(error) if error.code == "keep_worktree" => return Err(Fault::new("not_removable", format!("{} was kept: {}.", entry.path, error.message))),
            other => other?,
        };
        let removed = orphans::remove(&Git::new(runner, scope.clone()), &locked_primary,
            &entry.path, entry.branch, false).await;
        if let Some(record) = archive {
            // Even a failing git can have deleted some files. Keep its archive unless it is intact.
            saved::settle(&store, scope, record, matches!(&removed, Ok(Some(_)))).await?;
        }
        let Some(removal) = removed? else {
            return Err(Fault::new("not_removable", format!(
                "{} changed or git refused to remove it; nothing was removed.", entry.path
            )));
        };
        Ok(json!({"removal":removal}))
    }).await.map_err(command_fault)
}

#[cfg(test)]
#[path = "orphans_tests.rs"]
mod tests;
