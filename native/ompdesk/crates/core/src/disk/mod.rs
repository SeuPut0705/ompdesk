//! Disk care's disk work and gits (was the logic of `src/main/disk/`): folder sizes and the reading kept between runs
//! (`sizes`), which ignored paths a project makes again (`regenerable`), a worktree's facts (`facts`), and saving,
//! archiving, restoring and dropping (`saved`), each step one request main sends (`disk.*`). Main keeps the order of
//! the steps, its state (the saved records, the last run), what is in use (open tabs, the removal claim), the secret
//! check (the central redactor is TypeScript), the repository lock around each step, and where things are (the user
//! data folder, the home, the session folders, the bun cache). A request that runs git carries main's runner (`git`);
//! a cancelled request starts no more disk work and no git, and answers only once the call the system already has
//! returned and every git it ran exited (`tree::live`, each worker holds the request's scope).

mod facts;
mod regenerable;
mod saved;
mod sizes;
pub(crate) mod tree;

use serde::{Deserialize, Serialize};

use crate::git::read::blocking;
use crate::git::run::Git;
use crate::run::Runner;
use crate::server::{Registry, Reply};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    file: String,
    /// Main's clock (tests move it).
    now: f64,
    full_walk_every_ms: f64,
}

#[derive(Serialize)]
struct Opened {
    reading: u64,
    reused: bool,
}

/// `reading` none: a full walk that keeps nothing. `path` resolved by main.
#[derive(Deserialize)]
struct BytesParams {
    reading: Option<u64>,
    path: String,
    reuse: bool,
}

#[derive(Serialize)]
struct Measured {
    bytes: u64,
    lstat: u64,
    readdir: u64,
}

#[derive(Deserialize)]
struct SaveSizesParams {
    reading: u64,
    now: f64,
}

#[derive(Deserialize)]
struct WorktreeParams {
    git: Runner,
    worktree: String,
}

#[derive(Deserialize)]
struct ActivityParams {
    git: Runner,
    worktree: String,
    stamps: Vec<String>,
    ignored: Vec<String>,
    sessions: Option<String>,
}

#[derive(Deserialize)]
struct DropParams {
    worktree: String,
    entries: Vec<saved::Droppable>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckParams {
    git: Runner,
    worktree: String,
    untracked_files: Vec<String>,
    exclude: Vec<String>,
}

#[derive(Deserialize)]
struct BlobParams {
    git: Runner,
    worktree: String,
    path: String,
}

#[derive(Serialize)]
struct Complete {
    complete: bool,
}

#[derive(Deserialize)]
struct WorkParams {
    git: Runner,
    #[serde(flatten)]
    save: saved::Save,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RollbackParams {
    git: Runner,
    primary: String,
    branch: Option<String>,
    sha: Option<String>,
    archive_dir: String,
}

#[derive(Deserialize)]
struct RemoveParams {
    git: Runner,
    primary: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveParams {
    git: Runner,
    worktree: String,
    entries: Vec<String>,
    archive_dir: String,
}

#[derive(Serialize)]
struct ArchiveDone {
    files: usize,
    bytes: u64,
    head: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveAtParams {
    worktree: String,
    archive_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForgetParams {
    archive_dir: String,
}

#[derive(Deserialize)]
struct CheckoutParams {
    git: Runner,
    #[serde(flatten)]
    record: saved::Checkout,
}

#[derive(Serialize)]
struct Restored {
    restored: usize,
    skipped: usize,
}

pub fn register(registry: &mut Registry) {
    registry.add("disk.sizesOpen", |call| {
        Box::pin(async move {
            let OpenParams {
                file,
                now,
                full_walk_every_ms,
            } = call.params()?;
            let (reading, reused) =
                blocking(move || sizes::open(std::path::Path::new(&file), now, full_walk_every_ms))
                    .await?;
            Reply::json(&Opened { reading, reused })
        })
    });
    registry.add("disk.sizesBytes", |call| {
        Box::pin(async move {
            let BytesParams {
                reading,
                path,
                reuse,
            } = call.params()?;
            let scope = call.scope;
            let walked = blocking(move || sizes::bytes(reading, &path, reuse, &scope)).await??;
            Reply::json(&Measured {
                bytes: walked.bytes,
                lstat: walked.work.lstat,
                readdir: walked.work.readdir,
            })
        })
    });
    registry.add("disk.sizesSave", |call| {
        Box::pin(async move {
            let SaveSizesParams { reading, now } = call.params()?;
            let scope = call.scope;
            blocking(move || sizes::save(reading, now, &scope)).await??;
            Reply::json(&())
        })
    });
    registry.add("disk.processFolders", |call| {
        Box::pin(async move { Reply::json(&facts::process_folders(&call.scope).await?) })
    });
    registry.add("disk.worktreeFiles", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&facts::files(&git, &worktree).await?)
        })
    });
    registry.add("disk.inProgress", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&facts::in_progress(&git, &worktree).await?)
        })
    });
    registry.add("disk.head", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&facts::head(&git, &worktree).await?)
        })
    });
    registry.add("disk.lastActivity", |call| {
        Box::pin(async move {
            let ActivityParams {
                git,
                worktree,
                stamps,
                ignored,
                sessions,
            } = call.params()?;
            let scope = call.scope.clone();
            let git = Git::new(git, call.scope);
            let activity = facts::Activity {
                stamps,
                ignored,
                sessions,
            };
            Reply::json(&facts::last_activity(&git, &worktree, activity, &scope).await?)
        })
    });
    registry.add("disk.dropArtifacts", |call| {
        Box::pin(async move {
            let DropParams { worktree, entries } = call.params()?;
            let scope = call.scope;
            Reply::json(&blocking(move || saved::drop_entries(&worktree, entries, &scope)).await??)
        })
    });
    registry.add("disk.saveCheck", |call| {
        Box::pin(async move {
            let CheckParams {
                git,
                worktree,
                untracked_files,
                exclude,
            } = call.params()?;
            let scope = call.scope.clone();
            let git = Git::new(git, call.scope);
            Reply::json(&saved::check(&git, &worktree, untracked_files, exclude, &scope).await?)
        })
    });
    registry.add("disk.stagedBlob", |call| {
        Box::pin(async move {
            let BlobParams {
                git,
                worktree,
                path,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            let (complete, bytes) = saved::staged_blob(&git, &worktree, &path).await?;
            Ok(Reply::json(&Complete { complete })?.with_bin(bytes))
        })
    });
    registry.add("disk.saveWork", |call| {
        Box::pin(async move {
            let WorkParams { git, save } = call.params()?;
            let scope = call.scope.clone();
            let git = Git::new(git, call.scope);
            Reply::json(&saved::work(&git, save, &scope).await?)
        })
    });
    registry.add("disk.saveRollback", |call| {
        Box::pin(async move {
            let RollbackParams {
                git,
                primary,
                branch,
                sha,
                archive_dir,
            } = call.params()?;
            let scope = call.scope.clone();
            let git = Git::new(git, call.scope);
            saved::rollback(
                &git,
                &primary,
                branch.as_deref(),
                sha.as_deref(),
                &archive_dir,
                &scope,
            )
            .await;
            Reply::json(&())
        })
    });
    registry.add("disk.forceRemove", |call| {
        Box::pin(async move {
            let RemoveParams { git, primary, path } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&saved::force_remove(&git, &primary, &path).await?)
        })
    });
    registry.add("disk.archive", |call| {
        Box::pin(async move {
            let ArchiveParams {
                git,
                worktree,
                entries,
                archive_dir,
            } = call.params()?;
            let scope = call.scope.clone();
            let git = Git::new(git, call.scope);
            let done = saved::archive(&git, worktree, entries, archive_dir, &scope)
                .await?
                .map(|(files, bytes, head)| ArchiveDone { files, bytes, head });
            Reply::json(&done)
        })
    });
    registry.add("disk.settleArchive", |call| {
        Box::pin(async move {
            let ArchiveAtParams {
                worktree,
                archive_dir,
            } = call.params()?;
            let scope = call.scope;
            Reply::json(&blocking(move || saved::settle(&worktree, &archive_dir, &scope)).await??)
        })
    });
    registry.add("disk.restoreCheckout", |call| {
        Box::pin(async move {
            let CheckoutParams { git, record } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&saved::checkout(&git, record).await?)
        })
    });
    registry.add("disk.restoreFiles", |call| {
        Box::pin(async move {
            let ArchiveAtParams {
                worktree,
                archive_dir,
            } = call.params()?;
            let scope = call.scope;
            let (restored, skipped) =
                blocking(move || saved::restore(&worktree, &archive_dir, &scope)).await??;
            Reply::json(&Restored { restored, skipped })
        })
    });
    registry.add("disk.forgetArchive", |call| {
        Box::pin(async move {
            let ForgetParams { archive_dir } = call.params()?;
            let scope = call.scope;
            blocking(move || saved::forget(&archive_dir, &scope)).await??;
            Reply::json(&())
        })
    });
}
