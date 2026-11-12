//! Worktrees disk care takes off the disk, losing nothing, and puts back on request (was the disk and git work of
//! `src/main/disk/saved-worktrees.ts`). Main keeps the saved records (`saved.json`), the secret check (the central
//! redactor is TypeScript), whether nothing moved while a save ran (`stillSame`: it asks main's process list first),
//! the repository's seeding and setup hook between a restore's checkout and its files, and the order of the steps;
//! each step's disk work and gits are one request here.
//!
//! - `drop`: the regenerable entries go, each measured first.
//! - `check`, `work`, `rollback`, `remove`: a save. What is staged becomes one commit (from a copy of the index) and
//!   the working tree's tracked changes and untracked files one more on top (a scratch index), on a new
//!   `ompdesk/saved/…` branch; what git does not keep and no tool makes again is copied to a private archive (0700
//!   folders, 0600 files, cloned where the volume can, verified by a walk). A failure after the branch was made takes
//!   the branch and the archive back; a cancelled request makes nothing more, as the TypeScript's fenced calls did.
//! - `archive`, `settle`: the archive alone before a landed worktree's removal, and what becomes of it after.
//! - `checkout`, `restore`, `forget`: a restore.

use std::cmp::Ordering;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::sizes;
use super::tree::{
    self, chmod, copy, fault, live, make_dirs, read_link, relative_entries, remove, symlink, under,
};
use crate::fs::order::js_trim;
use crate::git::read::blocking;
use crate::git::run::Git;
use crate::run::Opts;
use crate::server::{Fault, Scope};

/// A worktree whose untracked files would make a commit this big is kept, not saved.
const SAVE_COMMIT_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// A worktree whose private archive would be this big is kept, not saved.
const ARCHIVE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// A staged file is read whole up to this size for main's secret check.
const SECRET_SCAN_MAX_BYTES: usize = 16 * 1024 * 1024;
/// The slow gits of a save and a restore (`add -A` of a big tree, `worktree add`, `worktree remove`).
const SLOW_MS: u64 = 300_000;
const SAVED_PREFIX: &str = "ompdesk/saved/";
const ZERO_SHA: &str = "0000000000000000000000000000000000000000";
/// Disk care's own identity on its commits; no hook runs and nothing is signed (`commit-tree --no-gpg-sign`).
const SAVE_ENV: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "OMPdesk disk care"),
    ("GIT_AUTHOR_EMAIL", "disk-care@ompdesk.invalid"),
    ("GIT_COMMITTER_NAME", "OMPdesk disk care"),
    ("GIT_COMMITTER_EMAIL", "disk-care@ompdesk.invalid"),
];
/// Files whose checkout writes the bytes the blob holds: `text` unspecified or unset and no other converting attribute.
const VERBATIM_PATHSPECS: [&str; 2] = [
    ":(attr:!text !eol !crlf !filter !working-tree-encoding !ident)",
    ":(attr:-text !eol !crlf !filter !working-tree-encoding !ident)",
];

/// Why a worktree is left in place (`KeepWorktree`); main logs it.
pub fn keep(reason: impl Into<String>) -> Fault {
    Fault::new("keep_worktree", reason)
}

/// One archived file, as `manifest.json` lists it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Archived {
    path: String,
    mode: u32,
    size: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    link: bool,
    /// A tracked file whose change was kept out of the saved commit (a secret): a restore writes it over HEAD's copy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    overwrite: bool,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    worktree: String,
    files: Vec<Archived>,
}

/// `lstat`'s permission bits; on Windows what libuv makes of the read-only attribute.
fn mode_of(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        if meta.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

/// The files under `relative` (a file itself, or every file of a folder, names in JavaScript's sort order), as node
/// named them: a name that is not UTF-8 reads lossily and then cannot be found, which fails the walk.
fn walk_files(root: &str, relative: &str, out: &mut Vec<Archived>) -> Result<(), Fault> {
    let path = under(root, relative);
    let meta = std::fs::symlink_metadata(&path).map_err(|error| fault(&error, "lstat", &path))?;
    if meta.is_dir() {
        let mut names: Vec<String> = crate::fs::disk::entries(&path)
            .map_err(|error| fault(&error, "scandir", &path))?
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for name in names {
            walk_files(root, &format!("{relative}/{name}"), out)?;
        }
        return Ok(());
    }
    out.push(Archived {
        path: relative.to_owned(),
        mode: mode_of(&meta),
        size: tree::entry_size(&path, &meta)?,
        link: meta.file_type().is_symlink(),
        overwrite: false,
    });
    Ok(())
}

/// Copies `entries` (relative to `worktree`; a directory ends in `/`) into the archive folder `dir`: clones where the
/// volume allows, links as links, then 0600 in 0700 folders with the original modes kept in `manifest.json`. Verified
/// by walking both sides; a mismatch or a failure removes the half archive (not after a cancel) and fails.
pub fn write_archive(
    worktree: &str,
    entries: &[String],
    dir: &str,
    overwrite: &[String],
    scope: &Scope,
) -> Result<(usize, u64), Fault> {
    relative_entries(entries.iter().chain(overwrite).map(String::as_str))?;
    let mut source = Vec::new();
    for entry in entries {
        live(scope)?;
        walk_files(worktree, entry.trim_end_matches('/'), &mut source)?;
    }
    for file in &mut source {
        file.overwrite = overwrite.contains(&file.path);
    }
    let bytes: u64 = source.iter().map(|file| file.size).sum();
    if bytes > ARCHIVE_MAX_BYTES {
        return Err(keep(format!(
            "files no tool makes again take {bytes} bytes, more than the archive takes"
        )));
    }
    if source.is_empty() {
        return Ok((0, 0));
    }
    let files = Path::new(dir).join("files");
    let written = (|| {
        make_dirs(&files, 0o700)?;
        for file in &source {
            live(scope)?;
            let target = under(&files.to_string_lossy(), &file.path);
            if let Some(parent) = target.parent() {
                make_dirs(parent, 0o700)?;
            }
            let from = under(worktree, &file.path);
            if file.link {
                symlink(&read_link(&from)?, &target)?;
            } else {
                copy(&from, &target)?;
                chmod(&target, 0o600)?;
            }
        }
        let mut copied = Vec::new();
        for file in &source {
            walk_files(&files.to_string_lossy(), &file.path, &mut copied)?;
        }
        let same = copied.len() == source.len()
            && copied
                .iter()
                .zip(&source)
                .all(|(copy, file)| copy.path == file.path && copy.size == file.size);
        if !same {
            return Err(Fault::new(
                "archive_mismatch",
                format!("the archive of {worktree} does not match its files"),
            ));
        }
        live(scope)?;
        let manifest = Manifest {
            worktree: worktree.to_owned(),
            files: source.clone(),
        };
        let mut text = serde_json::to_string_pretty(&manifest)
            .map_err(|error| Fault::new("internal", error.to_string()))?;
        text.push('\n');
        write_private(&Path::new(dir).join("manifest.json"), text.as_bytes())
    })();
    if let Err(error) = written {
        if !scope.cancelled() {
            let _ = remove(Path::new(dir), false, scope);
        }
        return Err(error);
    }
    Ok((source.len(), bytes))
}

/// `writeFile(path, bytes, { mode: 0o600 })`.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), Fault> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(path)
        .map_err(|error| fault(&error, "open", path))?;
    std::io::Write::write_all(&mut file, bytes).map_err(|error| fault(&error, "write", path))
}

/// The regenerable entries of a worktree to drop, each with the rule that proved it.
#[derive(Deserialize)]
pub struct Droppable {
    path: String,
    reason: String,
}

#[derive(Serialize)]
pub struct Dropped {
    path: String,
    bytes: u64,
    reason: String,
}

/// `dropArtifacts`: each entry measured (a full walk), then removed (`rm -rf` with node's three retries).
pub fn drop_entries(
    worktree: &str,
    entries: Vec<Droppable>,
    scope: &Scope,
) -> Result<Vec<Dropped>, Fault> {
    relative_entries(entries.iter().map(|entry| entry.path.as_str()))?;
    let mut dropped = Vec::new();
    for entry in entries {
        let target = under(worktree, entry.path.trim_end_matches('/'));
        let bytes = sizes::measure(&target, None, 0.0, scope)?.bytes;
        remove(&target, true, scope)?;
        dropped.push(Dropped {
            path: entry.path,
            bytes,
            reason: entry.reason,
        });
    }
    Ok(dropped)
}

/// What a save checked before it writes anything: HEAD, whether anything is staged, and the staged files that have
/// content in the index (a staged deletion has none to hold a secret), which main reads one at a time
/// (`staged_blob`) for its secret check.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    head: String,
    staged: bool,
    staged_files: Vec<String>,
}

/// `exclude` covers `file`: the file itself or one under a folder entry.
fn excluded(file: &str, exclude: &[String]) -> bool {
    exclude.iter().any(|entry| {
        file == entry
            || if entry.ends_with('/') {
                file.starts_with(entry.as_str())
            } else {
                file.strip_prefix(entry.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
            }
    })
}

/// A save's checks, in the TypeScript's order: HEAD, the size of the untracked files the commit would carry, whether
/// a restore could rewrite bytes, then what is staged.
pub async fn check(
    git: &Git,
    worktree: &str,
    untracked_files: Vec<String>,
    exclude: Vec<String>,
    scope: &Scope,
) -> Result<Checked, Fault> {
    relative_entries(untracked_files.iter().chain(&exclude).map(String::as_str))?;
    let head = js_trim(&git.text(worktree, &["rev-parse", "HEAD"]).await?).to_owned();
    let root = worktree.to_owned();
    let held = scope.clone();
    let commit_bytes = blocking(move || -> Result<u64, Fault> {
        let mut total = 0;
        for file in untracked_files
            .iter()
            .filter(|file| !excluded(file, &exclude))
        {
            live(&held)?;
            let path = under(&root, file);
            total += std::fs::symlink_metadata(&path)
                .ok()
                .and_then(|meta| tree::entry_size(&path, &meta).ok())
                .unwrap_or(0);
        }
        Ok(total)
    })
    .await??;
    if commit_bytes > SAVE_COMMIT_MAX_BYTES {
        return Err(keep(format!(
            "its untracked files take {commit_bytes} bytes, more than a saved commit takes"
        )));
    }
    if let Some(reason) = rewrites_bytes(git, worktree).await? {
        return Err(keep(reason));
    }
    let names = ["diff", "--cached", "--name-only", "--no-renames", "-z"];
    let staged = git.raw(worktree, &names).await?;
    if staged.code != 0 {
        return Err(Fault::new(
            "git_exit",
            format!(
                "git diff --cached failed in {worktree}: {}",
                js_trim(&staged.stderr)
            ),
        ));
    }
    if !staged.text().split('\0').any(|name| !name.is_empty()) {
        return Ok(Checked {
            head,
            staged: false,
            staged_files: Vec::new(),
        });
    }
    let with_content = git
        .raw(
            worktree,
            &[
                "diff",
                "--cached",
                "--name-only",
                "--no-renames",
                "--diff-filter=d",
                "-z",
            ],
        )
        .await?
        .text();
    Ok(Checked {
        head,
        staged: true,
        staged_files: with_content
            .split('\0')
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}

/// One staged file's content as the index holds it, up to `SECRET_SCAN_MAX_BYTES`, and whether it was read whole.
pub async fn staged_blob(git: &Git, worktree: &str, path: &str) -> Result<(bool, Vec<u8>), Fault> {
    let spec = format!(":{path}");
    let blob = git
        .capped(
            worktree,
            &["cat-file", "blob", &spec],
            SECRET_SCAN_MAX_BYTES,
        )
        .await?;
    Ok((blob.code == 0 && !blob.truncated, blob.stdout))
}

/// Losing nothing means the restore writes the very bytes the folder holds now. git rewrites bytes on add and checkout
/// when line-ending or filter settings apply, so a worktree with such a setting on a file the saved commit would carry
/// is kept: the reason, or none when bytes round-trip. git reads every attributes source itself (`:(attr:…)`).
async fn rewrites_bytes(git: &Git, worktree: &str) -> Result<Option<String>, Fault> {
    let config = |key: &'static str| async move {
        git.raw(worktree, &["config", "--get", key])
            .await
            .map(|output| js_trim(&output.text()).to_lowercase())
    };
    let autocrlf = config("core.autocrlf").await?;
    if autocrlf == "true" || autocrlf == "input" {
        return Ok(Some(format!(
            "core.autocrlf is {autocrlf}: a restore could change line endings"
        )));
    }
    if !config("core.eol").await?.is_empty() {
        return Ok(Some(
            "core.eol is set: a restore could change line endings".into(),
        ));
    }
    let files = |pathspecs: &'static [&'static str]| async move {
        let mut args = vec![
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
        ];
        args.extend(pathspecs);
        git.raw(worktree, &args).await.map(|output| {
            (output.code == 0 && !output.truncated).then(|| {
                output
                    .text()
                    .split('\0')
                    .filter(|name| !name.is_empty())
                    .count()
            })
        })
    };
    let all = files(&[]).await?;
    let verbatim = files(&VERBATIM_PATHSPECS).await?;
    Ok(match (all, verbatim) {
        (Some(all), Some(verbatim)) if verbatim < all => {
            Some("line-ending or filter attributes apply: a restore could rewrite files".into())
        }
        (Some(_), Some(_)) => None,
        _ => Some("git could not list the files' attributes".into()),
    })
}

/// A request's own temp folder (`<temp>/<prefix>XXXXXX`), removed when dropped: after the git that used it exited
/// (`run` returns only then), inside the request, also after a failure or a cancel.
struct Scratch(PathBuf);

impl Scratch {
    async fn new(prefix: &'static str) -> Result<Scratch, Fault> {
        blocking(move || crate::fs::disk::make_temp_dir(prefix))
            .await?
            .map(Scratch)
            .map_err(|error| error.fault(crate::fs::error::Codes::None))
    }

    fn index(&self) -> String {
        self.0.join("index").to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The worktree's index (what is staged) as one commit on top of `head`, written from a copy of the index, so the
/// worktree's own index file is never touched.
async fn staged_commit(git: &Git, worktree: &str, head: &str, name: &str) -> Result<String, Fault> {
    let scratch = Scratch::new("ompdesk-staged-").await?;
    let index = crate::git::read::resolve(
        worktree,
        js_trim(
            &git.text(worktree, &["rev-parse", "--git-path", "index"])
                .await?,
        ),
    );
    let copy_to = scratch.index();
    blocking(move || {
        std::fs::copy(&index, &copy_to)
            .map(|_| ())
            .map_err(|error| fault(&error, "copyfile", Path::new(&index)))
    })
    .await??;
    let file = scratch.index();
    let env = save_env(&file);
    let opts = Opts {
        env: &env,
        ..Opts::default()
    };
    let tree = js_trim(&git.run(worktree, &["write-tree"], opts).await?.text()).to_owned();
    if tree.is_empty() {
        return Err(Fault::new(
            "git_exit",
            format!("git write-tree of the index failed in {worktree}"),
        ));
    }
    let message = format!("Saved by OMPdesk disk care: what was staged in {name}");
    let args = [
        "commit-tree",
        "--no-gpg-sign",
        "-p",
        head,
        "-m",
        &message,
        &tree,
    ];
    let commit = git.run(worktree, &args, opts).await?;
    if commit.code != 0 {
        return Err(Fault::new(
            "git_exit",
            format!(
                "git commit-tree failed in {worktree}: {}",
                js_trim(&commit.stderr)
            ),
        ));
    }
    Ok(js_trim(&commit.text()).to_owned())
}

fn save_env(index: &str) -> Vec<(&'static str, &str)> {
    let mut env: Vec<(&str, &str)> = SAVE_ENV.to_vec();
    env.push(("GIT_INDEX_FILE", index));
    env
}

/// One commit on top of `base` holding the worktree's tracked changes and untracked files, built in a scratch index;
/// `exclude` (secrets, regenerable untracked folders) stays out. None when it would hold nothing more than `base`.
async fn work_commit(
    git: &Git,
    worktree: &str,
    base: &str,
    exclude: &[String],
    name: &str,
) -> Result<Option<String>, Fault> {
    let scratch = Scratch::new("ompdesk-save-").await?;
    let file = scratch.index();
    let env = save_env(&file);
    let step = async |args: &[&str]| -> Result<String, Fault> {
        let opts = Opts {
            env: &env,
            timeout_ms: Some(SLOW_MS),
            ..Opts::default()
        };
        let output = git.run(worktree, args, opts).await?;
        if output.code != 0 {
            return Err(Fault::new(
                "git_exit",
                format!(
                    "git {} failed in {worktree}: {}",
                    args[0],
                    js_trim(&output.stderr)
                ),
            ));
        }
        Ok(js_trim(&output.text()).to_owned())
    };
    step(&["read-tree", base]).await?;
    let pathspecs: Vec<String> = exclude
        .iter()
        .map(|entry| format!(":(exclude,literal){}", entry.trim_end_matches('/')))
        .collect();
    let mut add = vec!["add", "-A", "--", "."];
    add.extend(pathspecs.iter().map(String::as_str));
    step(&add).await?;
    let tree = step(&["write-tree"]).await?;
    if tree == step(&["rev-parse", &format!("{base}^{{tree}}")]).await? {
        return Ok(None);
    }
    let message = format!("Saved by OMPdesk disk care: uncommitted work of {name}");
    Ok(Some(
        step(&[
            "commit-tree",
            "--no-gpg-sign",
            "-p",
            base,
            "-m",
            &message,
            &tree,
        ])
        .await?,
    ))
}

/// `ompdesk/saved/<folder>-<day>`, numbered when that branch is taken.
async fn free_branch_name(
    git: &Git,
    primary: &str,
    folder: &str,
    day: &str,
) -> Result<String, Fault> {
    for suffix in 1u64.. {
        let name = if suffix > 1 {
            format!("{SAVED_PREFIX}{folder}-{day}-{suffix}")
        } else {
            format!("{SAVED_PREFIX}{folder}-{day}")
        };
        let reference = format!("refs/heads/{name}");
        let exists = git
            .raw(primary, &["show-ref", "--verify", "--quiet", &reference])
            .await?;
        if exists.code != 0 {
            return Ok(name);
        }
    }
    unreachable!("a branch name is free before the counter ends")
}

/// A save to make: the worktree, its repository's main checkout, its branch, what the checks found.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    worktree: String,
    primary: String,
    branch: Option<String>,
    /// Commits nothing else holds (the worktree is unlanded).
    unlanded: bool,
    head: String,
    staged: bool,
    exclude: Vec<String>,
    archive: Vec<String>,
    overwrite: Vec<String>,
    /// The archive folder main names (`saved/<id>`).
    archive_dir: String,
    /// The worktree's folder name and today's date (UTC), for the branch and the messages.
    name: String,
    day: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    staged: Option<String>,
    saved_branch: Option<String>,
    saved_sha: Option<String>,
    archived_files: usize,
    archived_bytes: u64,
}

/// HEAD → what was staged → the working tree, each as a commit; the saved branch; the archive. A failure after the
/// branch was made takes branch and archive back.
pub async fn work(git: &Git, save: Save, scope: &Scope) -> Result<Saved, Fault> {
    relative_entries(
        save.archive
            .iter()
            .chain(&save.exclude)
            .chain(&save.overwrite)
            .map(String::as_str),
    )?;
    let staged = if save.staged {
        Some(staged_commit(git, &save.worktree, &save.head, &save.name).await?)
    } else {
        None
    };
    let base = staged.as_deref().unwrap_or(&save.head);
    let wip = work_commit(git, &save.worktree, base, &save.exclude, &save.name).await?;
    let saved_sha = wip
        .clone()
        .or_else(|| staged.clone())
        .or_else(|| (save.branch.is_none() && save.unlanded).then(|| save.head.clone()));
    let saved_branch = match &saved_sha {
        Some(_) => Some(free_branch_name(git, &save.primary, &save.name, &save.day).await?),
        None => None,
    };
    if let (Some(branch), Some(sha)) = (&saved_branch, &saved_sha) {
        let reference = format!("refs/heads/{branch}");
        git.text(&save.primary, &["update-ref", &reference, sha, ZERO_SHA])
            .await?;
    }
    let (worktree, archive, dir, overwrite) = (
        save.worktree.clone(),
        save.archive,
        save.archive_dir.clone(),
        save.overwrite,
    );
    let held = scope.clone();
    let archived =
        blocking(move || write_archive(&worktree, &archive, &dir, &overwrite, &held)).await;
    // Every failure from here on (the archive's, or its worker's) takes the branch and the archive back.
    let (archived_files, archived_bytes) = match archived.and_then(|archived| archived) {
        Ok(archived) => archived,
        Err(error) => {
            rollback(
                git,
                &save.primary,
                saved_branch.as_deref(),
                saved_sha.as_deref(),
                &save.archive_dir,
                scope,
            )
            .await;
            return Err(error);
        }
    };
    Ok(Saved {
        staged,
        saved_branch,
        saved_sha,
        archived_files,
        archived_bytes,
    })
}

/// Takes a save back: the saved branch (only while it still names `sha`) and the archive folder. Nothing after a
/// cancel; a failure here leaves what it could not take.
pub async fn rollback(
    git: &Git,
    primary: &str,
    branch: Option<&str>,
    sha: Option<&str>,
    archive_dir: &str,
    scope: &Scope,
) {
    if let (Some(branch), Some(sha)) = (branch, sha) {
        let reference = format!("refs/heads/{branch}");
        let _ = git
            .raw(primary, &["update-ref", "-d", &reference, sha])
            .await;
    }
    let dir = PathBuf::from(archive_dir);
    let held = scope.clone();
    let _ = blocking(move || remove(&dir, false, &held)).await;
}

/// `git worktree remove --force` of a saved worktree; git's own words when it refused or stopped half way.
pub async fn force_remove(git: &Git, primary: &str, path: &str) -> Result<Option<String>, Fault> {
    let opts = Opts {
        timeout_ms: Some(SLOW_MS),
        ..Opts::default()
    };
    let removed = git
        .run(primary, &["worktree", "remove", "--force", path], opts)
        .await?;
    Ok((removed.code != 0).then(|| js_trim(&removed.stderr).to_owned()))
}

/// The archive alone of a landed worktree about to be removed, with the HEAD its record names; none when it holds
/// nothing.
pub async fn archive(
    git: &Git,
    worktree: String,
    entries: Vec<String>,
    archive_dir: String,
    scope: &Scope,
) -> Result<Option<(usize, u64, String)>, Fault> {
    let held = scope.clone();
    let root = worktree.clone();
    let (files, bytes) =
        blocking(move || write_archive(&root, &entries, &archive_dir, &[], &held)).await??;
    if files == 0 {
        return Ok(None);
    }
    let head = js_trim(&git.text(&worktree, &["rev-parse", "HEAD"]).await?).to_owned();
    Ok(Some((files, bytes, head)))
}

fn read_manifest(archive_dir: &str) -> Result<Manifest, Fault> {
    let path = Path::new(archive_dir).join("manifest.json");
    let bytes = std::fs::read(&path).map_err(|error| fault(&error, "open", &path))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| Fault::new("archive_manifest", error.to_string()))
}

/// After a landed worktree's removal that git stopped half way: whether the folder still holds every archived file as
/// it was (then the archive goes and nothing is recorded); otherwise the archive is its only copy.
pub fn settle(worktree: &str, archive_dir: &str, scope: &Scope) -> Result<bool, Fault> {
    let manifest = read_manifest(archive_dir)?;
    relative_entries(manifest.files.iter().map(|file| file.path.as_str()))?;
    let intact = manifest.files.iter().all(|file| {
        let path = under(worktree, &file.path);
        std::fs::symlink_metadata(&path)
            .ok()
            .and_then(|meta| tree::entry_size(&path, &meta).ok())
            == Some(file.size)
    });
    if intact {
        remove(Path::new(archive_dir), false, scope)?;
    }
    Ok(intact)
}

/// A restore's checkout: the saved worktree's record as main keeps it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    path: String,
    repo: String,
    branch: Option<String>,
    head: String,
    saved_branch: Option<String>,
    staged: Option<String>,
}

/// `git worktree add` at the old path, on its branch when the branch still points where it did and no other worktree
/// has it checked out, else detached at the saved HEAD; then the saved changes as uncommitted work and what was staged
/// back in the index. Answers whether it is on its branch.
pub async fn checkout(git: &Git, record: Checkout) -> Result<bool, Fault> {
    let path = record.path.clone();
    if blocking(move || std::fs::symlink_metadata(&path).is_ok()).await? {
        return Err(Fault::new(
            "path_exists",
            format!("{} already exists; nothing was restored.", record.path),
        ));
    }
    let (tip, checked_out) = match &record.branch {
        Some(branch) => {
            let reference = format!("refs/heads/{branch}");
            let tip = git
                .raw(
                    &record.repo,
                    &["rev-parse", "--verify", "--quiet", &reference],
                )
                .await?
                .text();
            let list = git
                .text(&record.repo, &["worktree", "list", "--porcelain"])
                .await?;
            (
                js_trim(&tip).to_owned(),
                list.contains(&format!("branch {reference}\n")),
            )
        }
        None => (String::new(), false),
    };
    let on_branch = record.branch.is_some() && tip == record.head && !checked_out;
    if let Some(parent) = Path::new(&record.path).parent().map(Path::to_owned) {
        blocking(move || make_dirs(&parent, 0o777)).await??;
    }
    let args: Vec<&str> = match (&record.branch, on_branch) {
        (Some(branch), true) => vec!["worktree", "add", &record.path, branch],
        _ => vec!["worktree", "add", "--detach", &record.path, &record.head],
    };
    let opts = Opts {
        timeout_ms: Some(SLOW_MS),
        ..Opts::default()
    };
    let added = git.run(&record.repo, &args, opts).await?;
    if added.code != 0 {
        return Err(Fault::new(
            "git_exit",
            format!("git worktree add failed: {}", js_trim(&added.stderr)),
        ));
    }
    if let Some(saved_branch) = &record.saved_branch {
        let reference = format!("refs/heads/{saved_branch}");
        let saved_sha =
            js_trim(&git.text(&record.repo, &["rev-parse", &reference]).await?).to_owned();
        if saved_sha != record.head {
            // Two-tree read-tree moves the working tree from HEAD to the saved commit (deletions too); the reset puts
            // the index back on HEAD, so the saved work is uncommitted again; then what was staged goes back into the
            // index alone (read-tree without -u leaves the working tree as it is).
            git.text(&record.path, &["read-tree", "-m", "-u", "HEAD", &saved_sha])
                .await?;
            git.text(&record.path, &["reset", "-q"]).await?;
            if let Some(staged) = &record.staged {
                git.text(&record.path, &["read-tree", staged]).await?;
            }
        }
    }
    Ok(on_branch)
}

/// `<target>.ompdesk-before-restore`, numbered when that is taken too.
fn aside_name(target: &Path) -> PathBuf {
    let base = target.to_string_lossy();
    (1u64..)
        .map(|suffix| {
            PathBuf::from(if suffix > 1 {
                format!("{base}.ompdesk-before-restore-{suffix}")
            } else {
                format!("{base}.ompdesk-before-restore")
            })
        })
        .find(|candidate| std::fs::symlink_metadata(candidate).is_err())
        .unwrap_or_else(|| target.to_owned())
}

/// Both files read whole hold the same bytes (an unreadable one never does).
fn same_bytes(a: &Path, b: &Path) -> bool {
    let (Ok(mut left), Ok(mut right)) = (std::fs::File::open(a), std::fs::File::open(b)) else {
        return false;
    };
    let mut one = vec![0u8; 64 * 1024];
    let mut two = vec![0u8; 64 * 1024];
    loop {
        let (Ok(read), Ok(other)) = (
            crate::fs::disk::read_into(&mut left, &mut one),
            crate::fs::disk::read_into(&mut right, &mut two),
        ) else {
            return false;
        };
        if read != other || one[..read].cmp(&two[..other]) != Ordering::Equal {
            return false;
        }
        if read < one.len() {
            return right.read(&mut two[..1]).is_ok_and(|more| more == 0);
        }
    }
}

/// Puts the archive back. The archived bytes are what the person had, so they win: a file something else made at
/// that path since (a hook's default `.env`, the repository's seeding) is moved aside to
/// `<name>.ompdesk-before-restore`, never deleted; an identical one counts as restored; a tracked secret's change goes
/// over HEAD's copy. A folder where a file was is left alone and the file counts as skipped.
pub fn restore(worktree: &str, archive_dir: &str, scope: &Scope) -> Result<(usize, usize), Fault> {
    let manifest = read_manifest(archive_dir)?;
    relative_entries(manifest.files.iter().map(|file| file.path.as_str()))?;
    let files = Path::new(archive_dir).join("files");
    let (mut restored, mut skipped) = (0, 0);
    for file in manifest.files {
        live(scope)?;
        let target = under(worktree, &file.path);
        let from = under(&files.to_string_lossy(), &file.path);
        if let Ok(existing) = std::fs::symlink_metadata(&target) {
            if existing.is_dir() {
                skipped += 1;
                continue;
            }
            if !file.link && existing.is_file() && same_bytes(&from, &target) {
                restored += 1;
                continue;
            }
            if file.overwrite {
                std::fs::remove_file(&target).map_err(|error| fault(&error, "rm", &target))?;
            } else {
                let aside = aside_name(&target);
                std::fs::rename(&target, &aside).map_err(|error| {
                    crate::fs::error::NodeError::with_dest(
                        &error,
                        "rename",
                        Some(&target.to_string_lossy()),
                        Some(&aside.to_string_lossy()),
                    )
                    .fault(crate::fs::error::Codes::None)
                })?;
            }
        }
        if let Some(parent) = target.parent() {
            make_dirs(parent, 0o777)?;
        }
        if file.link {
            symlink(&read_link(&from)?, &target)?;
        } else {
            copy(&from, &target)?;
            chmod(&target, file.mode)?;
        }
        restored += 1;
    }
    Ok((restored, skipped))
}

/// The archive folder of a record that is gone.
pub fn forget(archive_dir: &str, scope: &Scope) -> Result<(), Fault> {
    tree::remove(Path::new(archive_dir), false, scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn excludes_what_the_typescript_excluded() {
        let exclude = [
            "secret.env".to_owned(),
            "build/".to_owned(),
            "deps".to_owned(),
        ];
        assert!(excluded("secret.env", &exclude));
        assert!(excluded("build/x", &exclude));
        assert!(excluded("deps/x", &exclude));
        assert!(!excluded("depsx", &exclude));
        assert!(!excluded("secret.env.bak", &exclude));
    }

    #[cfg(unix)]
    #[test]
    fn archives_files_and_links_privately_and_puts_them_back() {
        let dir = std::env::temp_dir().join(format!("ompdesk-core-archive-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let worktree = dir.join("wt");
        fs::create_dir_all(worktree.join("data/b")).unwrap();
        fs::write(worktree.join(".env"), "A=1\n").unwrap();
        fs::write(worktree.join("data/z.db"), "z").unwrap();
        fs::write(worktree.join("data/b/a.db"), "a").unwrap();
        std::os::unix::fs::symlink("../.env", worktree.join("data/link")).unwrap();
        let archive = dir.join("saved/one");
        let wt = worktree.to_string_lossy().into_owned();
        let scope = Scope::detached();
        let (files, bytes) = write_archive(
            &wt,
            &[".env".into(), "data/".into()],
            &archive.to_string_lossy(),
            &[".env".into()],
            &scope,
        )
        .unwrap();
        assert_eq!((files, bytes), (4, 4 + 1 + 1 + 7));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&archive).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(archive.join("files/.env"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(archive.join("manifest.json")).unwrap()).unwrap();
        let paths: Vec<_> = manifest
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, [".env", "data/b/a.db", "data/link", "data/z.db"]);
        assert!(manifest.files[0].overwrite && manifest.files[2].link);
        assert!(settle(&wt, &archive.to_string_lossy(), &scope).unwrap());
        assert!(!archive.exists(), "an intact worktree drops its archive");

        write_archive(
            &wt,
            &[".env".into(), "data/".into()],
            &archive.to_string_lossy(),
            &[],
            &scope,
        )
        .unwrap();
        fs::remove_dir_all(&worktree).unwrap();
        assert!(!settle(&wt, &archive.to_string_lossy(), &scope).unwrap());
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".env"), "DEFAULT=1\n").unwrap();
        assert_eq!(
            restore(&wt, &archive.to_string_lossy(), &scope).unwrap(),
            (4, 0)
        );
        assert_eq!(fs::read_to_string(worktree.join(".env")).unwrap(), "A=1\n");
        assert_eq!(
            fs::read_to_string(worktree.join(".env.ompdesk-before-restore")).unwrap(),
            "DEFAULT=1\n"
        );
        assert_eq!(
            fs::read_link(worktree.join("data/link")).unwrap(),
            Path::new("../.env")
        );
        assert_eq!(
            restore(&wt, &archive.to_string_lossy(), &scope).unwrap(),
            (4, 0),
            "identical files count"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn archives_and_restores_windows_links_and_readonly_files() {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-core-archive-windows-{}",
            std::process::id()
        ));
        let worktree = dir.join("wt");
        let outside = dir.join("outside");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("kept"), "kept").unwrap();
        fs::write(worktree.join("readonly"), "original").unwrap();
        tree::chmod(&worktree.join("readonly"), 0o444).unwrap();
        symlink_dir(&outside, worktree.join("dir-link")).unwrap();
        symlink_file(outside.join("kept"), worktree.join("file-link")).unwrap();
        let archive = dir.join("saved/one");
        let wt = worktree.to_string_lossy();
        let scope = Scope::detached();
        let (files, _) = write_archive(
            &wt,
            &["readonly".into(), "dir-link".into(), "file-link".into()],
            &archive.to_string_lossy(),
            &["readonly".into()],
            &scope,
        )
        .unwrap();
        assert_eq!(files, 3);
        assert!(
            !fs::metadata(archive.join("files/readonly"))
                .unwrap()
                .permissions()
                .readonly()
        );
        tree::remove(&worktree, false, &scope).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join("readonly"), "checkout").unwrap();
        tree::chmod(&worktree.join("readonly"), 0o444).unwrap();
        assert_eq!(
            restore(&wt, &archive.to_string_lossy(), &scope).unwrap(),
            (3, 0)
        );
        assert_eq!(fs::read(worktree.join("readonly")).unwrap(), b"original");
        assert!(
            fs::metadata(worktree.join("readonly"))
                .unwrap()
                .permissions()
                .readonly()
        );
        assert_eq!(fs::read_link(worktree.join("dir-link")).unwrap(), outside);
        assert_eq!(
            fs::read_link(worktree.join("file-link")).unwrap(),
            outside.join("kept")
        );
        assert_eq!(fs::read(outside.join("kept")).unwrap(), b"kept");
        tree::remove(&dir, false, &scope).unwrap();
    }

    #[test]
    fn keeps_a_worktree_whose_archive_is_too_big_and_writes_nothing_after_a_cancel() {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-core-archive-cancel-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("wt")).unwrap();
        fs::write(dir.join("wt/f"), "x").unwrap();
        let scope = Scope::detached();
        scope.cancel();
        let archive = dir.join("saved/x");
        let failed = write_archive(
            &dir.join("wt").to_string_lossy(),
            &["f".into()],
            &archive.to_string_lossy(),
            &[],
            &scope,
        );
        assert_eq!(failed.unwrap_err(), Fault::cancelled());
        assert!(!archive.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_drop_or_an_archive_that_leaves_the_worktree_and_takes_nothing() {
        let dir = std::env::temp_dir().join(format!("ompdesk-core-escape-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let worktree = dir.join("wt");
        fs::create_dir_all(worktree.join("out")).unwrap();
        fs::create_dir_all(dir.join("outside")).unwrap();
        fs::write(dir.join("outside/kept"), "kept").unwrap();
        let wt = worktree.to_string_lossy().into_owned();
        let scope = Scope::detached();
        let bad_entries = ["../outside/", "/", "./", ""];
        #[cfg(windows)]
        let bad_entries =
            bad_entries
                .into_iter()
                .chain(["C:\\x", "\\\\server\\share\\x", "a:b", "..\\x"]);
        for bad in bad_entries {
            let entries = vec![
                Droppable {
                    path: "out/".into(),
                    reason: "build-tool-output".into(),
                },
                Droppable {
                    path: bad.into(),
                    reason: "build-tool-output".into(),
                },
            ];
            let refused = drop_entries(&wt, entries, &scope).err().unwrap();
            assert_eq!(refused.code, "invalid_entry", "{bad:?}");
            let archive = dir.join("saved/x").to_string_lossy().into_owned();
            let refused = write_archive(&wt, &[bad.into()], &archive, &[], &scope)
                .err()
                .unwrap();
            assert_eq!(refused.code, "invalid_entry", "{bad:?}");
        }
        assert!(
            worktree.join("out").is_dir(),
            "the good entry of a refused list stays too"
        );
        assert_eq!(
            fs::read_to_string(dir.join("outside/kept")).unwrap(),
            "kept"
        );
        assert!(!dir.join("saved").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    fn sh_git(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(cwd)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn a_save_whose_archive_fails_takes_its_branch_back() {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-rollback-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let repo = dir.join("repo");
        fs::create_dir_all(&repo).unwrap();
        sh_git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh_git(&repo, &["add", "."]);
        sh_git(&repo, &["commit", "-q", "-m", "init"]);
        fs::write(repo.join("a.txt"), "two\n").unwrap();
        let head = sh_git(&repo, &["rev-parse", "HEAD"]);
        let path = repo.to_string_lossy().into_owned();
        let archive_dir = dir.join("saved/one");
        let save = Save {
            worktree: path.clone(),
            primary: path.clone(),
            branch: Some("main".into()),
            unlanded: false,
            head,
            staged: false,
            exclude: Vec::new(),
            archive: vec!["missing.env".into()],
            overwrite: Vec::new(),
            archive_dir: archive_dir.to_string_lossy().into_owned(),
            name: "repo".into(),
            day: "2026-11-12".into(),
        };
        let git = crate::git::run::tests::git();
        let failed = work(&git, save, &Scope::detached()).await;
        assert!(failed.is_err(), "the archive of a missing file fails");
        assert_eq!(
            sh_git(&repo, &["for-each-ref", "refs/heads/ompdesk/"]),
            "",
            "the saved branch was taken back"
        );
        assert!(!archive_dir.exists());
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "two\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
