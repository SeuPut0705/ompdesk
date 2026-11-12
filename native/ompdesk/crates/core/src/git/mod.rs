//! Git for the Changes panel. The read side (was `src/main/local/git/changes.ts` and the parsers of `parse.ts` only it
//! used: `parseStatusV2`, `parseBranchHeaders`, `isProbablyBinaryHeader`, `newFileDiff`): the checkout root and the
//! main checkout, the footer's status, the Changes panel's list, fingerprint and diff. The write side and the history
//! (was `src/main/local/git/scm.ts` and `parseDecorations`, `remoteWebBase`): `scm.rs`. Worktrees and session
//! worktrees (was the git side of `worktree.ts` and `session-worktree.ts`): `worktree.rs`; what a branch has not landed
//! (`unlanded.ts`): `unlanded.rs`; a folder's project facts (`origin.ts`): `origin.rs`; a session worktree's standing,
//! merge and safe removal (`agent-control/branches.ts`): `branches.rs`; orphaned worktrees (`worktree-orphans.ts`):
//! `orphans.rs`; a fresh worktree's seeding from `.worktreeinclude` and its hook's lookup (`worktree-seed.ts`):
//! `seed.rs`. Every request carries `git`, how main runs git (`gitRunner` in `exec.ts`: binary, environment,
//! timeout, output cap), so this side decides none of it, and runs under the request's scope: a cancelled request
//! starts no git and ends the one it runs. Failures are faults whose message is what the TypeScript threw (git's
//! stderr, node's error text, `spawn <bin> ENOENT`, `-c timed out after 60000ms`); a refusal the TypeScript coded
//! carries that code.

mod branches;
mod checkout;
mod freshness;
mod origin;
mod orphans;
pub(crate) mod parse;
pub(crate) mod read;
pub(crate) mod run;
mod scm;
mod seed;
mod triggers;
mod unlanded;
mod worktree;

use serde::Deserialize;

use crate::run::Runner;
use crate::server::{Registry, Reply};
use run::Git;

#[derive(Deserialize)]
struct At {
    git: Runner,
    cwd: String,
}

#[derive(Deserialize)]
struct FingerprintParams {
    git: Runner,
    cwd: String,
    root: Option<String>,
}

#[derive(Deserialize)]
struct DiffParams {
    git: Runner,
    cwd: String,
    path: String,
}

/// A request on the checkout root main resolved.
#[derive(Deserialize)]
struct Root {
    git: Runner,
    root: String,
}

/// `paths` none: all of them.
#[derive(Deserialize)]
struct PathsParams {
    git: Runner,
    root: String,
    paths: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct DiscardParams {
    git: Runner,
    root: String,
    paths: Vec<String>,
}

/// `slowMs`: the timeout of the request's one slow git (a hook, the network, a merge), main's to choose.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitParams {
    git: Runner,
    root: String,
    message: String,
    amend: bool,
    slow_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteParams {
    git: Runner,
    root: String,
    action: scm::RemoteAction,
    slow_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashParams {
    git: Runner,
    root: String,
    action: scm::StashAction,
    message: Option<String>,
    slow_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationParams {
    git: Runner,
    root: String,
    action: scm::OperationAction,
    slow_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchParams {
    git: Runner,
    root: String,
    action: scm::BranchAction,
    name: String,
    #[serde(default)]
    new_name: String,
    base: Option<String>,
    force: bool,
    slow_ms: u64,
}

#[derive(Deserialize)]
struct LogParams {
    git: Runner,
    root: String,
    limit: Option<f64>,
    skip: Option<f64>,
    query: Option<String>,
}

#[derive(Deserialize)]
struct ShaParams {
    git: Runner,
    root: String,
    sha: String,
}

#[derive(Deserialize)]
struct CommitDiffParams {
    git: Runner,
    root: String,
    sha: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryParams {
    git: Runner,
    root: String,
    action: scm::HistoryAction,
    sha: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    name: String,
    slow_ms: u64,
}

/// `timeoutMs`: each git's own timeout (`readOriginFacts` asks with 10 s).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginParams {
    git: Runner,
    cwd: String,
    timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanParams {
    git: Runner,
    cwd: String,
    base_ref: Option<String>,
}

/// `addTimeoutMs`: `worktree add`'s timeout, main's to choose.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddParams {
    git: Runner,
    primary: String,
    base_cwd: String,
    path: String,
    branch: String,
    start_point: String,
    add_timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddNamedParams {
    git: Runner,
    primary: String,
    base_cwd: String,
    path: String,
    source: worktree::Source,
    add_timeout_ms: u64,
}

#[derive(Deserialize)]
struct RemovalParams {
    git: Runner,
    path: String,
    force: bool,
}

/// `timeoutMs`: `worktree remove`'s timeout, main's to choose.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    git: Runner,
    primary: String,
    path: String,
    timeout_ms: u64,
}

#[derive(Deserialize)]
struct LifecycleParams {
    git: Runner,
    worktree: worktree::Lifecycle,
}

/// `target`: the checkout to remove (main's guard passed it), none when it already vanished.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRemoveParams {
    git: Runner,
    primary: String,
    path: String,
    branch: String,
    target: Option<String>,
    moved: bool,
    timeout_ms: u64,
}

#[derive(Deserialize)]
struct WorktreeParams {
    git: Runner,
    worktree: branches::WorktreeRef,
}

/// `diff`: whether the caller reads the diff at all.
#[derive(Deserialize)]
struct EvidenceParams {
    git: Runner,
    worktree: branches::WorktreeRef,
    diff: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeParams {
    git: Runner,
    worktree: branches::WorktreeRef,
    base_branch: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SafeRemoveParams {
    git: Runner,
    worktree: branches::WorktreeRef,
    keep_branch: bool,
}

#[derive(Deserialize)]
struct DiscardRemoveParams {
    git: Runner,
    worktree: branches::WorktreeRef,
    tip: String,
}

/// `root`: the worktree root's real path, `open`: the real folders open sessions use, `only`: the one real path to
/// keep (a removal re-reads just that one).
#[derive(Deserialize)]
struct CandidatesParams {
    git: Runner,
    primary: String,
    root: String,
    open: Vec<String>,
    only: Option<String>,
}

#[derive(Deserialize)]
struct InspectParams {
    git: Runner,
    primary: String,
    candidates: Vec<orphans::Candidate>,
}

/// `branch`: none for a detached worktree.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrphanRemoveParams {
    git: Runner,
    primary: String,
    path: String,
    branch: Option<String>,
    keep_branch: bool,
}

#[derive(Deserialize)]
struct RoutineHeadParams {
    git: Runner,
    repo: String,
    branch: String,
}

#[derive(Deserialize)]
struct RoutineCommitsParams {
    git: Runner,
    repo: String,
    branch: String,
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct AutopilotStatusParams {
    git: Runner,
    root: String,
    base: String,
    branch: String,
}

#[derive(Deserialize)]
struct CheckoutStatusParams {
    git: Runner,
    toplevel: String,
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreshnessCheckoutParams {
    git: Runner,
    cwds: Vec<String>,
    timeout_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreshnessVerdictParams {
    git: Runner,
    checkout: String,
    #[serde(rename = "ref")]
    reference: String,
    page: freshness::Named,
    state: Option<freshness::State>,
    timeout_ms: u64,
}

/// `budgetMs`: how long the seed may start new entries, main's to choose. `pretendClones`: a test's stand-in for the
/// volume (`seed::pretend_cloner`); the app never sends it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedParams {
    git: Runner,
    primary: String,
    target: String,
    budget_ms: u64,
    pretend_clones: Option<u32>,
}

/// `script`: the hook's file, relative to a checkout; `log`: its log's file name.
#[derive(Deserialize)]
struct HookParams {
    git: Runner,
    primary: String,
    worktree: String,
    script: String,
    log: String,
}

pub fn register(registry: &mut Registry) {
    registry.add("git.freshnessCheckout", |call| {
        Box::pin(async move {
            let FreshnessCheckoutParams {
                git,
                cwds,
                timeout_ms,
            } = call.params()?;
            Reply::json(&freshness::checkout(&Git::new(git, call.scope), &cwds, timeout_ms).await)
        })
    });
    registry.add("git.freshnessVerdict", |call| {
        Box::pin(async move {
            let FreshnessVerdictParams {
                git,
                checkout,
                reference,
                page,
                state,
                timeout_ms,
            } = call.params()?;
            Reply::json(
                &freshness::verdict(
                    &Git::new(git, call.scope),
                    &checkout,
                    &reference,
                    &page,
                    state,
                    timeout_ms,
                )
                .await,
            )
        })
    });
    registry.add("git.checkoutStatus", |call| {
        Box::pin(async move {
            let CheckoutStatusParams {
                git,
                toplevel,
                paths,
            } = call.params()?;
            Reply::json(&checkout::status(&Git::new(git, call.scope), &toplevel, &paths).await?)
        })
    });
    registry.add("git.checkoutDirs", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            Reply::json(&checkout::dirs(&Git::new(git, call.scope), &cwd).await?)
        })
    });
    registry.add("git.routineHead", |call| {
        Box::pin(async move {
            let RoutineHeadParams { git, repo, branch } = call.params()?;
            Reply::json(&triggers::routine_head(&Git::new(git, call.scope), &repo, &branch).await?)
        })
    });
    registry.add("git.routineCommits", |call| {
        Box::pin(async move {
            let RoutineCommitsParams {
                git,
                repo,
                branch,
                from,
                to,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&triggers::routine_commits(&git, &repo, &branch, &from, &to).await?)
        })
    });
    registry.add("git.autopilotBranchStatus", |call| {
        Box::pin(async move {
            let AutopilotStatusParams {
                git,
                root,
                base,
                branch,
            } = call.params()?;
            Reply::json(
                &triggers::branch_status(&Git::new(git, call.scope), &root, &base, &branch).await?,
            )
        })
    });
    registry.add("git.repoRoot", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&read::repo_root(&git, &cwd).await?)
        })
    });
    registry.add("git.status", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&read::status(&git, &cwd).await?)
        })
    });
    registry.add("git.fingerprint", |call| {
        Box::pin(async move {
            let FingerprintParams { git, cwd, root } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&read::fingerprint(&git, &cwd, root.as_deref()).await?)
        })
    });
    registry.add("git.changes", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&read::changes(&git, &cwd).await?)
        })
    });
    registry.add("git.diff", |call| {
        Box::pin(async move {
            let DiffParams { git, cwd, path } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&read::diff(&git, &cwd, &path).await?)
        })
    });
    registry.add("git.stage", |call| {
        Box::pin(async move {
            let PathsParams { git, root, paths } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::stage(&git, &root, paths.as_deref()).await?)
        })
    });
    registry.add("git.unstage", |call| {
        Box::pin(async move {
            let PathsParams { git, root, paths } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::unstage(&git, &root, paths.as_deref()).await?)
        })
    });
    registry.add("git.discard", |call| {
        Box::pin(async move {
            let DiscardParams { git, root, paths } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::discard(&git, &root, &paths).await?)
        })
    });
    registry.add("git.commit", |call| {
        Box::pin(async move {
            let CommitParams {
                git,
                root,
                message,
                amend,
                slow_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::commit(&git, &root, &message, amend, slow_ms).await?)
        })
    });
    registry.add("git.lastCommitMessage", |call| {
        Box::pin(async move {
            let Root { git, root } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::last_commit_message(&git, &root).await?)
        })
    });
    registry.add("git.undoCommit", |call| {
        Box::pin(async move {
            let Root { git, root } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::undo_commit(&git, &root).await?)
        })
    });
    registry.add("git.staged", |call| {
        Box::pin(async move {
            let Root { git, root } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::staged(&git, &root).await?)
        })
    });
    registry.add("git.remote", |call| {
        Box::pin(async move {
            let RemoteParams {
                git,
                root,
                action,
                slow_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::remote(&git, &root, action, slow_ms).await?)
        })
    });
    registry.add("git.stash", |call| {
        Box::pin(async move {
            let StashParams {
                git,
                root,
                action,
                message,
                slow_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::stash(&git, &root, action, message.as_deref(), slow_ms).await?)
        })
    });
    registry.add("git.operation", |call| {
        Box::pin(async move {
            let OperationParams {
                git,
                root,
                action,
                slow_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::operation(&git, &root, action, slow_ms).await?)
        })
    });
    registry.add("git.branches", |call| {
        Box::pin(async move {
            let Root { git, root } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::branches(&git, &root).await?)
        })
    });
    registry.add("git.branch", |call| {
        Box::pin(async move {
            let BranchParams {
                git,
                root,
                action,
                name,
                new_name,
                base,
                force,
                slow_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            let input = scm::BranchInput {
                action,
                name: &name,
                new_name: &new_name,
                base: base.as_deref(),
                force,
            };
            Reply::json(&scm::branch(&git, &root, input, slow_ms).await?)
        })
    });
    registry.add("git.log", |call| {
        Box::pin(async move {
            let LogParams {
                git,
                root,
                limit,
                skip,
                query,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::log(&git, &root, limit, skip, query.as_deref()).await?)
        })
    });
    registry.add("git.commitDetail", |call| {
        Box::pin(async move {
            let ShaParams { git, root, sha } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::commit_detail(&git, &root, &sha).await?)
        })
    });
    registry.add("git.commitDiff", |call| {
        Box::pin(async move {
            let CommitDiffParams {
                git,
                root,
                sha,
                path,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&scm::commit_diff(&git, &root, &sha, &path).await?)
        })
    });
    registry.add("git.historyAction", |call| {
        Box::pin(async move {
            let HistoryParams {
                git,
                root,
                action,
                sha,
                mode,
                name,
                slow_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(
                &scm::history_action(&git, &root, action, &sha, &mode, &name, slow_ms).await?,
            )
        })
    });
    registry.add("git.primaryRoot", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&read::primary_root(&git, &cwd).await?)
        })
    });
    registry.add("git.unlanded", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&unlanded::unlanded(&git, &cwd).await?)
        })
    });
    registry.add("git.originFacts", |call| {
        Box::pin(async move {
            let OriginParams {
                git,
                cwd,
                timeout_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&origin::facts(&git, &cwd, timeout_ms).await)
        })
    });
    registry.add("git.worktreePlan", |call| {
        Box::pin(async move {
            let PlanParams { git, cwd, base_ref } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&worktree::plan(&git, &cwd, base_ref.as_deref()).await?)
        })
    });
    registry.add("git.worktreeAdd", |call| {
        Box::pin(async move {
            let AddParams {
                git,
                primary,
                base_cwd,
                path,
                branch,
                start_point,
                add_timeout_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(
                &worktree::add(
                    &git,
                    &primary,
                    &base_cwd,
                    &path,
                    &branch,
                    &start_point,
                    add_timeout_ms,
                )
                .await?,
            )
        })
    });
    registry.add("git.worktreeAddNamed", |call| {
        Box::pin(async move {
            let AddNamedParams {
                git,
                primary,
                base_cwd,
                path,
                source,
                add_timeout_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            worktree::add_named(&git, &primary, &base_cwd, &path, &source, add_timeout_ms).await?;
            Reply::json(&())
        })
    });
    registry.add("git.worktreeRemoval", |call| {
        Box::pin(async move {
            let RemovalParams { git, path, force } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&worktree::removal(&git, &path, force).await?)
        })
    });
    registry.add("git.worktreeRemove", |call| {
        Box::pin(async move {
            let RemoveParams {
                git,
                primary,
                path,
                timeout_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&worktree::remove(&git, &primary, &path, timeout_ms).await?)
        })
    });
    registry.add("git.sessionWorktreeSnapshot", |call| {
        Box::pin(async move {
            let LifecycleParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&worktree::snapshot(&git, &worktree).await?)
        })
    });
    registry.add("git.sessionWorktreeRemoval", |call| {
        Box::pin(async move {
            let LifecycleParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&worktree::session_removal(&git, &worktree).await?)
        })
    });
    registry.add("git.sessionWorktreeRemove", |call| {
        Box::pin(async move {
            let SessionRemoveParams {
                git,
                primary,
                path,
                branch,
                target,
                moved,
                timeout_ms,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            worktree::session_remove(
                &git,
                &primary,
                &path,
                &branch,
                target.as_deref(),
                moved,
                timeout_ms,
            )
            .await?;
            Reply::json(&())
        })
    });
    registry.add("git.branchFacts", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::facts(&git, &worktree).await?)
        })
    });
    registry.add("git.branchEvidence", |call| {
        Box::pin(async move {
            let EvidenceParams {
                git,
                worktree,
                diff,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::evidence(&git, &worktree, diff).await?)
        })
    });
    registry.add("git.predictMerge", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::predict(&git, &worktree).await?)
        })
    });
    registry.add("git.landingFacts", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::landing_facts(&git, &worktree).await?)
        })
    });
    registry.add("git.mergeBranch", |call| {
        Box::pin(async move {
            let MergeParams {
                git,
                worktree,
                base_branch,
                label,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::merge(&git, &worktree, &base_branch, &label).await?)
        })
    });
    registry.add("git.removeSafeWorktree", |call| {
        Box::pin(async move {
            let SafeRemoveParams {
                git,
                worktree,
                keep_branch,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::remove_safe(&git, &worktree, keep_branch).await?)
        })
    });
    registry.add("git.discardCheck", |call| {
        Box::pin(async move {
            let WorktreeParams { git, worktree } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::discard_check(&git, &worktree).await?)
        })
    });
    registry.add("git.discardRemove", |call| {
        Box::pin(async move {
            let DiscardRemoveParams { git, worktree, tip } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&branches::discard_remove(&git, &worktree, &tip).await?)
        })
    });
    registry.add("git.orphanCandidates", |call| {
        Box::pin(async move {
            let CandidatesParams {
                git,
                primary,
                root,
                open,
                only,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&orphans::candidates(&git, &primary, root, open, only).await?)
        })
    });
    registry.add("git.orphanInspect", |call| {
        Box::pin(async move {
            let InspectParams {
                git,
                primary,
                candidates,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&orphans::inspect(&git, &primary, &candidates).await?)
        })
    });
    registry.add("git.removeOrphanWorktree", |call| {
        Box::pin(async move {
            let OrphanRemoveParams {
                git,
                primary,
                path,
                branch,
                keep_branch,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&orphans::remove(&git, &primary, &path, branch, keep_branch).await?)
        })
    });
    registry.add("git.worktreeSeed", |call| {
        Box::pin(async move {
            let SeedParams {
                git,
                primary,
                target,
                budget_ms,
                pretend_clones,
            } = call.params()?;
            let limits = seed::Limits {
                budget: std::time::Duration::from_millis(budget_ms),
                pretend_clones,
            };
            let git = Git::new(git, call.scope.clone());
            Reply::json(&seed::seed(git, call.scope, primary, target, limits).await?)
        })
    });
    registry.add("git.worktreeHook", |call| {
        Box::pin(async move {
            let HookParams {
                git,
                primary,
                worktree,
                script,
                log,
            } = call.params()?;
            let git = Git::new(git, call.scope);
            Reply::json(&seed::hook(&git, &primary, &worktree, &script, &log).await?)
        })
    });
}
