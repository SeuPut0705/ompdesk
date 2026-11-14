//! The real `GithubSource`: GitHub's REST read with the person's own `gh` (`gh api --include`), so the core never
//! holds a token. Every read is conditional on the entity tag of its last `200` and kept here, so an unchanged
//! answer costs nothing of the account's quota and the caller gets the same rows again; what a request may spend is
//! `budget`'s. Only what a policy may do is written: a dispatch, a cancel, a rerun of the failed jobs.
//!
//! Measured on this repository (13 Nov 2026, gh 2.104.0): a conditional request answered `304` leaves
//! `x-ratelimit-remaining` where it was; GitHub answers the `304` with the strong form of the entity tag (`"…"`)
//! where the `200` carried the weak one (`W/"…"`), and the weak one is what has to be sent back.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Deserialize;

use super::budget::Budget;
use super::wire::{
    ARTIFACTS_PROJECTION, Answer, ArtifactRow, JOBS_PROJECTION, JobRow, JobsPage, RUN_PROJECTION,
    RunRow, RunsPage, rows, runs_projection,
};
use crate::checks::contract::{Sha, Timestamp};
use crate::checks::hub::{Fut, Runners};
use crate::checks::sources::{
    Budget as Quota, Checkout, CommitStatus, Dispatch, GithubArtifact, GithubJob, GithubRun,
    GithubSource, Read, SourceError, WriteError,
};
use crate::gh::Gh;
use crate::routines::github::encode_uri_component;
use crate::run::{Exec, Opts, Runner};
use crate::server::Scope;

/// Rows asked for per page: GitHub's most.
const PER_PAGE: usize = 100;
/// Pages read of one list: 300 unfinished runs, 300 jobs of a run. A list that holds more is cut there.
const PAGES_MAX: usize = 3;
/// The newest runs read beside the unfinished ones, for a run that began and ended between two reads.
const RECENT_ROWS: usize = 30;
/// Answers kept for their entity tags.
const PAGES_KEPT: usize = 512;
/// GitHub's own advice for a secondary limit that names no `retry-after`: at least a minute.
const SECONDARY_PAUSE_MS: u64 = 60_000;
/// One read's time and output: a list's answer is a few tens of KiB, a job's log a few MiB.
const READ_TIMEOUT_MS: u64 = 30_000;
const READ_MAX_BYTES: usize = 16 * 1024 * 1024;
/// An artifact's zip (a test report) may be large and slow.
const DOWNLOAD_TIMEOUT_MS: u64 = 300_000;
const DOWNLOAD_MAX_BYTES: usize = 512 * 1024 * 1024;

/// What one run of gh left: `code` as it exited, whatever it printed.
pub struct Printed {
    pub code: i32,
    pub stdout: Vec<u8>,
    /// Free of any token.
    pub stderr: String,
}

impl Printed {
    fn text(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }
}

/// Why gh printed nothing to read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// gh is not installed.
    Missing,
    /// OMPdesk has not said yet how gh runs (`checks.runners`).
    NotTold,
    /// It could not be run or was cut off; the words, free of any token.
    Broken(String),
}

/// How much one gh run may take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Size {
    /// An API answer or a log.
    Read,
    /// An artifact's zip.
    Download,
}

/// Runs gh. The seam the tests replay recorded answers through.
pub trait GhApi: Send + Sync {
    fn call<'a>(&'a self, args: &'a [String], size: Size) -> Fut<'a, Result<Printed, Failure>>;
}

/// A copy of a runner (`Runner` is main's shape and holds no `Clone`).
fn copy(runner: &Runner) -> Runner {
    Runner {
        bin: runner.bin.clone(),
        args: runner.args.clone(),
        env: runner.env.clone(),
        timeout_ms: runner.timeout_ms,
        max_bytes: runner.max_bytes,
    }
}

/// How gh and git run, as main last said (`checks.runners`); nothing before it said. The runners hold the person's
/// environment, tokens included: they are kept here and in no answer or log.
#[derive(Default)]
pub struct Tools(Mutex<Option<Arc<Runners>>>);

impl Tools {
    pub fn set(&self, runners: Runners) {
        *locked(&self.0) = Some(Arc::new(runners));
    }

    fn told(&self) -> Option<Arc<Runners>> {
        locked(&self.0).clone()
    }
}

/// The person's gh, run in the folder main named (`home`): an endpoint names its own repository.
pub struct GhCli {
    pub tools: Arc<Tools>,
}

impl GhApi for GhCli {
    fn call<'a>(&'a self, args: &'a [String], size: Size) -> Fut<'a, Result<Printed, Failure>> {
        Box::pin(async move {
            let told = self.tools.told().ok_or(Failure::NotTold)?;
            let runner = told.gh.as_ref().ok_or(Failure::Missing)?;
            let gh = Gh::new(Some(copy(runner)), Scope::detached());
            let exec = Exec::new(copy(runner), Scope::detached(), "gh");
            let opts = match size {
                Size::Read => Opts {
                    timeout_ms: Some(READ_TIMEOUT_MS),
                    max_bytes: Some(READ_MAX_BYTES),
                    ..Opts::default()
                },
                Size::Download => Opts {
                    timeout_ms: Some(DOWNLOAD_TIMEOUT_MS),
                    max_bytes: Some(DOWNLOAD_MAX_BYTES),
                    ..Opts::default()
                },
            };
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            match exec.run(&told.home, &args, opts).await {
                Ok(output) if output.truncated => Err(Failure::Broken(
                    "gh api output exceeded the size cap".to_owned(),
                )),
                Ok(output) => Ok(Printed {
                    code: output.code,
                    stdout: output.stdout,
                    stderr: gh.scrub(output.stderr),
                }),
                Err(fault) => Err(Failure::Broken(gh.scrub(fault.message))),
            }
        })
    }
}

/// An answer kept for its entity tag.
struct Page {
    etag: String,
    body: Arc<str>,
    used: u64,
}

#[derive(Default)]
struct State {
    budget: Budget,
    quota: Option<Quota>,
    pages: HashMap<String, Page>,
    /// Grows with every use of a page: the least recently used go first.
    uses: u64,
    /// Per repository, the runs last answered as unfinished.
    unfinished: HashMap<String, BTreeSet<u64>>,
}

/// What GitHub said to one read.
enum Got {
    Body(Arc<str>),
    /// It will not answer this one (`403`, `404`, `410`, `422`), in its words.
    Refused {
        status: u16,
        message: String,
    },
}

pub struct GhSource {
    api: Arc<dyn GhApi>,
    tools: Option<Arc<Tools>>,
    now: Box<dyn Fn() -> Timestamp + Send + Sync>,
    state: Mutex<State>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
}

/// gh has no account to ask as: its exit code for "sign in first", or its words for it.
fn signed_out(printed: &Printed) -> bool {
    let stderr = printed.stderr.to_ascii_lowercase();
    printed.code == 4
        || ["gh auth login", "not logged in", "authentication required"]
            .iter()
            .any(|words| stderr.contains(words))
}

/// `owner/name` in GitHub's characters, so an endpoint is only ever built from those.
fn repo_name(repo: &str) -> Result<&str, SourceError> {
    let named = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    match repo.split_once('/') {
        Some((owner, name)) if named(owner) && named(name) => Ok(repo),
        _ => Err(SourceError::new(
            "failed",
            format!("not a repository name: {repo}"),
        )),
    }
}

/// A path's segments, each written as a URL writes it.
fn path_of(text: &str) -> String {
    text.split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

/// The repository a remote's URL names on github.com.
pub fn github_repo_of(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = [
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
        "git@github.com:",
        "git://github.com/",
    ]
    .iter()
    .find_map(|prefix| {
        (url.len() > prefix.len() && url[..prefix.len()].eq_ignore_ascii_case(prefix))
            .then(|| &url[prefix.len()..])
    })?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    repo_name(rest).ok().map(str::to_owned)
}

impl GhSource {
    /// `tools` is where git runs from for `checkout`; none: no checkout is read.
    pub fn new(api: Arc<dyn GhApi>, tools: Option<Arc<Tools>>) -> GhSource {
        GhSource::at(api, tools, crate::clock::now_ms)
    }

    /// On a clock of the caller's.
    pub fn at(
        api: Arc<dyn GhApi>,
        tools: Option<Arc<Tools>>,
        now: impl Fn() -> Timestamp + Send + Sync + 'static,
    ) -> GhSource {
        GhSource {
            api,
            tools,
            now: Box::new(now),
            state: Mutex::default(),
        }
    }

    /// Why gh could not ask. One absent or not yet told sent nothing, so its allowance is given back; one that was
    /// cut off may have sent its request.
    fn failed(&self, failure: Failure) -> SourceError {
        match failure {
            Failure::Broken(message) => SourceError::new("offline", message),
            Failure::Missing => {
                locked(&self.state).budget.refund();
                SourceError::new("missing", "the GitHub CLI (gh) is not installed")
            }
            Failure::NotTold => {
                locked(&self.state).budget.refund();
                SourceError::new(
                    "offline",
                    "OMPdesk has not said yet how the GitHub CLI runs",
                )
            }
        }
    }

    fn limited(&self, state: &State) -> SourceError {
        SourceError {
            code: "rate_limited".to_owned(),
            message: "GitHub's request quota is used up for now".to_owned(),
            retry_at: Some(state.budget.next((self.now)())),
        }
    }

    /// Takes what an answer's headers say of the quota and a pause GitHub asks for; the error when it refused for
    /// either.
    fn heed(&self, state: &mut State, answer: &Answer) -> Result<(), SourceError> {
        let now = (self.now)();
        if let Some(rate) = answer.rate {
            state.budget.observe(rate);
            state.quota = Some(Quota {
                limit: rate.limit,
                remaining: rate.remaining,
                reset_at: rate.reset_at,
            });
        }
        if !answer.limited() {
            return Ok(());
        }
        // A spent quota already holds the budget until its reset; anything else is a pause GitHub asks for.
        if answer.retry_after.is_some() || answer.rate.is_none_or(|rate| rate.remaining != 0) {
            let wait = answer
                .retry_after
                .map_or(SECONDARY_PAUSE_MS, |seconds| seconds.saturating_mul(1000));
            state.budget.pause(now + wait);
        }
        Err(self.limited(state))
    }

    /// What gh printed as GitHub's answer, or why there is none.
    fn answer_of(&self, outcome: Result<Printed, Failure>) -> Result<Answer, SourceError> {
        let printed = outcome.map_err(|failure| self.failed(failure))?;
        if let Some(answer) = Answer::read(&printed.text()) {
            return Ok(answer);
        }
        if signed_out(&printed) {
            locked(&self.state).budget.refund();
            return Err(SourceError::new(
                "unauthenticated",
                "the GitHub CLI (gh) is not signed in",
            ));
        }
        Err(SourceError::new(
            "offline",
            match first_line(&printed.stderr) {
                "" => format!("gh api exited with code {}", printed.code),
                line => line.to_owned(),
            },
        ))
    }

    /// One conditional read of `endpoint`, its body projected by `projection`.
    async fn get(&self, endpoint: &str, projection: &str) -> Result<Got, SourceError> {
        let etag = {
            let mut state = locked(&self.state);
            if !state.budget.take((self.now)()) {
                return Err(self.limited(&state));
            }
            state.pages.get(endpoint).map(|page| page.etag.clone())
        };
        let mut args = vec![
            "api".to_owned(),
            "--include".to_owned(),
            "--jq".to_owned(),
            projection.to_owned(),
        ];
        if let Some(etag) = &etag {
            args.extend(["-H".to_owned(), format!("If-None-Match: {etag}")]);
        }
        args.push(endpoint.to_owned());
        let answer = self.answer_of(self.api.call(&args, Size::Read).await)?;
        let mut state = locked(&self.state);
        self.heed(&mut state, &answer)?;
        state.uses += 1;
        let uses = state.uses;
        match answer.status {
            304 => {
                state.budget.refund();
                let page = state.pages.get_mut(endpoint).ok_or_else(|| {
                    SourceError::new("failed", "GitHub answered 304 to an unconditional request")
                })?;
                page.used = uses;
                Ok(Got::Body(Arc::clone(&page.body)))
            }
            200 => {
                let body: Arc<str> = answer.body.into();
                match answer.etag {
                    Some(etag) => {
                        state.pages.insert(
                            endpoint.to_owned(),
                            Page {
                                etag,
                                body: Arc::clone(&body),
                                used: uses,
                            },
                        );
                        if state.pages.len() > PAGES_KEPT {
                            let mut used: Vec<u64> =
                                state.pages.values().map(|page| page.used).collect();
                            used.sort_unstable();
                            let oldest = used[used.len() - PAGES_KEPT];
                            state.pages.retain(|_, page| page.used >= oldest);
                        }
                    }
                    None => {
                        state.pages.remove(endpoint);
                    }
                }
                Ok(Got::Body(body))
            }
            401 => Err(SourceError::new(
                "unauthenticated",
                "GitHub refused the GitHub CLI's sign-in",
            )),
            status @ (403 | 404 | 410 | 422) => Ok(Got::Refused {
                status,
                message: answer.message().unwrap_or_else(|| format!("HTTP {status}")),
            }),
            status => Err(SourceError::new(
                "offline",
                format!("GitHub answered HTTP {status}"),
            )),
        }
    }

    /// A read whose refusal is a failure of that read.
    async fn body(&self, endpoint: &str, projection: &str) -> Result<Arc<str>, SourceError> {
        match self.get(endpoint, projection).await? {
            Got::Body(body) => Ok(body),
            Got::Refused { status, message } => Err(SourceError::new(
                "failed",
                format!("{message} (HTTP {status})"),
            )),
        }
    }

    /// A body in the shape asked for; one of another shape is forgotten, so no later `304` confirms rows never read.
    fn parsed<'a, T: Deserialize<'a>>(
        &self,
        endpoint: &str,
        body: &'a str,
    ) -> Result<T, SourceError> {
        rows(body).map_err(|message| {
            locked(&self.state).pages.remove(endpoint);
            SourceError::new(
                "failed",
                format!("GitHub's answer is unreadable: {message}"),
            )
        })
    }

    /// The pages of one list of runs, as far as `PAGES_MAX`.
    async fn run_list(&self, list: &str, rows_wanted: usize) -> Result<Vec<RunRow>, SourceError> {
        let projection = runs_projection();
        let mut all = Vec::new();
        for page in 1..=PAGES_MAX {
            let endpoint = format!("{list}per_page={rows_wanted}&page={page}");
            let body = self.body(&endpoint, &projection).await?;
            let read: RunsPage = self.parsed(&endpoint, &body)?;
            let got = read.workflow_runs.len();
            all.extend(read.workflow_runs);
            if rows_wanted < PER_PAGE || got < PER_PAGE || all.len() as u64 >= read.total_count {
                break;
            }
        }
        Ok(all)
    }

    /// A response-less write is unconfirmed, not a refusal. The versioned dispatch endpoint returns the exact run id.
    async fn post_receipt(
        &self,
        endpoint: String,
        fields: Vec<String>,
    ) -> Result<Answer, WriteError> {
        let mut args = vec![
            "api".to_owned(),
            "--include".to_owned(),
            "-X".to_owned(),
            "POST".to_owned(),
            "-H".to_owned(),
            "X-GitHub-Api-Version: 2026-03-10".to_owned(),
        ];
        for field in fields {
            args.extend(["-f".to_owned(), field]);
        }
        args.push(endpoint);
        let outcome = match self.api.call(&args, Size::Read).await {
            Err(failure @ (Failure::Missing | Failure::NotTold)) => {
                return Err(WriteError::Refused(self.failed(failure)));
            }
            other => other,
        };
        let answer = self.answer_of(outcome).map_err(|error| {
            if error.code == "unauthenticated" {
                WriteError::Refused(error)
            } else {
                WriteError::Unconfirmed(error)
            }
        })?;
        let quota = self.heed(&mut locked(&self.state), &answer);
        match answer.status {
            200..=299 => Ok(answer),
            400..=499 => Err(WriteError::Refused(quota.err().unwrap_or_else(|| {
                SourceError::new(
                    "rejected",
                    format!(
                        "{} (HTTP {})",
                        answer.message().unwrap_or_else(|| "refused".into()),
                        answer.status
                    ),
                )
            }))),
            status => Err(WriteError::Unconfirmed(SourceError::new(
                "offline",
                format!(
                    "{} (HTTP {status})",
                    answer
                        .message()
                        .unwrap_or_else(|| "acceptance unknown".into())
                ),
            ))),
        }
    }

    async fn post(&self, endpoint: String, fields: Vec<String>) -> Result<(), SourceError> {
        self.post_receipt(endpoint, fields)
            .await
            .map(|_| ())
            .map_err(|error| error.error().clone())
    }

    /// A file GitHub serves through a redirect (a log, an artifact's zip): no head to read, so gh's exit is the
    /// answer, and every request is charged.
    async fn fetch(&self, endpoint: String, size: Size) -> Result<Vec<u8>, SourceError> {
        {
            let mut state = locked(&self.state);
            if !state.budget.take((self.now)()) {
                return Err(self.limited(&state));
            }
        }
        let args = ["api".to_owned(), endpoint];
        let printed = self
            .api
            .call(&args, size)
            .await
            .map_err(|failure| self.failed(failure))?;
        if printed.code == 0 {
            return Ok(printed.stdout);
        }
        Err(if signed_out(&printed) {
            SourceError::new("unauthenticated", "the GitHub CLI (gh) is not signed in")
        } else {
            SourceError::new("failed", first_line(&printed.stderr))
        })
    }
}

impl GithubSource for GhSource {
    fn runs<'a>(
        &'a self,
        repo: &'a str,
        since: Timestamp,
        mark: Option<&'a str>,
    ) -> Fut<'a, Result<Read<Vec<GithubRun>>, SourceError>> {
        Box::pin(async move {
            let repo = repo_name(repo)?;
            let base = format!("repos/{repo}/actions/runs");
            let mut newest: BTreeMap<u64, RunRow> = BTreeMap::new();
            for list in [
                format!("{base}?status=in_progress&"),
                format!("{base}?status=queued&"),
            ] {
                for row in self.run_list(&list, PER_PAGE).await? {
                    match newest.get(&row.id) {
                        Some(known) if !row.newer_than(known) => {}
                        _ => {
                            newest.insert(row.id, row);
                        }
                    }
                }
            }
            for row in self.run_list(&format!("{base}?"), RECENT_ROWS).await? {
                match newest.get(&row.id) {
                    Some(known) if !row.newer_than(known) => {}
                    _ => {
                        newest.insert(row.id, row);
                    }
                }
            }
            // Unfinished at the last read and in no list now: it just ended, or waits in a state GitHub has no
            // list for. Asked for by its id; one GitHub no longer has is gone.
            let before: Vec<u64> = locked(&self.state)
                .unfinished
                .get(repo)
                .map(|ids| ids.iter().copied().collect())
                .unwrap_or_default();
            for id in before {
                if newest.contains_key(&id) {
                    continue;
                }
                let endpoint = format!("{base}/{id}");
                if let Got::Body(body) = self.get(&endpoint, RUN_PROJECTION).await? {
                    let row: RunRow = self.parsed(&endpoint, &body)?;
                    newest.insert(row.id, row);
                }
            }
            let mut state = locked(&self.state);
            state.unfinished.insert(
                repo.to_owned(),
                newest
                    .values()
                    .filter(|row| row.active())
                    .map(|row| row.id)
                    .collect(),
            );
            // The answer is what these tags stand for. The same tags hold nothing a caller that asks no further
            // back than it did before was not already told.
            let mut tags: Vec<String> = state
                .pages
                .iter()
                .filter(|(endpoint, _)| endpoint.starts_with(&base) && !endpoint.contains("/jobs"))
                .map(|(endpoint, page)| format!("{endpoint} {}", page.etag))
                .collect();
            tags.sort_unstable();
            let now_mark = tags.join("\n");
            if mark == Some(now_mark.as_str()) {
                return Ok(Read::Unchanged);
            }
            let mut runs: Vec<RunRow> = newest
                .into_values()
                .filter(|row| row.active() || row.updated_at >= since)
                .collect();
            runs.sort_by_key(|run| std::cmp::Reverse((run.created_at, run.id)));
            Ok(Read::Fresh {
                value: runs.into_iter().map(RunRow::into_run).collect(),
                mark: Some(now_mark),
            })
        })
    }

    fn jobs<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<Vec<GithubJob>, SourceError>> {
        Box::pin(async move {
            let repo = repo_name(repo)?;
            let mut all = Vec::new();
            for page in 1..=PAGES_MAX {
                let endpoint =
                    format!("repos/{repo}/actions/runs/{run}/jobs?per_page={PER_PAGE}&page={page}");
                let body = self.body(&endpoint, JOBS_PROJECTION).await?;
                let read: JobsPage = self.parsed(&endpoint, &body)?;
                let got = read.jobs.len();
                all.extend(read.jobs.into_iter().map(JobRow::into_job));
                if got < PER_PAGE || all.len() as u64 >= read.total_count {
                    break;
                }
            }
            Ok(all)
        })
    }

    fn job_log<'a>(&'a self, repo: &'a str, job: u64) -> Fut<'a, Result<String, SourceError>> {
        Box::pin(async move {
            let repo = repo_name(repo)?;
            let log = self
                .fetch(format!("repos/{repo}/actions/jobs/{job}/logs"), Size::Read)
                .await?;
            Ok(String::from_utf8_lossy(&log).into_owned())
        })
    }

    fn variable<'a>(
        &'a self,
        repo: &'a str,
        name: &'a str,
    ) -> Fut<'a, Result<Option<String>, SourceError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Variable {
                value: String,
            }
            let repo = repo_name(repo)?;
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                return Err(SourceError::new(
                    "failed",
                    format!("not a variable name: {name}"),
                ));
            }
            let endpoint = format!("repos/{repo}/actions/variables/{name}");
            match self.get(&endpoint, "{value}").await? {
                Got::Body(body) => Ok(Some(self.parsed::<Variable>(&endpoint, &body)?.value)),
                Got::Refused { status: 404, .. } => Ok(None),
                Got::Refused { status, message } => Err(SourceError::new(
                    "failed",
                    format!("{message} (HTTP {status})"),
                )),
            }
        })
    }

    fn head<'a>(
        &'a self,
        repo: &'a str,
        git_ref: &'a str,
    ) -> Fut<'a, Result<Option<Sha>, SourceError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Commit {
                sha: String,
            }
            let repo = repo_name(repo)?;
            let endpoint = format!("repos/{repo}/commits/{}", path_of(git_ref));
            match self.get(&endpoint, "{sha}").await? {
                Got::Body(body) => Ok(Some(self.parsed::<Commit>(&endpoint, &body)?.sha)),
                // `422`: GitHub's "No commit found" for a name it does not have.
                Got::Refused {
                    status: 404 | 422, ..
                } => Ok(None),
                Got::Refused { status, message } => Err(SourceError::new(
                    "failed",
                    format!("{message} (HTTP {status})"),
                )),
            }
        })
    }

    /// Read from the checkout alone, with git: no request to GitHub.
    fn checkout<'a>(&'a self, cwd: &'a str) -> Fut<'a, Result<Option<Checkout>, SourceError>> {
        Box::pin(async move {
            let runner = self
                .tools
                .as_ref()
                .and_then(|tools| tools.told())
                .and_then(|told| told.git.as_ref().map(copy));
            let Some(runner) = runner else {
                return Err(SourceError::new("missing", "git is not installed"));
            };
            let git = Exec::new(runner, Scope::detached(), "git");
            let mut read = Vec::with_capacity(3);
            let reads: [&[&str]; 3] = [
                &["rev-parse", "--abbrev-ref", "HEAD"],
                &["rev-parse", "HEAD"],
                &["remote", "get-url", "origin"],
            ];
            for args in reads {
                let output = git
                    .run(cwd, args, Opts::default())
                    .await
                    .map_err(|fault| SourceError::new("failed", fault.message))?;
                if output.code != 0 {
                    // No repository, no commit yet, or no `origin`.
                    return Ok(None);
                }
                read.push(output.text().trim().to_owned());
            }
            let [branch, sha, url] = [&read[0], &read[1], &read[2]];
            // `HEAD`: detached, on no branch.
            Ok(github_repo_of(url)
                .filter(|_| branch != "HEAD")
                .map(|repo| Checkout {
                    repo,
                    branch: branch.clone(),
                    sha: sha.clone(),
                }))
        })
    }

    fn dispatch<'a>(&'a self, dispatch: &'a Dispatch) -> Fut<'a, Result<u64, WriteError>> {
        Box::pin(async move {
            let repo = repo_name(&dispatch.repo).map_err(WriteError::Refused)?;
            let workflow = &dispatch.workflow;
            let named = |text: &str| {
                !text.is_empty()
                    && text.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            };
            if !named(workflow) || dispatch.inputs.keys().any(|key| !named(key)) {
                return Err(WriteError::Refused(SourceError::new(
                    "failed",
                    "not a workflow file or input name",
                )));
            }
            let mut fields = vec![format!("ref={}", dispatch.git_ref)];
            fields.extend(
                dispatch
                    .inputs
                    .iter()
                    .map(|(key, value)| format!("inputs[{key}]={value}")),
            );
            let answer = self
                .post_receipt(
                    format!("repos/{repo}/actions/workflows/{workflow}/dispatches"),
                    fields,
                )
                .await?;
            #[derive(Deserialize)]
            struct Receipt {
                workflow_run_id: u64,
            }
            let receipt: Receipt = serde_json::from_str(&answer.body).map_err(|_| {
                WriteError::Unconfirmed(SourceError::new(
                    "offline",
                    "GitHub accepted the dispatch but returned no authoritative run id",
                ))
            })?;
            if receipt.workflow_run_id == 0 {
                return Err(WriteError::Unconfirmed(SourceError::new(
                    "offline",
                    "GitHub returned an invalid run id",
                )));
            }
            Ok(receipt.workflow_run_id)
        })
    }

    fn cancel<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<(), SourceError>> {
        Box::pin(async move {
            let repo = repo_name(repo)?;
            self.post(
                format!("repos/{repo}/actions/runs/{run}/cancel"),
                Vec::new(),
            )
            .await
        })
    }

    fn rerun_failed<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<(), WriteError>> {
        Box::pin(async move {
            let repo = repo_name(repo).map_err(WriteError::Refused)?;
            self.post_receipt(
                format!("repos/{repo}/actions/runs/{run}/rerun-failed-jobs"),
                Vec::new(),
            )
            .await
            .map(|_| ())
        })
    }

    fn authorize_rerun<'a>(&'a self, status: &'a CommitStatus) -> Fut<'a, Result<(), WriteError>> {
        Box::pin(async move {
            let repo = repo_name(&status.repo).map_err(WriteError::Refused)?;
            self.post_receipt(
                format!("repos/{repo}/statuses/{}", path_of(&status.sha)),
                vec![
                    format!("context={}", status.context),
                    format!("description={}", status.description),
                    format!("state={}", status.state),
                ],
            )
            .await
            .map(|_| ())
        })
    }

    fn budget(&self) -> Option<Quota> {
        locked(&self.state).quota
    }

    fn artifacts<'a>(
        &'a self,
        repo: &'a str,
        run: u64,
    ) -> Fut<'a, Result<Vec<GithubArtifact>, SourceError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Page {
                artifacts: Vec<ArtifactRow>,
            }
            let repo = repo_name(repo)?;
            let endpoint = format!("repos/{repo}/actions/runs/{run}/artifacts?per_page={PER_PAGE}");
            let body = self.body(&endpoint, ARTIFACTS_PROJECTION).await?;
            let page: Page = self.parsed(&endpoint, &body)?;
            Ok(page
                .artifacts
                .into_iter()
                .map(ArtifactRow::into_artifact)
                .collect())
        })
    }

    fn artifact<'a>(&'a self, repo: &'a str, id: u64) -> Fut<'a, Result<Vec<u8>, SourceError>> {
        Box::pin(async move {
            let repo = repo_name(repo)?;
            self.fetch(
                format!("repos/{repo}/actions/artifacts/{id}/zip"),
                Size::Download,
            )
            .await
        })
    }

    fn is_private<'a>(&'a self, repo: &'a str) -> Fut<'a, Result<bool, SourceError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Visibility {
                private: bool,
            }
            let repo = repo_name(repo)?;
            let endpoint = format!("repos/{repo}");
            let body = self.body(&endpoint, "{private}").await?;
            Ok(self.parsed::<Visibility>(&endpoint, &body)?.private)
        })
    }

    fn file<'a>(
        &'a self,
        repo: &'a str,
        sha: &'a str,
        path: &'a str,
    ) -> Fut<'a, Result<Option<String>, SourceError>> {
        Box::pin(async move {
            use base64::Engine as _;
            #[derive(Deserialize)]
            struct Content {
                content: String,
                encoding: String,
            }
            let repo = repo_name(repo)?;
            if sha.is_empty() || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(SourceError::new("failed", format!("not a commit: {sha}")));
            }
            let endpoint = format!("repos/{repo}/contents/{}?ref={sha}", path_of(path));
            let body = match self.get(&endpoint, "{content, encoding}").await? {
                Got::Body(body) => body,
                Got::Refused { status: 404, .. } => return Ok(None),
                Got::Refused { status, message } => {
                    return Err(SourceError::new(
                        "failed",
                        format!("{message} (HTTP {status})"),
                    ));
                }
            };
            let content = self.parsed::<Content>(&endpoint, &body)?;
            let unreadable = |why: &str| SourceError::new("failed", format!("{path}: {why}"));
            if content.encoding != "base64" {
                return Err(unreadable("not served as base64"));
            }
            let packed: String = content.content.split_whitespace().collect();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(packed)
                .map_err(|_| unreadable("not base64"))?;
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| unreadable("not UTF-8"))
        })
    }

    fn default_branch<'a>(&'a self, repo: &'a str) -> Fut<'a, Result<Option<String>, SourceError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Repository {
                default_branch: Option<String>,
            }
            let repo = repo_name(repo)?;
            let endpoint = format!("repos/{repo}");
            let body = self.body(&endpoint, "{default_branch}").await?;
            Ok(self
                .parsed::<Repository>(&endpoint, &body)?
                .default_branch
                .filter(|branch| !branch.is_empty()))
        })
    }

    fn subject<'a>(
        &'a self,
        repo: &'a str,
        sha: &'a str,
    ) -> Fut<'a, Result<Option<String>, SourceError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Message {
                message: String,
            }
            let repo = repo_name(repo)?;
            if sha.is_empty() || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(SourceError::new("failed", format!("not a commit: {sha}")));
            }
            let endpoint = format!("repos/{repo}/commits/{sha}");
            match self.get(&endpoint, "{message: .commit.message}").await? {
                Got::Body(body) => Ok(self
                    .parsed::<Message>(&endpoint, &body)?
                    .message
                    .lines()
                    .next()
                    .map(str::to_owned)),
                Got::Refused {
                    status: 404 | 422, ..
                } => Ok(None),
                Got::Refused { status, message } => Err(SourceError::new(
                    "failed",
                    format!("{message} (HTTP {status})"),
                )),
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::{Value, json};

    use super::super::budget::PER_HOUR;
    use super::super::wire::fixtures::*;
    use super::*;

    pub(crate) const REPO: &str = "SeuPut0705/ompdesk";
    /// The recordings' own time: a little after the last of them was made.
    pub(crate) const T0: Timestamp = 1_794_596_700_000;

    const IN_PROGRESS: &str =
        "repos/SeuPut0705/ompdesk/actions/runs?status=in_progress&per_page=100&page=1";
    const QUEUED: &str = "repos/SeuPut0705/ompdesk/actions/runs?status=queued&per_page=100&page=1";
    const RECENT: &str = "repos/SeuPut0705/ompdesk/actions/runs?per_page=30&page=1";

    fn jobs_of(run: u64) -> String {
        format!("repos/{REPO}/actions/runs/{run}/jobs?per_page=100&page=1")
    }

    fn run_of(run: u64) -> String {
        format!("repos/{REPO}/actions/runs/{run}")
    }

    /// A recorded answer with its body's JSON changed, under a tag of its own.
    pub(crate) fn edited(text: &str, edit: impl FnOnce(&mut Value)) -> String {
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut body: Value = serde_json::from_str(body).unwrap();
        edit(&mut body);
        let body = body.to_string();
        let head: Vec<String> = head
            .split("\r\n")
            .map(|line| {
                if line.to_ascii_lowercase().starts_with("etag:") {
                    // Each edited body its own tag, so a changed answer is never taken for an unchanged one.
                    let mut hasher = std::hash::DefaultHasher::new();
                    std::hash::Hash::hash(&body, &mut hasher);
                    format!(
                        "Etag: W/\"edited-{:x}\"",
                        std::hash::Hasher::finish(&hasher)
                    )
                } else {
                    line.to_owned()
                }
            })
            .collect();
        format!("{}\r\n\r\n{body}", head.join("\r\n"))
    }

    /// gh as a table: what each endpoint prints, in turn (the last answer stays), and every call it got. An endpoint
    /// asked with the tag of the answer it would print prints the recorded `304` instead.
    #[derive(Default)]
    pub(crate) struct Replay {
        answers: Mutex<HashMap<String, VecDeque<String>>>,
        pub(crate) calls: Mutex<Vec<Vec<String>>>,
        failure: Mutex<Option<Result<(i32, String), Failure>>>,
    }

    impl Replay {
        pub(crate) fn recorded() -> Arc<Replay> {
            let replay = Arc::new(Replay::default());
            replay.say(IN_PROGRESS, RUNS_IN_PROGRESS);
            replay.say(QUEUED, RUNS_QUEUED);
            replay.say(RECENT, RUNS_RECENT);
            replay.say(&jobs_of(LIVE_RUN), JOBS_IN_PROGRESS);
            replay.say(&jobs_of(DONE_RUN), JOBS_COMPLETED);
            replay.say(&run_of(DONE_RUN), RUN_COMPLETED);
            replay
        }

        /// What `endpoint` prints once what was said before has been printed.
        pub(crate) fn say(&self, endpoint: &str, printed: &str) {
            locked(&self.answers)
                .entry(endpoint.to_owned())
                .or_default()
                .push_back(printed.to_owned());
        }

        /// What `endpoint` prints from now on, instead of what was said before.
        pub(crate) fn now_says(&self, endpoint: &str, printed: &str) {
            locked(&self.answers).insert(endpoint.to_owned(), VecDeque::from([printed.to_owned()]));
        }

        /// gh fails (`Err`) or exits with a code and stderr and no response head, until `works`.
        fn fails(&self, failure: Result<(i32, &str), Failure>) {
            *locked(&self.failure) = Some(failure.map(|(code, text)| (code, text.to_owned())));
        }

        fn works(&self) {
            *locked(&self.failure) = None;
        }

        pub(crate) fn count(&self) -> usize {
            locked(&self.calls).len()
        }

        fn sent_tag(args: &[String]) -> Option<&str> {
            args.iter()
                .find_map(|arg| arg.strip_prefix("If-None-Match: "))
        }
    }

    impl GhApi for Replay {
        fn call<'a>(
            &'a self,
            args: &'a [String],
            _size: Size,
        ) -> Fut<'a, Result<Printed, Failure>> {
            Box::pin(async move {
                locked(&self.calls).push(args.to_vec());
                if let Some(failure) = locked(&self.failure).clone() {
                    let (code, stderr) = failure?;
                    return Ok(Printed {
                        code,
                        stdout: Vec::new(),
                        stderr,
                    });
                }
                let mut answers = locked(&self.answers);
                let Some(queue) = answers.get_mut(args.last().unwrap()) else {
                    return Ok(Printed {
                        code: 1,
                        stdout: NOT_FOUND.into(),
                        stderr: "gh: Not Found (HTTP 404)".to_owned(),
                    });
                };
                let printed = if queue.len() > 1 {
                    queue.pop_front().unwrap()
                } else {
                    queue.front().unwrap().clone()
                };
                let answer = Answer::read(&printed);
                let tag = answer.as_ref().and_then(|answer| answer.etag.as_deref());
                if tag.is_some() && Replay::sent_tag(args) == tag {
                    return Ok(Printed {
                        code: 1,
                        stdout: JOBS_NOT_MODIFIED.into(),
                        stderr: "unexpected end of JSON input".to_owned(),
                    });
                }
                Ok(Printed {
                    code: i32::from(answer.is_none_or(|answer| answer.status >= 300)),
                    stdout: printed.into_bytes(),
                    stderr: String::new(),
                })
            })
        }
    }

    pub(crate) fn source(replay: &Arc<Replay>) -> (GhSource, Arc<AtomicU64>) {
        let now = Arc::new(AtomicU64::new(T0));
        let clock = Arc::clone(&now);
        let source = GhSource::at(replay.clone(), None, move || clock.load(Ordering::Relaxed));
        (source, now)
    }

    fn fresh(read: Read<Vec<GithubRun>>) -> (Vec<GithubRun>, String) {
        match read {
            Read::Fresh { value, mark } => (value, mark.expect("a mark")),
            Read::Unchanged => panic!("unchanged"),
        }
    }

    #[tokio::test]
    async fn the_runs_are_the_unfinished_ones_and_what_ended_since_newest_first() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let (runs, _) = fresh(source.runs(REPO, 0, None).await.unwrap());
        // 10 in progress and 4 queued by their lists; the newest 30 add one `pending` run and 16 finished ones.
        let count = |status: &str| runs.iter().filter(|run| run.status == status).count();
        assert_eq!(
            (
                count("in_progress"),
                count("queued"),
                count("pending"),
                count("completed")
            ),
            (10, 4, 1, 16)
        );
        assert!(
            runs.windows(2)
                .all(|pair| pair[0].created_at >= pair[1].created_at)
        );
        let live = runs.iter().find(|run| run.id == LIVE_RUN).unwrap();
        assert_eq!(
            (live.workflow.as_str(), live.event.as_str(), live.attempt),
            ("shell-batch-checks.yml", "workflow_dispatch", 1)
        );
        assert_eq!(source.budget().unwrap().limit, 5_000);

        // Only what ended since `since` is told of the finished ones; the unfinished always are.
        let (later, _) = fresh(source.runs(REPO, T0, None).await.unwrap());
        assert_eq!(later.len(), 15);
        assert!(later.iter().all(|run| run.status != "completed"));

        let calls = locked(&replay.calls);
        assert_eq!(
            calls[0][..4],
            ["api", "--include", "--jq", runs_projection().as_str()]
        );
        assert_eq!(
            calls[..3]
                .iter()
                .map(|call| call.last().unwrap().as_str())
                .collect::<Vec<_>>(),
            [IN_PROGRESS, QUEUED, RECENT]
        );
        assert!(
            calls[..3]
                .iter()
                .all(|call| Replay::sent_tag(call).is_none())
        );
    }

    #[tokio::test]
    async fn an_unchanged_list_is_asked_with_its_tag_answered_from_memory_and_costs_nothing() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let (first, mark) = fresh(source.runs(REPO, 0, None).await.unwrap());
        // A day of reads every 15 s, all at one moment: far more than an hour's allowance, were they charged.
        for round in 0..5_760 {
            let again = source.runs(REPO, 0, Some(&mark)).await;
            assert_eq!(again, Ok(Read::Unchanged), "round {round}");
        }
        assert!(5_760 * 3 > PER_HOUR as usize);
        // Without the mark, the same rows from memory.
        assert_eq!(fresh(source.runs(REPO, 0, None).await.unwrap()).0, first);
        let calls = locked(&replay.calls);
        // The tag goes back as GitHub wrote it, weak form and quotes; a `304`'s strong form never replaces it.
        let tag = Answer::read(RUNS_IN_PROGRESS).unwrap().etag.unwrap();
        assert!(tag.starts_with("W/\""));
        for call in calls
            .iter()
            .filter(|call| call.last().unwrap() == IN_PROGRESS)
            .skip(1)
        {
            assert_eq!(Replay::sent_tag(call), Some(tag.as_str()));
        }
    }

    #[tokio::test]
    async fn a_run_that_left_the_lists_is_asked_for_by_its_id() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        source.runs(REPO, 0, None).await.unwrap();
        // The lists no longer name it: neither the unfinished ones nor the newest.
        let without = |text: &str| {
            edited(text, |body| {
                body["workflow_runs"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|run| run["id"] != LIVE_RUN);
            })
        };
        replay.now_says(IN_PROGRESS, &without(RUNS_IN_PROGRESS));
        replay.now_says(RECENT, &without(RUNS_RECENT));
        // GitHub says how it ended.
        replay.now_says(
            &run_of(LIVE_RUN),
            &edited(RUN_COMPLETED, |row| {
                row["id"] = json!(LIVE_RUN);
                row["conclusion"] = json!("failure");
                row["updated_at"] = json!("2026-11-13T19:05:00Z");
            }),
        );
        let (runs, _) = fresh(source.runs(REPO, T0, None).await.unwrap());
        let ended = runs
            .iter()
            .find(|run| run.id == LIVE_RUN)
            .expect("still told");
        assert_eq!(
            (ended.status.as_str(), ended.conclusion.as_deref()),
            ("completed", Some("failure"))
        );
        // Finished: not asked for again.
        let before = replay.count();
        source.runs(REPO, T0, None).await.unwrap();
        assert!(
            !locked(&replay.calls)[before..]
                .iter()
                .any(|call| call.last().unwrap() == &run_of(LIVE_RUN))
        );

        // A run GitHub no longer has is simply gone.
        let pending = runs.iter().find(|run| run.status == "pending").unwrap().id;
        replay.now_says(
            RECENT,
            &edited(RUNS_RECENT, |body| {
                body["workflow_runs"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|run| run["id"] != pending && run["id"] != LIVE_RUN);
            }),
        );
        let (runs, _) = fresh(source.runs(REPO, T0, None).await.unwrap());
        assert!(!runs.iter().any(|run| run.id == pending));
    }

    #[tokio::test]
    async fn a_list_behind_the_times_never_unfinishes_a_run() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        // The newest runs already call it finished while the list of runs in progress still names it.
        replay.now_says(
            RECENT,
            &edited(RUNS_RECENT, |body| {
                for run in body["workflow_runs"].as_array_mut().unwrap() {
                    if run["id"] == LIVE_RUN {
                        run["status"] = json!("completed");
                        run["conclusion"] = json!("success");
                        run["updated_at"] = json!("2026-11-13T19:05:00Z");
                    }
                }
            }),
        );
        let (runs, _) = fresh(source.runs(REPO, 0, None).await.unwrap());
        let run = runs.iter().find(|run| run.id == LIVE_RUN).unwrap();
        assert_eq!(run.status, "completed");
    }

    #[tokio::test]
    async fn a_runs_jobs_are_read_and_an_unchanged_read_answers_the_same_rows() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let jobs = source.jobs(REPO, LIVE_RUN).await.unwrap();
        assert_eq!(jobs.len(), 6);
        assert!(jobs.iter().all(|job| job.run == LIVE_RUN));
        assert_eq!(source.jobs(REPO, LIVE_RUN).await.unwrap(), jobs);
        {
            let calls = locked(&replay.calls);
            assert_eq!(calls[0][3], JOBS_PROJECTION);
            assert_eq!(calls.len(), 2);
            assert!(Replay::sent_tag(&calls[1]).is_some());
        }
        // A run GitHub does not have is that read's failure, nothing more.
        let gone = source.jobs(REPO, 1).await.unwrap_err();
        assert_eq!(
            (gone.code.as_str(), gone.message.as_str()),
            ("failed", "Not Found (HTTP 404)")
        );
        assert!(source.jobs(REPO, LIVE_RUN).await.is_ok());
    }

    #[tokio::test]
    async fn a_spent_quota_is_told_with_its_reset_and_nothing_more_is_sent_until_then() {
        let replay = Replay::recorded();
        let (source, now) = source(&replay);
        replay.now_says(&jobs_of(LIVE_RUN), PRIMARY_LIMIT);
        let reset = Answer::read(PRIMARY_LIMIT).unwrap().rate.unwrap().reset_at;
        let refused = source.jobs(REPO, LIVE_RUN).await.unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.retry_at),
            ("rate_limited", Some(reset))
        );
        assert_eq!(source.budget().unwrap().remaining, 0);
        let sent = replay.count();
        for _ in 0..50 {
            let held = source.runs(REPO, 0, None).await.unwrap_err();
            assert_eq!(
                (held.code.as_str(), held.retry_at),
                ("rate_limited", Some(reset))
            );
        }
        now.store(reset - 1, Ordering::Relaxed);
        assert!(source.jobs(REPO, DONE_RUN).await.is_err());
        assert_eq!(replay.count(), sent, "held here, not asked of GitHub");
        now.store(reset, Ordering::Relaxed);
        assert!(source.jobs(REPO, DONE_RUN).await.is_ok());
    }

    #[tokio::test]
    async fn a_secondary_limit_pauses_for_as_long_as_github_asks() {
        let replay = Replay::recorded();
        let (source, now) = source(&replay);
        replay.now_says(&jobs_of(DONE_RUN), SECONDARY_LIMIT);
        replay.say(&jobs_of(DONE_RUN), JOBS_COMPLETED);
        let refused = source.jobs(REPO, DONE_RUN).await.unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.retry_at),
            ("rate_limited", Some(T0 + 60_000))
        );
        now.store(T0 + 59_999, Ordering::Relaxed);
        assert!(source.jobs(REPO, DONE_RUN).await.is_err());
        now.store(T0 + 60_000, Ordering::Relaxed);
        assert_eq!(source.jobs(REPO, DONE_RUN).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_allowance_bounds_what_an_hour_of_changing_answers_costs() {
        let replay = Replay::recorded();
        let (source, now) = source(&replay);
        let endpoint = jobs_of(LIVE_RUN);
        let mut charged = 0;
        // A read wanted every 100 ms for an hour, each finding the jobs changed (a `200`, which costs).
        for tick in 0..36_000u64 {
            now.store(T0 + tick * 100, Ordering::Relaxed);
            replay.now_says(
                &endpoint,
                &edited(JOBS_IN_PROGRESS, |body| {
                    body["total_count"] = json!(tick + 6)
                }),
            );
            match source.jobs(REPO, LIVE_RUN).await {
                Ok(_) => charged += 1,
                Err(error) => {
                    assert_eq!(error.code, "rate_limited");
                    assert!(error.retry_at.unwrap() > T0 + tick * 100);
                }
            }
        }
        assert_eq!(charged, PER_HOUR + 60 - 1);
        assert_eq!(
            replay.count() as u64,
            charged,
            "what is held back is never sent"
        );
    }

    #[tokio::test]
    async fn a_gh_that_cannot_ask_is_told_by_its_kind_and_costs_nothing() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let code = |outcome: Result<Vec<GithubJob>, SourceError>| outcome.unwrap_err().code;
        for _ in 0..10_000 {
            replay.fails(Err(Failure::Missing));
            assert_eq!(code(source.jobs(REPO, LIVE_RUN).await), "missing");
            replay.fails(Ok((
                4,
                "gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.",
            )));
            assert_eq!(code(source.jobs(REPO, LIVE_RUN).await), "unauthenticated");
        }
        replay.fails(Ok((
            1,
            "To get started with GitHub CLI, please run:  gh auth login",
        )));
        assert_eq!(code(source.jobs(REPO, LIVE_RUN).await), "unauthenticated");
        replay.fails(Ok((
            1,
            "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
        )));
        let offline = source.jobs(REPO, LIVE_RUN).await.unwrap_err();
        assert_eq!(
            (offline.code.as_str(), offline.message.as_str()),
            ("offline", "error connecting to api.github.com")
        );
        replay.fails(Err(Failure::Broken(
            "api timed out after 30000ms".to_owned(),
        )));
        assert_eq!(code(source.jobs(REPO, LIVE_RUN).await), "offline");
        replay.works();
        assert_eq!(source.jobs(REPO, LIVE_RUN).await.unwrap().len(), 6);
    }

    #[tokio::test]
    async fn an_unreadable_body_keeps_nothing_not_even_its_tag() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let endpoint = jobs_of(DONE_RUN);
        let (head, _) = JOBS_COMPLETED.split_once("\r\n\r\n").unwrap();
        replay.now_says(
            &endpoint,
            &format!("{head}\r\n\r\n{{\"total_count\":2,\"jobs\":[{{\"id\":\"two\"}}]}}"),
        );
        let error = source.jobs(REPO, DONE_RUN).await.unwrap_err();
        assert_eq!(error.code, "failed");
        assert!(source.jobs(REPO, DONE_RUN).await.is_err());
        let calls = locked(&replay.calls);
        assert!(
            calls.iter().all(|call| Replay::sent_tag(call).is_none()),
            "a later 304 must not confirm rows never read"
        );
    }

    #[tokio::test]
    async fn the_writes_are_one_post_each_and_names_are_checked_first() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let accepted = "HTTP/2.0 204 No Content\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4000\r\n\
            X-Ratelimit-Reset: 1794598857\r\nX-Ratelimit-Resource: core\r\n\r\n";
        let base = format!("repos/{REPO}/actions");
        replay.say(&format!("{base}/workflows/ci.yml/dispatches"), "HTTP/2.0 200 OK\r\n\r\n{\"workflow_run_id\":7,\"run_url\":\"https://api.github.com/repos/o/app/actions/runs/7\",\"html_url\":\"https://github.com/o/app/actions/runs/7\"}");
        replay.say(&format!("{base}/runs/7/cancel"), accepted);
        replay.say(&format!("{base}/runs/7/rerun-failed-jobs"), accepted);
        let dispatch = Dispatch {
            repo: REPO.to_owned(),
            workflow: "ci.yml".to_owned(),
            git_ref: "omp/agent/checks-poller".to_owned(),
            inputs: BTreeMap::from([("batch".to_owned(), "true".to_owned())]),
        };
        assert_eq!(source.dispatch(&dispatch).await.unwrap(), 7);
        source.cancel(REPO, 7).await.unwrap();
        source.rerun_failed(REPO, 7).await.unwrap();
        assert_eq!(
            *locked(&replay.calls),
            [
                vec![
                    "api",
                    "--include",
                    "-X",
                    "POST",
                    "-H",
                    "X-GitHub-Api-Version: 2026-03-10",
                    "-f",
                    "ref=omp/agent/checks-poller",
                    "-f",
                    "inputs[batch]=true",
                    "repos/SeuPut0705/ompdesk/actions/workflows/ci.yml/dispatches"
                ],
                vec![
                    "api",
                    "--include",
                    "-X",
                    "POST",
                    "-H",
                    "X-GitHub-Api-Version: 2026-03-10",
                    "repos/SeuPut0705/ompdesk/actions/runs/7/cancel"
                ],
                vec![
                    "api",
                    "--include",
                    "-X",
                    "POST",
                    "-H",
                    "X-GitHub-Api-Version: 2026-03-10",
                    "repos/SeuPut0705/ompdesk/actions/runs/7/rerun-failed-jobs"
                ],
            ]
        );
        // A run that is not there: GitHub's words.
        let missing = source.cancel(REPO, 8).await.unwrap_err();
        assert_eq!(missing.message, "Not Found (HTTP 404)");
        // Nothing is sent for a name that could reach another endpoint.
        let sent = replay.count();
        for repo in ["", "ompdesk", "a/b/c", "a/..", "a/b?x=1", "a b/c"] {
            assert_eq!(
                source.cancel(repo, 7).await.unwrap_err().code,
                "failed",
                "{repo}"
            );
            assert!(source.runs(repo, 0, None).await.is_err(), "{repo}");
        }
        let odd = Dispatch {
            workflow: "../ci.yml".to_owned(),
            ..dispatch
        };
        assert!(source.dispatch(&odd).await.is_err());
        assert!(source.variable(REPO, "MAC REFS").await.is_err());
        assert_eq!(replay.count(), sent);
    }

    #[tokio::test]
    async fn dispatch_acceptance_is_never_inferred_from_a_missing_or_broken_receipt() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let dispatch = Dispatch {
            repo: REPO.into(),
            workflow: "ci.yml".into(),
            git_ref: "feat".into(),
            inputs: BTreeMap::new(),
        };
        let endpoint = format!("repos/{REPO}/actions/workflows/ci.yml/dispatches");
        for response in [
            "HTTP/2.0 204 No Content\r\n\r\n",
            "HTTP/2.0 200 OK\r\n\r\n{\"workflow_run_id\":0}",
            "HTTP/2.0 502 Bad Gateway\r\n\r\n{\"message\":\"upstream response lost\"}",
        ] {
            replay.now_says(&endpoint, response);
            assert!(matches!(
                source.dispatch(&dispatch).await,
                Err(WriteError::Unconfirmed(_))
            ));
        }
        replay.now_says(
            &endpoint,
            "HTTP/2.0 422 Unprocessable Entity\r\n\r\n{\"message\":\"bad ref\"}",
        );
        assert!(matches!(
            source.dispatch(&dispatch).await,
            Err(WriteError::Refused(_))
        ));
        replay.fails(Err(Failure::Broken("response lost after send".into())));
        assert!(matches!(
            source.dispatch(&dispatch).await,
            Err(WriteError::Unconfirmed(_))
        ));
        replay.fails(Err(Failure::Missing));
        assert!(matches!(
            source.dispatch(&dispatch).await,
            Err(WriteError::Refused(_))
        ));
    }

    #[tokio::test]
    async fn a_variable_and_a_head_are_none_when_github_has_none() {
        let replay = Replay::recorded();
        let (source, _) = source(&replay);
        let ok = |body: &str| format!("HTTP/2.0 200 OK\r\nEtag: W/\"v\"\r\n\r\n{body}");
        replay.say(
            &format!("repos/{REPO}/actions/variables/MAC_REFS"),
            &ok("{\"value\":\"main omp/agent/rust-batch-shell\"}"),
        );
        replay.say(
            &format!("repos/{REPO}/commits/omp/agent/checks%20poller"),
            &ok("{\"sha\":\"759386ee3e8a85b60856b2b934e91eb47fc71821\"}"),
        );
        assert_eq!(
            source.variable(REPO, "MAC_REFS").await.unwrap().as_deref(),
            Some("main omp/agent/rust-batch-shell")
        );
        assert_eq!(source.variable(REPO, "RUNNER_LIMITS").await.unwrap(), None);
        assert_eq!(
            source
                .head(REPO, "omp/agent/checks poller")
                .await
                .unwrap()
                .as_deref(),
            Some("759386ee3e8a85b60856b2b934e91eb47fc71821")
        );
        assert_eq!(source.head(REPO, "no-such-branch").await.unwrap(), None);
    }

    #[test]
    fn a_remotes_url_names_its_github_repository() {
        for (url, repo) in [
            ("https://github.com/SeuPut0705/ompdesk.git", Some(REPO)),
            ("https://github.com/SeuPut0705/ompdesk", Some(REPO)),
            ("https://GitHub.com/SeuPut0705/ompdesk/", Some(REPO)),
            ("git@github.com:SeuPut0705/ompdesk.git\n", Some(REPO)),
            ("ssh://git@github.com/SeuPut0705/ompdesk", Some(REPO)),
            ("https://gitlab.com/SeuPut0705/ompdesk.git", None),
            ("https://github.com/SeuPut0705", None),
            ("https://github.com/a/b/c", None),
            ("/Users/x/ompdesk", None),
            ("", None),
        ] {
            assert_eq!(github_repo_of(url).as_deref(), repo, "{url}");
        }
    }

    /// gh for real, as far as a stand-in goes: the runner main handed over, its output read as an answer.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_persons_gh_is_run_with_the_asks_arguments() {
        // Prints the recorded answer of the endpoint it was asked, named by its last argument; a token in its
        // environment shows in its words, as gh's own error could carry one.
        let script = r#"for last; do :; done
case "$last" in
  */jobs*) cat "$FIXTURES/jobs-completed.http" ;;
  *) echo "error connecting to api.github.com as $GH_TOKEN" >&2; exit 1 ;;
esac"#;
        let gh = Runner {
            bin: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned(), "gh".to_owned()],
            env: BTreeMap::from([
                ("PATH".to_owned(), "/bin:/usr/bin".to_owned()),
                ("GH_TOKEN".to_owned(), "ghp_0123456789abcdef".to_owned()),
                (
                    "FIXTURES".to_owned(),
                    concat!(env!("CARGO_MANIFEST_DIR"), "/src/checks/fixtures").to_owned(),
                ),
            ]),
            timeout_ms: 10_000,
            max_bytes: 1 << 20,
        };
        let tools = Arc::new(Tools::default());
        let cli = GhCli {
            tools: Arc::clone(&tools),
        };
        // On a clock of its own: the process-wide one may be another test's manual clock.
        let source = GhSource::at(Arc::new(cli), Some(Arc::clone(&tools)), || T0);
        // Before main said how gh runs: nothing is run, and nothing is charged.
        let early = source.jobs(REPO, DONE_RUN).await.unwrap_err();
        assert_eq!(early.code, "offline");
        tools.set(Runners {
            gh: Some(gh),
            git: None,
            home: "/".to_owned(),
        });
        let jobs = source.jobs(REPO, DONE_RUN).await.unwrap();
        assert_eq!(
            jobs.iter()
                .map(|job| (job.name.as_str(), job.attempt))
                .collect::<Vec<_>>(),
            [("formal", 1), ("publish", 1)]
        );
        let offline = source.runs(REPO, 0, None).await.unwrap_err();
        assert_eq!(
            (offline.code.as_str(), offline.message.as_str()),
            ("offline", "error connecting to api.github.com as ***")
        );
        let no_git = source.checkout("/").await.unwrap_err();
        assert_eq!(no_git.code, "missing");
    }
}
