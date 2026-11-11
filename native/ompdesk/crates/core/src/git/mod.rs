//! Git for the Changes panel. The read side (was `src/main/local/git/changes.ts` and the parsers of `parse.ts` only it
//! used: `parseStatusV2`, `parseBranchHeaders`, `isProbablyBinaryHeader`, `newFileDiff`): the checkout root, the
//! footer's status, the Changes panel's list, fingerprint and diff. The write side and the history (was
//! `src/main/local/git/scm.ts` and `parseDecorations`, `remoteWebBase`): `scm.rs`. Every request carries `git`, how
//! main runs git (`gitRunner` in `exec.ts`: binary, environment, timeout, output cap), so this side decides none of
//! it, and runs under the request's scope: a cancelled request starts no git and ends the one it runs. Failures are
//! faults whose message is what the TypeScript threw (git's stderr, node's error text, `spawn <bin> ENOENT`,
//! `-c timed out after 60000ms`); a refusal the TypeScript coded carries that code.

mod parse;
mod read;
mod run;
mod scm;

use serde::Deserialize;

use crate::server::{Registry, Reply};
use run::{Git, Runner};

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

pub fn register(registry: &mut Registry) {
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
}
