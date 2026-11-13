//! What `ompdesk_compare`, `ompdesk_merge`, the review queue and the orphan list know about a session's worktree (was
//! the git logic of `src/main/agent-control/branches.ts`): where its work lands and whether it landed (by ancestry,
//! or by content: a squash merge, a rebase, a cherry-pick), its facts and diff, a merge's prediction by `merge-tree
//! --write-tree` in a scratch object store, the merge's git steps, and the removals that lose nothing. Main keeps what
//! is its own: the merge hooks (`worktree-seed.ts`), the `prepare` that archives before a removal, the removal claim
//! and the repository lock (`worktree-orphans.ts`), and `mergeProblem`, a rule over facts that `service.ts` reads too.
//! A `BranchError` of the TypeScript is the fault `branch_error`, with its message.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

use super::parse;
use super::read::{self, blocking};
use super::run::Git;
use crate::fs::disk;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::js_trim;
use crate::run::{Opts, Output};
use crate::server::Fault;

/// Each git that `text` runs, a merge, the merge trees and the patch reads may take this long.
const TIMEOUT_MS: u64 = 120_000;
const MAX_FILES: usize = 200;
/// Bytes of patch text one landing check reads; a bigger diff is not judged landed by it.
const PATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONTENT_VERDICTS: usize = 256;

/// The worktree binding of a tab (`IpcTabWorktree`): the checkout, its branch and the repo it forked from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    pub path: String,
    pub branch: String,
    pub base_cwd: String,
}

fn slow() -> Opts<'static> {
    Opts {
        timeout_ms: Some(TIMEOUT_MS),
        ..Opts::default()
    }
}

pub fn branch_error(message: impl Into<String>) -> Fault {
    Fault::new("branch_error", message)
}

fn is_cancel(fault: &Fault) -> bool {
    fault.code == "cancelled"
}

/// `fs.realpath` as node spells the answer.
pub(super) fn real(path: &str) -> Result<String, NodeError> {
    disk::realpath(path).map(|resolved| disk::spelled(&resolved))
}

/// git's stdout trimmed, failing with git's own words (`text` of the TypeScript), at the slow timeout.
async fn text(git: &Git, cwd: &str, args: &[&str]) -> Result<String, Fault> {
    let output = git.text_with(cwd, args, slow()).await?;
    Ok(js_trim(&output).to_owned())
}

fn trimmed(output: &Output) -> String {
    js_trim(&output.text()).to_owned()
}

/// `git status --porcelain` lines of tracked changes and the untracked count.
#[derive(Debug, PartialEq, Deserialize)]
pub struct Dirt {
    tracked: usize,
    untracked: usize,
}

fn count_dirt(output: &str) -> Dirt {
    let lines: Vec<&str> = js_trim(output)
        .split('\n')
        .filter(|line| !line.is_empty())
        .collect();
    let untracked = lines.iter().filter(|line| line.starts_with("?? ")).count();
    Dirt {
        tracked: lines.len() - untracked,
        untracked,
    }
}

async fn dirtiness(git: &Git, cwd: &str) -> Result<Dirt, Fault> {
    let args = ["status", "--porcelain=v1", "--untracked-files=all"];
    Ok(count_dirt(&git.text_with(cwd, &args, slow()).await?))
}

/// A tracked file that differs from where the branch left the parent. The one definition, for git and for agent
/// control (which reads it back from main's JSON).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileChange {
    pub path: String,
    pub added: u64,
    pub removed: u64,
}

/// `Number(count) || 0` of a count git printed (digits, or `-` for a binary file).
fn count(text: &str) -> u64 {
    parse::digits(js_trim(text)).unwrap_or(0)
}

/// `diff --numstat` lines: counts, then the path (everything after the second tab).
fn numstat(output: &str) -> Vec<FileChange> {
    output
        .split('\n')
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let (added, removed, file) = (fields.next()?, fields.next()?, fields.next()?);
            (!file.is_empty()).then(|| FileChange {
                path: file.to_owned(),
                added: count(added),
                removed: count(removed),
            })
        })
        .collect()
}

/// Whether `commit` is in the history of `reference` (both read in `cwd`'s repository).
async fn contains(git: &Git, cwd: &str, reference: &str, commit: &str) -> Result<bool, Fault> {
    let output = git
        .raw(cwd, &["merge-base", "--is-ancestor", commit, reference])
        .await?;
    Ok(output.code == 0)
}

/// The commit `rev` names in `cwd`'s repository, or none when it names none.
async fn resolve(git: &Git, cwd: &str, rev: &str) -> Result<Option<String>, Fault> {
    let wanted = format!("{rev}^{{commit}}");
    let output = git
        .raw(cwd, &["rev-parse", "--verify", "-q", &wanted])
        .await?;
    let sha = trimmed(&output);
    Ok((output.code == 0 && !sha.is_empty()).then_some(sha))
}

/// What a child's work lands in: the parent checkout's branch (none while detached) and HEAD, and the tip of that
/// branch's `@{upstream}`, else of `origin`'s default branch as last fetched. Agents push there while the parent's own
/// checkout stays where it was, so only this ref knows their work landed.
struct Base {
    branch: Option<String>,
    head: String,
    upstream: Option<String>,
}

/// Reads the parent's base refs; never fetches or moves anything.
async fn read_base(git: &Git, base_cwd: &str) -> Result<Base, Fault> {
    let symbolic = git
        .raw(base_cwd, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await?;
    let name = trimmed(&symbolic);
    let branch = (symbolic.code == 0 && !name.is_empty()).then_some(name);
    let tracked = async {
        match &branch {
            // `<branch>@{upstream}` wants the short name: `refs/heads/<branch>@{upstream}` names nothing.
            Some(branch) => resolve(git, base_cwd, &format!("{branch}@{{upstream}}")).await,
            None => Ok(None),
        }
    };
    let (head, tracked, remote) = tokio::try_join!(
        text(git, base_cwd, &["rev-parse", "HEAD"]),
        tracked,
        resolve(git, base_cwd, "refs/remotes/origin/HEAD"),
    )?;
    Ok(Base {
        branch,
        head,
        upstream: tracked.or(remote),
    })
}

/// Verdicts of `landed_by_content` per (target, tip) commit pair: both are immutable, and the review sweep asks every
/// 10 s. The oldest goes first.
#[derive(Default)]
struct Verdicts {
    known: HashMap<String, bool>,
    order: VecDeque<String>,
}

static VERDICTS: LazyLock<Mutex<Verdicts>> = LazyLock::new(Mutex::default);

fn verdicts() -> std::sync::MutexGuard<'static, Verdicts> {
    VERDICTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A private object store `<temp>/ompdesk-merge-tree-XXXXXX` that `merge-tree --write-tree` writes the trees it builds
/// to, with the repository's store as a read-only alternate, so a prediction or a landing check leaves no object in
/// the repository. Removed when dropped: after the git that wrote there exited (`run` returns only then), inside the
/// request, so before it answers, also after a failure, a timeout or a cancel.
struct Scratch(PathBuf);

impl Scratch {
    async fn new() -> Result<Scratch, Fault> {
        blocking(|| disk::make_temp_dir("ompdesk-merge-tree-"))
            .await?
            .map(Scratch)
            .map_err(|error| error.fault(Codes::None))
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Folders git may read objects from besides the scratch one: the repo's own store and any the environment main
/// handed over tells git to borrow.
async fn object_stores(git: &Git, base_cwd: &str) -> Result<String, Fault> {
    let own = match git.env("GIT_OBJECT_DIRECTORY") {
        Some(own) => own.to_owned(),
        None => {
            let args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
            read::resolve(&text(git, base_cwd, &args).await?, "objects")
        }
    };
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    let stores: Vec<&str> = [
        Some(own.as_str()),
        git.env("GIT_ALTERNATE_OBJECT_DIRECTORIES"),
    ]
    .into_iter()
    .flatten()
    .filter(|store| !store.is_empty())
    .collect();
    Ok(stores.join(delimiter))
}

/// `merge-tree --write-tree` in `cwd` into `scratch`, at the slow timeout.
async fn merge_tree(
    git: &Git,
    cwd: &str,
    args: &[&str],
    scratch: &Scratch,
    stores: &str,
) -> Result<Output, Fault> {
    let dir = scratch.path();
    let env = [
        ("GIT_OBJECT_DIRECTORY", dir.as_str()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", stores),
    ];
    let opts = Opts {
        timeout_ms: Some(TIMEOUT_MS),
        env: &env,
        ..Opts::default()
    };
    git.run(cwd, args, opts).await
}

/// The tree a merge of `tip` into `target` would make is `target`'s own tree: merging adds nothing.
async fn merges_add_nothing(git: &Git, cwd: &str, target: &str, tip: &str) -> Result<bool, Fault> {
    let scratch = Scratch::new().await?;
    let stores = object_stores(git, cwd).await?;
    // Exit 0 prints the merged tree first; a conflict exits 1, and git older than 2.38 has no `--write-tree`.
    let args = ["merge-tree", "--write-tree", target, tip];
    let merged = merge_tree(git, cwd, &args, &scratch, &stores).await?;
    if merged.code != 0 {
        return Ok(false);
    }
    let text = merged.text();
    let merged_tree = js_trim(text.split('\n').next().unwrap_or_default());
    if merged_tree.is_empty() {
        return Ok(false);
    }
    let wanted = format!("{target}^{{tree}}");
    let target_tree = git
        .raw(cwd, &["rev-parse", "--verify", "-q", &wanted])
        .await?;
    Ok(target_tree.code == 0 && trimmed(&target_tree) == merged_tree)
}

/// Every line of `git cherry` is `-`: each commit has a patch-equivalent in the target.
fn all_picked(output: &str) -> bool {
    let mut lines = output
        .split('\n')
        .filter(|line| !line.is_empty())
        .peekable();
    lines.peek().is_some() && lines.all(|line| line.starts_with('-'))
}

/// Every commit of `tip` has a patch-equivalent in `target`: a rebase or cherry-pick landed it.
async fn patches_all_in(git: &Git, cwd: &str, target: &str, tip: &str) -> Result<bool, Fault> {
    let cherry = git.raw(cwd, &["cherry", target, tip]).await?;
    Ok(cherry.code == 0 && all_picked(&cherry.text()))
}

/// The first column of each line of `git patch-id` output.
fn patch_id_column(output: &str) -> Vec<&str> {
    output
        .split('\n')
        .map(|line| line.split(' ').next().unwrap_or_default())
        .filter(|id| !id.is_empty())
        .collect()
}

/// Pipes `input` through `git patch-id --stable`; the ids of its patches.
async fn patch_ids(git: &Git, cwd: &str, input: &[u8]) -> Result<Option<Vec<String>>, Fault> {
    let opts = Opts {
        timeout_ms: Some(TIMEOUT_MS),
        max_bytes: Some(PATCH_BYTES),
        input: Some(input),
        ..Opts::default()
    };
    let result = git.run(cwd, &["patch-id", "--stable"], opts).await?;
    if result.code != 0 {
        return Ok(None);
    }
    let text = result.text();
    Ok(Some(
        patch_id_column(&text)
            .into_iter()
            .map(str::to_owned)
            .collect(),
    ))
}

/// A squash merge: the whole change `tip` made since its merge-base with `target` has the patch-id of one commit that
/// `target` gained since. Holds after `target` edited the same lines, where the merge-tree and `git cherry` tests fail.
async fn squashed_into(git: &Git, cwd: &str, target: &str, tip: &str) -> Result<bool, Fault> {
    let found = git.raw(cwd, &["merge-base", target, tip]).await?;
    let base = trimmed(&found);
    if found.code != 0 || base.is_empty() {
        return Ok(false);
    }
    let capped = Opts {
        timeout_ms: Some(TIMEOUT_MS),
        max_bytes: Some(PATCH_BYTES),
        ..Opts::default()
    };
    let range = format!("{base}..{target}");
    let diff_args = ["diff", base.as_str(), tip];
    let log_args = ["log", "-p", "--no-merges", "--format=commit %H", &range];
    let (own, log) = tokio::try_join!(
        git.run(cwd, &diff_args, capped),
        git.run(cwd, &log_args, capped),
    )?;
    if own.code != 0 || log.code != 0 || own.truncated || log.truncated || own.stdout.is_empty() {
        return Ok(false);
    }
    let (mine, theirs) = tokio::try_join!(
        patch_ids(git, cwd, &own.stdout),
        patch_ids(git, cwd, &log.stdout)
    )?;
    let id = mine.and_then(|ids| ids.into_iter().next());
    Ok(id.is_some_and(|id| theirs.is_some_and(|theirs| theirs.contains(&id))))
}

/// Whether `target` already holds what `tip` changed although `tip` is not in its history: merging adds nothing, its
/// whole patch is one commit of `target` (a squash), or every commit has a patch-equivalent there (a rebase or
/// cherry-pick). Both are commit ids, so the verdict is kept.
async fn landed_by_content(git: &Git, cwd: &str, target: &str, tip: &str) -> Result<bool, Fault> {
    let key = format!("{target} {tip}");
    if let Some(known) = verdicts().known.get(&key) {
        return Ok(*known);
    }
    let verdict = merges_add_nothing(git, cwd, target, tip).await?
        || patches_all_in(git, cwd, target, tip).await?
        || squashed_into(git, cwd, target, tip).await?;
    let mut kept = verdicts();
    if !kept.known.contains_key(&key) {
        if kept.known.len() >= MAX_CONTENT_VERDICTS
            && let Some(oldest) = kept.order.pop_front()
        {
            kept.known.remove(&oldest);
        }
        kept.order.push_back(key.clone());
    }
    kept.known.insert(key, verdict);
    Ok(verdict)
}

struct Landing {
    landed: bool,
    /// Landed by content, not by ancestry.
    squashed: bool,
    diff_base: String,
}

/// Where the child's own work starts: the base that already holds its tip when it landed (so only uncommitted work is
/// left), else the upstream when it holds the parent's HEAD (a stale local branch never lends the child the upstream's
/// newer commits), else the parent's HEAD. A tip in no base's history has still landed when a base holds its changes;
/// the work is then measured from the tip itself.
async fn landing(git: &Git, cwd: &str, base: &Base, tip: &str) -> Result<Landing, Fault> {
    let Base { head, upstream, .. } = base;
    let in_upstream = async {
        match upstream {
            Some(upstream) => contains(git, cwd, upstream, tip).await,
            None => Ok(false),
        }
    };
    let head_in_upstream = async {
        match upstream {
            Some(upstream) => contains(git, cwd, upstream, head).await,
            None => Ok(false),
        }
    };
    let (in_upstream, in_head, head_in_upstream) =
        tokio::try_join!(in_upstream, contains(git, cwd, head, tip), head_in_upstream)?;
    if let Some(upstream) = upstream.as_ref().filter(|_| in_upstream) {
        return Ok(Landing {
            landed: true,
            squashed: false,
            diff_base: upstream.clone(),
        });
    }
    if in_head {
        return Ok(Landing {
            landed: true,
            squashed: false,
            diff_base: head.clone(),
        });
    }
    for target in upstream.iter().chain([head]) {
        if landed_by_content(git, cwd, target, tip).await? {
            return Ok(Landing {
                landed: true,
                squashed: true,
                diff_base: tip.to_owned(),
            });
        }
    }
    let diff_base = match upstream {
        Some(upstream) if head_in_upstream => upstream.clone(),
        _ => head.clone(),
    };
    Ok(Landing {
        landed: false,
        squashed: false,
        diff_base,
    })
}

/// Where a child's work starts, measured the way `facts` and `evidence` both read it.
struct Measure {
    base: Base,
    tip: String,
    landed: bool,
    merge_base: String,
}

async fn measure(git: &Git, worktree: &WorktreeRef) -> Result<Measure, Fault> {
    let (base, tip) = tokio::try_join!(
        read_base(git, &worktree.base_cwd),
        text(git, &worktree.path, &["rev-parse", "HEAD"]),
    )?;
    let Landing {
        landed, diff_base, ..
    } = landing(git, &worktree.path, &base, &tip).await?;
    let merge_base = text(git, &worktree.path, &["merge-base", &tip, &diff_base]).await?;
    Ok(Measure {
        base,
        tip,
        landed,
        merge_base,
    })
}

/// `BranchFacts`: what git says about a child's branch. The one definition, for git and for agent control.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchFacts {
    pub branch: String,
    /// The parent checkout's current branch; none while its HEAD is detached.
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub commits_ahead: u64,
    #[serde(default)]
    pub files: Vec<FileChange>,
    #[serde(default)]
    pub files_truncated: bool,
    #[serde(default)]
    pub uncommitted: usize,
    #[serde(default)]
    pub untracked: usize,
    #[serde(default)]
    pub base_uncommitted: usize,
    #[serde(default)]
    pub merged: bool,
}

pub async fn facts(git: &Git, worktree: &WorktreeRef) -> Result<BranchFacts, Fault> {
    let Measure {
        base,
        tip,
        landed,
        merge_base,
    } = measure(git, worktree).await?;
    let range = format!("{merge_base}..{tip}");
    let ahead_args = ["rev-list", "--count", &range];
    let numstat_args = ["diff", "--numstat", "--no-renames", &merge_base];
    let (ahead, numstat_text, own, parent) = tokio::try_join!(
        text(git, &worktree.path, &ahead_args),
        text(git, &worktree.path, &numstat_args),
        dirtiness(git, &worktree.path),
        dirtiness(git, &worktree.base_cwd),
    )?;
    let mut files = numstat(&numstat_text);
    let files_truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    Ok(BranchFacts {
        branch: worktree.branch.clone(),
        base_branch: base.branch,
        commits_ahead: count(&ahead),
        files,
        files_truncated,
        uncommitted: own.tracked,
        untracked: own.untracked,
        base_uncommitted: parent.tracked,
        merged: landed,
    })
}

/// What merging a branch into the parent checkout's HEAD would do, without doing it.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Prediction {
    Clean,
    Conflict { files: Vec<String> },
    Unknown { reason: String },
}

/// `merge-tree --write-tree --name-only -z` with conflicts: `<tree oid>\0<name>\0<name>\0…`, a name once per
/// conflicting stage; each name once, in git's order.
fn conflicted(output: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for name in output.split('\0').skip(1) {
        if !name.is_empty() && !files.iter().any(|file| file == name) {
            files.push(name.to_owned());
        }
    }
    files
}

async fn predict_with(
    git: &Git,
    worktree: &WorktreeRef,
    scratch: &Scratch,
) -> Result<Prediction, Fault> {
    let theirs = format!("refs/heads/{}", worktree.branch);
    let (ours, theirs, stores) = tokio::try_join!(
        resolve(git, &worktree.base_cwd, "HEAD"),
        resolve(git, &worktree.base_cwd, &theirs),
        object_stores(git, &worktree.base_cwd),
    )?;
    let (Some(ours), Some(theirs)) = (&ours, &theirs) else {
        let missing = if ours.is_some() {
            worktree.branch.as_str()
        } else {
            "HEAD"
        };
        return Ok(Prediction::Unknown {
            reason: format!("{missing} names no commit"),
        });
    };
    let args = [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        "--no-messages",
        ours,
        theirs,
    ];
    let result = merge_tree(git, &worktree.base_cwd, &args, scratch, &stores).await?;
    Ok(match result.code {
        0 => Prediction::Clean,
        1 => Prediction::Conflict {
            files: conflicted(&result.text()),
        },
        code => {
            let reason = js_trim(&result.stderr);
            Prediction::Unknown {
                reason: if reason.is_empty() {
                    format!("git merge-tree exited {code}")
                } else {
                    reason.to_owned()
                },
            }
        }
    })
}

/// Whether merging the branch into the parent checkout's HEAD would conflict, asked of `git merge-tree --write-tree`
/// (idea: Orca) with its trees in a scratch store: the repo's own object store, index and refs stay as they were. A
/// failure is `unknown` with its message; only a cancel fails the call.
pub async fn predict(git: &Git, worktree: &WorktreeRef) -> Result<Prediction, Fault> {
    let scratch = Scratch::new().await?;
    match predict_with(git, worktree, &scratch).await {
        Err(fault) if !is_cancel(&fault) => Ok(Prediction::Unknown {
            reason: fault.message,
        }),
        outcome => outcome,
    }
}

/// What a merge needs before its hooks run: the parent's branch, or the refusal `merge_problem` gives (a
/// `branch_error`), and `git merge-tree`'s prediction.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCheck {
    base_branch: Option<String>,
    merge: Prediction,
}

/// A merge's checks before anything is touched (`mergeBranch`'s first steps): the branch's facts, what a merge
/// would lose or tangle (refused), then the prediction.
pub async fn merge_check(git: &Git, worktree: &WorktreeRef) -> Result<MergeCheck, Fault> {
    let facts = facts(git, worktree).await?;
    if let Some(problem) = merge_problem(worktree, &facts) {
        return Err(branch_error(problem));
    }
    Ok(MergeCheck {
        base_branch: facts.base_branch,
        merge: predict(git, worktree).await?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    diff: String,
    diff_omitted: usize,
    merge: Prediction,
}

/// The child's diff cut to `diff_chars` (`git diff <mergeBase>` in its worktree, the committed and uncommitted
/// tracked work `facts` counts, cut fairly across files by `bound_diff`; git's own output is capped, and a capped one
/// still counts as cut), and what merging it would do. `diff_chars` 0 reads no diff.
pub async fn evidence(
    git: &Git,
    worktree: &WorktreeRef,
    diff_chars: usize,
) -> Result<Evidence, Fault> {
    let shown = async {
        if diff_chars == 0 {
            return Ok((String::new(), false));
        }
        let Measure { merge_base, .. } = measure(git, worktree).await?;
        let opts = Opts {
            timeout_ms: Some(TIMEOUT_MS),
            max_bytes: Some(MAX_DIFF_BYTES),
            ..Opts::default()
        };
        let args = [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            &merge_base,
        ];
        let raw = git.run(&worktree.path, &args, opts).await?;
        if raw.code != 0 {
            let stderr = js_trim(&raw.stderr);
            let reason = if stderr.is_empty() {
                format!("exit {}", raw.code)
            } else {
                stderr.to_owned()
            };
            return Err(branch_error(format!("git diff failed: {reason}")));
        }
        Ok((raw.text(), raw.truncated))
    };
    // Both run to their end, so the prediction's scratch store goes before the request answers either way.
    let (shown, merge) = tokio::join!(shown, predict(git, worktree));
    let (raw, truncated) = shown?;
    let (diff, omitted) = bound_diff(&raw, diff_chars);
    Ok(Evidence {
        diff,
        diff_omitted: if truncated { omitted.max(1) } else { omitted },
        merge: merge?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingFacts {
    has_work: bool,
    landed: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    squashed: bool,
    clean: bool,
}

/// The commit a branch was created at (its oldest reflog entry), or none without a reflog.
async fn created_at(git: &Git, base_cwd: &str, branch: &str) -> Result<Option<String>, Fault> {
    let reference = format!("refs/heads/{branch}");
    let reflog = git
        .raw(base_cwd, &["reflog", "show", "--format=%H", &reference])
        .await?;
    Ok(reflog
        .text()
        .split('\n')
        .rfind(|line| !line.is_empty())
        .map(str::to_owned))
}

/// A failure read as none, as `.catch(() => null)` did; a cancel still fails.
fn or_none<T>(outcome: Result<T, Fault>) -> Result<Option<T>, Fault> {
    match outcome {
        Ok(value) => Ok(Some(value)),
        Err(fault) if is_cancel(&fault) => Err(fault),
        Err(_) => Ok(None),
    }
}

/// Whether a child's work has landed (its tip in the parent's HEAD or upstream, by ancestry or by content), whether
/// it has work at all (its tip is not where the branch was created; without a reflog nothing counts as work) and
/// whether the worktree is clean; and the tip it judged (none when the branch names no commit).
async fn judge_landing(
    git: &Git,
    worktree: &WorktreeRef,
) -> Result<(LandingFacts, Option<String>), Fault> {
    let reference = format!("refs/heads/{}", worktree.branch);
    let Some(tip) = resolve(git, &worktree.base_cwd, &reference).await? else {
        let facts = LandingFacts {
            has_work: false,
            landed: false,
            squashed: false,
            clean: false,
        };
        return Ok((facts, None));
    };
    let (base, created, own) = tokio::try_join!(
        read_base(git, &worktree.base_cwd),
        created_at(git, &worktree.base_cwd, &worktree.branch),
        async { or_none(dirtiness(git, &worktree.path).await) },
    )?;
    let state = landing(git, &worktree.base_cwd, &base, &tip).await?;
    let facts = LandingFacts {
        has_work: created.is_some_and(|created| created != tip),
        landed: state.landed,
        squashed: state.squashed,
        clean: own.is_some_and(|own| own.tracked == 0 && own.untracked == 0),
    };
    Ok((facts, Some(tip)))
}

pub async fn landing_facts(git: &Git, worktree: &WorktreeRef) -> Result<LandingFacts, Fault> {
    Ok(judge_landing(git, worktree).await?.0)
}

/// A linked worktree as the orphan listing sees it: its branch is none on a detached HEAD.
pub struct Standing {
    pub has_work: bool,
    pub landed: bool,
    pub squashed: bool,
    pub commits_ahead: u64,
    pub dirty_files: usize,
}

/// `landing_facts` and `facts` for the worktree's HEAD in one read, whether or not it has a branch.
pub async fn standing(
    git: &Git,
    path: &str,
    branch: Option<&str>,
    base_cwd: &str,
) -> Result<Standing, Fault> {
    let (base, tip) = tokio::try_join!(
        read_base(git, base_cwd),
        text(git, path, &["rev-parse", "HEAD"])
    )?;
    let created = async {
        match branch {
            Some(branch) => created_at(git, base_cwd, branch).await,
            None => Ok(None),
        }
    };
    // Joined to the end, not `try_join!`: a failing sibling must not drop the landing check while its `merge-tree`
    // still writes into the scratch store it owns.
    let (state, created, own) = tokio::join!(
        landing(git, base_cwd, &base, &tip),
        created,
        dirtiness(git, path),
    );
    let (state, created, own) = (state?, created?, own?);
    let commits_ahead = if state.landed {
        0
    } else {
        let not_in = format!("^{}", state.diff_base);
        count(&text(git, base_cwd, &["rev-list", "--count", &tip, &not_in]).await?)
    };
    Ok(Standing {
        has_work: created.is_some_and(|created| created != tip),
        landed: state.landed,
        squashed: state.squashed,
        commits_ahead,
        dirty_files: own.tracked + own.untracked,
    })
}

/// What a safe removal did: worktree and branch gone, or the worktree gone but the branch kept (asked to, or it moved
/// after its landing was judged). None: nothing went.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Removal {
    Removed,
    BranchKept,
}

/// `git worktree remove` without `--force` of `path`, only when git lists it as a linked worktree of the repository at
/// `base_cwd` (the primary checkout never goes); git itself refuses one with uncommitted or untracked files or locked.
/// The primary checkout's path when the worktree went.
pub async fn remove_linked(git: &Git, base_cwd: &str, path: &str) -> Result<Option<String>, Fault> {
    let listed = text(git, base_cwd, &["worktree", "list", "--porcelain"]).await?;
    let entries: Vec<String> = listed
        .split('\n')
        .filter_map(|line| line.strip_prefix("worktree "))
        .map(str::to_owned)
        .collect();
    let wanted = path.to_owned();
    let (listed, wanted) = blocking(move || {
        let listed: Vec<String> = entries
            .into_iter()
            .map(|entry| real(&entry).unwrap_or(entry))
            .collect();
        let wanted = real(&wanted).unwrap_or(wanted);
        (listed, wanted)
    })
    .await?;
    let Some((primary, linked)) = listed.split_first() else {
        return Ok(None);
    };
    if !linked.contains(&wanted) {
        return Ok(None);
    }
    let removed = git
        .run(primary, &["worktree", "remove", &wanted], slow())
        .await?;
    Ok((removed.code == 0).then(|| primary.clone()))
}

/// `update-ref -d` of `reference` against the very tip judged, so a branch something moved meanwhile stays.
async fn delete_at(git: &Git, primary: &str, reference: &str, tip: &str) -> Result<Removal, Fault> {
    let deleted = git
        .raw(primary, &["update-ref", "-d", reference, tip])
        .await?;
    Ok(if deleted.code == 0 {
        Removal::Removed
    } else {
        Removal::BranchKept
    })
}

/// Remove an agent session's worktree and its branch, losing nothing: only a registered linked worktree with no
/// uncommitted or untracked file whose work has landed in the parent's HEAD or upstream goes. `judge_landing` is the
/// one judge of landed; the branch goes with `update-ref -d` against the tip it judged, never `branch -d`.
pub async fn remove_safe(
    git: &Git,
    worktree: &WorktreeRef,
    keep_branch: bool,
) -> Result<Option<Removal>, Fault> {
    let (facts, tip) = judge_landing(git, worktree).await?;
    let Some(tip) = tip.filter(|_| facts.landed && facts.clean) else {
        return Ok(None);
    };
    let Some(primary) = remove_linked(git, &worktree.base_cwd, &worktree.path).await? else {
        return Ok(None);
    };
    if keep_branch {
        return Ok(Some(Removal::BranchKept));
    }
    let reference = format!("refs/heads/{}", worktree.branch);
    Ok(Some(delete_at(git, &primary, &reference, &tip).await?))
}

/// A worktree an open just made and nobody used, as its `prepare` hears of it.
#[derive(Serialize)]
pub struct Discardable {
    path: String,
    repo: String,
    tip: String,
}

/// Whether the worktree is one nobody used: its branch's reflog holds just the entry that created it and its HEAD is
/// still there. Its real path, the repository's main checkout (`/^worktree (.+)$/m` of git's list) and that tip.
pub async fn discard_check(
    git: &Git,
    worktree: &WorktreeRef,
) -> Result<Option<Discardable>, Fault> {
    let reference = format!("refs/heads/{}", worktree.branch);
    let log = git
        .raw(
            &worktree.base_cwd,
            &["reflog", "show", "--format=%H", &reference],
        )
        .await?;
    if log.code != 0 {
        return Ok(None);
    }
    let text_out = log.text();
    let entries: Vec<&str> = text_out
        .split('\n')
        .filter(|line| !line.is_empty())
        .collect();
    let &[tip] = entries.as_slice() else {
        return Ok(None);
    };
    let head = or_none(text(git, &worktree.path, &["rev-parse", "HEAD"]).await)?;
    if head.as_deref() != Some(tip) {
        return Ok(None);
    }
    let listed = text(
        git,
        &worktree.base_cwd,
        &["worktree", "list", "--porcelain"],
    )
    .await?;
    let repo = parse::first_worktree(&listed)
        .unwrap_or(&worktree.base_cwd)
        .to_owned();
    let wanted = worktree.path.clone();
    let path = blocking(move || real(&wanted).unwrap_or(wanted)).await?;
    Ok(Some(Discardable {
        path,
        repo,
        tip: tip.to_owned(),
    }))
}

/// The removal `discard_check` cleared: the worktree without `--force`, then the branch against the tip it read.
/// None when the worktree stayed.
pub async fn discard_remove(
    git: &Git,
    worktree: &WorktreeRef,
    tip: &str,
) -> Result<Option<Removal>, Fault> {
    let Some(primary) = remove_linked(git, &worktree.base_cwd, &worktree.path).await? else {
        return Ok(None);
    };
    let reference = format!("refs/heads/{}", worktree.branch);
    Ok(Some(delete_at(git, &primary, &reference, tip).await?))
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum Merged {
    Done {
        merged: bool,
        sha: String,
        summary: String,
    },
    Conflict {
        merged: bool,
        reason: &'static str,
        files: Vec<String>,
        predicted: bool,
    },
}

/// `git merge --no-ff` of the branch into the parent checkout's current branch `base_branch`, with a merge commit
/// that names `label`. One that fails is aborted, so the parent's checkout is never left half merged: with conflicted
/// files it is a conflict, else a `branch_error` with git's words.
pub async fn merge(
    git: &Git,
    worktree: &WorktreeRef,
    base_branch: &str,
    label: &str,
) -> Result<Merged, Fault> {
    let labelled = if label.is_empty() {
        String::new()
    } else {
        format!(" ({label})")
    };
    let message = format!("Merge {} into {base_branch}{labelled}", worktree.branch);
    let cwd = &worktree.base_cwd;
    let args = [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        &message,
        &worktree.branch,
    ];
    let result = git.run(cwd, &args, slow()).await?;
    if result.code != 0 {
        let conflicted = git
            .raw(cwd, &["diff", "--name-only", "--diff-filter=U"])
            .await?;
        let files: Vec<String> = conflicted
            .text()
            .split('\n')
            .filter(|file| !file.is_empty())
            .map(str::to_owned)
            .collect();
        git.raw(cwd, &["merge", "--abort"]).await?;
        if !files.is_empty() {
            return Ok(Merged::Conflict {
                merged: false,
                reason: "conflict",
                files,
                predicted: false,
            });
        }
        let stderr = js_trim(&result.stderr);
        let reason = if stderr.is_empty() {
            format!("exit {}", result.code)
        } else {
            stderr.to_owned()
        };
        return Err(branch_error(format!("git merge failed: {reason}")));
    }
    let sha = text(git, cwd, &["rev-parse", "--short", "HEAD"]).await?;
    let summary = text(git, cwd, &["diff", "--shortstat", "HEAD~1", "HEAD"]).await?;
    Ok(Merged::Done {
        merged: true,
        sha,
        summary,
    })
}

// ---- the rules over facts and diffs a merge and the compare's judge read (were `branches.ts`'s) ---------------------

/// `text.length`: UTF-16 units.
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Why a merge of this branch cannot go ahead (what it would lose or tangle), or None.
pub fn merge_problem(worktree: &WorktreeRef, facts: &BranchFacts) -> Option<String> {
    let Some(base) = facts.base_branch.as_deref().filter(|base| !base.is_empty()) else {
        return Some(format!(
            "The parent checkout ({}) is on a detached HEAD; check out a branch there first.",
            worktree.base_cwd
        ));
    };
    if facts.uncommitted > 0 {
        return Some(format!(
            "{} has {} uncommitted file(s) in {}; ask that session to commit them first (ompdesk_session_send).",
            worktree.branch, facts.uncommitted, worktree.path
        ));
    }
    if facts.base_uncommitted > 0 {
        return Some(format!(
            "{} has {} uncommitted file(s); commit or stash them first so the merge cannot mix with them.",
            worktree.base_cwd, facts.base_uncommitted
        ));
    }
    if facts.merged || facts.commits_ahead == 0 {
        return Some(format!(
            "{} has nothing to merge into {base}.",
            worktree.branch
        ));
    }
    None
}

/// The `diff --git` header's path; the header itself when it is quoted or odd.
fn section_path(section: &str) -> String {
    let header = match section.find('\n') {
        Some(at) if at > 0 => &section[..at],
        _ => section,
    };
    if let Some(both) = header.strip_prefix("diff --git a/") {
        let count = both.chars().count();
        if count >= 5 && (count - 3) % 2 == 0 {
            let half = (count - 3) / 2;
            let middle = both
                .char_indices()
                .nth(half)
                .map_or(both.len(), |(at, _)| at);
            let (first, rest) = both.split_at(middle);
            if let Some(second) = rest.strip_prefix(" b/")
                && first == second
                && !first.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
            {
                return first.to_owned();
            }
        }
    }
    header
        .strip_prefix("diff --git ")
        .unwrap_or(header)
        .to_owned()
}

/// Where JavaScript's multiline `^` matches: the start, and after a line terminator.
fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(text.char_indices().filter_map(|(at, c)| {
        matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}').then_some(at + c.len_utf8())
    }))
}

/// `diff.split(/^(?=diff --git )/m)`.
fn diff_sections(diff: &str) -> Vec<&str> {
    let mut cuts: Vec<usize> = line_starts(diff)
        .filter(|at| *at > 0 && diff[*at..].starts_with("diff --git "))
        .collect();
    cuts.dedup();
    let mut sections = Vec::new();
    let mut from = 0;
    for at in cuts {
        sections.push(&diff[from..at]);
        from = at;
    }
    sections.push(&diff[from..]);
    sections
}

/// `section.match(/[^\n]*\n|[^\n]+$/g)`: its lines, each with its newline.
fn section_lines(section: &str) -> Vec<&str> {
    section.split_inclusive('\n').collect()
}

/// Cut a unified diff to about `chars` characters, fairly across files: each file gets an equal share, and what a
/// small file does not use goes to the larger ones. A cut file ends at a line boundary with one line saying how many
/// lines went. `omitted` counts the characters of the diff left out.
pub fn bound_diff(diff: &str, chars: usize) -> (String, usize) {
    if chars == 0 {
        return (String::new(), utf16_len(diff));
    }
    if utf16_len(diff) <= chars {
        return (diff.to_owned(), 0);
    }
    let sections = diff_sections(diff);
    let mut order: Vec<(usize, usize)> = sections
        .iter()
        .enumerate()
        .map(|(index, section)| (index, utf16_len(section)))
        .collect();
    order.sort_by_key(|(_, size)| *size);
    let mut shares = vec![0usize; sections.len()];
    let mut remaining = chars;
    for (rank, (index, size)) in order.iter().enumerate() {
        let share = remaining / (order.len() - rank);
        shares[*index] = (*size).min(share);
        remaining -= shares[*index];
    }
    let mut out = String::new();
    let mut omitted = 0;
    for (index, section) in sections.iter().enumerate() {
        let share = shares[index];
        if utf16_len(section) <= share {
            out.push_str(section);
            continue;
        }
        let lines = section_lines(section);
        let path = section_path(section);
        let marker = |left: usize| {
            format!(
                "… {left} more line{} of {path} left out\n",
                if left == 1 { "" } else { "s" }
            )
        };
        // Reserve the longest the marker can be (every line left out) so the cut file stays within its share.
        let mut budget = share as i64 - utf16_len(&marker(lines.len())) as i64;
        let mut kept = 0;
        while kept < lines.len() && (utf16_len(lines[kept]) as i64) <= budget {
            budget -= utf16_len(lines[kept]) as i64;
            out.push_str(lines[kept]);
            kept += 1;
        }
        omitted += lines[kept..]
            .iter()
            .map(|line| utf16_len(line))
            .sum::<usize>();
        out.push_str(&marker(lines.len() - kept));
    }
    (out, omitted)
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::Value;

    use super::*;

    /// Rows captured from the TypeScript (`parseNumstat`, `dirtiness`, the `cherry`, `patch-id` and `merge-tree -z`
    /// reads, `parseWorktreeList`, `classifyOrphan`) before it was deleted.
    pub fn captured(table: &str) -> Vec<Value> {
        let rows: Value = serde_json::from_str(include_str!("branches-captured.json")).unwrap();
        rows[table].as_array().unwrap().clone()
    }

    #[test]
    fn reads_numstat_and_status_counts_as_the_typescript_did() {
        for row in captured("numstat") {
            let expected: Vec<FileChange> = serde_json::from_value(row[1].clone()).unwrap();
            assert_eq!(numstat(row[0].as_str().unwrap()), expected, "{}", row[0]);
        }
        for row in captured("dirtiness") {
            let expected: Dirt = serde_json::from_value(row[1].clone()).unwrap();
            assert_eq!(count_dirt(row[0].as_str().unwrap()), expected, "{}", row[0]);
        }
    }

    #[test]
    fn reads_cherry_patch_id_and_merge_tree_output_as_the_typescript_did() {
        for row in captured("cherry") {
            assert_eq!(
                all_picked(row[0].as_str().unwrap()),
                row[1].as_bool().unwrap()
            );
        }
        for row in captured("patchIds") {
            let expected: Vec<String> = serde_json::from_value(row[1].clone()).unwrap();
            assert_eq!(patch_id_column(row[0].as_str().unwrap()), expected);
        }
        for row in captured("conflicts") {
            let expected: Vec<String> = serde_json::from_value(row[1].clone()).unwrap();
            assert_eq!(conflicted(row[0].as_str().unwrap()), expected);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_merge_tree_has_exited_before_its_scratch_store_goes() {
        use crate::run::tests::shell;
        use crate::server::Scope;
        let marker =
            std::env::temp_dir().join(format!("ompdesk-core-scratch-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let scope = Scope::detached();
        let git = Git::new(shell(60_000, 1024), scope.clone());
        let scratch = Scratch::new().await.unwrap();
        let dir = scratch.0.clone();
        assert!(
            dir.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ompdesk-merge-tree-")
        );
        // The stand-in checks its store in its SIGTERM trap: the folder is there until it exited.
        let script = format!(
            "trap '[ -d \"$GIT_OBJECT_DIRECTORY\" ] && echo there > \"{marker}\"; exit 1' TERM; touch \"{marker}.up\"; while :; do sleep 0.05; done",
            marker = marker.display()
        );
        let started = format!("{}.up", marker.display());
        let args = [script.as_str()];
        let (outcome, ()) =
            tokio::join!(merge_tree(&git, "/", &args, &scratch, "/nowhere"), async {
                while !std::path::Path::new(&started).exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                scope.cancel();
            });
        assert_eq!(outcome.err().unwrap(), Fault::cancelled());
        assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "there");
        drop(scratch);
        assert!(!dir.exists());
        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_file(started);
    }
    /// A unified diff's section for `file` with `lines` added lines.
    fn section(file: &str, lines: usize) -> String {
        let mut out =
            format!("diff --git a/{file} b/{file}\n--- a/{file}\n+++ b/{file}\n@@ -1 +1 @@\n");
        for line in 0..lines {
            out.push_str(&format!("+line {line}\n"));
        }
        out
    }

    /// Ported from `branches-worktrees.test.ts` (`boundDiff`) when the TypeScript copy went.
    #[test]
    fn bound_diff_returns_the_whole_diff_when_it_fits_and_nothing_without_a_budget() {
        let diff = section("a.ts", 3);
        assert_eq!(bound_diff(&diff, diff.len()), (diff.clone(), 0));
        assert_eq!(bound_diff(&diff, 0), (String::new(), diff.len()));
        assert_eq!(bound_diff("", 100), (String::new(), 0));
    }

    #[test]
    fn bound_diff_gives_a_small_source_file_its_whole_hunk_beside_a_huge_lockfile() {
        let source = section("src/app.ts", 4);
        let lock = section("package-lock.json", 5000);
        let (text, omitted) = bound_diff(&format!("{lock}{source}"), 2000);
        assert!(text.contains(&source));
        assert!(utf16_len(&text) <= 2000);
        let marker = text
            .lines()
            .find(|line| line.starts_with("… ") && line.ends_with(" of package-lock.json left out"))
            .expect("the lockfile's marker");
        let kept = utf16_len(&text) - utf16_len(marker) - 1;
        assert_eq!(omitted, utf16_len(&lock) + utf16_len(&source) - kept);
    }

    #[test]
    fn bound_diff_cuts_at_a_line_boundary_and_says_how_many_lines_it_left_out() {
        let (text, _) = bound_diff(&section("big.ts", 100), 300);
        assert!(text.ends_with(" left out\n"));
        let kept = text
            .lines()
            .filter(|line| line.starts_with("+line "))
            .count();
        let left: usize = text
            .rsplit("… ")
            .next()
            .and_then(|tail| tail.split(' ').next())
            .and_then(|count| count.parse().ok())
            .unwrap();
        assert_eq!(kept + left, 100);
    }
}
