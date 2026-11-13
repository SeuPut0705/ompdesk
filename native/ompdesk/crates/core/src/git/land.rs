//! Landing a commit on a remote branch with git, shared by Autopilot's ShipRunner (`autopilot/ship.rs`, where it was
//! written) and check control's merge queue (`checks/queue_run.rs`): read a remote branch's tip, build a merge as a
//! commit object without any checkout, and push one sha to one branch, never forced, with the remote's own URL pinned.
//! What a refused push means is read out of git's words here too, so both read it alike.

use serde::Serialize;

use super::run::Git;
use crate::fs::order::{is_js_space, js_trim};
use crate::run::{Opts, Output};
use crate::server::Fault;

/// A fetch or a push: the network may be slow.
pub const PUSH_TIMEOUT_MS: u64 = 180_000;
/// Any other git of a landing.
pub const GIT_TIMEOUT_MS: u64 = 120_000;

const NETWORK_FAILURE: [&str; 10] = [
    "could not resolve host",
    "unable to access",
    "connection refused",
    "connection reset",
    "connection timed out",
    "timed out",
    "network is unreachable",
    "no route to host",
    "does not appear to be a git repository",
    "could not read from remote",
];
const REFUSED_FIRST: [&str; 7] = [
    "rejected",
    "denied",
    "permission",
    "authentication",
    "could not read username",
    "terminal prompts disabled",
    "protected branch",
];
/// A refused push that is the branch moving on, not a rule against pushing there.
const MOVED_ON: [&str; 4] = [
    "non-fast-forward",
    "fetch first",
    "stale info",
    "(already exists)",
];
/// A refusal that is the account, not the branch: a pull request would be refused as well.
const NOT_ALLOWED_AT_ALL: [&str; 4] = [
    "could not read username",
    "authentication failed",
    "terminal prompts disabled",
    "invalid credentials",
];

fn mentions(text: &str, words: &[&str]) -> bool {
    let lowered = text.to_lowercase();
    words.iter().any(|word| lowered.contains(word))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PushFailure {
    Rejected,
    Network,
}

/// A failed push's stderr: refused or authentication (stop at once) or the network (stop after repeats).
pub fn classify_push_failure(stderr: &str) -> PushFailure {
    if mentions(stderr, &REFUSED_FIRST) {
        return PushFailure::Rejected;
    }
    if mentions(stderr, &NETWORK_FAILURE) {
        PushFailure::Network
    } else {
        PushFailure::Rejected
    }
}

/// The TypeScript's word for a failure, which the captured cases are written in.
#[cfg(test)]
pub fn failure_name(failure: PushFailure) -> &'static str {
    match failure {
        PushFailure::Rejected => "rejected",
        PushFailure::Network => "network",
    }
}

/// The push was refused because the branch has commits the pushed sha lacks.
pub fn moved_on(stderr: &str) -> bool {
    mentions(stderr, &MOVED_ON)
}

/// The push was refused for the account, not the branch.
pub fn not_allowed_at_all(stderr: &str) -> bool {
    mentions(stderr, &NOT_ALLOWED_AT_ALL)
}

/// The last three non-blank lines of `text` on one line, at most 300 characters.
pub fn brief(text: &str) -> String {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|entry| entry.trim_matches(is_js_space))
        .filter(|entry| !entry.is_empty())
        .collect();
    let start = lines.len().saturating_sub(3);
    let line = lines[start..].join(" · ");
    let line = if line.is_empty() {
        "failed".to_owned()
    } else {
        line
    };
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() > 300 {
        format!("{}...", String::from_utf16_lossy(&units[..297]))
    } else {
        line
    }
}

/// Why a landing step failed: git did not run or failed (`Git`, its message already brief), or the remote said no
/// (`Remote`, its stderr whole, for `classify_push_failure`).
#[derive(Debug)]
pub enum Failure {
    Git(Fault),
    Remote(String),
}

impl From<Fault> for Failure {
    fn from(fault: Fault) -> Failure {
        Failure::Git(fault)
    }
}

async fn run(
    git: &Git,
    cwd: &str,
    args: &[&str],
    env: &[(&str, &str)],
    timeout_ms: u64,
) -> Result<Output, Fault> {
    let opts = Opts {
        timeout_ms: Some(timeout_ms),
        env,
        ..Opts::default()
    };
    git.run(cwd, args, opts).await
}

/// A git at the landing timeout, whatever its exit code.
pub async fn plain(git: &Git, cwd: &str, args: &[&str]) -> Result<Output, Fault> {
    run(git, cwd, args, &[], GIT_TIMEOUT_MS).await
}

/// A git's trimmed stdout; one that failed is a fault with its stderr, brief.
pub async fn text(git: &Git, cwd: &str, args: &[&str]) -> Result<String, Fault> {
    let result = plain(git, cwd, args).await?;
    if result.code != 0 {
        return Err(Fault::new("git_exit", brief(&result.stderr)));
    }
    Ok(js_trim(&result.text()).to_owned())
}

/// Fetches `dest` of `remote` into its remote-tracking ref; its tip, or none when the remote has no such branch.
pub async fn fetch_tip(
    git: &Git,
    root: &str,
    remote: &str,
    dest: &str,
) -> Result<Option<String>, Failure> {
    let tracking = format!("refs/remotes/{remote}/{dest}");
    let refspec = format!("+refs/heads/{dest}:{tracking}");
    let fetched = run(
        git,
        root,
        &["fetch", "--no-tags", remote, &refspec],
        &[],
        PUSH_TIMEOUT_MS,
    )
    .await?;
    if fetched.code != 0
        && !fetched
            .stderr
            .to_lowercase()
            .contains("couldn't find remote ref")
    {
        return Err(Failure::Remote(fetched.stderr));
    }
    let tip = plain(git, root, &["rev-parse", "--verify", "-q", &tracking]).await?;
    Ok((tip.code == 0).then(|| js_trim(&tip.text()).to_owned()))
}

/// What merging `second` into `first` would make (`git merge-tree --write-tree`, no checkout touched).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Merge {
    Clean {
        tree: String,
    },
    /// The files it conflicts in.
    Conflicts(Vec<String>),
    /// Git could not say (an unknown commit, an old git).
    Unknown {
        stderr: String,
    },
}

pub async fn merge_tree(git: &Git, root: &str, first: &str, second: &str) -> Result<Merge, Fault> {
    let merged = plain(
        git,
        root,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            first,
            second,
        ],
    )
    .await?;
    // Exit 0: a clean merge, the tree; 1: conflicts, the files after the tree line; anything else: git could not say.
    let text = merged.text();
    let mut lines = js_trim(&text).split('\n');
    Ok(match merged.code {
        0 => Merge::Clean {
            tree: lines.next().unwrap_or_default().to_owned(),
        },
        1 => Merge::Conflicts(
            lines
                .skip(1)
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect(),
        ),
        _ => Merge::Unknown {
            stderr: merged.stderr,
        },
    })
}

/// A commit of `tree` with these parents, made without any checkout or ref (`git commit-tree`, never signed). With
/// `date` (git's date format) the author and committer dates are that instead of now, so the same inputs make the same
/// commit: a build asked again after a restart is the commit it was.
pub async fn commit_tree(
    git: &Git,
    root: &str,
    tree: &str,
    parents: &[&str],
    message: &str,
    date: Option<&str>,
) -> Result<String, Fault> {
    let mut args = vec!["commit-tree", "--no-gpg-sign", tree];
    for parent in parents {
        args.extend(["-p", parent]);
    }
    args.extend(["-m", message]);
    let dates = date.map(|date| [("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)]);
    let result = run(
        git,
        root,
        &args,
        dates.as_ref().map_or(&[][..], |dates| &dates[..]),
        GIT_TIMEOUT_MS,
    )
    .await?;
    if result.code != 0 {
        return Err(Fault::new("git_exit", brief(&result.stderr)));
    }
    Ok(js_trim(&result.text()).to_owned())
}

/// The URL `remote` pushes to now, pinned for the push that follows.
pub async fn push_url(git: &Git, root: &str, remote: &str) -> Result<String, Fault> {
    text(git, root, &["remote", "get-url", remote]).await
}

/// `git push <remote> <sha>:refs/heads/<dest>`: never forced (no `+`, so git refuses anything but a fast-forward), the
/// remote by name with `url` pinned as its `pushurl` through `GIT_CONFIG_*`, so a `pushInsteadOf` rule cannot redirect
/// it. Answers whatever git's exit code.
pub async fn push_sha(
    git: &Git,
    root: &str,
    remote: &str,
    url: &str,
    sha: &str,
    dest: &str,
) -> Result<Output, Fault> {
    let key = format!("remote.{remote}.pushurl");
    let refspec = format!("{sha}:refs/heads/{dest}");
    run(
        git,
        root,
        &["push", remote, &refspec],
        &[
            ("GIT_CONFIG_COUNT", "1"),
            ("GIT_CONFIG_KEY_0", &key),
            ("GIT_CONFIG_VALUE_0", url),
        ],
        PUSH_TIMEOUT_MS,
    )
    .await
}
