//! The read side of git (was `src/main/local/git/changes.ts` and the parsers of `parse.ts` only it used:
//! `parseStatusV2`, `parseBranchHeaders`, `isProbablyBinaryHeader`, `newFileDiff`): the checkout root, the footer's
//! status, the Changes panel's list, fingerprint and diff, and the source-control head. Every request carries `git`,
//! how main runs git (`gitRunner` in `exec.ts`: binary, environment, timeout, output cap), so this side decides none
//! of it. Failures are faults whose message is what the TypeScript threw (git's stderr, node's error text,
//! `spawn <bin> ENOENT`, `-c timed out after 60000ms`); main reads only the message.

mod parse;
mod read;
mod run;

use serde::Deserialize;

use crate::server::{Registry, Reply};
use run::Runner;

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

pub fn register(registry: &mut Registry) {
    registry.add("git.repoRoot", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            Reply::json(&read::repo_root(&git, &cwd).await?)
        })
    });
    registry.add("git.status", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            Reply::json(&read::status(&git, &cwd).await?)
        })
    });
    registry.add("git.head", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            Reply::json(&read::head(&git, &cwd).await?)
        })
    });
    registry.add("git.fingerprint", |call| {
        Box::pin(async move {
            let FingerprintParams { git, cwd, root } = call.params()?;
            Reply::json(&read::fingerprint(&git, &cwd, root.as_deref()).await?)
        })
    });
    registry.add("git.changes", |call| {
        Box::pin(async move {
            let At { git, cwd } = call.params()?;
            Reply::json(&read::changes(&git, &cwd).await?)
        })
    });
    registry.add("git.diff", |call| {
        Box::pin(async move {
            let DiffParams { git, cwd, path } = call.params()?;
            Reply::json(&read::diff(&git, &cwd, &path).await?)
        })
    });
}
