//! The PR Center over gh (was `src/main/local/git/pr.ts`): the checkout's GitHub repository, the list, a PR's detail,
//! one file's diff, the facts a draft is written from, create, merge, review, comment, the conversation and edit. A
//! refusal is a fault whose code is the `LocalCommandError` code the TypeScript threw (`gh_missing`,
//! `gh_unauthenticated`, `not_a_repo`, `no_github_remote`, `pr_not_found`, `pr_create_failed`, `pr_draft_failed`,
//! `pr_merge_failed`, `pr_review_failed`, `pr_edit_failed`); what the TypeScript let through uncoded keeps the runner's
//! code (`git_exit`, `gh_json`, …). Main keeps the checks of what the page sent that came before the repository (a PR
//! number, an empty review or comment) and the draft's model call.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::json::{self, get, or};
use super::{BodyFile, Gh, Tools};
use crate::fs::order::{is_js_space, js_trim};
use crate::git::parse::js_number;
use crate::git::read;
use crate::json::utf16_prefix;
use crate::run::Opts;
use crate::server::Fault;

const LIST_FIELDS: &str = "number,title,url,isDraft,author,headRefName,baseRefName,additions,deletions,updatedAt,reviewDecision,statusCheckRollup";
const DETAIL_FIELDS: &str = "number,title,url,isDraft,author,body,state,baseRefName,headRefName,mergeStateStatus,additions,deletions,reviewDecision,files,statusCheckRollup";

/// The checkout's GitHub repository (`requireGithubRepo`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub root: String,
    pub repo: String,
    pub default_branch: Option<String>,
}

/// gh, the checkout root, then `gh repo view`; when gh cannot read the repository, whether gh is signed in decides
/// which refusal it is.
pub async fn repo(tools: &Tools, cwd: &str) -> Result<Repo, Fault> {
    tools.gh.require()?;
    let Some(root) = read::repo_root(tools.git()?, cwd).await? else {
        return Err(Fault::new(
            "not_a_repo",
            format!("Not a git repository: {cwd}"),
        ));
    };
    let view = match tools
        .gh
        .call(
            &root,
            &["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
            Opts::default(),
        )
        .await
        .and_then(|text| json::parse(&text))
    {
        Ok(view) => view,
        Err(fault) if fault == Fault::cancelled() => return Err(fault),
        Err(fault) => {
            // gh cannot read any repo while signed out; say that instead of "no GitHub remote".
            return Err(if signed_in(&tools.gh, &root).await == Some(false) {
                Fault::new(
                    "gh_unauthenticated",
                    format!("GitHub CLI is not signed in: {}", fault.message),
                )
            } else {
                Fault::new(
                    "no_github_remote",
                    format!("No GitHub remote for {root}: {}", fault.message),
                )
            });
        }
    };
    let Some(name) = json::text(&view, "nameWithOwner").filter(|name| !name.is_empty()) else {
        return Err(Fault::new(
            "no_github_remote",
            format!("No GitHub remote for {root}"),
        ));
    };
    let default_branch = get(&view, "defaultBranchRef")
        .and_then(|branch| json::text(branch, "name"))
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    Ok(Repo {
        repo: name.to_owned(),
        root,
        default_branch,
    })
}

/// `ghAuthStatus(...).authenticated` on github.com: `--active` first, the plain call on a gh older than 2.40 that has no
/// such flag. None when gh could not answer (`.catch(() => null)`). The TypeScript then listed the other accounts, which
/// this answer never read.
async fn signed_in(gh: &Gh, root: &str) -> Option<bool> {
    const HOST: [&str; 4] = ["auth", "status", "--hostname", "github.com"];
    let mut auth = gh
        .text(root, &[&HOST[..], &["--active"]].concat())
        .await
        .ok()?;
    if auth.code != 0 && unknown_active(&format!("{}\n{}", auth.stdout, auth.stderr)) {
        auth = gh.text(root, &HOST).await.ok()?;
    }
    Some(auth.code == 0)
}

/// `/unknown flag:? --active/i`.
fn unknown_active(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.match_indices("unknown flag").any(|(at, found)| {
        let rest = &lower[at + found.len()..];
        let rest = rest.strip_prefix(':').unwrap_or(rest);
        rest.starts_with(" --active")
    })
}

/// `pr_repo`: the repository, or which of four reasons makes the PR Center unavailable.
#[derive(Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum Availability {
    Available {
        available: bool,
        repo: String,
        default_branch: Option<String>,
    },
    Unavailable {
        available: bool,
        reason: String,
    },
}

pub async fn availability(tools: &Tools, cwd: &str) -> Result<Availability, Fault> {
    match repo(tools, cwd).await {
        Ok(found) => Ok(Availability::Available {
            available: true,
            repo: found.repo,
            default_branch: found.default_branch,
        }),
        Err(fault)
            if matches!(
                fault.code.as_ref(),
                "gh_missing" | "gh_unauthenticated" | "not_a_repo" | "no_github_remote"
            ) =>
        {
            Ok(Availability::Unavailable {
                available: false,
                reason: fault.code.into_owned(),
            })
        }
        Err(fault) => Err(fault),
    }
}

/// The PR Center's list views: every PR, those waiting on your review, yours.
#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum View {
    #[default]
    All,
    Review,
    Mine,
}

#[derive(Serialize)]
pub struct Counts {
    success: u32,
    failure: u32,
    pending: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    number: Value,
    title: Value,
    url: Value,
    is_draft: Value,
    author_login: Value,
    head_ref_name: Value,
    base_ref_name: Value,
    additions: Value,
    deletions: Value,
    updated_at: Value,
    review_decision: Value,
    checks: Counts,
}

pub async fn list(
    tools: &Tools,
    cwd: &str,
    state: Option<&str>,
    limit: Option<f64>,
    view: View,
) -> Result<Vec<ListItem>, Fault> {
    let found = repo(tools, cwd).await?;
    let limit = limit.map_or_else(|| "50".to_owned(), js_number);
    let mut args = vec![
        "pr",
        "list",
        "--repo",
        &found.repo,
        "--state",
        state.unwrap_or("open"),
        "--limit",
        &limit,
    ];
    match view {
        View::All => {}
        View::Review => args.extend(["--search", "review-requested:@me"]),
        View::Mine => args.extend(["--search", "author:@me"]),
    }
    args.extend(["--json", LIST_FIELDS]);
    let rows = json::parse(&tools.gh.call(&found.root, &args, Opts::default()).await?)?;
    Ok(json::list(&rows)
        .iter()
        .map(|row| ListItem {
            number: or(row, "number", 0),
            title: or(row, "title", ""),
            url: or(row, "url", ""),
            is_draft: or(row, "isDraft", false),
            author_login: json::login(row, "author"),
            head_ref_name: or(row, "headRefName", ""),
            base_ref_name: or(row, "baseRefName", ""),
            additions: or(row, "additions", 0),
            deletions: or(row, "deletions", 0),
            updated_at: or(row, "updatedAt", ""),
            review_decision: or(row, "reviewDecision", Value::Null),
            checks: rollup_counts(json::rows(row, "statusCheckRollup")),
        })
        .collect())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Check {
    name: Value,
    status: Value,
    conclusion: Value,
}

/// `rollupChecks`: a check run as it is; a commit status (Jenkins, Prow, a deploy hook) has only a `state`, and
/// SUCCESS, FAILURE and ERROR are finished with that conclusion while PENDING and EXPECTED still wait.
fn rollup_checks(rollup: &[Value]) -> Vec<Check> {
    rollup
        .iter()
        .map(|check| {
            let name = get(check, "name")
                .or_else(|| get(check, "context"))
                .cloned()
                .unwrap_or_else(|| "check".into());
            let state = check.get("state");
            if check.get("status").is_none() && state.is_some_and(json::truthy) {
                let state = state.cloned().unwrap_or_default();
                let finished = matches!(state.as_str(), Some("SUCCESS" | "FAILURE" | "ERROR"));
                return if finished {
                    Check {
                        name,
                        status: "COMPLETED".into(),
                        conclusion: state,
                    }
                } else {
                    Check {
                        name,
                        status: state,
                        conclusion: Value::Null,
                    }
                };
            }
            let conclusion = check.get("conclusion").filter(|value| json::truthy(value));
            Check {
                name,
                status: or(check, "status", ""),
                conclusion: conclusion.cloned().unwrap_or(Value::Null),
            }
        })
        .collect()
}

/// `githubConclusionPassed` (`src/shared/github-checks.ts`, which the page keeps).
fn passed(conclusion: &Value) -> bool {
    conclusion.as_str().is_some_and(|conclusion| {
        matches!(
            conclusion.to_lowercase().as_str(),
            "success" | "neutral" | "skipped"
        )
    })
}

fn rollup_counts(rollup: &[Value]) -> Counts {
    let mut counts = Counts {
        success: 0,
        failure: 0,
        pending: 0,
    };
    for check in rollup_checks(rollup) {
        if json::truthy(&check.conclusion) && passed(&check.conclusion) {
            counts.success += 1;
        } else if json::truthy(&check.conclusion) {
            counts.failure += 1;
        } else {
            counts.pending += 1;
        }
    }
    counts
}

/// A number as JSON carries it: an integer while it is one JavaScript holds exactly, `null` for none.
fn number_value(number: Option<f64>) -> Value {
    match number {
        Some(number) if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 => {
            Value::from(number as i64)
        }
        Some(number) => serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number),
        None => Value::Null,
    }
}

/// `String(number)` for a number the page sent (`NaN` where JSON brought `null`).
fn spelled(number: Option<f64>) -> String {
    number.map_or_else(|| "NaN".to_owned(), js_number)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    path: Value,
    change_type: Value,
    additions: Value,
    deletions: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    number: Value,
    title: Value,
    url: Value,
    is_draft: Value,
    author_login: Value,
    body: Value,
    base_ref_name: Value,
    head_ref_name: Value,
    merge_state_status: Value,
    state: Value,
    additions: Value,
    deletions: Value,
    review_decision: Value,
    files: Vec<File>,
    checks: Vec<Check>,
}

pub async fn detail(tools: &Tools, cwd: &str, number: Option<f64>) -> Result<Detail, Fault> {
    let found = repo(tools, cwd).await?;
    let spelled = spelled(number);
    let args = [
        "pr",
        "view",
        &spelled,
        "--repo",
        &found.repo,
        "--json",
        DETAIL_FIELDS,
    ];
    let row = match tools.gh.call(&found.root, &args, Opts::default()).await {
        Ok(text) => json::parse(&text),
        Err(fault) => Err(fault),
    }
    .map_err(|fault| Fault::new("pr_not_found", format!("PR #{spelled}: {}", fault.message)))?;
    Ok(Detail {
        number: get(&row, "number")
            .cloned()
            .unwrap_or_else(|| number_value(number)),
        title: or(&row, "title", ""),
        url: or(&row, "url", ""),
        is_draft: or(&row, "isDraft", false),
        author_login: json::login(&row, "author"),
        body: or(&row, "body", ""),
        base_ref_name: or(&row, "baseRefName", ""),
        head_ref_name: or(&row, "headRefName", ""),
        merge_state_status: or(&row, "mergeStateStatus", ""),
        state: or(&row, "state", ""),
        additions: or(&row, "additions", 0),
        deletions: or(&row, "deletions", 0),
        review_decision: or(&row, "reviewDecision", Value::Null),
        files: json::rows(&row, "files")
            .iter()
            .map(|file| File {
                path: or(file, "path", ""),
                change_type: or(file, "changeType", "modified"),
                additions: or(file, "additions", 0),
                deletions: or(file, "deletions", 0),
            })
            .collect(),
        checks: rollup_checks(json::rows(&row, "statusCheckRollup")),
    })
}

#[derive(Serialize)]
pub struct Diff {
    diff: String,
}

/// One file's unified-diff slice (the page asks per file it expands; the file index rides `pr_get`).
pub async fn diff(
    tools: &Tools,
    cwd: &str,
    number: Option<f64>,
    path: &str,
) -> Result<Diff, Fault> {
    let found = repo(tools, cwd).await?;
    let spelled = spelled(number);
    let args = [
        "pr",
        "diff",
        &spelled,
        "--repo",
        &found.repo,
        "--color",
        "never",
    ];
    let text = tools
        .gh
        .call(&found.root, &args, Opts::default())
        .await
        .map_err(|fault| Fault::new("pr_not_found", format!("PR #{spelled}: {}", fault.message)))?;
    let Some((start, end)) = unified_diff_files(&text)
        .into_iter()
        .find(|file| file.path == path)
        .map(|file| (file.start, file.end))
    else {
        return Err(Fault::new(
            "pr_not_found",
            format!("PR #{spelled} has no file {path}"),
        ));
    };
    Ok(Diff {
        diff: text[start..end].to_owned(),
    })
}

/// One file of a unified multi-file diff: the path the page names it by and its byte range.
#[derive(Debug, PartialEq)]
struct DiffFile {
    path: String,
    start: usize,
    end: usize,
}

/// `parsePrUnifiedDiff`: each `diff --git ` at a line start (`/^diff --git /gm`: after `\n`, `\r`, U+2028 or U+2029)
/// up to the next; a deleted file goes by its old path, any other by its new one.
fn unified_diff_files(text: &str) -> Vec<DiffFile> {
    const HEADER: &str = "diff --git ";
    let mut starts: Vec<usize> = Vec::new();
    if text.starts_with(HEADER) {
        starts.push(0);
    }
    for (at, end) in text.match_indices(['\n', '\r', '\u{2028}', '\u{2029}']) {
        let line = at + end.len();
        if text[line..].starts_with(HEADER) {
            starts.push(line);
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(index, &start)| {
            let end = starts.get(index + 1).copied().unwrap_or(text.len());
            let mut lines = text[start..end].split('\n');
            let (mut old_path, mut new_path) = header_paths(lines.next().unwrap_or(""));
            let mut deleted = false;
            for line in lines {
                if line.starts_with("@@ ") {
                    break;
                }
                if line.starts_with("deleted file mode") {
                    deleted = true;
                } else if let Some(path) = line.strip_prefix("rename from ") {
                    old_path = Some(path.to_owned());
                } else if let Some(path) = line.strip_prefix("rename to ") {
                    new_path = Some(path.to_owned());
                }
            }
            let path = if deleted {
                old_path.or(new_path)
            } else {
                new_path.or(old_path)
            };
            DiffFile {
                path: path.unwrap_or_else(|| "(unknown)".into()),
                start,
                end,
            }
        })
        .collect()
}

/// `parseDiffHeaderPaths`: the old and new paths of a `diff --git a/x b/y` header, C-quoted paths included.
fn header_paths(header: &str) -> (Option<String>, Option<String>) {
    let trail = header.strip_prefix("diff --git ").unwrap_or("");
    let strip = |value: String, prefix: &str| value.strip_prefix(prefix).map(str::to_owned);
    let chars: Vec<char> = trail.chars().collect();
    if chars.first() == Some(&'"') {
        let Some((old, next)) = quoted(&chars, 0) else {
            return (None, None);
        };
        let mut start = next;
        while chars.get(start) == Some(&' ') {
            start += 1;
        }
        let new =
            quoted(&chars, start).map_or_else(|| chars[start..].iter().collect(), |(new, _)| new);
        return (strip(old, "a/"), strip(new, "b/"));
    }
    match trail.find(" b/") {
        Some(at) if trail.starts_with("a/") && at > 0 => (
            Some(trail[2..at].to_owned()),
            Some(trail[at + 3..].to_owned()),
        ),
        _ => (None, None),
    }
}

/// A C-quoted path from `start` (its `"`): octal escapes are bytes, decoded together as UTF-8 so a Korean name is no
/// mojibake (kept over stock gh-pr-diff). None without a closing quote.
fn quoted(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars.get(start) != Some(&'"') {
        return None;
    }
    let mut bytes = Vec::new();
    let mut at = start + 1;
    while at < chars.len() {
        let ch = chars[at];
        if ch == '"' {
            return Some((String::from_utf8_lossy(&bytes).into_owned(), at + 1));
        }
        if ch != '\\' {
            bytes.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
            at += 1;
            continue;
        }
        let Some(&next) = chars.get(at + 1) else {
            // A backslash at the end: nothing to decode, and no closing quote.
            return None;
        };
        if ('0'..='7').contains(&next) {
            let mut end = at + 1;
            let mut value: u32 = 0;
            while end < chars.len() && end < at + 4 && ('0'..='7').contains(&chars[end]) {
                value = value * 8 + chars[end].to_digit(8).unwrap_or(0);
                end += 1;
            }
            // A Uint8Array keeps the low byte of 0o400 and above.
            bytes.push((value & 0xff) as u8);
            at = end;
            continue;
        }
        let escaped = match next {
            'a' => '\x07',
            'b' => '\x08',
            'f' => '\x0c',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'v' => '\x0b',
            other => other,
        };
        bytes.extend_from_slice(escaped.encode_utf8(&mut [0; 4]).as_bytes());
        at += 2;
    }
    None
}

/// `name` when it resolves locally, else `origin/name` (a fresh clone often lacks the local default branch).
async fn resolve_rev(tools: &Tools, root: &str, name: &str) -> Result<String, Fault> {
    let git = tools.git()?;
    for candidate in [name.to_owned(), format!("origin/{name}")] {
        let spec = format!("{candidate}^{{commit}}");
        if git
            .raw(root, &["rev-parse", "--verify", "--quiet", &spec])
            .await?
            .code
            == 0
        {
            return Ok(candidate);
        }
    }
    Err(Fault::new(
        "pr_draft_failed",
        format!("Unknown revision: {name}"),
    ))
}

/// What a PR draft is written from: the head branch's commits and changed files against the base, read in the
/// checkout's root (where main then runs the model).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftFacts {
    root: String,
    base: String,
    head: String,
    commits: Vec<String>,
    files: Vec<String>,
    diff_stat: String,
}

pub async fn draft_facts(
    tools: &Tools,
    cwd: &str,
    base: Option<String>,
    head: Option<String>,
) -> Result<DraftFacts, Fault> {
    let found = repo(tools, cwd).await?;
    let git = tools.git()?;
    let root = found.root;
    let base = base
        .or(found.default_branch)
        .unwrap_or_else(|| "HEAD~1".into());
    let current = git
        .raw(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await?
        .text();
    let current = js_trim(&current);
    let head = head.unwrap_or_else(|| {
        if current.is_empty() {
            "HEAD".into()
        } else {
            current.to_owned()
        }
    });
    let range = format!(
        "{}...{}",
        resolve_rev(tools, &root, &base).await?,
        resolve_rev(tools, &root, &head).await?
    );
    let log_args = ["log", "--no-merges", "--format=%s", "-n", "50", &range];
    let name_args = ["diff", "--name-only", &range];
    let numstat_args = ["diff", "--numstat", &range];
    let (log, names, numstat) = tokio::try_join!(
        git.text(&root, &log_args),
        git.text(&root, &name_args),
        git.text(&root, &numstat_args),
    )?;
    let lines = |text: &str| -> Vec<String> {
        text.split('\n')
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let commits = lines(&log);
    let files = lines(&names);
    if commits.is_empty() && files.is_empty() {
        return Err(Fault::new(
            "pr_draft_failed",
            format!("No changes between {base} and {head}"),
        ));
    }
    Ok(DraftFacts {
        diff_stat: js_trim(&numstat).to_owned(),
        root,
        base,
        head,
        commits,
        files,
    })
}

#[derive(Deserialize)]
pub struct CreateInput {
    title: String,
    body: String,
    base: Option<String>,
    head: Option<String>,
    #[serde(default)]
    draft: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Created {
    url: String,
    number: Value,
}

/// `gh pr create` with the flags stock `tools/gh-pr-checkout.ts#executePrCreate` passes for the same input (pinned by
/// `pr-create-stock.test.ts`); the body goes through a private file.
pub async fn create(
    tools: &Tools,
    cwd: &str,
    input: &CreateInput,
    timeout_ms: u64,
) -> Result<Created, Fault> {
    let found = repo(tools, cwd).await?;
    let created = async {
        let body = BodyFile::new(&input.body).await?;
        let mut args = vec![
            "pr",
            "create",
            "--repo",
            &found.repo,
            "--title",
            &input.title,
            "--body-file",
            body.path(),
        ];
        if let Some(base) = input.base.as_deref().filter(|base| !base.is_empty()) {
            args.extend(["--base", base]);
        }
        if let Some(head) = input.head.as_deref().filter(|head| !head.is_empty()) {
            args.extend(["--head", head]);
        }
        if input.draft {
            args.push("--draft");
        }
        let opts = Opts {
            timeout_ms: Some(timeout_ms),
            ..Opts::default()
        };
        let output = tools.gh.call(&found.root, &args, opts).await?;
        created_pr(&output).ok_or_else(|| {
            Fault::new(
                "pr_create_failed",
                format!(
                    "gh pr create returned no PR URL: {}",
                    utf16_prefix(&output, 300)
                ),
            )
        })
    }
    .await;
    created.map_err(|fault| Fault::new("pr_create_failed", fault.message))
}

/// `createdPr`: the first `https://…/pull/<n>` gh printed (`/https:\/\/\S+\/pull\/\d+/`, its `\S+` as long as it can
/// be), with the number its last part reads as.
fn created_pr(output: &str) -> Option<Created> {
    const SCHEME: &str = "https://";
    const PULL: &str = "/pull/";
    output.match_indices(SCHEME).find_map(|(at, _)| {
        let rest = &output[at + SCHEME.len()..];
        let run = &rest[..rest.find(is_js_space).unwrap_or(rest.len())];
        // `\S+` takes at least one character before `/pull/`.
        let first = run.chars().next()?.len_utf8();
        run.match_indices(PULL)
            .filter(|(pull, _)| *pull >= first)
            .filter_map(|(pull, _)| {
                let digits = run[pull + PULL.len()..]
                    .bytes()
                    .take_while(u8::is_ascii_digit)
                    .count();
                (digits > 0).then_some(pull + PULL.len() + digits)
            })
            .last()
            .map(|end| {
                let url = &output[at..at + SCHEME.len() + end];
                let number = url
                    .rsplit('/')
                    .next()
                    .and_then(|digits| digits.parse::<f64>().ok());
                Created {
                    url: url.to_owned(),
                    number: number_value(number),
                }
            })
    })
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Serialize)]
pub struct Merged {
    merged: bool,
}

/// Merge on GitHub with the chosen method. `--repo` keeps gh from touching the local checkout: with it,
/// `--delete-branch` removes only the remote head branch.
pub async fn merge(
    tools: &Tools,
    cwd: &str,
    number: u64,
    method: MergeMethod,
    delete_branch: bool,
    timeout_ms: u64,
) -> Result<Merged, Fault> {
    let found = repo(tools, cwd).await?;
    let number = number.to_string();
    let flag = match method {
        MergeMethod::Merge => "--merge",
        MergeMethod::Squash => "--squash",
        MergeMethod::Rebase => "--rebase",
    };
    let mut args = vec!["pr", "merge", &number, "--repo", &found.repo, flag];
    if delete_branch {
        args.push("--delete-branch");
    }
    let opts = Opts {
        timeout_ms: Some(timeout_ms),
        ..Opts::default()
    };
    tools
        .gh
        .call(&found.root, &args, opts)
        .await
        .map_err(|fault| Fault::new("pr_merge_failed", fault.message))?;
    Ok(Merged { merged: true })
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

#[derive(Serialize)]
pub struct Submitted {
    submitted: bool,
}

pub async fn review(
    tools: &Tools,
    cwd: &str,
    number: u64,
    event: ReviewEvent,
    body: &str,
) -> Result<Submitted, Fault> {
    let found = repo(tools, cwd).await?;
    let number = number.to_string();
    let flag = match event {
        ReviewEvent::Approve => "--approve",
        ReviewEvent::RequestChanges => "--request-changes",
        ReviewEvent::Comment => "--comment",
    };
    let submitted = async {
        let file = if body.is_empty() {
            None
        } else {
            Some(BodyFile::new(body).await?)
        };
        let mut args = vec!["pr", "review", &number, "--repo", &found.repo, flag];
        if let Some(file) = &file {
            args.extend(["--body-file", file.path()]);
        }
        tools.gh.call(&found.root, &args, Opts::default()).await
    }
    .await;
    submitted.map_err(|fault| Fault::new("pr_review_failed", fault.message))?;
    Ok(Submitted { submitted: true })
}

pub async fn comment(
    tools: &Tools,
    cwd: &str,
    number: u64,
    body: &str,
) -> Result<Submitted, Fault> {
    let found = repo(tools, cwd).await?;
    let number = number.to_string();
    let submitted = async {
        let file = BodyFile::new(body).await?;
        let args = [
            "pr",
            "comment",
            &number,
            "--repo",
            &found.repo,
            "--body-file",
            file.path(),
        ];
        tools.gh.call(&found.root, &args, Opts::default()).await
    }
    .await;
    submitted.map_err(|fault| Fault::new("pr_review_failed", fault.message))?;
    Ok(Submitted { submitted: true })
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Entry {
    Comment {
        author: Value,
        body: Value,
        #[serde(rename = "createdAt")]
        created_at: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<Value>,
    },
    Review {
        author: Value,
        body: Value,
        #[serde(rename = "createdAt")]
        created_at: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<Value>,
    },
    Inline {
        author: Value,
        body: Value,
        #[serde(rename = "createdAt")]
        created_at: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<Value>,
    },
}

impl Entry {
    fn created_at(&self) -> &str {
        let (Entry::Comment { created_at, .. }
        | Entry::Review { created_at, .. }
        | Entry::Inline { created_at, .. }) = self;
        created_at.as_str().unwrap_or("")
    }
}

#[derive(Serialize)]
pub struct Comments {
    entries: Vec<Entry>,
}

/// `row.key`, none where JavaScript reads `undefined` (an absent key is left out of the answer).
fn present(row: &Value, key: &str) -> Option<Value> {
    row.get(key).cloned()
}

/// Conversation comments, reviews and inline review comments, oldest first.
pub async fn comments(tools: &Tools, cwd: &str, number: u64) -> Result<Comments, Fault> {
    let found = repo(tools, cwd).await?;
    let number = number.to_string();
    let endpoint = format!("repos/{}/pulls/{number}/comments?per_page=100", found.repo);
    let view_args = [
        "pr",
        "view",
        &number,
        "--repo",
        &found.repo,
        "--json",
        "comments,reviews",
    ];
    let (view, inline) = tokio::try_join!(
        async {
            json::parse(
                &tools
                    .gh
                    .call(&found.root, &view_args, Opts::default())
                    .await?,
            )
        },
        async {
            json::parse(
                &tools
                    .gh
                    .call(&found.root, &["api", &endpoint], Opts::default())
                    .await?,
            )
        },
    )
    .map_err(|fault| Fault::new("pr_not_found", format!("PR #{number}: {}", fault.message)))?;
    let mut entries: Vec<Entry> = json::rows(&view, "comments")
        .iter()
        .map(|row| Entry::Comment {
            author: json::login(row, "author"),
            body: or(row, "body", ""),
            created_at: or(row, "createdAt", ""),
            url: present(row, "url"),
        })
        .collect();
    entries.extend(
        json::rows(&view, "reviews")
            .iter()
            // A bare "COMMENTED" review without text only wraps inline comments, listed below.
            .filter(|row| {
                json::text(row, "body").is_some_and(|body| !js_trim(body).is_empty())
                    || row.get("state").and_then(Value::as_str) != Some("COMMENTED")
            })
            .map(|row| Entry::Review {
                author: json::login(row, "author"),
                body: or(row, "body", ""),
                created_at: get(row, "submittedAt")
                    .or_else(|| get(row, "createdAt"))
                    .cloned()
                    .unwrap_or_else(|| "".into()),
                state: present(row, "state"),
            }),
    );
    entries.extend(json::list(&inline).iter().map(|row| {
        Entry::Inline {
            author: json::login(row, "user"),
            body: or(row, "body", ""),
            created_at: or(row, "created_at", ""),
            url: present(row, "html_url"),
            path: present(row, "path"),
            line: get(row, "line")
                .or_else(|| get(row, "original_line"))
                .cloned(),
        }
    }));
    // ISO 8601 times from GitHub order the same by code point as by `localeCompare`.
    entries.sort_by(|a, b| a.created_at().cmp(b.created_at()));
    Ok(Comments { entries })
}

/// What a PR edit changes; none leaves it.
pub struct Edit<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub base: Option<&'a str>,
}

#[derive(Serialize)]
pub struct Edited {
    edited: bool,
}

pub async fn edit(tools: &Tools, cwd: &str, number: u64, edit: Edit<'_>) -> Result<Edited, Fault> {
    let found = repo(tools, cwd).await?;
    let number = number.to_string();
    let title = match edit.title.map(js_trim) {
        Some("") => {
            return Err(Fault::new("pr_edit_failed", "A pull request needs a title"));
        }
        title => title,
    };
    let edited = async {
        let file = match edit.body {
            Some(body) => Some(BodyFile::new(body).await?),
            None => None,
        };
        let mut args = vec!["pr", "edit", &number, "--repo", &found.repo];
        if let Some(title) = title {
            args.extend(["--title", title]);
        }
        if let Some(base) = edit.base.filter(|base| !base.is_empty()) {
            args.extend(["--base", base]);
        }
        if let Some(file) = &file {
            args.extend(["--body-file", file.path()]);
        }
        tools.gh.call(&found.root, &args, Opts::default()).await
    }
    .await;
    edited.map_err(|fault| Fault::new("pr_edit_failed", fault.message))?;
    Ok(Edited { edited: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn indexes_a_unified_diff_by_file_as_the_typescript_did() {
        let text = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1 +1 @@",
            "-x",
            "+y",
            "diff --git a/old.ts b/new.ts",
            "similarity index 100%",
            "rename from old.ts",
            "rename to new.ts",
            "diff --git a/gone.ts b/gone.ts",
            "deleted file mode 100644",
            "diff --git \"a/sp ace\\303\\251.ts\" \"b/sp ace\\303\\251.ts\"",
            "",
        ]
        .join("\n");
        let files = unified_diff_files(&text);
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["a.ts", "new.ts", "gone.ts", "sp aceé.ts"]);
        assert!(text[files[0].start..files[0].end].starts_with("diff --git a/a.ts"));
        assert!(text[files[0].start..files[0].end].ends_with("+y\n"));
        assert_eq!(files[3].end, text.len());
        let encoded: String = "한글.ts"
            .bytes()
            .map(|byte| format!("\\{byte:03o}"))
            .collect();
        let korean = format!("diff --git \"a/{encoded}\" \"b/{encoded}\"\n");
        assert_eq!(unified_diff_files(&korean)[0].path, "한글.ts");
    }

    /// Rows captured from `parsePrUnifiedDiff` (12 Nov 2026): headers of each shape and the line starts JavaScript's
    /// `m` flag knows.
    #[test]
    fn reads_headers_and_line_starts_as_javascript_did() {
        let cases: &[(&str, &[&str])] = &[
            ("diff --git a/x b/y\r\ndiff --git a/z b/z\n", &["y\r", "z"]),
            (
                "x\rdiff --git a/1 b/1\u{2028}diff --git a/2 b/2",
                &["1\u{2028}", "2"],
            ),
            ("diff --git nonsense\n", &["(unknown)"]),
            ("diff --git a/x\n", &["(unknown)"]),
            ("diff --git \"a/q\\\"t\" b/plain\n", &["plain"]),
            ("diff --git \"a/unterminated\n", &["(unknown)"]),
            (
                "diff --git \"a/\\t\\777\" \"b/\\t\\777\"\n",
                &["\t\u{fffd}"],
            ),
            (
                "diff --git a/a b/b\ndeleted file mode 1\nrename to c\n",
                &["a"],
            ),
            ("diff --git a/a b/b\n@@ x\nrename to c\n", &["b"]),
            (" diff --git a/a b/a\n", &[]),
            ("diff --git \"a/x\\\" \"b/y\"\n", &["y\""]),
            ("diff --git \"a/x\"   \"b/y z\"\n", &["y z"]),
        ];
        for (text, want) in cases {
            let got: Vec<String> = unified_diff_files(text)
                .into_iter()
                .map(|file| file.path)
                .collect();
            assert_eq!(&got, want, "{text:?}");
        }
    }

    #[test]
    fn reads_the_rollup_as_check_runs() {
        let rollup = json!([
            { "__typename": "CheckRun", "name": "check", "status": "COMPLETED", "conclusion": "SUCCESS" },
            { "__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS", "conclusion": "" },
            { "__typename": "StatusContext", "context": "ci/jenkins", "state": "SUCCESS" },
            { "__typename": "StatusContext", "context": "ci/linux", "state": "FAILURE" },
            { "__typename": "StatusContext", "context": "ci/windows", "state": "ERROR" },
            { "__typename": "StatusContext", "context": "tide", "state": "PENDING" },
            { "__typename": "StatusContext", "context": "deploy", "state": "EXPECTED" },
        ]);
        let rows = rollup.as_array().unwrap();
        let checks = serde_json::to_value(rollup_checks(rows)).unwrap();
        assert_eq!(
            checks,
            json!([
                { "name": "check", "status": "COMPLETED", "conclusion": "SUCCESS" },
                { "name": "build", "status": "IN_PROGRESS", "conclusion": null },
                { "name": "ci/jenkins", "status": "COMPLETED", "conclusion": "SUCCESS" },
                { "name": "ci/linux", "status": "COMPLETED", "conclusion": "FAILURE" },
                { "name": "ci/windows", "status": "COMPLETED", "conclusion": "ERROR" },
                { "name": "tide", "status": "PENDING", "conclusion": null },
                { "name": "deploy", "status": "EXPECTED", "conclusion": null },
            ])
        );
        let counts = serde_json::to_value(rollup_counts(rows)).unwrap();
        assert_eq!(counts, json!({ "success": 2, "failure": 2, "pending": 3 }));
        let none = serde_json::to_value(rollup_counts(&[])).unwrap();
        assert_eq!(none, json!({ "success": 0, "failure": 0, "pending": 0 }));
        // A `status: null` is not an absent one; a falsy state is no commit status.
        let odd = json!([{ "status": null, "state": "SUCCESS", "conclusion": "skipped" }, { "state": "" }]);
        let checks = serde_json::to_value(rollup_checks(odd.as_array().unwrap())).unwrap();
        assert_eq!(
            checks,
            json!([
                { "name": "check", "status": "", "conclusion": "skipped" },
                { "name": "check", "status": "", "conclusion": null },
            ])
        );
    }

    /// Outputs captured from `createdPr` (12 Nov 2026).
    #[test]
    fn reads_the_created_pr_as_the_typescript_did() {
        let cases: &[(&str, Option<(&str, Value)>)] = &[
            (
                "Creating pull request\n\nhttps://github.com/o/r/pull/7\n",
                Some(("https://github.com/o/r/pull/7", json!(7))),
            ),
            (
                "https://x/pull/1/pull/22 tail\n",
                Some(("https://x/pull/1/pull/22", json!(22))),
            ),
            ("https://pull/3", None),
            ("https:///pull/3", None),
            (
                "a https://h/x b https://h/pull/04x",
                Some(("https://h/pull/04", json!(4))),
            ),
            (
                "xhttps://h/pull/12345678901234567890",
                Some((
                    "https://h/pull/12345678901234567890",
                    json!(12345678901234567000.0),
                )),
            ),
            ("https://h/pull/\nhttps://h/pull/", None),
            ("no url", None),
            (
                "https://h/pull/5\u{a0}https://h/pull/6",
                Some(("https://h/pull/5", json!(5))),
            ),
        ];
        for (output, want) in cases {
            let got = created_pr(output);
            let want = want.as_ref().map(|(url, number)| Created {
                url: (*url).to_owned(),
                number: number.clone(),
            });
            assert_eq!(got, want, "{output:?}");
        }
    }

    #[test]
    fn knows_an_old_gh_by_its_words() {
        assert!(unknown_active("x\nunknown flag: --active"));
        assert!(unknown_active("Unknown Flag --active"));
        assert!(!unknown_active("unknown flag:: --active"));
        assert!(!unknown_active("unknown shorthand flag: 'a' in -active"));
    }

    #[test]
    fn spells_numbers_the_page_sent_as_javascript_does() {
        assert_eq!(spelled(None), "NaN");
        assert_eq!(spelled(Some(1e21)), "1e+21");
        assert_eq!(spelled(Some(7.0)), "7");
        assert_eq!(number_value(Some(7.0)), json!(7));
        assert_eq!(number_value(Some(1e21)), json!(1e21));
        assert_eq!(number_value(None), Value::Null);
    }
}
