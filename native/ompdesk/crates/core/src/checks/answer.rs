//! A run's result as an agent reads it (design §3 `Answer`, §7 criterion 3): green or red under the flaky quarantine,
//! the failed tests with their first error, whether each is known flaky, whether it blocks a release gate, the reruns
//! left and what to do next. Never green from old data: an answer the poller cannot confirm is `unknown`.
//!
//! `fetch` reads what a completed run left (its jobs and their test reports) once; `judge` takes it into the
//! repository's ledger (`results::take_in`, P4's) and writes the `Answer`. The hub keeps the first answer per run.

use std::collections::BTreeMap;

use super::contract::{
    Answer, AnswerVerdict, BlocksRelease, Counts, GateId, Next, Origin, Reused, RunId, RunVerdict,
    Timestamp,
};
use super::results::ledger::Ledger;
use super::results::reports::Case;
use super::results::{self, Finished, JobFacts};
use super::sources::{GithubJob, GithubRun, GithubSource, SourceError};

/// What a completed GitHub run left, read once.
pub struct Fetched {
    pub run: GithubRun,
    pub jobs: Vec<GithubJob>,
    /// A job's test report, by job id.
    pub cases: BTreeMap<u64, Vec<Case>>,
    /// Reports that could not be read, in words.
    pub notes: Vec<String>,
}

/// Reads run `run` of `repo` (`since`: a time before it was last updated, its first job's queue time), its jobs and
/// each job's report artifact.
pub async fn fetch(
    github: &dyn GithubSource,
    repo: &str,
    run: u64,
    since: Timestamp,
) -> Result<Fetched, SourceError> {
    let listed = match github.runs(repo, since, None).await? {
        super::sources::Read::Fresh { value, .. } => value,
        // Asked with no mark, GitHub always answers in full.
        super::sources::Read::Unchanged => Vec::new(),
    };
    let found = listed
        .into_iter()
        .find(|candidate| candidate.id == run)
        .ok_or_else(|| SourceError::new("failed", format!("GitHub does not list run {run}")))?;
    let jobs = github.jobs(repo, run).await?;
    let mut cases = BTreeMap::new();
    let mut notes = Vec::new();
    for artifact in github.artifacts(repo, run).await? {
        let Some(job) = results::job_of_artifact(&artifact.name) else {
            continue;
        };
        if artifact.expired {
            notes.push(format!("the test report of job {job} expired"));
            continue;
        }
        let read = github
            .artifact(repo, artifact.id)
            .await
            .map_err(|error| error.message)
            .and_then(|zip| results::cases_of(&zip, repo));
        match read {
            Ok(found) => {
                cases.insert(job, found);
            }
            Err(why) => notes.push(format!("the test report of job {job}: {why}")),
        }
    }
    Ok(Fetched {
        run: found,
        jobs,
        cases,
        notes,
    })
}

/// What the run is for, as the hub recorded it at `start`.
pub struct Judged<'a> {
    pub run_id: &'a str,
    pub digest: &'a str,
    pub by: Option<&'a Origin>,
    /// The release gate the run decides, if it decides one.
    pub gate: Option<&'a GateId>,
    pub now: Timestamp,
}

/// The answer for a completed run; None while it is not completed or when this attempt was taken in already.
pub fn judge(ledger: &mut Ledger, fetched: &Fetched, judged: &Judged) -> Option<Answer> {
    let jobs: Vec<JobFacts> = fetched
        .jobs
        .iter()
        .map(|job| JobFacts {
            job,
            cases: fetched.cases.get(&job.id).map(Vec::as_slice),
        })
        .collect();
    let verdict = results::take_in(
        ledger,
        &Finished {
            run: &fetched.run,
            jobs: &jobs,
            digest: judged.digest,
            by: judged.by,
            release: judged.gate.is_some(),
        },
    )?;
    let mut notes = fetched.notes.clone();
    notes.extend(verdict.notes);
    let (answer_verdict, next) = match verdict.verdict {
        RunVerdict::Green => (AnswerVerdict::Green, verdict.next),
        RunVerdict::Red => (AnswerVerdict::Red, verdict.next),
        RunVerdict::Cancelled => {
            notes.push(
                "the run was cancelled: start it again, or wait for the run that replaced it"
                    .into(),
            );
            (AnswerVerdict::Unknown, Next::Wait)
        }
    };
    Some(Answer {
        run_id: judged.run_id.to_owned(),
        verdict: answer_verdict,
        as_of: judged.now,
        counts: verdict.counts,
        failed: verdict.failed,
        blocks_release: judged
            .gate
            .filter(|_| verdict.blocks_release || answer_verdict != AnswerVerdict::Green)
            .map(|gate| BlocksRelease { gate: gate.clone() }),
        expected_wait_min: None,
        reused: None,
        next,
        notes,
    })
}

/// No verdict yet, or none that can be trusted: what the agent does is wait (or what `next` says).
pub fn unknown(run_id: &str, as_of: Timestamp, next: Next, note: String) -> Answer {
    Answer {
        run_id: run_id.to_owned(),
        verdict: AnswerVerdict::Unknown,
        as_of,
        counts: Counts {
            passed: 0,
            failed: 0,
        },
        failed: Vec::new(),
        blocks_release: None,
        expected_wait_min: None,
        reused: None,
        next,
        notes: vec![note],
    }
}

/// A start answered from a green run of the same inputs: green, with where it came from.
pub fn reused(
    run_id: &str,
    from: &Answer,
    from_run: &RunId,
    saved_min: u32,
    now: Timestamp,
) -> Answer {
    Answer {
        run_id: run_id.to_owned(),
        verdict: AnswerVerdict::Green,
        as_of: now,
        counts: from.counts.clone(),
        failed: Vec::new(),
        blocks_release: None,
        expected_wait_min: None,
        reused: Some(Reused {
            from: from_run.clone(),
            saved_min,
        }),
        next: Next::Land,
        notes: vec![format!(
            "the same commit, workflow and inputs were green in {from_run}: nothing ran"
        )],
    }
}
