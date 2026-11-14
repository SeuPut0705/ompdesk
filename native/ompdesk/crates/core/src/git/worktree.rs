//! Worktrees (was the git side of `src/main/local/git/worktree.ts` and `session-worktree.ts`): a new worktree's base
//! and branch, its `worktree add` with the branch rolled back when the add fails, the checks before a removal and
//! the removal itself, and a session worktree's snapshot and removal. Each method is one whole step: main runs the
//! ones that change the repository under its lock (`withRepoLock`), so a stopped holder cancels the request and the
//! lock's next holder starts once its gits exited. What main keeps: where worktrees go (omp's
//! `git.worktree_location`), the folder checks and `mkdir` its fenced files make under the lock (`fenced-fs.ts`), the
//! removal guard on main's own real paths (`removableWorktreePath`) and the exit policy. A refusal is a fault whose
//! code is the `LocalCommandError` code the TypeScript threw; git's own failure keeps run's `git_exit`.

use std::hash::{DefaultHasher, Hasher};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::parse;
use super::read::{self, blocking};
use super::run::Git;
use crate::fs::disk;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::js_trim;
use crate::run::{Opts, Output};
use crate::server::Fault;

fn refuse(code: &'static str, message: impl Into<String>) -> Fault {
    Fault::new(code, message)
}

/// `fs.realpath` as node spells the answer.
pub(super) fn real(path: &str) -> Result<String, NodeError> {
    disk::realpath(path).map(|resolved| disk::spelled(&resolved))
}

/// `rev-parse --verify --quiet <ref>`: the object it names, none when git says no.
async fn rev_parse(git: &Git, cwd: &str, reference: &str) -> Result<Option<String>, Fault> {
    let output = git
        .raw(cwd, &["rev-parse", "--verify", "--quiet", reference])
        .await?;
    let text = output.text();
    let sha = js_trim(&text);
    Ok((output.code == 0 && !sha.is_empty()).then(|| sha.to_owned()))
}

async fn branch_exists(git: &Git, cwd: &str, branch: &str) -> Result<bool, Fault> {
    let reference = format!("refs/heads/{branch}");
    let output = git
        .raw(cwd, &["show-ref", "--verify", "--quiet", &reference])
        .await?;
    Ok(output.code == 0)
}

/// `worktree add` with its own timeout (minutes on a large repository: it checks out the whole tree).
async fn add_worktree(
    git: &Git,
    primary: &str,
    args: &[&str],
    timeout_ms: u64,
) -> Result<(), Fault> {
    let opts = Opts {
        timeout_ms: Some(timeout_ms),
        ..Opts::default()
    };
    git.text_with(primary, args, opts).await.map(drop)
}

/// The main checkout a new worktree is cut from and the commit its branch starts at.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    primary: String,
    start_point: String,
}

/// Before a worktree is made: `cwd` is in a repository, its main checkout, and the start point `base_ref` names:
/// `HEAD` (the default), `default` (the remote's default branch, else HEAD), or any branch, tag or commit the
/// repository resolves. A ref that resolves to no commit, or reads as a git option, is refused.
pub async fn plan(git: &Git, cwd: &str, base_ref: Option<&str>) -> Result<Plan, Fault> {
    if read::repo_root(git, cwd).await?.is_none() {
        return Err(refuse("not_a_repo", format!("Not a git repository: {cwd}")));
    }
    let primary = read::primary_root(git, cwd).await?;
    let start_point = match base_ref {
        None | Some("HEAD") => "HEAD".to_owned(),
        Some("default") => {
            let output = git
                .raw(
                    &primary,
                    &[
                        "symbolic-ref",
                        "--quiet",
                        "--short",
                        "refs/remotes/origin/HEAD",
                    ],
                )
                .await?;
            let text = output.text();
            let name = js_trim(&text);
            if output.code == 0 && !name.is_empty() {
                name.to_owned()
            } else {
                "HEAD".to_owned()
            }
        }
        Some(base) => {
            let resolves = !base.starts_with('-')
                && rev_parse(git, cwd, &format!("{base}^{{commit}}"))
                    .await?
                    .is_some();
            if !resolves {
                return Err(refuse(
                    "invalid_base",
                    format!(
                        "The base \"{base}\" is not a branch, tag or commit of {cwd}. Use \"HEAD\" (default), \"default\" (the remote's default branch) or a ref the repository has."
                    ),
                ));
            }
            base.to_owned()
        }
    };
    Ok(Plan {
        primary,
        start_point,
    })
}

#[derive(Serialize)]
pub struct Added {
    taken: bool,
}

/// A worktree at `target` on a new branch `branch` from `start_point`; `taken` when the branch already exists (the
/// caller tries its next name). A failed `branch` or `worktree add` deletes the branch again, so a retry does not
/// trip over a half-made ref.
pub async fn add(
    git: &Git,
    primary: &str,
    base_cwd: &str,
    target: &str,
    branch: &str,
    start_point: &str,
    add_timeout_ms: u64,
) -> Result<Added, Fault> {
    if branch_exists(git, primary, branch).await? {
        return Ok(Added { taken: true });
    }
    let made = async {
        git.text(base_cwd, &["branch", "--no-track", branch, start_point])
            .await?;
        add_worktree(
            git,
            primary,
            &["worktree", "add", target, branch],
            add_timeout_ms,
        )
        .await
    };
    if let Err(error) = made.await {
        let _ = git.raw(primary, &["branch", "-D", branch]).await;
        return Err(error);
    }
    Ok(Added { taken: false })
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    New,
    Local,
    Remote,
}

/// The branch a caller names (main checked its shape: `worktreeBranchSource`).
#[derive(Deserialize)]
pub struct Source {
    name: String,
    mode: Mode,
    remote: Option<String>,
    from: Option<String>,
}

/// A worktree at `target` on exactly the branch the caller names: a new one (from `from`, else HEAD), an existing
/// local one, or a new local one tracking `<remote>/<name>`. The name is never changed: a taken, missing or invalid
/// one is refused, and a new branch whose `worktree add` failed is deleted again.
pub async fn add_named(
    git: &Git,
    primary: &str,
    base_cwd: &str,
    target: &str,
    source: &Source,
    add_timeout_ms: u64,
) -> Result<(), Fault> {
    let name = source.name.as_str();
    let valid = !name.starts_with('-')
        && git
            .raw(primary, &["check-ref-format", "--branch", name])
            .await?
            .code
            == 0;
    if !valid {
        return Err(refuse(
            "invalid_name",
            format!("\"{name}\" is not a valid branch name."),
        ));
    }
    let exists = branch_exists(git, primary, name).await?;
    let failed = |message: String| refuse("worktree_create_failed", message);
    match source.mode {
        Mode::New => {
            if exists {
                return Err(failed(format!("The branch {name} already exists.")));
            }
            let from = source.from.as_deref().unwrap_or("HEAD");
            git.text(base_cwd, &["branch", "--no-track", name, from])
                .await?;
            let args = ["worktree", "add", target, name];
            if let Err(error) = add_worktree(git, primary, &args, add_timeout_ms).await {
                let _ = git.raw(primary, &["branch", "-D", name]).await;
                return Err(error);
            }
            Ok(())
        }
        Mode::Local => {
            if !exists {
                return Err(failed(format!("The branch {name} does not exist.")));
            }
            add_worktree(
                git,
                primary,
                &["worktree", "add", target, name],
                add_timeout_ms,
            )
            .await
        }
        Mode::Remote => {
            if exists {
                return Err(failed(format!("The branch {name} already exists locally.")));
            }
            let upstream = format!("{}/{name}", source.remote.as_deref().unwrap_or_default());
            let tracked = format!("refs/remotes/{upstream}");
            let found = git
                .raw(primary, &["show-ref", "--verify", "--quiet", &tracked])
                .await?;
            if found.code != 0 {
                return Err(failed(format!(
                    "The remote branch {upstream} does not exist."
                )));
            }
            add_worktree(
                git,
                primary,
                &["worktree", "add", "--track", "-b", name, target, &upstream],
                add_timeout_ms,
            )
            .await
        }
    }
}

#[derive(Serialize)]
pub struct Removal {
    pub(super) primary: String,
}

/// Before `path` (a real path under the worktree root, main's guard) is removed: it is a checkout root, git lists it
/// as a linked worktree of its repository (never the main checkout), and unless `force` nothing in it is uncommitted.
/// Answers the main checkout, whose lock the removal takes.
pub async fn removal(git: &Git, path: &str, force: bool) -> Result<Removal, Fault> {
    let not_a_worktree = |what: &str| refuse("not_a_worktree", format!("{what}: {path}"));
    let checkout_root = read::repo_root(git, path).await.ok().flatten();
    let Some(checkout_root) = checkout_root else {
        return Err(not_a_worktree("Not a git checkout root"));
    };
    let wanted = path.to_owned();
    let (own, root) = blocking(move || (real(&wanted), real(&checkout_root))).await?;
    let own = own.map_err(|error| error.fault(Codes::None))?;
    if root.map_err(|error| error.fault(Codes::None))? != own {
        return Err(not_a_worktree("Not a git checkout root"));
    }
    let primary = read::primary_root(git, path).await?;
    let list = git
        .text(&primary, &["worktree", "list", "--porcelain", "-z"])
        .await?;
    let linked: Vec<String> = parse::worktree_paths(&list)
        .into_iter()
        .skip(1)
        .map(str::to_owned)
        .collect();
    let main = primary.clone();
    let (main, linked) = blocking(move || {
        let linked: Vec<Option<String>> = linked.iter().map(|file| real(file).ok()).collect();
        (real(&main), linked)
    })
    .await?;
    if main.map_err(|error| error.fault(Codes::None))? == own
        || !linked.iter().flatten().any(|file| *file == own)
    {
        return Err(not_a_worktree("Not a registered linked worktree"));
    }
    if !force {
        let parse::Summary {
            staged,
            unstaged,
            untracked,
            ..
        } = read::status(git, path).await?.summary;
        if staged > 0 || unstaged > 0 || untracked > 0 {
            return Err(refuse(
                "worktree_dirty",
                format!(
                    "Worktree has uncommitted changes: {staged} staged, {unstaged} unstaged, {untracked} untracked."
                ),
            ));
        }
    }
    Ok(Removal { primary })
}

/// `worktree remove --force` with its own timeout, which a person sees refused with git's reason.
async fn remove_worktree(
    git: &Git,
    primary: &str,
    target: &str,
    timeout_ms: u64,
) -> Result<Output, Fault> {
    let opts = Opts {
        timeout_ms: Some(timeout_ms),
        ..Opts::default()
    };
    git.run(primary, &["worktree", "remove", "--force", target], opts)
        .await
}

#[derive(Serialize)]
pub struct Removed {
    removed: bool,
}

/// The removal `removal` cleared: the checkout goes, its branch stays, git's list is pruned.
pub async fn remove(
    git: &Git,
    primary: &str,
    path: &str,
    timeout_ms: u64,
) -> Result<Removed, Fault> {
    let removed = remove_worktree(git, primary, path, timeout_ms).await?;
    if removed.code != 0 {
        let reason = js_trim(&removed.stderr);
        let reason = if reason.is_empty() {
            String::new()
        } else {
            format!(" ({reason})")
        };
        return Err(refuse(
            "worktree_remove_failed",
            format!("git worktree remove failed: {path}{reason}"),
        ));
    }
    git.raw(primary, &["worktree", "prune"]).await?;
    Ok(Removed { removed: true })
}

/// A worktree omp's `worktree.onStart` made for a session (main's `LifecycleWorktree`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    pub(super) path: String,
    pub(super) branch: String,
    pub(super) source_cwd: String,
    pub(super) base_commit: String,
}

/// Whether `dir` is itself a checkout root (a parent repository does not count).
async fn is_checkout_root(git: &Git, dir: &str) -> Result<bool, Fault> {
    let top = read::repo_root(git, dir).await.ok().flatten();
    let dir = dir.to_owned();
    blocking(move || {
        let (Some(top), Ok(own)) = (top, real(&dir)) else {
            return false;
        };
        real(&top).unwrap_or(top) == own
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub(super) dirty: bool,
    pub(super) moved: bool,
    pub(super) off_branch: bool,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub(super) state: State,
    pub(super) fingerprint: String,
    pub(super) present: bool,
}

/// One value per part, each followed by a NUL; only ever compared with this process's own answers.
fn hash_parts(parts: &[String]) -> String {
    let mut hasher = DefaultHasher::new();
    for part in parts {
        hasher.write(part.as_bytes());
        hasher.write_u8(0);
    }
    format!("{:016x}", hasher.finish())
}

/// The worktree's state at a session's exit (stock `snapshotSessionWorktree`) and a fingerprint that changes whenever
/// any file, ref or `HEAD` in it does. A missing worktree is not dirty and not off its branch; a deleted branch has
/// not moved; a missing source repository counts as moved, so the branch is never deleted.
pub async fn snapshot(git: &Git, worktree: &Lifecycle) -> Result<Snapshot, Fault> {
    let mut moved = true;
    let mut tip = None;
    if read::repo_root(git, &worktree.source_cwd)
        .await
        .ok()
        .flatten()
        .is_some()
    {
        let reference = format!("refs/heads/{}", worktree.branch);
        tip = rev_parse(git, &worktree.source_cwd, &reference).await?;
        moved = tip.as_ref().is_some_and(|tip| *tip != worktree.base_commit);
    }
    let tip = tip.unwrap_or_default();
    if !is_checkout_root(git, &worktree.path).await? {
        return Ok(Snapshot {
            state: State {
                dirty: false,
                moved,
                off_branch: false,
            },
            fingerprint: format!("missing\0{tip}"),
            present: false,
        });
    }
    let status = git
        .raw(
            &worktree.path,
            &["status", "--porcelain", "-z", "--untracked-files=all"],
        )
        .await?;
    if status.code != 0 {
        let reason = js_trim(&status.stderr);
        let reason = if reason.is_empty() {
            String::new()
        } else {
            format!(": {reason}")
        };
        return Err(Fault::new(
            "git_exit",
            format!("git status failed in {}{reason}", worktree.path),
        ));
    }
    let status = status.text();
    let head = rev_parse(git, &worktree.path, "HEAD").await?;
    let state = State {
        dirty: !status.is_empty(),
        moved,
        off_branch: head.as_ref().is_some_and(|head| *head != tip),
    };
    let mut parts = vec![head.unwrap_or_default(), tip, status];
    let root = worktree.path.clone();
    // Porcelain codes do not change when an already-modified file is edited again, so each changed path's size and
    // mtime count too.
    let parts = blocking(move || {
        let stated: Vec<String> = parse::status_v1_paths(&parts[2])
            .into_iter()
            .map(|file| {
                let at = Path::new(&root).join(file.as_ref());
                match disk::stat(&at.to_string_lossy()) {
                    Ok(meta) => format!(
                        "{file}:{}:{}",
                        meta.len(),
                        parse::js_number(disk::mtime_ms(&meta))
                    ),
                    Err(_) => format!("{file}:-"),
                }
            })
            .collect();
        parts.extend(stated);
        parts
    })
    .await?;
    Ok(Snapshot {
        state,
        fingerprint: hash_parts(&parts),
        present: true,
    })
}

#[derive(Serialize)]
pub struct SessionRemoval {
    pub(super) primary: String,
    pub(super) present: bool,
}

/// Before a session worktree is removed: the main checkout of its source (whose lock the removal takes) and whether
/// the worktree is still a checkout of its own.
pub async fn session_removal(git: &Git, worktree: &Lifecycle) -> Result<SessionRemoval, Fault> {
    let primary = read::primary_root(git, &worktree.source_cwd).await?;
    let present = is_checkout_root(git, &worktree.path).await?;
    Ok(SessionRemoval { primary, present })
}

/// Force-removes the session worktree at `target` (none when it already vanished: git's list is only pruned) and
/// deletes its branch unless it `moved` (stock `removeSessionWorktree`). `path` and `branch` name it in a refusal.
pub async fn session_remove(
    git: &Git,
    primary: &str,
    path: &str,
    branch: &str,
    target: Option<&str>,
    moved: bool,
    timeout_ms: u64,
) -> Result<(), Fault> {
    let failed = |message: String| refuse("worktree_remove_failed", message);
    if let Some(target) = target
        && remove_worktree(git, primary, target, timeout_ms)
            .await?
            .code
            != 0
    {
        return Err(failed(format!(
            "Failed to remove worktree {path}; branch '{branch}' kept."
        )));
    }
    git.raw(primary, &["worktree", "prune"]).await?;
    if !moved && git.raw(primary, &["branch", "-D", branch]).await?.code != 0 {
        return Err(failed(format!(
            "Removed worktree {path} but failed to delete branch '{branch}'."
        )));
    }
    Ok(())
}
