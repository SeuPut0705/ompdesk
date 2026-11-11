//! Agents › GitHub over gh (was the operations of `src/main/local/git/github.ts`): issues, Actions, releases,
//! notifications and repositories, on a GitHub Enterprise host (`GH_HOST`, `--hostname`) and on another repository than
//! the tab's checkout. Main validates the request first (`parseGithubRequest`, zod) and resolves a clone's destination
//! and its folder with node's `path`; this side runs it. A gh failure is `github_failed` with gh's own words, or
//! `gh_unauthenticated` when those words say gh is signed out; the checkout's repository refuses as `requireGithubRepo`
//! does (`pr.rs`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::json::{self, get, or};
use super::{BodyFile, Tools, pr};
use crate::fs::order::{is_js_space, js_trim};
use crate::run::Opts;
use crate::server::{Fault, Reply};

const ISSUE_FIELDS: &str = "number,title,state,author,labels,comments,updatedAt,url";
const RUN_FIELDS: &str =
    "databaseId,workflowName,displayTitle,status,conclusion,headBranch,event,createdAt,url";
const RELEASE_FIELDS: &str = "tagName,name,isDraft,isPrerelease,isLatest,publishedAt,createdAt";
const REPO_FIELDS: &str =
    "nameWithOwner,description,visibility,isFork,stargazerCount,updatedAt,url";
/// Lines of a run log kept for the viewer (its end, where failures show).
const LOG_LINES: usize = 3000;

/// Main's timeouts of the two long runs.
pub struct Timeouts {
    pub clone_ms: u64,
    pub log_ms: u64,
}

/// Where an operation runs: the gh host (default: gh's own) and, for repository operations, the repository.
#[derive(Deserialize)]
struct Target {
    host: Option<String>,
    repo: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum Op {
    Hosts,
    IssueList {
        state: String,
        search: Option<String>,
    },
    IssueGet {
        number: u64,
    },
    IssueCreate {
        title: String,
        body: String,
    },
    IssueEdit {
        number: u64,
        title: String,
        body: String,
    },
    IssueState {
        number: u64,
        state: String,
    },
    IssueComment {
        number: u64,
        body: String,
    },
    RepoList {
        owner: Option<String>,
    },
    RepoGet,
    RepoCreate {
        name: String,
        visibility: String,
        description: String,
    },
    /// `destination` resolved and `parent` its folder, by main.
    RepoClone {
        destination: String,
        parent: String,
    },
    RepoFork,
    WorkflowList,
    RunList {
        workflow: Option<String>,
    },
    RunGet {
        id: u64,
    },
    RunLog {
        id: u64,
        failed_only: bool,
    },
    WorkflowDispatch {
        workflow: String,
        #[serde(rename = "ref")]
        reference: Option<String>,
    },
    RunRerun {
        id: u64,
        failed_only: bool,
    },
    RunCancel {
        id: u64,
    },
    ReleaseList,
    ReleaseGet {
        tag: String,
    },
    ReleaseCreate {
        tag: String,
        title: String,
        notes: String,
        draft: bool,
        prerelease: bool,
        target: Option<String>,
    },
    ReleaseEdit {
        tag: String,
        title: String,
        notes: String,
        draft: bool,
        prerelease: bool,
    },
    NotificationList {
        all: bool,
    },
    NotificationRead {
        id: String,
    },
    NotificationReadAll,
}

struct Center<'a> {
    tools: &'a Tools,
    cwd: &'a str,
    host: Option<&'a str>,
    named: Option<&'a str>,
}

impl Center<'_> {
    /// One gh run on the chosen host; its failure is `github_failed`, or `gh_unauthenticated` by gh's words.
    async fn call(&self, args: &[&str], timeout_ms: Option<u64>) -> Result<String, Fault> {
        let host = self.host.map(|host| [("GH_HOST", host)]);
        let opts = Opts {
            timeout_ms,
            env: host.as_ref().map_or(&[], |host| host.as_slice()),
            ..Opts::default()
        };
        self.tools
            .gh
            .call(self.cwd, args, opts)
            .await
            .map_err(|fault| {
                if fault == Fault::cancelled() {
                    return fault;
                }
                // `/gh auth login|not logged in|authentication required/i`
                let words = fault.message.to_ascii_lowercase();
                let signed_out = ["gh auth login", "not logged in", "authentication required"]
                    .iter()
                    .any(|phrase| words.contains(phrase));
                let code = if signed_out {
                    "gh_unauthenticated"
                } else {
                    "github_failed"
                };
                Fault::new(code, fault.message)
            })
    }

    async fn json(&self, args: &[&str]) -> Result<Value, Fault> {
        json::parse(&self.call(args, None).await?)
    }

    /// `--repo` for repository operations: the named repository (on the chosen host) or the checkout's.
    async fn repo(&self) -> Result<String, Fault> {
        match (self.named, self.host) {
            (Some(repo), Some(host)) => Ok(format!("{host}/{repo}")),
            (Some(repo), None) => Ok(repo.to_owned()),
            (None, _) => Ok(pr::repo(self.tools, self.cwd).await?.repo),
        }
    }

    /// `gh api` with `--hostname` on a chosen host.
    async fn api(&self, rest: &[&str]) -> Result<String, Fault> {
        let mut args = vec!["api"];
        if let Some(host) = self.host {
            args.extend(["--hostname", host]);
        }
        args.extend(rest);
        self.call(&args, None).await
    }
}

#[derive(Serialize)]
struct Done {
    ok: bool,
}

const DONE: Done = Done { ok: true };

#[derive(Serialize)]
struct Hosts {
    hosts: Vec<String>,
    repo: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Issue {
    number: Value,
    title: Value,
    state: &'static str,
    author: Value,
    labels: Vec<Value>,
    comment_count: usize,
    updated_at: Value,
    url: Value,
}

fn issue(row: &Value) -> Issue {
    Issue {
        number: or(row, "number", 0),
        title: or(row, "title", ""),
        state: if row.get("state").and_then(Value::as_str) == Some("CLOSED") {
            "CLOSED"
        } else {
            "OPEN"
        },
        author: json::login(row, "author"),
        labels: json::rows(row, "labels")
            .iter()
            .filter_map(|label| label.get("name").filter(|name| json::truthy(name)).cloned())
            .collect(),
        comment_count: get(row, "comments")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        updated_at: or(row, "updatedAt", ""),
        url: or(row, "url", ""),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssueComment {
    author: Value,
    body: Value,
    created_at: Value,
}

#[derive(Serialize)]
struct IssueDetail {
    #[serde(flatten)]
    issue: Issue,
    body: Value,
    comments: Vec<IssueComment>,
}

#[derive(Serialize)]
struct IssueCreated {
    url: String,
    number: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoItem {
    name_with_owner: Value,
    description: Value,
    visibility: String,
    is_fork: Value,
    stars: Value,
    updated_at: Value,
    url: Value,
}

fn repo_item(row: &Value) -> RepoItem {
    RepoItem {
        name_with_owner: or(row, "nameWithOwner", ""),
        description: or(row, "description", ""),
        visibility: json::text(row, "visibility")
            .map(str::to_lowercase)
            .unwrap_or_default(),
        is_fork: or(row, "isFork", false),
        stars: or(row, "stargazerCount", 0),
        updated_at: or(row, "updatedAt", ""),
        url: or(row, "url", ""),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoDetail {
    #[serde(flatten)]
    item: RepoItem,
    default_branch: Value,
    homepage: Value,
    license: Value,
    ssh_url: Value,
}

#[derive(Serialize)]
struct Url {
    url: String,
}

#[derive(Serialize)]
struct Cloned {
    path: String,
}

#[derive(Serialize)]
struct Workflow {
    id: Value,
    name: Value,
    path: Value,
    state: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: Value,
    workflow: Value,
    title: Value,
    status: Value,
    conclusion: Value,
    branch: Value,
    event: Value,
    created_at: Value,
    url: Value,
}

fn run(row: &Value) -> Run {
    Run {
        id: or(row, "databaseId", 0),
        workflow: or(row, "workflowName", ""),
        title: or(row, "displayTitle", ""),
        status: or(row, "status", ""),
        conclusion: or(row, "conclusion", ""),
        branch: or(row, "headBranch", ""),
        event: or(row, "event", ""),
        created_at: or(row, "createdAt", ""),
        url: or(row, "url", ""),
    }
}

#[derive(Serialize)]
struct Job {
    name: Value,
    status: Value,
    conclusion: Value,
}

#[derive(Serialize)]
struct RunDetail {
    #[serde(flatten)]
    run: Run,
    jobs: Vec<Job>,
}

#[derive(Serialize)]
struct Log {
    text: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    tag: Value,
    name: Value,
    is_draft: Value,
    is_prerelease: Value,
    is_latest: Value,
    published_at: Value,
    created_at: Value,
}

fn release(row: &Value) -> Release {
    Release {
        tag: or(row, "tagName", ""),
        name: or(row, "name", ""),
        is_draft: or(row, "isDraft", false),
        is_prerelease: or(row, "isPrerelease", false),
        is_latest: or(row, "isLatest", false),
        published_at: or(row, "publishedAt", ""),
        created_at: or(row, "createdAt", ""),
    }
}

#[derive(Serialize)]
struct Asset {
    name: Value,
    size: Value,
    downloads: Value,
}

#[derive(Serialize)]
struct ReleaseDetail {
    #[serde(flatten)]
    release: Release,
    body: Value,
    target: Value,
    url: Value,
    assets: Vec<Asset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Notification {
    id: Value,
    unread: Value,
    reason: Value,
    title: Value,
    #[serde(rename = "type")]
    kind: Value,
    repo: Value,
    updated_at: Value,
    url: Value,
}

/// `obj.outer?.inner ?? fallback`.
fn nested(row: &Value, outer: &str, inner: &str, fallback: &str) -> Value {
    get(row, outer)
        .and_then(|value| get(value, inner))
        .cloned()
        .unwrap_or_else(|| fallback.into())
}

/// The URL gh prints last (create commands), or "".
fn printed_url(output: &str) -> String {
    js_trim(output)
        .split('\n')
        .rev()
        .map(js_trim)
        .find(|line| line.starts_with("https://") || line.starts_with("http://"))
        .unwrap_or_default()
        .to_owned()
}

/// `Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? 0)`.
fn issue_number(url: &str) -> Value {
    const ISSUES: &str = "/issues/";
    url.match_indices(ISSUES)
        .find_map(|(at, _)| {
            let rest = &url[at + ISSUES.len()..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0).then(|| &rest[..digits])
        })
        .and_then(|digits| digits.parse::<f64>().ok())
        .map_or(Value::from(0), |number| {
            if number < 9_007_199_254_740_992.0 {
                Value::from(number as u64)
            } else {
                serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
            }
        })
}

/// Every host in `gh auth status` output (`/Logged in to (\S+)/g`), first seen first.
fn signed_in_hosts(output: &str) -> Vec<String> {
    const LOGGED: &str = "Logged in to ";
    let mut hosts: Vec<String> = Vec::new();
    for (at, _) in output.match_indices(LOGGED) {
        let rest = &output[at + LOGGED.len()..];
        let host = &rest[..rest.find(is_js_space).unwrap_or(rest.len())];
        if !host.is_empty() && !hosts.iter().any(|known| known == host) {
            hosts.push(host.to_owned());
        }
    }
    hosts
}

/// `notificationWebUrl`: a notification subject's API URL as its web page: `https://api.github.com/repos/o/r/pulls/1`
/// is `https://github.com/o/r/pull/1`, Enterprise `https://host/api/v3/repos/…` is `https://host/…`; none for a subject
/// without a URL (a discussion) or one that is no API URL.
fn notification_web_url(api: &str) -> Option<String> {
    let rest = api.strip_prefix("https://")?;
    // `(?:api\.(github\.com)|([^/]+)\/api\/v3)\/repos\/([^/]+\/[^/]+)(\/.*)?$`, the first alternative tried first.
    let github = rest
        .strip_prefix("api.github.com/repos/")
        .and_then(|after| repository_path(after).map(|path| ("github.com", path)));
    let (host, (repo, tail)) = github.or_else(|| {
        let slash = rest.find('/').filter(|&slash| slash > 0)?;
        let after = rest[slash..].strip_prefix("/api/v3/repos/")?;
        repository_path(after).map(|path| (&rest[..slash], path))
    })?;
    let tail = match tail.strip_prefix("/pulls/") {
        Some(after) => format!("/pull/{after}"),
        None => tail.to_owned(),
    };
    let tail = match tail.strip_prefix("/commits/") {
        Some(after) => format!("/commit/{after}"),
        None => tail,
    };
    let release = tail
        .strip_prefix("/releases/")
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()));
    let tail = if release {
        "/releases".to_owned()
    } else {
        tail
    };
    Some(format!("https://{host}/{repo}{tail}"))
}

/// `([^/]+\/[^/]+)(\/.*)?$`: `owner/name` and the rest, which holds no line terminator (`.`).
fn repository_path(after: &str) -> Option<(&str, &str)> {
    let owner = after.find('/').filter(|&slash| slash > 0)?;
    let name_start = owner + 1;
    let name_end = after[name_start..]
        .find('/')
        .map_or(after.len(), |slash| name_start + slash);
    if name_end == name_start {
        return None;
    }
    let tail = &after[name_end..];
    if tail.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((&after[..name_end], tail))
}

pub async fn command(
    tools: &Tools,
    cwd: &str,
    request: &Value,
    timeouts: Timeouts,
) -> Result<Reply, Fault> {
    tools.gh.require()?;
    let invalid = |error: serde_json::Error| Fault::new("invalid_params", error.to_string());
    let op = Op::deserialize(request).map_err(invalid)?;
    let target = Target::deserialize(request).map_err(invalid)?;
    let center = Center {
        tools,
        cwd,
        host: target.host.as_deref(),
        named: target.repo.as_deref(),
    };
    match op {
        Op::Hosts => {
            let status = tools.gh.text(cwd, &["auth", "status"]).await?;
            let hosts = signed_in_hosts(&format!("{}\n{}", status.stdout, status.stderr));
            let repo = pr::repo(tools, cwd).await.ok().map(|found| found.repo);
            Reply::json(&Hosts { hosts, repo })
        }
        Op::IssueList { state, search } => {
            let repo = center.repo().await?;
            let mut args = vec![
                "issue", "list", "--repo", &repo, "--state", &state, "--limit", "50",
            ];
            if let Some(search) = search.as_deref().filter(|search| !search.is_empty()) {
                args.extend(["--search", search]);
            }
            args.extend(["--json", ISSUE_FIELDS]);
            let rows = center.json(&args).await?;
            Reply::json(&json::list(&rows).iter().map(issue).collect::<Vec<_>>())
        }
        Op::IssueGet { number } => {
            let number = number.to_string();
            let repo = center.repo().await?;
            let fields = format!("{ISSUE_FIELDS},body");
            let row = center
                .json(&["issue", "view", &number, "--repo", &repo, "--json", &fields])
                .await?;
            Reply::json(&IssueDetail {
                issue: issue(&row),
                body: or(&row, "body", ""),
                comments: json::rows(&row, "comments")
                    .iter()
                    .map(|comment| IssueComment {
                        author: json::login(comment, "author"),
                        body: or(comment, "body", ""),
                        created_at: or(comment, "createdAt", ""),
                    })
                    .collect(),
            })
        }
        Op::IssueCreate { title, body } => {
            let repo = center.repo().await?;
            let file = BodyFile::new(&body).await?;
            let args = [
                "issue",
                "create",
                "--repo",
                &repo,
                "--title",
                &title,
                "--body-file",
                file.path(),
            ];
            let output = center.call(&args, None).await?;
            drop(file);
            let url = printed_url(&output);
            let number = issue_number(&url);
            Reply::json(&IssueCreated { url, number })
        }
        Op::IssueEdit {
            number,
            title,
            body,
        } => {
            let number = number.to_string();
            let repo = center.repo().await?;
            let file = BodyFile::new(&body).await?;
            let args = [
                "issue",
                "edit",
                &number,
                "--repo",
                &repo,
                "--title",
                &title,
                "--body-file",
                file.path(),
            ];
            center.call(&args, None).await?;
            Reply::json(&DONE)
        }
        Op::IssueState { number, state } => {
            let number = number.to_string();
            let verb = if state == "closed" { "close" } else { "reopen" };
            let repo = center.repo().await?;
            center
                .call(&["issue", verb, &number, "--repo", &repo], None)
                .await?;
            Reply::json(&DONE)
        }
        Op::IssueComment { number, body } => {
            let number = number.to_string();
            let repo = center.repo().await?;
            let file = BodyFile::new(&body).await?;
            let args = [
                "issue",
                "comment",
                &number,
                "--repo",
                &repo,
                "--body-file",
                file.path(),
            ];
            center.call(&args, None).await?;
            Reply::json(&DONE)
        }
        Op::RepoList { owner } => {
            let mut args = vec!["repo", "list"];
            if let Some(owner) = owner.as_deref() {
                args.push(owner);
            }
            args.extend(["--limit", "100", "--json", REPO_FIELDS]);
            let rows = center.json(&args).await?;
            Reply::json(&json::list(&rows).iter().map(repo_item).collect::<Vec<_>>())
        }
        Op::RepoGet => {
            let repo = center.repo().await?;
            let fields = format!("{REPO_FIELDS},defaultBranchRef,homepageUrl,sshUrl,licenseInfo");
            let row = center
                .json(&["repo", "view", &repo, "--json", &fields])
                .await?;
            Reply::json(&RepoDetail {
                item: repo_item(&row),
                default_branch: json::name_of(&row, "defaultBranchRef"),
                homepage: or(&row, "homepageUrl", ""),
                license: json::name_of(&row, "licenseInfo"),
                ssh_url: or(&row, "sshUrl", ""),
            })
        }
        Op::RepoCreate {
            name,
            visibility,
            description,
        } => {
            let visibility = format!("--{visibility}");
            let mut args = vec!["repo", "create", &name, &visibility];
            if !description.is_empty() {
                args.extend(["--description", &description]);
            }
            let url = printed_url(&center.call(&args, None).await?);
            Reply::json(&Url { url })
        }
        Op::RepoClone {
            destination,
            parent,
        } => {
            if center.named.is_none() {
                return Err(Fault::new("github_failed", "Name the repository to clone"));
            }
            let (folder, taken) = {
                let (parent, destination) = (parent.clone(), destination.clone());
                tokio::task::spawn_blocking(move || {
                    (
                        std::fs::metadata(&parent).is_ok_and(|meta| meta.is_dir()),
                        std::fs::symlink_metadata(&destination).is_ok(),
                    )
                })
                .await
                .map_err(|_| Fault::new("internal", "The clone's folder check panicked"))?
            };
            if !folder {
                return Err(Fault::new(
                    "github_failed",
                    format!("The folder {parent} does not exist"),
                ));
            }
            if taken {
                return Err(Fault::new(
                    "github_failed",
                    format!("{destination} already exists"),
                ));
            }
            let repo = center.repo().await?;
            center
                .call(
                    &["repo", "clone", &repo, &destination],
                    Some(timeouts.clone_ms),
                )
                .await?;
            Reply::json(&Cloned { path: destination })
        }
        Op::RepoFork => {
            let repo = center.repo().await?;
            center
                .call(&["repo", "fork", &repo, "--clone=false"], None)
                .await?;
            Reply::json(&DONE)
        }
        Op::WorkflowList => {
            let repo = center.repo().await?;
            let rows = center
                .json(&[
                    "workflow",
                    "list",
                    "--repo",
                    &repo,
                    "--all",
                    "--json",
                    "id,name,path,state",
                ])
                .await?;
            let workflows: Vec<Workflow> = json::list(&rows)
                .iter()
                .map(|row| Workflow {
                    id: or(row, "id", 0),
                    name: or(row, "name", ""),
                    path: or(row, "path", ""),
                    state: or(row, "state", ""),
                })
                .collect();
            Reply::json(&workflows)
        }
        Op::RunList { workflow } => {
            let repo = center.repo().await?;
            let mut args = vec!["run", "list", "--repo", &repo, "--limit", "30"];
            if let Some(workflow) = workflow.as_deref() {
                args.extend(["--workflow", workflow]);
            }
            args.extend(["--json", RUN_FIELDS]);
            let rows = center.json(&args).await?;
            Reply::json(&json::list(&rows).iter().map(run).collect::<Vec<_>>())
        }
        Op::RunGet { id } => {
            let id = id.to_string();
            let repo = center.repo().await?;
            let fields = format!("{RUN_FIELDS},jobs");
            let row = center
                .json(&["run", "view", &id, "--repo", &repo, "--json", &fields])
                .await?;
            Reply::json(&RunDetail {
                run: run(&row),
                jobs: json::rows(&row, "jobs")
                    .iter()
                    .map(|job| Job {
                        name: or(job, "name", ""),
                        status: or(job, "status", ""),
                        conclusion: or(job, "conclusion", ""),
                    })
                    .collect(),
            })
        }
        Op::RunLog { id, failed_only } => {
            let id = id.to_string();
            let repo = center.repo().await?;
            let flag = if failed_only { "--log-failed" } else { "--log" };
            let output = center
                .call(
                    &["run", "view", &id, "--repo", &repo, flag],
                    Some(timeouts.log_ms),
                )
                .await?;
            let lines: Vec<&str> = output
                .strip_suffix('\n')
                .unwrap_or(&output)
                .split('\n')
                .collect();
            Reply::json(&Log {
                text: lines[lines.len().saturating_sub(LOG_LINES)..].join("\n"),
                truncated: lines.len() > LOG_LINES,
            })
        }
        Op::WorkflowDispatch {
            workflow,
            reference,
        } => {
            let repo = center.repo().await?;
            let mut args = vec!["workflow", "run", &workflow, "--repo", &repo];
            if let Some(reference) = reference.as_deref() {
                args.extend(["--ref", reference]);
            }
            center.call(&args, None).await?;
            Reply::json(&DONE)
        }
        Op::RunRerun { id, failed_only } => {
            let id = id.to_string();
            let repo = center.repo().await?;
            let mut args = vec!["run", "rerun", &id, "--repo", &repo];
            if failed_only {
                args.push("--failed");
            }
            center.call(&args, None).await?;
            Reply::json(&DONE)
        }
        Op::RunCancel { id } => {
            let id = id.to_string();
            let repo = center.repo().await?;
            center
                .call(&["run", "cancel", &id, "--repo", &repo], None)
                .await?;
            Reply::json(&DONE)
        }
        Op::ReleaseList => {
            let repo = center.repo().await?;
            let rows = center
                .json(&[
                    "release",
                    "list",
                    "--repo",
                    &repo,
                    "--limit",
                    "30",
                    "--json",
                    RELEASE_FIELDS,
                ])
                .await?;
            Reply::json(&json::list(&rows).iter().map(release).collect::<Vec<_>>())
        }
        Op::ReleaseGet { tag } => {
            let repo = center.repo().await?;
            let row = center
                .json(&[
                    "release",
                    "view",
                    &tag,
                    "--repo",
                    &repo,
                    "--json",
                    "tagName,name,isDraft,isPrerelease,publishedAt,createdAt,body,targetCommitish,url,assets",
                ])
                .await?;
            Reply::json(&ReleaseDetail {
                release: release(&row),
                body: or(&row, "body", ""),
                target: or(&row, "targetCommitish", ""),
                url: or(&row, "url", ""),
                assets: json::rows(&row, "assets")
                    .iter()
                    .map(|asset| Asset {
                        name: or(asset, "name", ""),
                        size: or(asset, "size", 0),
                        downloads: or(asset, "downloadCount", 0),
                    })
                    .collect(),
            })
        }
        Op::ReleaseCreate {
            tag,
            title,
            notes,
            draft,
            prerelease,
            target,
        } => {
            let repo = center.repo().await?;
            let file = BodyFile::new(&notes).await?;
            let mut args = vec![
                "release",
                "create",
                &tag,
                "--repo",
                &repo,
                "--title",
                &title,
                "--notes-file",
                file.path(),
            ];
            if draft {
                args.push("--draft");
            }
            if prerelease {
                args.push("--prerelease");
            }
            if let Some(target) = target.as_deref() {
                args.extend(["--target", target]);
            }
            let output = center.call(&args, None).await?;
            drop(file);
            Reply::json(&Url {
                url: printed_url(&output),
            })
        }
        Op::ReleaseEdit {
            tag,
            title,
            notes,
            draft,
            prerelease,
        } => {
            let repo = center.repo().await?;
            let file = BodyFile::new(&notes).await?;
            let draft = format!("--draft={draft}");
            let prerelease = format!("--prerelease={prerelease}");
            let args = [
                "release",
                "edit",
                &tag,
                "--repo",
                &repo,
                "--title",
                &title,
                "--notes-file",
                file.path(),
                &draft,
                &prerelease,
            ];
            center.call(&args, None).await?;
            Reply::json(&DONE)
        }
        Op::NotificationList { all } => {
            let endpoint = format!(
                "notifications?per_page=50{}",
                if all { "&all=true" } else { "" }
            );
            let rows = json::parse(&center.api(&[&endpoint]).await?)?;
            let notifications: Vec<Notification> = json::list(&rows)
                .iter()
                .map(|row| {
                    let subject = get(row, "subject")
                        .and_then(|subject| json::text(subject, "url"))
                        .and_then(notification_web_url);
                    Notification {
                        id: or(row, "id", ""),
                        unread: or(row, "unread", false),
                        reason: or(row, "reason", ""),
                        title: nested(row, "subject", "title", ""),
                        kind: nested(row, "subject", "type", ""),
                        repo: nested(row, "repository", "full_name", ""),
                        updated_at: or(row, "updated_at", ""),
                        url: subject
                            .map_or_else(|| nested(row, "repository", "html_url", ""), Value::from),
                    }
                })
                .collect();
            Reply::json(&notifications)
        }
        Op::NotificationRead { id } => {
            let endpoint = format!("notifications/threads/{id}");
            center.api(&["-X", "PATCH", &endpoint]).await?;
            Reply::json(&DONE)
        }
        Op::NotificationReadAll => {
            center.api(&["-X", "PUT", "notifications"]).await?;
            Reply::json(&DONE)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows captured from `notificationWebUrl` (`src/shared/github.ts`, 12 Nov 2026).
    #[test]
    fn turns_a_notification_subject_s_api_url_into_its_web_page() {
        let cases: &[(&str, Option<&str>)] = &[
            (
                "https://api.github.com/repos/o/r/pulls/7",
                Some("https://github.com/o/r/pull/7"),
            ),
            (
                "https://api.github.com/repos/o/r/issues/3",
                Some("https://github.com/o/r/issues/3"),
            ),
            (
                "https://api.github.com/repos/o/r/commits/abc",
                Some("https://github.com/o/r/commit/abc"),
            ),
            (
                "https://api.github.com/repos/o/r/releases/123",
                Some("https://github.com/o/r/releases"),
            ),
            (
                "https://api.github.com/repos/o/r/releases/123/assets",
                Some("https://github.com/o/r/releases/123/assets"),
            ),
            (
                "https://ghe.example.com/api/v3/repos/o/r/issues/1",
                Some("https://ghe.example.com/o/r/issues/1"),
            ),
            ("https://example.com/x", None),
            (
                "https://api.github.com/repos/o/r",
                Some("https://github.com/o/r"),
            ),
            ("https://api.github.com/repos/o", None),
            ("https://api.github.com/repos/o/r/pulls/7\nx", None),
            (
                "https://h:8443/api/v3/repos/o/r/pulls/1",
                Some("https://h:8443/o/r/pull/1"),
            ),
            (
                "https://api.github.com/api/v3/repos/o/r/pulls/2",
                Some("https://api.github.com/o/r/pull/2"),
            ),
            ("https://a/b/api/v3/repos/o/r", None),
            ("http://api.github.com/repos/o/r/pulls/7", None),
            (
                "https://api.github.com/repos/o/r/pulls/",
                Some("https://github.com/o/r/pull/"),
            ),
            ("", None),
        ];
        for (url, want) in cases {
            assert_eq!(notification_web_url(url).as_deref(), *want, "{url:?}");
        }
    }

    #[test]
    fn reads_what_gh_printed() {
        assert_eq!(
            printed_url("Creating issue\nhttps://github.com/o/r/issues/12\n\n"),
            "https://github.com/o/r/issues/12"
        );
        assert_eq!(
            printed_url("✓ Created\n  https://github.com/o/n\n"),
            "https://github.com/o/n"
        );
        assert_eq!(printed_url("done\n"), "");
        assert_eq!(
            issue_number("https://github.com/o/r/issues/12"),
            Value::from(12)
        );
        assert_eq!(issue_number("https://x/issues/a/issues/7"), Value::from(7));
        assert_eq!(issue_number(""), Value::from(0));
        assert_eq!(
            signed_in_hosts(
                "✓ Logged in to github.com account a\nX Logged in to ghe.io x\nLogged in to github.com"
            ),
            ["github.com", "ghe.io"]
        );
    }
}
