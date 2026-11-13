//! One `gh api --include` answer: the status line, the headers the source acts on, and the body as typed rows.
//!
//! gh prints the response head and then the body. With `--jq` the body of a `200` is the projection below (a run
//! object is about 13 KiB as GitHub sends it, most of it two copies of the repository), an error's body passes as
//! GitHub sent it, and a `304` has none. gh exits non-zero for every status but 2xx (and words a `304` as
//! `unexpected end of JSON input` under `--jq`), so the status is read from what it printed, never from its exit.

use serde::{Deserialize, Deserializer};

use crate::care::date_parse;
use crate::checks::contract::{Os, Timestamp};
use crate::checks::sources::{GithubArtifact, GithubJob, GithubRun, GithubStep};
use crate::json::whole_surrogates;

/// The fields of a workflow run the source keeps.
pub const RUN_PROJECTION: &str = "{id, name, display_title, status, conclusion, event, head_branch, head_sha, \
    run_attempt, path, created_at, updated_at, actor: .actor.login, triggering_actor: .triggering_actor.login}";

/// `--jq` for a list of runs.
pub fn runs_projection() -> String {
    format!("{{total_count, workflow_runs: [.workflow_runs[] | {RUN_PROJECTION}]}}")
}

/// `--jq` for a run's jobs. A step keeps its name and how it ended: the rest of a step is most of the answer.
pub const JOBS_PROJECTION: &str = "{total_count, jobs: [.jobs[] | {id, run_id, run_attempt, name, status, \
    conclusion, created_at, started_at, completed_at, labels, steps: [(.steps // [])[] | {name, conclusion}]}]}";

/// `--jq` for a run's artifacts.
pub const ARTIFACTS_PROJECTION: &str =
    "{total_count, artifacts: [.artifacts[] | {id, name, size_in_bytes, expired, created_at}]}";

/// The account's primary rate limit as an answer's headers gave it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    pub limit: u32,
    pub remaining: u32,
    /// When `remaining` goes back to `limit`.
    pub reset_at: Timestamp,
}

/// What GitHub answered one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    /// The entity tag as GitHub wrote it, quotes and `W/` included.
    pub etag: Option<String>,
    pub rate: Option<Rate>,
    /// `retry-after`, in seconds.
    pub retry_after: Option<u64>,
    pub body: String,
}

impl Answer {
    /// Reads what `gh api --include` printed; none when it printed no response head (gh never reached GitHub).
    pub fn read(stdout: &str) -> Option<Answer> {
        let (head, body) = ["\r\n\r\n", "\n\n"]
            .iter()
            .filter_map(|blank| {
                stdout
                    .find(blank)
                    .map(|at| (at, &stdout[..at], &stdout[at + blank.len()..]))
            })
            .min_by_key(|(at, ..)| *at)
            .map_or((stdout, ""), |(_, head, body)| (head, body));
        let mut lines = head.lines();
        let mut status_line = lines.next()?.split(' ');
        if !status_line.next()?.starts_with("HTTP/") {
            return None;
        }
        let status = status_line.next()?.parse().ok()?;
        let mut answer = Answer {
            status,
            etag: None,
            rate: None,
            retry_after: None,
            body: body.to_owned(),
        };
        let (mut limit, mut remaining, mut reset, mut core) = (None, None, None::<u64>, true);
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match name.trim().to_ascii_lowercase().as_str() {
                "etag" => answer.etag = Some(value.to_owned()),
                "retry-after" => answer.retry_after = value.parse().ok(),
                "x-ratelimit-limit" => limit = value.parse().ok(),
                "x-ratelimit-remaining" => remaining = value.parse().ok(),
                "x-ratelimit-reset" => reset = value.parse().ok(),
                // Another resource's numbers (search, graphql) say nothing of the quota these requests draw on.
                "x-ratelimit-resource" => core = value == "core",
                _ => {}
            }
        }
        if let (true, Some(limit), Some(remaining), Some(reset)) = (core, limit, remaining, reset) {
            answer.rate = Some(Rate {
                limit,
                remaining,
                reset_at: reset.saturating_mul(1000),
            });
        }
        Some(answer)
    }

    /// GitHub's `message` of an error's body, when it has one.
    pub fn message(&self) -> Option<String> {
        #[derive(Deserialize)]
        struct Problem {
            message: String,
        }
        serde_json::from_str::<Problem>(&self.body)
            .ok()
            .map(|problem| problem.message)
    }

    /// GitHub refuses for a rate limit: the quota is spent (`403` with nothing remaining), or it asks for a pause
    /// (`429`, or a `403` with `retry-after` or its words for a secondary limit).
    pub fn limited(&self) -> bool {
        self.status == 429
            || (self.status == 403
                && (self.retry_after.is_some()
                    || self.rate.is_some_and(|rate| rate.remaining == 0)
                    || self.message().is_some_and(|message| {
                        message.to_ascii_lowercase().contains("rate limit")
                    })))
    }
}

/// A body as `T`, in serde's words when it is another shape.
pub fn rows<'a, T: Deserialize<'a>>(body: &'a str) -> Result<T, String> {
    // serde_json refuses half a surrogate pair, which a title may hold.
    match whole_surrogates(body) {
        std::borrow::Cow::Borrowed(text) => serde_json::from_str(text).map_err(|e| e.to_string()),
        std::borrow::Cow::Owned(_) => Err("half a surrogate pair in GitHub's answer".to_owned()),
    }
}

fn instant<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Timestamp, D::Error> {
    let text = String::deserialize(deserializer)?;
    parse_instant(&text).ok_or_else(|| serde::de::Error::custom(format!("not a time: {text}")))
}

fn optional_instant<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Timestamp>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        None => Ok(None),
        Some(text) => parse_instant(&text)
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom(format!("not a time: {text}"))),
    }
}

fn parse_instant(text: &str) -> Option<Timestamp> {
    date_parse(text).and_then(|ms| Timestamp::try_from(ms).ok())
}

/// One workflow run as GitHub lists it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct RunRow {
    pub id: u64,
    pub name: Option<String>,
    pub display_title: Option<String>,
    pub status: String,
    pub conclusion: Option<String>,
    pub event: String,
    pub head_branch: Option<String>,
    pub head_sha: String,
    pub run_attempt: u32,
    /// The workflow's file, `.github/workflows/ci.yml`.
    pub path: String,
    #[serde(deserialize_with = "instant")]
    pub created_at: Timestamp,
    #[serde(deserialize_with = "instant")]
    pub updated_at: Timestamp,
    pub actor: Option<String>,
    pub triggering_actor: Option<String>,
}

impl RunRow {
    /// Not finished yet. A word GitHub adds later is not taken for finished.
    pub fn active(&self) -> bool {
        self.status != "completed"
    }

    /// Whether this row says more than `known` of the same run: a later attempt, else a later change, else the end.
    pub fn newer_than(&self, known: &RunRow) -> bool {
        (self.run_attempt, self.updated_at, !self.active())
            > (known.run_attempt, known.updated_at, !known.active())
    }

    pub fn into_run(self) -> GithubRun {
        GithubRun {
            id: self.id,
            workflow: self.path.rsplit('/').next().unwrap_or_default().to_owned(),
            title: self.display_title.or(self.name).unwrap_or_default(),
            branch: self.head_branch.unwrap_or_default(),
            sha: self.head_sha,
            event: self.event,
            status: self.status,
            conclusion: self.conclusion,
            attempt: self.run_attempt,
            actor: self.triggering_actor.or(self.actor).unwrap_or_default(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Deserialize)]
pub struct RunsPage {
    pub total_count: u64,
    pub workflow_runs: Vec<RunRow>,
}

#[derive(Deserialize)]
struct StepRow {
    name: String,
    conclusion: Option<String>,
}

/// One job of a run as GitHub lists it.
#[derive(Deserialize)]
pub struct JobRow {
    id: u64,
    run_id: u64,
    run_attempt: u32,
    name: String,
    status: String,
    conclusion: Option<String>,
    #[serde(deserialize_with = "instant")]
    created_at: Timestamp,
    #[serde(default, deserialize_with = "optional_instant")]
    started_at: Option<Timestamp>,
    #[serde(default, deserialize_with = "optional_instant")]
    completed_at: Option<Timestamp>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    steps: Vec<StepRow>,
}

impl JobRow {
    pub fn into_job(self) -> GithubJob {
        GithubJob {
            id: self.id,
            run: self.run_id,
            attempt: self.run_attempt,
            name: self.name,
            status: self.status,
            conclusion: self.conclusion,
            labels: self.labels,
            created_at: self.created_at,
            started_at: self.started_at,
            completed_at: self.completed_at,
            steps: self
                .steps
                .into_iter()
                .map(|step| GithubStep {
                    name: step.name,
                    conclusion: step.conclusion,
                })
                .collect(),
        }
    }
}

#[derive(Deserialize)]
pub struct JobsPage {
    pub total_count: u64,
    pub jobs: Vec<JobRow>,
}

/// A file a run uploaded, as GitHub lists it.
#[derive(Deserialize)]
pub struct ArtifactRow {
    id: u64,
    name: String,
    size_in_bytes: u64,
    expired: bool,
    #[serde(deserialize_with = "instant")]
    created_at: Timestamp,
}

impl ArtifactRow {
    pub fn into_artifact(self) -> GithubArtifact {
        GithubArtifact {
            id: self.id,
            name: self.name,
            size_bytes: self.size_in_bytes,
            expired: self.expired,
            created_at: self.created_at,
        }
    }
}

/// Whose machine a job takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Runner {
    /// One of GitHub's own, which counts against the account's limits.
    Hosted(Os),
    /// The repository's own runner: no account limit applies.
    SelfHosted,
    /// A label this code does not know (a larger runner's custom name), or none yet.
    Unknown,
}

/// Read from `runs-on`: GitHub's images are named `ubuntu-…`, `windows-…` and `macos-…`.
pub fn runner_of(labels: &[String]) -> Runner {
    let lower = || labels.iter().map(|label| label.to_ascii_lowercase());
    if lower().any(|label| label == "self-hosted") {
        return Runner::SelfHosted;
    }
    lower()
        .find_map(|label| {
            [
                ("macos", Os::Macos),
                ("windows", Os::Windows),
                ("ubuntu", Os::Linux),
            ]
            .into_iter()
            .find(|(prefix, _)| label.starts_with(prefix))
            .map(|(_, os)| Runner::Hosted(os))
        })
        .unwrap_or(Runner::Unknown)
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Answers recorded from `SeuPut0705/ompdesk` (public) on 13 Nov 2026 with gh 2.104.0, each the stdout of
    //! `gh api --include --jq <projection> <endpoint>` as printed, less four header lines that describe the
    //! recording account's token rather than the answer (`x-oauth-scopes`, `x-accepted-oauth-scopes`,
    //! `x-oauth-client-id`, `x-github-request-id`). The projection then kept a few fields more than today's and no
    //! steps. `primary-limit.http` and `secondary-limit.http` are not recordings: they are written from GitHub's
    //! documented answers, because recording one means exhausting the account's quota.

    pub const RUNS_IN_PROGRESS: &str = include_str!("../fixtures/runs-in-progress.http");
    pub const RUNS_QUEUED: &str = include_str!("../fixtures/runs-queued.http");
    pub const RUNS_RECENT: &str = include_str!("../fixtures/runs-recent.http");
    pub const RUN_COMPLETED: &str = include_str!("../fixtures/run-completed.http");
    pub const JOBS_IN_PROGRESS: &str = include_str!("../fixtures/jobs-in-progress.http");
    pub const JOBS_COMPLETED: &str = include_str!("../fixtures/jobs-completed.http");
    pub const JOBS_NOT_MODIFIED: &str = include_str!("../fixtures/jobs-not-modified.http");
    pub const NOT_FOUND: &str = include_str!("../fixtures/not-found.http");
    pub const PRIMARY_LIMIT: &str = include_str!("../fixtures/primary-limit.http");
    pub const SECONDARY_LIMIT: &str = include_str!("../fixtures/secondary-limit.http");

    /// The run `jobs-in-progress.http` belongs to, which `runs-in-progress.http` lists.
    pub const LIVE_RUN: u64 = 43_485_676_714;
    /// The run of `run-completed.http` and `jobs-completed.http`.
    pub const DONE_RUN: u64 = 43_485_704_044;
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn read(recorded: &str) -> Answer {
        Answer::read(recorded).expect("a response head")
    }

    #[test]
    fn a_recorded_list_reads_as_its_status_tag_quota_and_rows() {
        let answer = read(RUNS_IN_PROGRESS);
        assert_eq!(answer.status, 200);
        let etag = answer.etag.as_deref().expect("an entity tag");
        assert!(etag.starts_with("W/\"") && etag.ends_with('"'), "{etag}");
        let rate = answer.rate.expect("the quota headers");
        assert_eq!(rate.limit, 5000);
        assert!(rate.remaining < 5000);
        assert_eq!(rate.reset_at, 1_794_598_857_000);
        let page: RunsPage = rows(&answer.body).unwrap();
        assert_eq!(page.total_count, 10);
        assert_eq!(page.workflow_runs.len(), 10);
        assert!(
            page.workflow_runs
                .iter()
                .all(|run| run.status == "in_progress" && run.conclusion.is_none() && run.active())
        );
        let run = page.workflow_runs.into_iter().next().unwrap().into_run();
        assert!(run.created_at <= run.updated_at);
        assert_eq!(run.actor, "SeuPut0705");
        assert!(run.workflow.ends_with(".yml") && !run.workflow.contains('/'));
        assert!(!run.title.is_empty() && !run.branch.is_empty());
    }

    #[test]
    fn a_not_modified_answer_has_no_body_and_spent_nothing() {
        let first = read(JOBS_COMPLETED);
        let again = read(JOBS_NOT_MODIFIED);
        assert_eq!(again.status, 304);
        assert_eq!(again.body, "");
        // The two were recorded back to back: the conditional request left the quota where it was.
        assert_eq!(again.rate.unwrap().remaining, first.rate.unwrap().remaining);
        // GitHub answers with the strong form of the tag it was sent in the weak form.
        let sent = first.etag.unwrap();
        assert_eq!(
            again.etag.unwrap(),
            sent.strip_prefix("W/").expect("a weak tag")
        );
    }

    #[test]
    fn a_job_names_the_runner_it_takes() {
        let page: JobsPage = rows(&read(JOBS_IN_PROGRESS).body).unwrap();
        assert_eq!(page.total_count as usize, page.jobs.len());
        let jobs: Vec<GithubJob> = page.jobs.into_iter().map(JobRow::into_job).collect();
        let on = |os| {
            jobs.iter()
                .filter(|job| runner_of(&job.labels) == Runner::Hosted(os))
                .count()
        };
        assert_eq!((on(Os::Macos), on(Os::Windows), on(Os::Linux)), (3, 2, 1));
        let running: Vec<_> = jobs
            .iter()
            .filter(|job| job.status == "in_progress")
            .map(|job| runner_of(&job.labels))
            .collect();
        assert_eq!(
            running,
            [Runner::Hosted(Os::Windows), Runner::Hosted(Os::Macos)]
        );
        assert!(
            jobs.iter()
                .filter(|job| job.status == "in_progress")
                .all(|job| job.run == LIVE_RUN
                    && job.started_at.is_some()
                    && job.completed_at.is_none())
        );
        let labelled = |labels: &[&str]| {
            runner_of(
                &labels
                    .iter()
                    .map(|label| (*label).to_owned())
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(
            labelled(&["self-hosted", "macOS", "ARM64"]),
            Runner::SelfHosted
        );
        assert_eq!(labelled(&[]), Runner::Unknown);
        assert_eq!(labelled(&["big-box-16"]), Runner::Unknown);
    }

    #[test]
    fn an_error_keeps_its_status_and_githubs_words() {
        let missing = read(NOT_FOUND);
        assert_eq!(missing.status, 404);
        assert_eq!(missing.message().as_deref(), Some("Not Found"));
        assert!(missing.rate.is_some() && !missing.limited());

        let spent = read(PRIMARY_LIMIT);
        assert_eq!((spent.status, spent.rate.unwrap().remaining), (403, 0));
        assert!(spent.limited());

        let slow_down = read(SECONDARY_LIMIT);
        assert_eq!((slow_down.status, slow_down.retry_after), (403, Some(60)));
        assert!(slow_down.limited());
    }

    #[test]
    fn what_is_no_response_head_is_no_answer() {
        // gh's own words when it never reached GitHub go to stderr; stdout is empty.
        assert_eq!(Answer::read(""), None);
        assert_eq!(Answer::read("{\"total_count\":0}"), None);
        assert_eq!(Answer::read("HTTP/2.0 abc OK\r\n\r\n"), None);
        // LF alone, and a head with no blank line after it.
        let bare = Answer::read("HTTP/1.1 304 Not Modified\nEtag: \"a\"\n\n").unwrap();
        assert_eq!((bare.status, bare.etag.as_deref()), (304, Some("\"a\"")));
        assert_eq!(
            Answer::read("HTTP/2.0 502 Bad Gateway").unwrap().status,
            502
        );
    }

    #[test]
    fn another_resources_quota_is_not_this_ones() {
        let search = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 30\r\nX-Ratelimit-Remaining: 0\r\n\
            X-Ratelimit-Reset: 1794598857\r\nX-Ratelimit-Resource: search\r\n\r\n{}";
        assert_eq!(Answer::read(search).unwrap().rate, None);
    }

    #[test]
    fn a_row_says_more_by_attempt_then_by_time_then_by_having_ended() {
        let known: RunRow = rows(&read(RUN_COMPLETED).body).unwrap();
        assert_eq!(known.id, DONE_RUN);
        assert!(!known.active() && !known.newer_than(&known));
        let with = |change: &dyn Fn(&mut RunRow)| {
            let mut row = known.clone();
            change(&mut row);
            row
        };
        let earlier = with(&|row| {
            row.status = "in_progress".to_owned();
            row.updated_at -= 1_000;
        });
        assert!(known.newer_than(&earlier) && !earlier.newer_than(&known));
        // The same moment told two ways: the end is the later word.
        let same_time = with(&|row| row.status = "in_progress".to_owned());
        assert!(known.newer_than(&same_time) && !same_time.newer_than(&known));
        // Run again: unfinished, and newer whatever its time.
        let rerun = with(&|row| {
            row.status = "queued".to_owned();
            row.run_attempt = 2;
            row.updated_at -= 1_000;
        });
        assert!(rerun.newer_than(&known));
        // A status word this code has never seen is not an end.
        assert!(with(&|row| row.status = "paused_for_review".to_owned()).active());
    }
}
