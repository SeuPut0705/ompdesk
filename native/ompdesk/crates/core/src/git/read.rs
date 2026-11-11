//! The reads themselves: which gits run, in which order, and what is made of their output (was
//! `src/main/local/git/changes.ts`).

use std::collections::HashSet;
use std::hash::{DefaultHasher, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::parse::{self, MAX_FILES};
use super::run::Git;
use crate::fs::disk;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::js_trim;
use crate::run::Output;
use crate::server::Fault;

const MAX_DIFF_BYTES: u64 = 4 * 1024 * 1024;
/// UTF-16 units of a diff the page gets.
const MAX_DIFF_CHARS: usize = 200_000;
const BINARY_SNIFF_BYTES: usize = 8192;

/// A path as node's `path.resolve` spells an absolute one: separators the platform's, `.` and doubled separators
/// dropped, `..` taken back lexically (git prints `C:/x` on Windows).
pub(super) fn native(path: &str) -> String {
    let mut resolved = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    resolved.to_string_lossy().into_owned()
}

/// node's `path.resolve(base, path)` for an absolute `base`: `path` itself when absolute, else joined to `base`.
pub(super) fn resolve(base: &str, path: &str) -> String {
    if is_absolute(path) {
        native(path)
    } else {
        native(&Path::new(base).join(path).to_string_lossy())
    }
}

/// `path.isAbsolute`: on Windows a leading separator or a drive with one counts too.
fn is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        matches!(bytes.first(), Some(b'/' | b'\\'))
            || (bytes.len() > 2
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'/' | b'\\'))
    } else {
        path.starts_with('/')
    }
}

/// Disk work on tokio's blocking pool.
pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The git read's disk work panicked"))
}

/// Worktree top level of `cwd`, or none outside a repository.
pub async fn repo_root(git: &Git, cwd: &str) -> Result<Option<String>, Fault> {
    let output = git.raw(cwd, &["rev-parse", "--show-toplevel"]).await?;
    if output.code != 0 {
        return Ok(None);
    }
    let text = output.text();
    let root = js_trim(&text);
    Ok((!root.is_empty()).then(|| native(root)))
}

/// The main checkout every linked worktree of `cwd`'s repository shares (`--git-common-dir`'s parent, or the common
/// dir itself when it is not a `.git`), as a native path. git's own failure is its fault (`git` threw it).
pub async fn primary_root(git: &Git, cwd: &str) -> Result<String, Fault> {
    let text = git
        .text(
            cwd,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
    let common = native(js_trim(&text));
    let path = Path::new(&common);
    Ok(match (path.file_name(), path.parent()) {
        (Some(name), Some(parent)) if name == ".git" => parent.to_string_lossy().into_owned(),
        _ => common,
    })
}

async fn head_sha(git: &Git, cwd: &str) -> Result<Option<String>, Fault> {
    let output = git
        .raw(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .await?;
    if output.code != 0 {
        return Ok(None);
    }
    let text = output.text();
    let sha = js_trim(&text);
    Ok((!sha.is_empty()).then(|| sha.to_owned()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    is_repo: bool,
    #[serde(flatten)]
    pub(super) summary: parse::Summary,
}

pub async fn status(git: &Git, cwd: &str) -> Result<Status, Fault> {
    let output = git
        .raw(
            cwd,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )
        .await?;
    Ok(if output.code == 0 {
        Status {
            is_repo: true,
            summary: parse::status_v2(&output.text()),
        }
    } else {
        Status {
            is_repo: false,
            summary: parse::Summary::default(),
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub(super) branch: Option<String>,
    pub(super) upstream: Option<String>,
    ahead: u64,
    behind: u64,
    pub(super) operation: Option<&'static str>,
    stashes: usize,
    pub(super) has_remote: bool,
}

/// Which stopped operation (merge, rebase, cherry-pick, revert) waits in `git_dir`, if any.
fn pending_operation(git_dir: &str) -> Option<&'static str> {
    let exists = |name: &str| std::fs::metadata(Path::new(git_dir).join(name)).is_ok();
    if exists("rebase-merge") || exists("rebase-apply") {
        Some("rebase")
    } else if exists("MERGE_HEAD") {
        Some("merge")
    } else if exists("CHERRY_PICK_HEAD") {
        Some("cherry-pick")
    } else if exists("REVERT_HEAD") {
        Some("revert")
    } else {
        None
    }
}

/// Branch, upstream, ahead/behind, stopped operation and stash count of the checkout at `root`.
pub async fn head(git: &Git, root: &str) -> Result<Head, Fault> {
    let (branch_status, git_dir, stashes, remotes) = tokio::try_join!(
        git.text(
            root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=no"
            ]
        ),
        git.text(root, &["rev-parse", "--absolute-git-dir"]),
        git.raw(root, &["stash", "list", "--format=%H"]),
        git.text(root, &["remote"]),
    )?;
    let git_dir = js_trim(&git_dir).to_owned();
    let operation = blocking(move || pending_operation(&git_dir)).await?;
    let branch = parse::branch_headers(&branch_status);
    Ok(Head {
        branch: branch.branch,
        upstream: branch.upstream,
        ahead: branch.ahead,
        behind: branch.behind,
        operation,
        stashes: if stashes.code == 0 {
            stashes
                .text()
                .split('\n')
                .filter(|line| !line.is_empty())
                .count()
        } else {
            0
        },
        has_remote: !js_trim(&remotes).is_empty(),
    })
}

#[derive(Serialize)]
pub struct Fingerprint {
    fingerprint: String,
}

const STATUS_ARGS: [&str; 5] = [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
];
/// False once a git refused `--show-stash` (older than 2.35): it is never asked again.
static SHOW_STASH: AtomicBool = AtomicBool::new(true);

/// The checkout's porcelain status with a `# stash <n>` header (`--show-stash`, in the same process): making or
/// removing a stash changes no file, and the Changes bar shows the count.
async fn checkout_status(git: &Git, cwd: &str) -> Result<Output, Fault> {
    if SHOW_STASH.load(Ordering::Relaxed) {
        let mut args = STATUS_ARGS.to_vec();
        args.push("--show-stash");
        let status = git.raw(cwd, &args).await?;
        if status.code == 0 || !status.stderr.contains("show-stash") {
            return Ok(status);
        }
        SHOW_STASH.store(false, Ordering::Relaxed);
    }
    git.raw(cwd, &STATUS_ARGS).await
}

/// A cheap stand-in for `changes` that the Changes panel polls: one porcelain v2 status (whose `branch.oid` header is
/// the HEAD oid) plus an `lstat` of every listed path, and a `rev-parse --show-toplevel` only when the caller does not
/// pass the root its last full read reported (or passes one that does not hold `cwd`). The stats matter because a
/// file edited again keeps its ` M` status while its line counts and diff move. It changes whenever the full answer
/// may have, and never reads a diff. Its value only compares with this process's own answers.
pub async fn fingerprint(git: &Git, cwd: &str, known: Option<&str>) -> Result<Fingerprint, Fault> {
    // Git reports the root as a real path; the tab's folder may reach it through a symlink (macOS /var, /tmp).
    let known = known.filter(|root| is_absolute(root)).map(native);
    let trusted = match known {
        Some(known) => {
            let folder = cwd.to_owned();
            let real = blocking(move || {
                disk::realpath(&folder)
                    .ok()
                    .map(|real| disk::spelled(&real))
            })
            .await?;
            real.filter(|real| Path::new(real).starts_with(&known))
                .map(|_| known)
        }
        None => None,
    };
    let root = async {
        match trusted {
            Some(root) => Ok(Some(root)),
            None => repo_root(git, cwd).await,
        }
    };
    let (root, status) = tokio::try_join!(root, checkout_status(git, cwd))?;
    let mut hash = DefaultHasher::new();
    let Some(root) = root.filter(|_| status.code == 0) else {
        hash.write(b"not-a-repository");
        return Ok(Fingerprint {
            fingerprint: format!("{:016x}", hash.finish()),
        });
    };
    hash.write(&status.stdout);
    let paths: Vec<String> = parse::status_v2_entries(&status.text())
        .paths()
        .take(MAX_FILES)
        .map(|file| native(&Path::new(&root).join(file).to_string_lossy()))
        .collect();
    let stamps = blocking(move || {
        paths
            .iter()
            .map(|file| {
                disk::lstat(file)
                    .ok()
                    .map(|meta| (disk::mtime_ms(&meta), meta.len()))
            })
            .collect::<Vec<_>>()
    })
    .await?;
    for stamp in stamps {
        hash.write_u8(0);
        match stamp {
            Some((mtime_ms, size)) => {
                hash.write_u64(mtime_ms.to_bits());
                hash.write_u64(size);
            }
            None => hash.write(b"gone"),
        }
    }
    Ok(Fingerprint {
        fingerprint: format!("{:016x}", hash.finish()),
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_path: Option<String>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    removed: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    is_repo: bool,
    root: Option<String>,
    base: Option<String>,
    files: Vec<ChangedFile>,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    head: Option<Head>,
}

/// Net changes from HEAD to the checkout `cwd` is in, untracked files included, with its head.
pub async fn changes(git: &Git, cwd: &str) -> Result<Changes, Fault> {
    // HEAD resolves the same from anywhere in the worktree, so it does not wait for the root.
    let (root, base) = tokio::try_join!(repo_root(git, cwd), head_sha(git, cwd))?;
    let Some(root) = root else {
        return Ok(Changes {
            is_repo: false,
            root: None,
            base: None,
            files: Vec::new(),
            truncated: false,
            head: None,
        });
    };
    let changed = async {
        match &base {
            Some(base) => git
                .text(&root, &["diff", "--name-only", "-z", "--no-renames", base])
                .await
                .map(Some),
            None => Ok(None),
        }
    };
    let numstat = async {
        match &base {
            Some(base) => {
                git.text(
                    &root,
                    &[
                        "diff",
                        "--numstat",
                        "-z",
                        "--find-renames",
                        "--no-ext-diff",
                        base,
                    ],
                )
                .await
            }
            None => Ok(String::new()),
        }
    };
    // Porcelain v2, the one status format this side reads (the footer's counts and the fingerprint too), listed in v1's
    // order; the write side in main keeps its own v1 reader for its own gits.
    let (status, changed, numstat, head) = tokio::try_join!(
        git.text(
            &root,
            &["status", "--porcelain=v2", "-z", "--untracked-files=all"]
        ),
        changed,
        numstat,
        head(git, &root),
    )?;
    let counts = parse::numstat(&numstat);
    // Net change vs HEAD: a file edited then reverted in the worktree shows in status but not here. A staged path
    // stays: the next commit would record it.
    let net: Option<HashSet<&str>> = changed
        .as_deref()
        .map(|names| names.split('\0').filter(|name| !name.is_empty()).collect());
    let mut files: Vec<ChangedFile> = parse::status_v2_entries(&status)
        .in_v1_order()
        .into_iter()
        .filter(|entry| {
            entry.index != ' '
                || entry.old_path.is_some()
                || net.as_ref().map_or(entry.worktree != 'D', |net| {
                    net.contains(entry.path.as_str())
                })
        })
        .map(|entry| {
            let count = counts.get(&entry.path).copied();
            ChangedFile {
                status: format!("{}{}", entry.index, entry.worktree),
                added: count.map(|(added, _)| added),
                removed: count.map(|(_, removed)| removed),
                path: entry.path,
                old_path: entry.old_path,
            }
        })
        .collect();
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    Ok(Changes {
        is_repo: true,
        root: Some(root),
        base,
        files,
        truncated,
        head: Some(head),
    })
}

#[derive(Serialize)]
pub struct Diff {
    path: String,
    diff: String,
    kind: &'static str,
    truncated: bool,
}

impl Diff {
    /// A path answered by its kind alone (binary, large, a symlink, a directory).
    pub(super) fn of_kind(path: &str, kind: &'static str, truncated: bool) -> Diff {
        Diff {
            path: path.to_owned(),
            diff: String::new(),
            kind,
            truncated,
        }
    }

    /// A text diff as the page gets it: its first `MAX_DIFF_CHARS` UTF-16 units, `truncated` when cut here or
    /// before (`cut`).
    pub(super) fn text(path: &str, diff: &str, cut: bool) -> Diff {
        let (kept, half, truncated) = parse::utf16_prefix(diff, MAX_DIFF_CHARS);
        let mut shown = kept.to_owned();
        shown.extend(half);
        Diff {
            path: path.to_owned(),
            diff: shown,
            kind: "text",
            truncated: cut || truncated,
        }
    }
}

/// What the disk says about the changed path before any diff is read.
enum OnDisk {
    /// A symlink, a directory or a file over the cap: answered by its kind alone.
    Kind(&'static str, bool),
    /// A file: whether its first bytes read as binary.
    File {
        binary: bool,
    },
    Missing,
}

/// lstat, real path inside the checkout, size and first bytes, failing as node's calls failed. A missing entry (or
/// root) on the way is `Missing`, as the TypeScript caught `ENOENT` around all of it.
fn inspect(root: &str, absolute: &str) -> Result<OnDisk, Fault> {
    let probe = || -> Result<Result<OnDisk, NodeError>, Fault> {
        let meta = match disk::lstat(absolute) {
            Ok(meta) => meta,
            Err(error) => return Ok(Err(error)),
        };
        if meta.file_type().is_symlink() {
            return Ok(Ok(OnDisk::Kind("symlink", false)));
        }
        if meta.is_dir() {
            return Ok(Ok(OnDisk::Kind("directory", false)));
        }
        let resolved = match disk::realpath(absolute) {
            Ok(resolved) => resolved,
            Err(error) => return Ok(Err(error)),
        };
        let real_root = match disk::realpath(root) {
            Ok(real_root) => real_root,
            Err(error) => return Ok(Err(error)),
        };
        if resolved == real_root || !resolved.starts_with(&real_root) {
            return Err(Fault::new("outside", "File resolves outside this checkout"));
        }
        if meta.len() > MAX_DIFF_BYTES {
            return Ok(Ok(OnDisk::Kind("large", true)));
        }
        Ok(Ok(OnDisk::File { binary: false }))
    };
    match probe()? {
        Err(error) if error.code == "ENOENT" => Ok(OnDisk::Missing),
        Err(error) => Err(error.fault(Codes::None)),
        Ok(OnDisk::File { .. }) => {
            let mut file = disk::open(absolute).map_err(|error| error.fault(Codes::None))?;
            let mut header = vec![0; BINARY_SNIFF_BYTES];
            let read = disk::read_into(&mut file, &mut header)
                .map_err(|error| error.fault(Codes::None))?;
            Ok(OnDisk::File {
                binary: parse::is_probably_binary(&header[..read]),
            })
        }
        Ok(other) => Ok(other),
    }
}

/// One changed path's diff against HEAD; never follows a symlink out of the checkout. Main checked that `file_path`
/// is a safe relative path (`isSafeRelativePath`).
pub async fn diff(git: &Git, cwd: &str, file_path: &str) -> Result<Diff, Fault> {
    let changes = changes(git, cwd).await?;
    let entry = changes
        .files
        .iter()
        .find(|file| file.path == file_path)
        .cloned();
    let (Some(root), Some(entry)) = (changes.root, entry) else {
        return Err(Fault::new(
            "not_changed",
            "This file is no longer in the changed file list. Refresh to continue.",
        ));
    };
    let answer = |kind: &'static str, truncated: bool| Diff::of_kind(file_path, kind, truncated);
    let absolute = native(&Path::new(&root).join(file_path).to_string_lossy());
    let exists = {
        let (root, absolute) = (root.clone(), absolute.clone());
        match blocking(move || inspect(&root, &absolute)).await?? {
            OnDisk::Kind(kind, truncated) => return Ok(answer(kind, truncated)),
            OnDisk::File { binary: true } => return Ok(answer("binary", false)),
            OnDisk::File { binary: false } => true,
            OnDisk::Missing => false,
        }
    };
    let base = changes.base.as_deref();
    let is_new = base.is_none() || entry.status == "??" || entry.status.starts_with('A');
    if let (false, Some(base)) = (is_new, base) {
        let spec = format!("{base}:{}", entry.old_path.as_deref().unwrap_or(file_path));
        let size = git.raw(&root, &["cat-file", "-s", &spec]).await?;
        if size.code == 0 {
            // `Number(text) > cap`: text that is no number is never over it.
            let bytes = js_trim(&size.text()).parse::<f64>().unwrap_or(f64::NAN);
            if bytes > MAX_DIFF_BYTES as f64 {
                return Ok(answer("large", true));
            }
            let old = git
                .capped(&root, &["cat-file", "blob", &spec], BINARY_SNIFF_BYTES)
                .await?;
            if parse::is_probably_binary(&old.stdout) {
                return Ok(answer("binary", false));
            }
        }
    }
    let mut diff = if is_new {
        let content = if exists {
            let file = absolute.clone();
            blocking(move || {
                std::fs::read(&file).map_err(|error| NodeError::new(&error, "open", Some(&file)))
            })
            .await?
            .map_err(|error| error.fault(Codes::None))?
        } else {
            Vec::new()
        };
        parse::new_file_diff(&String::from_utf8_lossy(&content))
    } else {
        let mut args = vec![
            "diff".to_owned(),
            "--no-color".into(),
            "--no-ext-diff".into(),
            "--find-renames".into(),
            "-U3".into(),
            base.unwrap_or_default().to_owned(),
            "--".into(),
            format!(":(literal){file_path}"),
        ];
        if let Some(old) = &entry.old_path {
            args.push(format!(":(literal){old}"));
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw = git.capped(&root, &args, MAX_DIFF_BYTES as usize).await?;
        if raw.code != 0 {
            let stderr = js_trim(&raw.stderr);
            return Err(Fault::new(
                "git_failed",
                if stderr.is_empty() {
                    "git diff failed"
                } else {
                    stderr
                },
            ));
        }
        raw.text()
    };
    // A content-identical rename diffs empty: keep what the status says.
    if diff.is_empty()
        && let Some(old) = &entry.old_path
    {
        diff = format!("rename from {old}\nrename to {file_path}");
    }
    Ok(Diff::text(file_path, &diff, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run::tests::git;

    #[test]
    fn spells_paths_as_node_resolves_them() {
        assert_eq!(native("/a//b/./c/"), "/a/b/c");
        assert!(is_absolute("/x"));
        assert!(!is_absolute("relative/root"));
    }

    // Rows from node's `path.resolve(base, path)` (node 24, POSIX), which `origin.ts` and `changes.ts` called.
    #[cfg(unix)]
    #[test]
    fn resolves_a_git_dir_as_node_did() {
        for (base, path, resolved) in [
            ("/a/b", "../c", "/a/c"),
            ("/a", "/x/./y/", "/x/y"),
            ("/a/b", ".git", "/a/b/.git"),
            ("/a/b", "../../..", "/"),
            (
                "/w/repo/sub",
                "../.git/worktrees/x",
                "/w/repo/.git/worktrees/x",
            ),
            ("/", "x//y", "/x/y"),
        ] {
            assert_eq!(resolve(base, path), resolved, "{base} {path}");
        }
    }

    #[tokio::test]
    async fn answers_outside_a_repository() {
        let dir = std::env::temp_dir().join(format!("ompdesk-core-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();
        let git = git();
        let changes = serde_json::to_value(changes(&git, cwd).await.unwrap()).unwrap();
        assert_eq!(
            changes,
            serde_json::json!({ "isRepo": false, "root": null, "base": null, "files": [], "truncated": false })
        );
        let status = serde_json::to_value(status(&git, cwd).await.unwrap()).unwrap();
        assert_eq!(
            status,
            serde_json::json!({ "isRepo": false, "branch": null, "staged": 0, "unstaged": 0, "untracked": 0 })
        );
        let one = fingerprint(&git, cwd, None).await.unwrap().fingerprint;
        assert_eq!(fingerprint(&git, cwd, None).await.unwrap().fingerprint, one);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
