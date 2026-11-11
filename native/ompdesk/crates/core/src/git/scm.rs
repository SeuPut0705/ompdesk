//! Git's write side and the Changes panel's history (was `src/main/local/git/scm.ts`): stage, unstage, discard,
//! commit and undo, push/pull/fetch, stash, a stopped operation's continue or abort, branches, the log, a commit's
//! files and diff, and the history's actions. Each method runs its whole sequence of gits here. Main resolves the
//! checkout root first (`git.repoRoot`), takes the repository lock around every mutation and checks what a person
//! typed (paths, branch and tag names, shas, an empty message, a reset mode) before the request; what needs main stays
//! there: removing the untracked files a discard names (main's fenced files, `discard` answers them) and the commit
//! message omp writes. A refusal is a fault whose code is the `LocalCommandError` code the TypeScript threw; git's own
//! failure keeps run's `git_exit` (main reports it as `git_failed` in a mutation, as the TypeScript did).

use std::collections::HashSet;
use std::hash::{BuildHasher, RandomState};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::parse::{self, LOG_FORMAT};
use super::read::{self, Diff, blocking};
use super::run::{Git, Opts, Output, failure};
use crate::fs::disk;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::js_trim;
use crate::server::Fault;

const LOG_PAGE: f64 = 100.0;
const LOG_MAX: f64 = 500.0;
const COMMIT_DIFF_BYTES: usize = 4 * 1024 * 1024;
const BRANCH_FORMAT: &str = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:unix)%00%(worktreepath)%00%(HEAD)";

fn refuse(code: &'static str, message: impl Into<String>) -> Fault {
    Fault::new(code, message)
}

fn strs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

fn literal(paths: &[String]) -> impl Iterator<Item = String> {
    paths.iter().map(|file| format!(":(literal){file}"))
}

/// What a command that may stop on conflicts answers.
#[derive(Serialize)]
pub struct Mutation {
    conflicts: usize,
}

const CLEAN: Mutation = Mutation { conflicts: 0 };

async fn has_head(git: &Git, root: &str) -> Result<bool, Fault> {
    Ok(git
        .raw(root, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .await?
        .code
        == 0)
}

/// Unmerged paths left in the index after a merge, cherry-pick, revert or rebase stopped.
async fn conflict_count(git: &Git, root: &str) -> Result<usize, Fault> {
    let status = git
        .text(
            root,
            &["status", "--porcelain=v2", "-z", "--untracked-files=no"],
        )
        .await?;
    Ok(parse::status_v2_entries(&status).unmerged())
}

/// A command that may stop on conflicts (the slow timeout, no editor): success or conflicts both answer.
async fn run_may_conflict(
    git: &Git,
    root: &str,
    args: &[&str],
    slow_ms: u64,
    sequence_editor: Option<&str>,
) -> Result<Mutation, Fault> {
    let editor = [("GIT_EDITOR", "true")];
    let both;
    let env: &[(&str, &str)] = match sequence_editor {
        Some(command) => {
            both = [("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", command)];
            &both
        }
        None => &editor,
    };
    let opts = Opts {
        timeout_ms: Some(slow_ms),
        env,
        ..Opts::default()
    };
    let output = git.run(root, args, opts).await?;
    if output.code == 0 {
        return Ok(CLEAN);
    }
    let conflicts = conflict_count(git, root).await?;
    if conflicts > 0 {
        return Ok(Mutation { conflicts });
    }
    Err(failure(args, &output))
}

pub async fn stage(git: &Git, root: &str, paths: Option<&[String]>) -> Result<(), Fault> {
    let mut args = vec!["add".to_owned(), "-A".into()];
    if let Some(paths) = paths {
        args.push("--".into());
        args.extend(literal(paths));
    }
    git.text(root, &strs(&args)).await?;
    Ok(())
}

pub async fn unstage(git: &Git, root: &str, paths: Option<&[String]>) -> Result<(), Fault> {
    let spec: Vec<String> = match paths {
        Some(paths) => literal(paths).collect(),
        None => vec![".".into()],
    };
    // An unborn branch has no HEAD to restore the index from: drop the entries instead.
    let mut args: Vec<String> = if has_head(git, root).await? {
        ["restore", "--staged", "--"].map(String::from).to_vec()
    } else {
        ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--"]
            .map(String::from)
            .to_vec()
    };
    args.extend(spec);
    git.text(root, &strs(&args)).await?;
    Ok(())
}

#[derive(Serialize)]
pub struct Discarded {
    /// Untracked or newly added paths, out of the index now: main removes them from the checkout.
    fresh: Vec<String>,
}

/// Back to HEAD in index and worktree; untracked or newly added paths leave the index and are answered for removal.
pub async fn discard(git: &Git, root: &str, paths: &[String]) -> Result<Discarded, Fault> {
    let mut args: Vec<String> = [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--",
    ]
    .map(String::from)
    .to_vec();
    args.extend(literal(paths));
    let status = parse::status_v2_entries(&git.text(root, &strs(&args)).await?).in_v1_order();
    let is_fresh = |index: char| index == '?' || index == 'A';
    let fresh: Vec<String> = status
        .iter()
        .filter(|entry| is_fresh(entry.index))
        .map(|entry| entry.path.clone())
        .collect();
    let mut tracked: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut track = |path: &str| {
        if seen.insert(path.to_owned()) {
            tracked.push(path.to_owned());
        }
    };
    for entry in status.iter().filter(|entry| !is_fresh(entry.index)) {
        track(&entry.path);
        if let Some(old) = &entry.old_path {
            track(old);
        }
    }
    // A status limited to the new path cannot pair a staged rename with its old path (outside the pathspec), so it
    // reports a plain add; discarding that alone would leave the old file staged as deleted.
    if status.iter().any(|entry| entry.index == 'A') {
        let whole = git
            .text(
                root,
                &["status", "--porcelain=v2", "-z", "--untracked-files=no"],
            )
            .await?;
        let added: HashSet<&str> = status
            .iter()
            .filter(|entry| entry.index == 'A')
            .map(|entry| entry.path.as_str())
            .collect();
        for entry in parse::status_v2_entries(&whole).in_v1_order() {
            if let (true, Some(old)) = (
                entry.index == 'R' && added.contains(entry.path.as_str()),
                &entry.old_path,
            ) {
                track(old);
            }
        }
    }
    if !tracked.is_empty() {
        let mut args: Vec<String> = ["restore", "--source=HEAD", "--staged", "--worktree", "--"]
            .map(String::from)
            .to_vec();
        args.extend(literal(&tracked));
        git.text(root, &strs(&args)).await?;
    }
    if !fresh.is_empty() {
        let mut args: Vec<String> = ["rm", "-q", "--cached", "--ignore-unmatch", "--"]
            .map(String::from)
            .to_vec();
        args.extend(literal(&fresh));
        git.raw(root, &strs(&args)).await?;
    }
    Ok(Discarded { fresh })
}

#[derive(Serialize)]
pub struct Committed {
    sha: String,
}

/// Commits what is staged with `message` (main trimmed it and refused an empty one), or amends the last commit.
pub async fn commit(
    git: &Git,
    root: &str,
    message: &str,
    amend: bool,
    slow_ms: u64,
) -> Result<Committed, Fault> {
    if conflict_count(git, root).await? > 0 {
        return Err(refuse(
            "git_failed",
            "Resolve every conflict before committing",
        ));
    }
    let mut args = vec!["commit", "--cleanup=strip", "-m", message];
    if amend {
        args.push("--amend");
    } else if git.raw(root, &["diff", "--cached", "--quiet"]).await?.code == 0 {
        return Err(refuse("nothing_staged", "Nothing is staged to commit"));
    }
    let opts = Opts {
        timeout_ms: Some(slow_ms),
        ..Opts::default()
    };
    git.text_with(root, &args, opts).await?;
    let sha = git.text(root, &["rev-parse", "HEAD"]).await?;
    Ok(Committed {
        sha: js_trim(&sha).to_owned(),
    })
}

#[derive(Serialize)]
pub struct Message {
    message: String,
}

pub async fn last_commit_message(git: &Git, root: &str) -> Result<Message, Fault> {
    if !has_head(git, root).await? {
        return Ok(Message {
            message: String::new(),
        });
    }
    let message = git.text(root, &["log", "-1", "--format=%B"]).await?;
    Ok(Message {
        message: js_trim(&message).to_owned(),
    })
}

/// Undo the last commit and keep its changes staged (`reset --soft HEAD~1`).
pub async fn undo_commit(git: &Git, root: &str) -> Result<(), Fault> {
    if git
        .raw(root, &["rev-parse", "--verify", "--quiet", "HEAD~1"])
        .await?
        .code
        != 0
    {
        return Err(refuse(
            "git_failed",
            "The first commit has no parent to go back to",
        ));
    }
    git.text(root, &["reset", "--soft", "HEAD~1"]).await?;
    Ok(())
}

#[derive(Serialize)]
pub struct Staged {
    staged: bool,
}

/// Whether anything is staged: the commit message omp writes (main) reads the staged changes.
pub async fn staged(git: &Git, root: &str) -> Result<Staged, Fault> {
    let quiet = git.raw(root, &["diff", "--cached", "--quiet"]).await?;
    Ok(Staged {
        staged: quiet.code != 0,
    })
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteAction {
    Push,
    Pull,
    Fetch,
}

impl RemoteAction {
    fn word(self) -> &'static str {
        match self {
            RemoteAction::Push => "push",
            RemoteAction::Pull => "pull",
            RemoteAction::Fetch => "fetch",
        }
    }
}

#[derive(Serialize)]
pub struct Remote {
    #[serde(skip_serializing_if = "Option::is_none")]
    published: Option<String>,
    output: String,
}

fn remote_failure(action: RemoteAction, output: &Output) -> Fault {
    let stderr = js_trim(&output.stderr);
    let text = if stderr.is_empty() {
        format!("git {} exited with code {}", action.word(), output.code)
    } else {
        stderr.to_owned()
    };
    let rejected = [
        "[rejected]",
        "non-fast-forward",
        "fetch first",
        "(stale info)",
    ]
    .iter()
    .any(|mark| text.contains(mark));
    refuse(
        if rejected {
            "push_rejected"
        } else {
            "git_failed"
        },
        text,
    )
}

pub async fn remote(
    git: &Git,
    root: &str,
    action: RemoteAction,
    slow_ms: u64,
) -> Result<Remote, Fault> {
    let head = read::head(git, root).await?;
    if !head.has_remote {
        return Err(refuse("no_remote", "This repository has no remote"));
    }
    let slow = Opts {
        timeout_ms: Some(slow_ms),
        ..Opts::default()
    };
    if action == RemoteAction::Fetch {
        let output = git.run(root, &["fetch", "--prune"], slow).await?;
        if output.code != 0 {
            return Err(remote_failure(action, &output));
        }
        return Ok(Remote {
            published: None,
            output: js_trim(&output.stderr).to_owned(),
        });
    }
    let Some(branch) = head.branch else {
        return Err(refuse(
            "detached_head",
            format!(
                "Switch to a branch before you {}: HEAD is detached",
                action.word()
            ),
        ));
    };
    if action == RemoteAction::Pull {
        if head.upstream.is_none() {
            return Err(refuse(
                "no_remote",
                format!("{branch} has no upstream to pull from"),
            ));
        }
        // Without the user's own pull.rebase/pull.ff, git refuses a divergent pull; merge then, like a plain
        // `git pull` did.
        let configured = git
            .raw(root, &["config", "--get-regexp", "^pull\\.(rebase|ff)$"])
            .await?
            .code
            == 0;
        let mut args = vec!["pull", "--no-edit"];
        if !configured {
            args.push("--no-rebase");
        }
        let opts = Opts {
            env: &[("GIT_EDITOR", "true")],
            ..slow
        };
        let output = git.run(root, &args, opts).await?;
        if output.code != 0 {
            if conflict_count(git, root).await? > 0 {
                return Err(refuse(
                    "git_failed",
                    "Pull stopped on conflicts; resolve them, then continue",
                ));
            }
            return Err(remote_failure(action, &output));
        }
        let stdout = output.text();
        let said = js_trim(&stdout);
        return Ok(Remote {
            published: None,
            output: if said.is_empty() {
                js_trim(&output.stderr).to_owned()
            } else {
                said.to_owned()
            },
        });
    }
    if head.upstream.is_some() {
        let output = git.run(root, &["push"], slow).await?;
        if output.code != 0 {
            return Err(remote_failure(action, &output));
        }
        return Ok(Remote {
            published: None,
            output: js_trim(&output.stderr).to_owned(),
        });
    }
    let remotes = git.text(root, &["remote"]).await?;
    let names: Vec<&str> = remotes
        .split('\n')
        .filter(|name| !name.is_empty())
        .collect();
    let target = if names.contains(&"origin") {
        "origin"
    } else {
        names.first().copied().unwrap_or("")
    };
    let output = git
        .run(root, &["push", "--set-upstream", target, &branch], slow)
        .await?;
    if output.code != 0 {
        return Err(remote_failure(action, &output));
    }
    Ok(Remote {
        published: Some(format!("{target}/{branch}")),
        output: js_trim(&output.stderr).to_owned(),
    })
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StashAction {
    Push,
    Pop,
}

/// `message` is what main kept of the person's text (trimmed, none when empty).
pub async fn stash(
    git: &Git,
    root: &str,
    action: StashAction,
    message: Option<&str>,
    slow_ms: u64,
) -> Result<Mutation, Fault> {
    if action == StashAction::Pop {
        return run_may_conflict(git, root, &["stash", "pop"], slow_ms, None).await;
    }
    let mut args = vec!["stash", "push", "--include-untracked"];
    if let Some(message) = message {
        args.extend(["-m", message]);
    }
    git.text(root, &args).await?;
    Ok(CLEAN)
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OperationAction {
    Continue,
    Abort,
}

pub async fn operation(
    git: &Git,
    root: &str,
    action: OperationAction,
    slow_ms: u64,
) -> Result<Mutation, Fault> {
    let head = read::head(git, root).await?;
    let Some(operation) = head.operation else {
        return Err(refuse(
            "git_failed",
            "No merge, rebase, cherry-pick or revert is in progress",
        ));
    };
    if action == OperationAction::Abort {
        git.text(root, &[operation, "--abort"]).await?;
        return Ok(CLEAN);
    }
    if conflict_count(git, root).await? > 0 {
        return Err(refuse(
            "git_failed",
            "Resolve every conflict before continuing",
        ));
    }
    run_may_conflict(git, root, &[operation, "--continue"], slow_ms, None).await
}

#[derive(Serialize)]
pub struct Branch {
    name: String,
    remote: bool,
    current: bool,
    upstream: Option<String>,
    /// The checkout that holds the branch when it is another one than this.
    worktree: Option<String>,
    sha: String,
    date: u64,
}

/// `fsp.realpath` as node spells the answer.
fn real(path: &str) -> Result<String, NodeError> {
    disk::realpath(path).map(|real| disk::spelled(&real))
}

pub async fn branches(git: &Git, root: &str) -> Result<Vec<Branch>, Fault> {
    let checkout = root.to_owned();
    let real_root = blocking(move || real(&checkout))
        .await?
        .map_err(|error| error.fault(Codes::None))?;
    let format = format!("--format={BRANCH_FORMAT}");
    let output = git
        .text(
            root,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                &format,
                "refs/heads",
                "refs/remotes",
            ],
        )
        .await?;
    blocking(move || {
        let mut list = Vec::new();
        for line in output.split('\n') {
            let fields: Vec<&str> = line.split('\0').collect();
            let field = |at: usize| fields.get(at).copied().unwrap_or("");
            let (refname, name) = (field(0), field(1));
            if refname.is_empty() || name.is_empty() || refname.ends_with("/HEAD") {
                continue;
            }
            let current = field(6) == "*";
            let worktree = field(5);
            let elsewhere = (!worktree.is_empty() && !current)
                .then(|| real(worktree).unwrap_or_else(|_| worktree.to_owned()))
                .filter(|place| *place != real_root)
                .map(|_| worktree.to_owned());
            let upstream = field(2);
            list.push(Branch {
                name: name.to_owned(),
                remote: refname.starts_with("refs/remotes/"),
                current,
                upstream: (!upstream.is_empty()).then(|| upstream.to_owned()),
                worktree: elsewhere,
                sha: field(3).to_owned(),
                date: parse::seconds(field(4)),
            });
        }
        list
    })
    .await
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BranchAction {
    Switch,
    Create,
    Rename,
    Delete,
    Merge,
}

/// What a branch action names: `name` always, `new_name` for a rename and `base` for a create (main checked them).
pub struct BranchInput<'a> {
    pub action: BranchAction,
    pub name: &'a str,
    pub new_name: &'a str,
    pub base: Option<&'a str>,
    pub force: bool,
}

pub async fn branch(
    git: &Git,
    root: &str,
    input: BranchInput<'_>,
    slow_ms: u64,
) -> Result<Mutation, Fault> {
    let name = input.name;
    let known = branches(git, root).await?;
    let entry = known.iter().find(|item| item.name == name);
    let held = || {
        entry
            .and_then(|entry| entry.worktree.as_deref())
            .map(|worktree| {
                refuse(
                    "branch_checked_out",
                    format!("{name} is checked out in {worktree}"),
                )
            })
    };
    match input.action {
        BranchAction::Switch => {
            if let Some(refused) = held() {
                return Err(refused);
            }
            if entry.is_some_and(|entry| entry.remote) {
                let local = name.split_once('/').map_or(name, |(_, rest)| rest);
                if known.iter().any(|item| !item.remote && item.name == local) {
                    git.text(root, &["switch", local]).await?;
                } else {
                    git.text(root, &["switch", "--track", name]).await?;
                }
            } else {
                git.text(root, &["switch", name]).await?;
            }
            Ok(CLEAN)
        }
        BranchAction::Create => {
            let mut args = vec!["switch", "-c", name];
            args.extend(input.base);
            git.text(root, &args).await?;
            Ok(CLEAN)
        }
        BranchAction::Rename => {
            git.text(root, &["branch", "-m", name, input.new_name])
                .await?;
            Ok(CLEAN)
        }
        BranchAction::Delete => {
            if entry.is_some_and(|entry| entry.current) {
                return Err(refuse(
                    "git_failed",
                    "Switch away before deleting the current branch",
                ));
            }
            if let Some(refused) = held() {
                return Err(refused);
            }
            let flag = if input.force { "-D" } else { "-d" };
            git.text(root, &["branch", flag, name]).await?;
            Ok(CLEAN)
        }
        BranchAction::Merge => {
            run_may_conflict(git, root, &["merge", "--no-edit", name], slow_ms, None).await
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    commits: Vec<parse::Commit>,
    /// More commits exist past this page.
    more: bool,
    /// `<web base>/commit/{sha}` of the remote the history links to.
    commit_url: Option<String>,
}

async fn commit_url(git: &Git, root: &str) -> Result<Option<String>, Fault> {
    let remotes = git.text(root, &["remote"]).await?;
    let names: Vec<&str> = remotes
        .split('\n')
        .filter(|name| !name.is_empty())
        .collect();
    let Some(&name) = names
        .iter()
        .find(|name| **name == "origin")
        .or(names.first())
    else {
        return Ok(None);
    };
    let url = git.raw(root, &["remote", "get-url", name]).await?;
    let base = (url.code == 0)
        .then(|| parse::remote_web_base(&url.text()))
        .flatten();
    Ok(base.map(|base| format!("{base}/commit/{{sha}}")))
}

/// `limit` and `skip` as the page sent them (JSON numbers), `query` as main trimmed it (none when empty).
pub async fn log(
    git: &Git,
    root: &str,
    limit: Option<f64>,
    skip: Option<f64>,
    query: Option<&str>,
) -> Result<Log, Fault> {
    if !has_head(git, root).await? {
        return Ok(Log {
            commits: Vec::new(),
            more: false,
            commit_url: None,
        });
    }
    let limit = limit.unwrap_or(LOG_PAGE).clamp(1.0, LOG_MAX);
    let skip = skip.unwrap_or(0.0).max(0.0);
    let mut args = vec![
        "log".to_owned(),
        format!("--format={LOG_FORMAT}"),
        "-n".into(),
        parse::js_number(limit + 1.0),
        format!("--skip={}", parse::js_number(skip)),
    ];
    let grep = |query: &str| {
        [
            "--regexp-ignore-case".to_owned(),
            "--fixed-strings".into(),
            format!("--grep={query}"),
        ]
    };
    if let Some(query) = query {
        // A hex query may be a commit id; otherwise match subject/body and author.
        let hex =
            (4..=40).contains(&query.len()) && query.bytes().all(|byte| byte.is_ascii_hexdigit());
        let found = if hex {
            let spec = format!("{query}^{{commit}}");
            let found = git
                .raw(root, &["rev-parse", "--verify", "--quiet", &spec])
                .await?;
            (found.code == 0).then(|| js_trim(&found.text()).to_owned())
        } else {
            None
        };
        match found {
            Some(sha) => args.extend(["--no-walk".to_owned(), sha]),
            None => args.extend(grep(query)),
        }
    }
    let args = strs(&args);
    let (output, url) = tokio::try_join!(git.text(root, &args), commit_url(git, root))?;
    let mut commits: Vec<parse::Commit> =
        output.split('\x1e').filter_map(parse::log_record).collect();
    let more = commits.len() as f64 > limit;
    // `slice(0, limit)`: the whole part of the limit.
    commits.truncate(limit.trunc() as usize);
    Ok(Log {
        commits,
        more,
        commit_url: url,
    })
}

#[derive(Serialize)]
pub struct CommitDetail {
    #[serde(flatten)]
    commit: parse::Commit,
    body: String,
    files: Vec<parse::CommitFile>,
}

/// One commit's header, body and files; `sha` is what main checked (4 to 64 hex digits).
pub async fn commit_detail(git: &Git, root: &str, sha: &str) -> Result<CommitDetail, Fault> {
    let format = format!("--format={LOG_FORMAT}");
    let header = ["log", "-1", &format, sha];
    let body = ["log", "-1", "--format=%b", sha];
    let numstat = [
        "show",
        "--format=",
        "--numstat",
        "-z",
        "--find-renames",
        "--first-parent",
        sha,
    ];
    let names = [
        "show",
        "--format=",
        "--name-status",
        "-z",
        "--find-renames",
        "--first-parent",
        sha,
    ];
    let (header, body, numstat, names) = tokio::try_join!(
        git.text(root, &header),
        git.text(root, &body),
        git.text(root, &numstat),
        git.text(root, &names),
    )?;
    let Some(commit) = parse::log_record(header.split('\x1e').next().unwrap_or("")) else {
        return Err(refuse("invalid_name", format!("Unknown commit: {sha}")));
    };
    Ok(CommitDetail {
        commit,
        body: js_trim(&body).to_owned(),
        files: parse::commit_files(&numstat, &names),
    })
}

/// One file's diff in a commit against its first parent; main checked the sha and the path.
pub async fn commit_diff(git: &Git, root: &str, sha: &str, file_path: &str) -> Result<Diff, Fault> {
    let spec = format!(":(literal){file_path}");
    let args = [
        "show",
        "--format=",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--first-parent",
        "-U3",
        sha,
        "--",
        &spec,
    ];
    let output = git.capped(root, &args, COMMIT_DIFF_BYTES).await?;
    if output.code != 0 {
        let stderr = js_trim(&output.stderr);
        return Err(refuse(
            "git_failed",
            if stderr.is_empty() {
                "git show failed"
            } else {
                stderr
            },
        ));
    }
    let diff = output.text();
    if parse::has_line_starting(&diff, "Binary files ") {
        return Ok(Diff::of_kind(file_path, "binary", false));
    }
    Ok(Diff::text(file_path, &diff, output.truncated))
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryAction {
    Checkout,
    Branch,
    CherryPick,
    Revert,
    Reset,
    Tag,
    DeleteTag,
    MoveEarlier,
    MoveLater,
}

/// A history action on `sha`; `mode` (a reset's) and `name` (a branch's or tag's) as main checked them.
pub async fn history_action(
    git: &Git,
    root: &str,
    action: HistoryAction,
    sha: &str,
    mode: &str,
    name: &str,
    slow_ms: u64,
) -> Result<Mutation, Fault> {
    match action {
        HistoryAction::Checkout => git.text(root, &["switch", "--detach", sha]).await,
        HistoryAction::Branch => git.text(root, &["switch", "-c", name, sha]).await,
        HistoryAction::CherryPick => {
            return run_may_conflict(git, root, &["cherry-pick", sha], slow_ms, None).await;
        }
        HistoryAction::Revert => {
            return run_may_conflict(git, root, &["revert", "--no-edit", sha], slow_ms, None).await;
        }
        HistoryAction::Reset => git.text(root, &["reset", &format!("--{mode}"), sha]).await,
        HistoryAction::Tag => git.text(root, &["tag", name, sha]).await,
        HistoryAction::DeleteTag => git.text(root, &["tag", "-d", name]).await,
        HistoryAction::MoveEarlier => return reorder(git, root, sha, true, slow_ms).await,
        HistoryAction::MoveLater => return reorder(git, root, sha, false, slow_ms).await,
    }?;
    Ok(CLEAN)
}

/// The parents `rev-list --parents -n 1` names after the commit itself.
async fn parents_of(git: &Git, root: &str, commit: &str) -> Result<Vec<String>, Fault> {
    let line = git
        .text(root, &["rev-list", "--parents", "-n", "1", commit])
        .await?;
    Ok(js_trim(&line)
        .split(' ')
        .skip(1)
        .map(str::to_owned)
        .collect())
}

/// A fresh folder `<temp>/<prefix>XXXXXX`, only the user's (node's `fs.mkdtemp`).
fn make_temp_dir(prefix: &str) -> Result<PathBuf, NodeError> {
    const LETTERS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let base = std::env::temp_dir();
    let random = RandomState::new();
    let mut attempt = 0u32;
    loop {
        let mut bits = random.hash_one(attempt);
        let name: String = (0..6)
            .map(|_| {
                let letter = LETTERS[(bits % LETTERS.len() as u64) as usize];
                bits /= LETTERS.len() as u64;
                char::from(letter)
            })
            .collect();
        let dir = base.join(format!("{prefix}{name}"));
        #[cfg(unix)]
        let builder = {
            let mut builder = std::fs::DirBuilder::new();
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = std::fs::DirBuilder::new();
        match builder.create(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 100 => {
                attempt += 1;
            }
            Err(error) => {
                let spelled = base.join(format!("{prefix}XXXXXX"));
                return Err(NodeError::new(
                    &error,
                    "mkdtemp",
                    Some(&spelled.to_string_lossy()),
                ));
            }
        }
    }
}

/// Swap `sha` with its parent (`earlier`) or with its child on HEAD's line through an interactive rebase whose todo is
/// written here (`GIT_SEQUENCE_EDITOR` copies it in). Only a clean, merge-free, unpushed stretch of the current line
/// is rewritten; a conflict stops the rebase for continue/abort like any other.
async fn reorder(
    git: &Git,
    root: &str,
    sha: &str,
    earlier: bool,
    slow_ms: u64,
) -> Result<Mutation, Fault> {
    let head = read::head(git, root).await?;
    if let Some(operation) = head.operation {
        return Err(refuse(
            "git_failed",
            format!("Finish or abort the {operation} first"),
        ));
    }
    let dirty = git
        .text(root, &["status", "--porcelain=v1", "--untracked-files=no"])
        .await?;
    if !js_trim(&dirty).is_empty() {
        return Err(refuse(
            "dirty_worktree",
            "Commit or stash your changes before moving a commit",
        ));
    }
    let spec = format!("{sha}^{{commit}}");
    let full = git.text(root, &["rev-parse", "--verify", &spec]).await?;
    let full = js_trim(&full).to_owned();
    let mut older = full.clone();
    if earlier {
        let parents = parents_of(git, root, &full).await?;
        let [parent] = parents.as_slice() else {
            return Err(refuse(
                "git_failed",
                "Only a commit with one parent can move earlier",
            ));
        };
        older = parent.clone();
    }
    let older_parents = parents_of(git, root, &older).await?;
    let [base] = older_parents.as_slice() else {
        return Err(refuse(
            "git_failed",
            "The first commit and merge commits can't be moved",
        ));
    };
    let range = format!("{base}..HEAD");
    // A merge anywhere above `base` would be flattened (or its side lost) by a plain todo: refuse those lines.
    let merges = git
        .text(root, &["rev-list", "--merges", "--count", &range])
        .await?;
    if js_trim(&merges) != "0" {
        return Err(refuse(
            "git_failed",
            "Commits after this one include a merge; reorder them in a terminal",
        ));
    }
    // HEAD's line from `older` up, oldest first.
    let line = git.text(root, &["rev-list", "--reverse", &range]).await?;
    let mut order: Vec<&str> = js_trim(&line)
        .split('\n')
        .filter(|commit| !commit.is_empty())
        .collect();
    if order.first() != Some(&older.as_str()) || order.len() < 2 || (earlier && order[1] != full) {
        return Err(refuse(
            "git_failed",
            "Only commits on the current branch with a commit after them can move",
        ));
    }
    if let Some(upstream) = &head.upstream
        && git
            .raw(
                root,
                &["merge-base", "--is-ancestor", &older, "@{upstream}"],
            )
            .await?
            .code
            == 0
    {
        let short: String = older.chars().take(7).collect();
        return Err(refuse(
            "commit_pushed",
            format!("{short} is already on {upstream}; moving it would rewrite pushed history"),
        ));
    }
    order.swap(0, 1);
    let todo: String = order
        .iter()
        .map(|commit| format!("pick {commit}\n"))
        .collect();
    let dir = blocking(|| make_temp_dir("ompdesk-reorder-"))
        .await?
        .map_err(|error| error.fault(Codes::None))?;
    let file = dir.join("git-rebase-todo");
    let written = {
        let file = file.clone();
        blocking(move || {
            std::fs::write(&file, todo)
                .map_err(|error| NodeError::new(&error, "open", Some(&file.to_string_lossy())))
        })
        .await
    };
    let outcome = match written {
        Ok(Ok(())) => {
            // git runs the sequence editor through its shell (sh, also on Git for Windows) with the todo path appended.
            let path = file
                .to_string_lossy()
                .replace('\\', "/")
                .replace('\'', "'\\''");
            let editor = format!("cp '{path}'");
            run_may_conflict(
                git,
                root,
                &["rebase", "-i", "--no-autosquash", base.as_str()],
                slow_ms,
                Some(&editor),
            )
            .await
        }
        Ok(Err(error)) => Err(error.fault(Codes::None)),
        Err(fault) => Err(fault),
    };
    let _ = blocking(move || std::fs::remove_dir_all(Path::new(&dir))).await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run::tests::git;
    use std::process::Command;

    /// The tests' own git, which no host config shapes (an empty file: Windows git cannot open `NUL` as one).
    fn sh(dir: &Path, args: &[&str]) -> String {
        let config =
            std::env::temp_dir().join(format!("ompdesk-core-scm-config-{}", std::process::id()));
        if !config.exists() {
            std::fs::write(&config, "").unwrap();
        }
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &config)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repo(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-scm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q", "-b", "main"]);
        // The core's gits read the host's config: Git for Windows sets core.autocrlf system-wide.
        sh(&dir, &["config", "core.autocrlf", "false"]);
        sh(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        sh(&dir, &["add", "-A"]);
        sh(&dir, &["commit", "-qm", "init"]);
        dir
    }

    /// A merge stopped on a conflict: the porcelain v2 count of unmerged paths is what v1's conflict letters gave.
    #[tokio::test]
    async fn counts_the_conflicts_a_stopped_merge_left_and_answers_them() {
        let dir = repo("conflict");
        sh(&dir, &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.join("README.md"), "side\n").unwrap();
        std::fs::write(dir.join("both.txt"), "side\n").unwrap();
        sh(&dir, &["add", "-A"]);
        sh(&dir, &["commit", "-qm", "side"]);
        sh(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("README.md"), "main\n").unwrap();
        std::fs::write(dir.join("both.txt"), "main\n").unwrap();
        sh(&dir, &["add", "-A"]);
        sh(&dir, &["commit", "-qm", "main"]);
        let root = dir.to_str().unwrap();
        let git = git();
        let failed = run_may_conflict(&git, root, &["no-such-command"], 60_000, None).await;
        assert_eq!(failed.err().unwrap().code, "git_exit");
        let merged = run_may_conflict(&git, root, &["merge", "--no-edit", "side"], 60_000, None)
            .await
            .unwrap();
        assert_eq!(merged.conflicts, 2);
        assert_eq!(conflict_count(&git, root).await.unwrap(), 2);
        let refused = commit(&git, root, "x", false, 60_000).await.err().unwrap();
        assert_eq!(
            refused,
            refuse("git_failed", "Resolve every conflict before committing")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn answers_what_a_discard_leaves_main_to_remove() {
        let dir = repo("discard");
        std::fs::write(dir.join("README.md"), "changed\n").unwrap();
        std::fs::write(dir.join("new file.txt"), "new\n").unwrap();
        std::fs::write(dir.join("added.txt"), "added\n").unwrap();
        sh(&dir, &["add", "added.txt"]);
        let root = dir.to_str().unwrap();
        let paths = ["README.md", "new file.txt", "added.txt"].map(String::from);
        let discarded = discard(&git(), root, &paths).await.unwrap();
        assert_eq!(discarded.fresh, ["added.txt", "new file.txt"]);
        assert_eq!(
            std::fs::read_to_string(dir.join("README.md")).unwrap(),
            "hello\n"
        );
        assert_eq!(
            sh(&dir, &["status", "--porcelain", "-z"]),
            "?? added.txt\0?? new file.txt\0"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn makes_a_private_temp_folder_once_per_name() {
        let one = make_temp_dir("ompdesk-core-test-").unwrap();
        let two = make_temp_dir("ompdesk-core-test-").unwrap();
        assert_ne!(one, two);
        let name = one.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.len(), "ompdesk-core-test-".len() + 6);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&one).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::remove_dir(one).unwrap();
        std::fs::remove_dir(two).unwrap();
    }
}
