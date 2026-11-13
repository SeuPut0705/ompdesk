//! The hub's two fact adapters, each a trait at a real seam with a fake for tests (`docs/design/check-control.md` §4).
//! The shapes here are the sources' own facts, as GitHub's REST and this computer's journals give them; the hub turns
//! them into the contract's `Pool`, `Run` and `Answer`. Nothing here decides anything.
//!
//! - `GithubSource`: runs, jobs and logs of a repo's workflows, and the four writes a policy may make (dispatch,
//!   cancel, rerun the failed jobs, nothing else). One poller reads through it for every session.
//! - `LocalSource`: each computer's heavy slots and disk (`ompdesk heavy status --json`, a paired one over the link)
//!   and the `ompdesk check` journals with their flaky record.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::contract::{DeviceId, InputsDigest, Os, RepoId, Sha, Timestamp};
use super::hub::Fut;

/// A source that could not answer: the hub then shows what it had as `stale` and says so, never as fresh.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    /// `missing` (no gh, no binary), `unauthenticated`, `rate_limited`, `offline`, `failed`.
    pub code: String,
    pub message: String,
    /// For `rate_limited`: when the limit resets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<Timestamp>,
}

impl SourceError {
    pub fn new(code: &str, message: impl Into<String>) -> SourceError {
        SourceError {
            code: code.to_owned(),
            message: message.into(),
            retry_at: None,
        }
    }
}

/// A conditional read: the value, or the word that nothing changed since the mark the caller gave.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Read<T> {
    Fresh {
        value: T,
        /// What to hand back on the next read (an ETag).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mark: Option<String>,
    },
    Unchanged,
}

/// What is left of the hour's requests, as the last answer's headers said.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub limit: u32,
    pub remaining: u32,
    pub reset_at: Timestamp,
}

/// A workflow run as GitHub lists it (`actions/runs`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRun {
    pub id: u64,
    /// The workflow's file name (`ci.yml`).
    pub workflow: String,
    /// `display_title`: a dispatch's carries its inputs (`ci [batch ]`).
    pub title: String,
    pub branch: String,
    pub sha: Sha,
    /// `push`, `pull_request`, `workflow_dispatch`, `schedule`, …
    pub event: String,
    /// `queued`, `in_progress`, `completed`, `pending`, `waiting`, `requested`.
    pub status: String,
    /// `success`, `failure`, `cancelled`, `timed_out`, `skipped`, …; None until it completed.
    pub conclusion: Option<String>,
    pub attempt: u32,
    /// The login that triggered it.
    pub actor: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStep {
    pub name: String,
    pub conclusion: Option<String>,
}

/// A job of a run (`actions/runs/<id>/jobs`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubJob {
    pub id: u64,
    pub run: u64,
    pub name: String,
    /// GitHub's `run_attempt` of the job: one not run again in a rerun keeps the earlier attempt's number.
    pub attempt: u32,
    pub status: String,
    pub conclusion: Option<String>,
    /// The runner labels (`macos-15`, `ubuntu-latest`); empty while a concurrency group holds the job back.
    pub labels: Vec<String>,
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub completed_at: Option<Timestamp>,
    pub steps: Vec<GithubStep>,
}

/// A file a run uploaded (`actions/runs/<id>/artifacts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubArtifact {
    pub id: u64,
    pub name: String,
    pub size_bytes: u64,
    pub expired: bool,
    pub created_at: Timestamp,
}

/// A workflow dispatch. `inputs` carry the admission ticket once the workflows ask for one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub repo: RepoId,
    pub workflow: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub inputs: BTreeMap<String, String>,
}

pub trait GithubSource: Send + Sync {
    /// The repo's runs that are not completed plus those updated since `since`, newest first.
    fn runs<'a>(
        &'a self,
        repo: &'a str,
        since: Timestamp,
        mark: Option<&'a str>,
    ) -> Fut<'a, Result<Read<Vec<GithubRun>>, SourceError>>;

    fn jobs<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<Vec<GithubJob>, SourceError>>;

    /// A finished job's log as text (GitHub serves it while the run still goes).
    fn job_log<'a>(&'a self, repo: &'a str, job: u64) -> Fut<'a, Result<String, SourceError>>;

    /// A repository variable (`MAC_REFS`); None when it is not set.
    fn variable<'a>(
        &'a self,
        repo: &'a str,
        name: &'a str,
    ) -> Fut<'a, Result<Option<String>, SourceError>>;

    /// The head commit of `git_ref`; None when it is not pushed.
    fn head<'a>(
        &'a self,
        repo: &'a str,
        git_ref: &'a str,
    ) -> Fut<'a, Result<Option<Sha>, SourceError>>;

    /// The repo the folder's checkout pushes to and its current branch; None outside a GitHub checkout.
    fn checkout<'a>(&'a self, cwd: &'a str) -> Fut<'a, Result<Option<Checkout>, SourceError>>;

    fn dispatch<'a>(&'a self, dispatch: &'a Dispatch) -> Fut<'a, Result<(), SourceError>>;

    fn cancel<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<(), SourceError>>;

    fn rerun_failed<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<(), SourceError>>;

    /// None before the first answer.
    fn budget(&self) -> Option<Budget>;

    /// The run's artifacts (the test reports a workflow uploads).
    fn artifacts<'a>(
        &'a self,
        repo: &'a str,
        run: u64,
    ) -> Fut<'a, Result<Vec<GithubArtifact>, SourceError>>;

    /// One artifact's zip, as GitHub serves it.
    fn artifact<'a>(&'a self, repo: &'a str, id: u64) -> Fut<'a, Result<Vec<u8>, SourceError>>;

    /// Whether the repo is private (placement: a private repo goes local first, a public one to runners).
    fn is_private<'a>(&'a self, repo: &'a str) -> Fut<'a, Result<bool, SourceError>>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    pub repo: RepoId,
    pub branch: String,
    pub sha: Sha,
}

/// A volume heavy work writes to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVolume {
    pub path: String,
    pub free_gb: f64,
    pub total_gb: f64,
    /// Under `min_free`: no heavy work starts on it.
    pub low: bool,
}

/// A computer's heavy pool (`ompdesk heavy status --json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPool {
    pub device: DeviceId,
    pub os: Os,
    pub slots: u32,
    pub held: u32,
    pub queued: u32,
    pub oldest_wait_ms: u64,
    pub volumes: Vec<LocalVolume>,
    pub as_of: Timestamp,
    /// The paired link to that computer is lost: zero capacity, shown as `offline`, never as empty.
    pub offline: bool,
    /// The size of that computer's check store (`<cache>/ompdesk/checks`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_store_bytes: Option<u64>,
    /// Heavy work there that holds none of its slots; an older computer's answer has none.
    #[serde(default)]
    pub foreign: Vec<super::contract::ForeignLoad>,
}

/// One `ompdesk check` run, from its journal (`<cache>/ompdesk/checks/runs/<id>/run.json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRun {
    pub id: String,
    pub device: DeviceId,
    pub cwd: String,
    pub argv: Vec<String>,
    /// `starting`, `waiting`, `running`, `passed`, `failed`, `cancelled`, `killed`, `error`.
    pub state: String,
    pub started: Timestamp,
    pub ended: Option<Timestamp>,
    pub head: Option<Sha>,
    pub digest: InputsDigest,
    pub failed: Vec<String>,
    pub flaky: Vec<String>,
    pub saved_ms: u64,
    /// The session whose omp started it (`OMP_GUI_SESSION_TAG`), when one did.
    pub session_tag: Option<String>,
}

/// A test's flaky record of one check (`flaky/<check key>.json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFlaky {
    pub check: String,
    pub name: String,
    pub passed: u32,
    pub failed: u32,
    pub quarantined: bool,
    /// Passes in a row on different inputs, of the 5 that clear it.
    pub streak: u32,
}

pub trait LocalSource: Send + Sync {
    /// This computer's pool and each paired computer's.
    fn pools(&self) -> Fut<'_, Result<Vec<LocalPool>, SourceError>>;

    /// The check runs still going and those ended since `since`.
    fn runs(&self, since: Timestamp) -> Fut<'_, Result<Vec<LocalRun>, SourceError>>;

    fn flaky(&self) -> Fut<'_, Result<Vec<LocalFlaky>, SourceError>>;
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a `FakeGithub` was asked to change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GithubWrite {
    Dispatch(Dispatch),
    Cancel { repo: RepoId, run: u64 },
    RerunFailed { repo: RepoId, run: u64 },
}

/// What a `FakeGithub` answers; a test sets the fields it needs (`with`).
#[derive(Clone, Debug, Default)]
pub struct GithubFacts {
    pub runs: Vec<(RepoId, GithubRun)>,
    pub jobs: Vec<GithubJob>,
    /// By job id.
    pub logs: BTreeMap<u64, String>,
    /// By `repo\nname`.
    pub variables: BTreeMap<String, String>,
    /// By `repo\nref`.
    pub heads: BTreeMap<String, Sha>,
    /// By folder.
    pub checkouts: BTreeMap<String, Checkout>,
    pub budget: Option<Budget>,
    /// By run id.
    pub artifacts: Vec<(u64, GithubArtifact)>,
    /// An artifact's zip, by its id.
    pub archives: BTreeMap<u64, Vec<u8>>,
    /// The private repos; every other is public.
    pub private: Vec<RepoId>,
    /// Every read and write fails with this while it is set.
    pub down: Option<SourceError>,
}

/// GitHub in memory: it answers its facts as they are and records every write and how many reads were made.
#[derive(Default)]
pub struct FakeGithub {
    facts: Mutex<GithubFacts>,
    writes: Mutex<Vec<GithubWrite>>,
    reads: Mutex<u64>,
}

impl FakeGithub {
    pub fn with<T>(&self, change: impl FnOnce(&mut GithubFacts) -> T) -> T {
        change(&mut locked(&self.facts))
    }

    pub fn writes(&self) -> Vec<GithubWrite> {
        locked(&self.writes).clone()
    }

    /// How many requests it was sent: what a budget test counts.
    pub fn reads(&self) -> u64 {
        *locked(&self.reads)
    }

    fn read<T>(&self, answer: impl FnOnce(&GithubFacts) -> T) -> Result<T, SourceError> {
        *locked(&self.reads) += 1;
        let facts = locked(&self.facts);
        match &facts.down {
            Some(error) => Err(error.clone()),
            None => Ok(answer(&facts)),
        }
    }

    fn write(&self, write: GithubWrite) -> Result<(), SourceError> {
        self.read(|_| ())?;
        locked(&self.writes).push(write);
        Ok(())
    }
}

impl GithubSource for FakeGithub {
    fn runs<'a>(
        &'a self,
        repo: &'a str,
        since: Timestamp,
        _mark: Option<&'a str>,
    ) -> Fut<'a, Result<Read<Vec<GithubRun>>, SourceError>> {
        Box::pin(async move {
            self.read(|facts| Read::Fresh {
                value: facts
                    .runs
                    .iter()
                    .filter(|(of, run)| {
                        of == repo && (run.status != "completed" || run.updated_at >= since)
                    })
                    .map(|(_, run)| run.clone())
                    .collect(),
                mark: None,
            })
        })
    }

    fn jobs<'a>(
        &'a self,
        _repo: &'a str,
        run: u64,
    ) -> Fut<'a, Result<Vec<GithubJob>, SourceError>> {
        Box::pin(async move {
            self.read(|facts| {
                facts
                    .jobs
                    .iter()
                    .filter(|job| job.run == run)
                    .cloned()
                    .collect()
            })
        })
    }

    fn job_log<'a>(&'a self, _repo: &'a str, job: u64) -> Fut<'a, Result<String, SourceError>> {
        Box::pin(
            async move { self.read(|facts| facts.logs.get(&job).cloned().unwrap_or_default()) },
        )
    }

    fn variable<'a>(
        &'a self,
        repo: &'a str,
        name: &'a str,
    ) -> Fut<'a, Result<Option<String>, SourceError>> {
        Box::pin(async move {
            self.read(|facts| facts.variables.get(&format!("{repo}\n{name}")).cloned())
        })
    }

    fn head<'a>(
        &'a self,
        repo: &'a str,
        git_ref: &'a str,
    ) -> Fut<'a, Result<Option<Sha>, SourceError>> {
        Box::pin(async move {
            self.read(|facts| facts.heads.get(&format!("{repo}\n{git_ref}")).cloned())
        })
    }

    fn checkout<'a>(&'a self, cwd: &'a str) -> Fut<'a, Result<Option<Checkout>, SourceError>> {
        Box::pin(async move { self.read(|facts| facts.checkouts.get(cwd).cloned()) })
    }

    fn dispatch<'a>(&'a self, dispatch: &'a Dispatch) -> Fut<'a, Result<(), SourceError>> {
        Box::pin(async move { self.write(GithubWrite::Dispatch(dispatch.clone())) })
    }

    fn cancel<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<(), SourceError>> {
        Box::pin(async move {
            self.write(GithubWrite::Cancel {
                repo: repo.to_owned(),
                run,
            })
        })
    }

    fn rerun_failed<'a>(&'a self, repo: &'a str, run: u64) -> Fut<'a, Result<(), SourceError>> {
        Box::pin(async move {
            self.write(GithubWrite::RerunFailed {
                repo: repo.to_owned(),
                run,
            })
        })
    }

    fn budget(&self) -> Option<Budget> {
        locked(&self.facts).budget
    }

    fn artifacts<'a>(
        &'a self,
        _repo: &'a str,
        run: u64,
    ) -> Fut<'a, Result<Vec<GithubArtifact>, SourceError>> {
        Box::pin(async move {
            self.read(|facts| {
                facts
                    .artifacts
                    .iter()
                    .filter(|(of, _)| *of == run)
                    .map(|(_, artifact)| artifact.clone())
                    .collect()
            })
        })
    }

    fn artifact<'a>(&'a self, _repo: &'a str, id: u64) -> Fut<'a, Result<Vec<u8>, SourceError>> {
        Box::pin(async move {
            self.read(|facts| facts.archives.get(&id).cloned())?
                .ok_or_else(|| SourceError::new("failed", format!("no artifact {id}")))
        })
    }

    fn is_private<'a>(&'a self, repo: &'a str) -> Fut<'a, Result<bool, SourceError>> {
        Box::pin(async move { self.read(|facts| facts.private.iter().any(|of| of == repo)) })
    }
}

/// What a `FakeLocal` answers.
#[derive(Clone, Debug, Default)]
pub struct LocalFacts {
    pub pools: Vec<LocalPool>,
    pub runs: Vec<LocalRun>,
    pub flaky: Vec<LocalFlaky>,
    pub down: Option<SourceError>,
}

/// The computers' pools and journals in memory.
#[derive(Default)]
pub struct FakeLocal {
    facts: Mutex<LocalFacts>,
}

impl FakeLocal {
    pub fn with<T>(&self, change: impl FnOnce(&mut LocalFacts) -> T) -> T {
        change(&mut locked(&self.facts))
    }

    fn read<T>(&self, answer: impl FnOnce(&LocalFacts) -> T) -> Result<T, SourceError> {
        let facts = locked(&self.facts);
        match &facts.down {
            Some(error) => Err(error.clone()),
            None => Ok(answer(&facts)),
        }
    }
}

impl LocalSource for FakeLocal {
    fn pools(&self) -> Fut<'_, Result<Vec<LocalPool>, SourceError>> {
        Box::pin(async move { self.read(|facts| facts.pools.clone()) })
    }

    fn runs(&self, since: Timestamp) -> Fut<'_, Result<Vec<LocalRun>, SourceError>> {
        Box::pin(async move {
            self.read(|facts| {
                facts
                    .runs
                    .iter()
                    .filter(|run| run.ended.is_none_or(|ended| ended >= since))
                    .cloned()
                    .collect()
            })
        })
    }

    fn flaky(&self) -> Fut<'_, Result<Vec<LocalFlaky>, SourceError>> {
        Box::pin(async move { self.read(|facts| facts.flaky.clone()) })
    }
}
