//! Orphaned worktrees (was the git logic of `src/main/worktree-orphans.ts`): the linked worktrees OMPdesk made
//! (`<worktree root>/gui-<name>-<hash7>`) that no open session uses, each with what git says about its work, and the
//! removal of one that holds nothing the user could lose. Main keeps what is its own and passes it in: where the
//! worktree root is (omp's `git.worktree_location`) and its real path, read on main's fenced files under the
//! repository lock; the folders open sessions use (`realFolder` of each); the removal claim, the `prepare` that
//! archives first, which states are removable and the refusals' words.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

use super::branches::{self, Removal, WorktreeRef};
use super::parse;
use super::read::blocking;
use super::run::Git;
use crate::fs::order::js_trim;
use crate::server::Fault;

/// How many worktrees are read at once: each read is a handful of git processes.
const INSPECT_CONCURRENCY: usize = 4;

#[derive(Debug, PartialEq, Deserialize)]
struct Listed {
    path: String,
    branch: Option<String>,
    locked: bool,
}

/// `git worktree list --porcelain -z`: NUL-separated fields, a record per worktree starting at its `worktree` field.
fn worktree_list(output: &str) -> Vec<Listed> {
    let mut records: Vec<Listed> = Vec::new();
    for field in output.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            records.push(Listed {
                path: path.to_owned(),
                branch: None,
                locked: false,
            });
        } else if let Some(current) = records.last_mut() {
            if let Some(branch) = field.strip_prefix("branch ") {
                current.branch = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_owned(),
                );
            } else if field == "locked" || field.starts_with("locked ") {
                current.locked = true;
            }
        }
    }
    records
}

/// node's `isInside`: `child` is strictly inside `root` (both real paths), as `path.relative` reads it (on Windows
/// case-insensitively; a first part starting with `..` reads as outside).
pub(super) fn inside(root: &str, child: &str) -> bool {
    let (root, child) = if cfg!(windows) {
        (root.to_lowercase(), child.to_lowercase())
    } else {
        (root.to_owned(), child.to_owned())
    };
    Path::new(&child).strip_prefix(&root).is_ok_and(|rest| {
        let rest = rest.to_string_lossy();
        !rest.is_empty() && !rest.starts_with("..")
    })
}

#[derive(Serialize, Deserialize)]
pub struct Candidate {
    path: String,
    branch: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Candidates {
    candidates: Vec<Candidate>,
    /// OMPdesk's worktrees an open session uses.
    in_use: Vec<String>,
}

/// OMPdesk's linked worktrees of the repository at `primary`, unread (one `git worktree list`): not locked, a real
/// folder strictly inside `root` named `gui-…`, `only` that one when asked, and none an open folder is or is inside
/// (those are `inUse`).
pub async fn candidates(
    git: &Git,
    primary: &str,
    root: String,
    open: Vec<String>,
    only: Option<String>,
) -> Result<Candidates, Fault> {
    let list = git
        .text(primary, &["worktree", "list", "--porcelain", "-z"])
        .await?;
    let linked: Vec<Listed> = worktree_list(&list).into_iter().skip(1).collect();
    blocking(move || {
        let mut found = Candidates::default();
        for entry in linked.into_iter().filter(|entry| !entry.locked) {
            let Ok(real) = branches::real(&entry.path) else {
                continue;
            };
            let gui = Path::new(&real)
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("gui-"));
            if !inside(&root, &real) || !gui || only.as_ref().is_some_and(|only| *only != real) {
                continue;
            }
            if open
                .iter()
                .any(|folder| *folder == real || inside(&real, folder))
            {
                found.in_use.push(real);
                continue;
            }
            found.candidates.push(Candidate {
                path: real,
                branch: entry.branch,
            });
        }
        found
    })
    .await
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Landed,
    Untouched,
    Unlanded,
    Dirty,
}

/// What `classify` reads of one worktree.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Facts {
    /// HEAD is detached: the worktree has no branch.
    detached: bool,
    /// Tracked changes plus untracked files.
    dirty_files: usize,
    /// The branch has a commit of its own (its tip differs from where it was created).
    has_work: bool,
    /// The HEAD's work is in the base's HEAD or upstream, by ancestry or by content.
    landed: bool,
    /// `landed` by content (squash merge, rebase, cherry-pick).
    squashed: bool,
    /// Commits of its own against the base (0 once landed).
    commits_ahead: u64,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Verdict {
    state: State,
    commits_ahead: u64,
    #[serde(default)]
    squashed: bool,
}

/// The state of an orphan, first matching row wins: dirty wins over every other state. A detached HEAD never counts
/// commits and has no creation point, so it is never `untouched`; `untouched` needs the base to hold the tip too, so
/// a branch whose reflog is gone (it then reads as no work) cannot hide unmerged commits.
fn classify(facts: &Facts) -> Verdict {
    let verdict = |state, commits_ahead| Verdict {
        state,
        commits_ahead,
        squashed: false,
    };
    if facts.dirty_files > 0 {
        verdict(
            State::Dirty,
            if facts.detached {
                0
            } else {
                facts.commits_ahead
            },
        )
    } else if facts.detached && !facts.landed {
        verdict(State::Unlanded, 0)
    } else if !facts.detached && !facts.has_work && facts.landed {
        verdict(State::Untouched, 0)
    } else if facts.landed {
        Verdict {
            state: State::Landed,
            commits_ahead: 0,
            squashed: facts.squashed,
        }
    } else {
        verdict(State::Unlanded, facts.commits_ahead)
    }
}

/// `RpcOrphanWorktree`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    path: String,
    branch: Option<String>,
    repo: String,
    state: State,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    squashed: bool,
    commits_ahead: u64,
    dirty_files: usize,
    modified_at: u64,
}

async fn inspect_one(git: &Git, primary: &str, candidate: &Candidate) -> Result<Orphan, Fault> {
    let branch = candidate.branch.as_deref();
    // Joined to the end, not `try_join!`: a failing `log` must not drop the landing check while its `merge-tree`
    // still writes into the scratch store it owns.
    let (standing, committed) = tokio::join!(
        branches::standing(git, &candidate.path, branch, primary),
        git.text(&candidate.path, &["log", "-1", "--format=%ct", "HEAD"]),
    );
    let (standing, committed) = (standing?, committed?);
    let verdict = classify(&Facts {
        detached: branch.is_none(),
        dirty_files: standing.dirty_files,
        has_work: standing.has_work,
        landed: standing.landed,
        squashed: standing.squashed,
        commits_ahead: standing.commits_ahead,
    });
    Ok(Orphan {
        path: candidate.path.clone(),
        branch: candidate.branch.clone(),
        repo: primary.to_owned(),
        state: verdict.state,
        squashed: verdict.squashed,
        commits_ahead: verdict.commits_ahead,
        dirty_files: standing.dirty_files,
        modified_at: parse::seconds(js_trim(&committed)) * 1000,
    })
}

/// The shared work of `inspect`'s readers: the next candidate to read, what each read gave, whether one was
/// cancelled.
struct Pool<'a> {
    candidates: &'a [Candidate],
    next: AtomicUsize,
    read: Mutex<Vec<Option<Orphan>>>,
    cancelled: AtomicBool,
}

async fn reader(git: &Git, primary: &str, pool: &Pool<'_>) {
    loop {
        let index = pool.next.fetch_add(1, Ordering::Relaxed);
        let Some(candidate) = pool.candidates.get(index) else {
            return;
        };
        match inspect_one(git, primary, candidate).await {
            Ok(orphan) => {
                pool.read
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)[index] = Some(orphan);
            }
            Err(fault) if fault.code == "cancelled" => {
                pool.cancelled.store(true, Ordering::Relaxed)
            }
            // A worktree git cannot read (a broken checkout) is left out: nothing about it is known to be safe.
            Err(_) => {}
        }
    }
}

/// Each candidate's state (`INSPECT_CONCURRENCY` read at once), newest commit first.
pub async fn inspect(
    git: &Git,
    primary: &str,
    candidates: &[Candidate],
) -> Result<Vec<Orphan>, Fault> {
    let pool = Pool {
        candidates,
        next: AtomicUsize::new(0),
        read: Mutex::new(candidates.iter().map(|_| None).collect()),
        cancelled: AtomicBool::new(false),
    };
    const _: () = assert!(INSPECT_CONCURRENCY == 4, "one reader per join! arm");
    tokio::join!(
        reader(git, primary, &pool),
        reader(git, primary, &pool),
        reader(git, primary, &pool),
        reader(git, primary, &pool),
    );
    if pool.cancelled.load(Ordering::Relaxed) {
        return Err(Fault::cancelled());
    }
    let mut orphans: Vec<Orphan> = pool
        .read
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .into_iter()
        .flatten()
        .collect();
    orphans.sort_by_key(|orphan| std::cmp::Reverse(orphan.modified_at));
    Ok(orphans)
}

/// Removes the orphan at `path` of the repository at `primary`, never forced: a detached one when git lists it as
/// linked, one on a branch by `remove_safe` (landed and clean once more, the branch at the tip it judged unless
/// `keep_branch`). None when it stayed.
pub async fn remove(
    git: &Git,
    primary: &str,
    path: &str,
    branch: Option<String>,
    keep_branch: bool,
) -> Result<Option<Removal>, Fault> {
    match branch {
        None => Ok(branches::remove_linked(git, primary, path)
            .await?
            .map(|_| Removal::Removed)),
        Some(branch) => {
            let worktree = WorktreeRef {
                path: path.to_owned(),
                branch,
                base_cwd: primary.to_owned(),
            };
            branches::remove_safe(git, &worktree, keep_branch).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::captured;

    /// `worktree-orphans.test.ts`'s cases: a base with three commits of its own, patched.
    #[test]
    fn classifies_the_typescript_test_s_cases() {
        let base = serde_json::json!({
            "detached": false, "dirtyFiles": 0, "hasWork": true, "landed": false, "squashed": false, "commitsAhead": 3
        });
        let cases = [
            (
                "dirty wins over landed",
                serde_json::json!({ "dirtyFiles": 2, "landed": true, "commitsAhead": 0 }),
                (State::Dirty, 0, false),
            ),
            (
                "dirty keeps its own commits",
                serde_json::json!({ "dirtyFiles": 1 }),
                (State::Dirty, 3, false),
            ),
            (
                "no commit of its own and in the base is untouched",
                serde_json::json!({ "hasWork": false, "landed": true, "commitsAhead": 0 }),
                (State::Untouched, 0, false),
            ),
            (
                "no reflog but unmerged commits is unlanded, not untouched",
                serde_json::json!({ "hasWork": false }),
                (State::Unlanded, 3, false),
            ),
            (
                "landed by ancestry",
                serde_json::json!({ "landed": true, "commitsAhead": 0 }),
                (State::Landed, 0, false),
            ),
            (
                "landed by content says so",
                serde_json::json!({ "landed": true, "squashed": true, "commitsAhead": 0 }),
                (State::Landed, 0, true),
            ),
            (
                "commits nothing holds",
                serde_json::json!({}),
                (State::Unlanded, 3, false),
            ),
            (
                "detached outside the base never counts commits",
                serde_json::json!({ "detached": true, "hasWork": false }),
                (State::Unlanded, 0, false),
            ),
            (
                "detached inside the base is landed",
                serde_json::json!({ "detached": true, "hasWork": false, "landed": true, "commitsAhead": 0 }),
                (State::Landed, 0, false),
            ),
        ];
        for (name, patch, (state, commits_ahead, squashed)) in cases {
            let mut facts = base.clone();
            for (key, value) in patch.as_object().unwrap() {
                facts[key] = value.clone();
            }
            let facts: Facts = serde_json::from_value(facts).unwrap();
            let expected = Verdict {
                state,
                commits_ahead,
                squashed,
            };
            assert_eq!(classify(&facts), expected, "{name}");
        }
    }

    #[test]
    fn classifies_as_the_typescript_did() {
        let rows = captured("classify");
        assert_eq!(rows.len(), 64);
        for row in rows {
            let facts: Facts = serde_json::from_value(row[0].clone()).unwrap();
            let expected: Verdict = serde_json::from_value(row[1].clone()).unwrap();
            assert_eq!(classify(&facts), expected, "{facts:?}");
        }
    }

    #[test]
    fn reads_the_worktree_list_as_the_typescript_did() {
        for row in captured("worktreeList") {
            let expected: Vec<Listed> = serde_json::from_value(row[1].clone()).unwrap();
            assert_eq!(
                worktree_list(row[0].as_str().unwrap()),
                expected,
                "{}",
                row[0]
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn reads_inside_as_path_relative_does() {
        let rows = [
            ("/wt", "/wt/gui-a", true),
            ("/wt", "/wt", false),
            ("/wt", "/wt/", false),
            ("/wt", "/wtx/gui-a", false),
            ("/wt", "/wt/..x", false),
            ("/wt", "/other", false),
            ("/", "/a", true),
            ("/wt/gui-a", "/wt/gui-a/src/deeper", true),
        ];
        for (root, child, expected) in rows {
            assert_eq!(inside(root, child), expected, "{root} {child}");
        }
    }
}
