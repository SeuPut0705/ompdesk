//! What a session's own branch has not landed in the default branch yet (was `src/main/local/git/unlanded.ts`): its
//! commits and its uncommitted and untracked work, measured from the merge-base with the remote's default branch
//! (`origin/HEAD`, else `origin/main`/`origin/master`, else a local `main`/`master`). None on the default branch itself,
//! where sessions share one working tree and nothing in it is one session's, on a detached HEAD and outside a
//! repository.

use serde::Serialize;

use super::parse::{self, CommitFile, MAX_FILES};
use super::read;
use super::run::Git;
use crate::fs::order::js_trim;
use crate::server::Fault;

#[derive(Serialize)]
pub struct Unlanded {
    branch: String,
    target: String,
    files: Vec<CommitFile>,
    truncated: bool,
}

/// Trimmed stdout of `rev-parse <args>` when it succeeded with some.
async fn rev_parse(git: &Git, root: &str, args: &[&str]) -> Result<Option<String>, Fault> {
    let mut command = vec!["rev-parse"];
    command.extend_from_slice(args);
    let output = git.raw(root, &command).await?;
    let text = output.text();
    let text = js_trim(&text);
    Ok((output.code == 0 && !text.is_empty()).then(|| text.to_owned()))
}

/// The ref a branch lands in and its short name: `origin/main` lands in `main`.
async fn landing_target(git: &Git, root: &str) -> Result<Option<(String, String)>, Fault> {
    let remote_head = rev_parse(
        git,
        root,
        &[
            "--abbrev-ref",
            "--verify",
            "--quiet",
            "refs/remotes/origin/HEAD",
        ],
    )
    .await?;
    let candidates = remote_head
        .into_iter()
        .chain(["origin/main", "origin/master", "main", "master"].map(String::from));
    for candidate in candidates {
        let commit = format!("{candidate}^{{commit}}");
        if rev_parse(git, root, &["--verify", "--quiet", &commit])
            .await?
            .is_some()
        {
            let name = candidate
                .strip_prefix("origin/")
                .unwrap_or(&candidate)
                .to_owned();
            return Ok(Some((candidate, name)));
        }
    }
    Ok(None)
}

pub async fn unlanded(git: &Git, cwd: &str) -> Result<Option<Unlanded>, Fault> {
    let Some(root) = read::repo_root(git, cwd).await? else {
        return Ok(None);
    };
    let head = git
        .raw(&root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await?
        .text();
    let branch = js_trim(&head);
    if branch.is_empty() {
        return Ok(None);
    }
    let Some((reference, target)) = landing_target(git, &root).await? else {
        return Ok(None);
    };
    if target == branch {
        return Ok(None);
    }
    let base = git
        .raw(&root, &["merge-base", "HEAD", &reference])
        .await?
        .text();
    let merge_base = js_trim(&base);
    if merge_base.is_empty() {
        return Ok(None);
    }
    let diff = ["--find-renames", "--no-ext-diff", "-z", merge_base];
    let names = [&["diff", "--name-status"][..], &diff].concat();
    let counts = [&["diff", "--numstat"][..], &diff].concat();
    let (names, counts, status) = tokio::try_join!(
        git.text(&root, &names),
        git.text(&root, &counts),
        git.text(
            &root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"]
        ),
    )?;
    let mut files = parse::landing_files(&names, &counts);
    files.extend(
        parse::untracked_v1(&status)
            .into_iter()
            .map(|path| CommitFile {
                path,
                old_path: None,
                status: "??".into(),
                added: None,
                removed: None,
            }),
    );
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    Ok(Some(Unlanded {
        branch: branch.to_owned(),
        target,
        files,
        truncated,
    }))
}
