//! What git says about a folder's checkout, for the project it belongs to (was `readOriginFacts` of
//! `src/main/local/git/origin.ts`): the common git dir, the git dir, the branch, the top level, and the first listed
//! checkout when the common dir is not `<main>/.git`. Every git gets main's short timeout, and any that fails counts
//! as git not knowing. Main keeps the cache and the rule that makes a project of the facts (`deriveProjectOrigin`).

use std::path::Path;

use serde::Serialize;

use super::parse;
use super::read::resolve;
use super::run::{Git, Opts};
use crate::fs::order::js_trim;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    common_dir: String,
    git_dir: String,
    branch: Option<String>,
    toplevel: Option<String>,
    primary: Option<String>,
}

/// Trimmed stdout of a git that succeeded with some, else none.
async fn out(git: &Git, cwd: &str, args: &[&str], timeout_ms: u64) -> Option<String> {
    let opts = Opts {
        timeout_ms: Some(timeout_ms),
        ..Opts::default()
    };
    let output = git.run(cwd, args, opts).await.ok()?;
    let text = output.text();
    let text = js_trim(&text);
    (output.code == 0 && !text.is_empty()).then(|| text.to_owned())
}

/// The facts of `cwd` (absolute), none outside a repository.
pub async fn facts(git: &Git, cwd: &str, timeout_ms: u64) -> Option<Facts> {
    let dirs = out(
        git,
        cwd,
        &["rev-parse", "--git-common-dir", "--git-dir"],
        timeout_ms,
    )
    .await?;
    let mut lines = dirs
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    let (Some(common), Some(own)) = (lines.next(), lines.next()) else {
        return None;
    };
    if common.is_empty() || own.is_empty() {
        return None;
    }
    let common_dir = resolve(cwd, common);
    let git_dir = resolve(cwd, own);
    // Only a git dir that is not `<main>/.git` (bare, relocated) needs the worktree list.
    let listed = Path::new(&common_dir)
        .file_name()
        .is_some_and(|name| name == ".git");
    let listing = async {
        if listed {
            None
        } else {
            out(git, cwd, &["worktree", "list", "--porcelain"], timeout_ms).await
        }
    };
    let (branch, toplevel, listing) = tokio::join!(
        out(
            git,
            cwd,
            &["symbolic-ref", "--short", "-q", "HEAD"],
            timeout_ms
        ),
        out(git, cwd, &["rev-parse", "--show-toplevel"], timeout_ms),
        listing,
    );
    Some(Facts {
        common_dir,
        git_dir,
        branch,
        toplevel: toplevel.map(|toplevel| resolve("", &toplevel)),
        primary: listing.and_then(|listing| parse::first_worktree(&listing).map(str::to_owned)),
    })
}
