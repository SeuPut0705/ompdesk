//! The one poller of check control (`docs/design/check-control.md` §4, §9.2): it reads GitHub's runs and jobs and
//! every computer's heavy slots through the hub's two sources, for every session at once, and keeps the hub's
//! `Snapshot` told of them (`pools`, `runs`). Sessions never ask GitHub for checks; `status` answers from here.
//!
//! - `Engine`: the schedule as a state machine. `plan` names what to read now, `apply` takes one answer, `pools`
//!   and `runs` are what readers see. It reads no clock and no source, so the same answers at the same times
//!   always leave the same state.
//! - `Poller`: the engine on the hub's sources and clock, and the door the other parts use (`watch`, `expect`).
//! - `github`, `local`: the real sources. `budget`, `wire`: what a GitHub request may cost and what it answers.
//!   `pools`, `provenance`: capacity in one shape, and who started a run.
//!
//! What is read, per watched repository: its runs every 15 s while one is unfinished and every 30 s otherwise; the
//! jobs of each unfinished run (20 s while it runs, 60 s while it waits) and once more after it ended; the limits
//! variable every 10 min. Every computer's pool and the local check journals every 10 s. Whatever is due is read
//! oldest first, so when GitHub's quota is short every run still gets its turn. A fact not confirmed within three
//! of its periods is told `stale`, never as current (§9.3).

pub mod budget;
pub mod foreign;
pub mod github;
pub mod local;
pub mod pools;
pub mod provenance;
pub mod wire;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{Notify, watch};
use tokio::task::AbortHandle;

use self::github::{GhCli, GhSource, Tools};
use self::local::{HeavyCli, HeavyLocal, Journals, PairedPools};
use self::pools::{Limits, Observed};
use self::provenance::{Claim, Claims, Expected};
use super::contract::{
    Job, JobState, Lane, MainFact, Origin, Os, Pool, PoolState, RepoId, Run, RunVerdict, Snapshot,
    StatusRequest, StatusScope, Timestamp, Trigger,
};
use super::hub::Runners;
use super::sources::{
    Checkout, GithubJob, GithubRun, GithubSource, LocalPool, LocalRun, LocalSource, Read,
    SourceError,
};
use crate::clock;
use crate::server::Fault;

const RUNS_ACTIVE_EVERY: Timestamp = 15_000;
const RUNS_IDLE_EVERY: Timestamp = 30_000;
const JOBS_RUNNING_EVERY: Timestamp = 20_000;
const JOBS_WAITING_EVERY: Timestamp = 60_000;
const LIMITS_EVERY: Timestamp = 600_000;
const LOCAL_EVERY: Timestamp = 10_000;
/// A paired computer's pool is current this long after that computer read it.
const PAIRED_FRESH: Timestamp = 60_000;
/// A fact is current for this many of its periods after its last confirmation.
const FRESH_PERIODS: Timestamp = 3;
/// Reads one round makes at most, so a round ends in seconds.
const ROUND_MAX: usize = 16;
/// Reads under way at once.
const AT_ONCE: usize = 4;
/// Finished runs kept per repository.
const DONE_KEPT: usize = 200;
/// Jobs reads after a run ended before its jobs are taken as they are.
const FINAL_READS: u8 = 3;
/// How far back finished runs are asked for: a repository's at its first read, the local checks' at every read.
const HISTORY: Timestamp = 1_800_000;
/// GitHub's clock and this computer's may differ by this much.
const SKEW: Timestamp = 120_000;
/// The wait after a failure of the whole source: doubled per failure in a row, up to `RETRY_MAX`.
const RETRY_FIRST: Timestamp = 15_000;
const RETRY_MAX: Timestamp = 300_000;
/// The snapshot is told again at least this often, so its `asOf` is never far behind a live fact's.
const RETELL_EVERY: Timestamp = 60_000;

/// One read to make.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    Runs {
        repo: String,
        since: Timestamp,
        mark: Option<String>,
    },
    Jobs {
        repo: String,
        run: u64,
    },
    Limits {
        repo: String,
    },
    Pools,
    LocalRuns {
        since: Timestamp,
    },
    /// The repository a local check's folder belongs to.
    Checkout {
        cwd: String,
    },
}

/// What a read answered.
#[derive(Debug)]
pub enum Got {
    Runs(Result<Read<Vec<GithubRun>>, SourceError>),
    Jobs(Result<Vec<GithubJob>, SourceError>),
    Limits(Result<Option<String>, SourceError>),
    Pools(Result<Vec<LocalPool>, SourceError>),
    LocalRuns(Result<Vec<LocalRun>, SourceError>),
    Checkout(Result<Option<Checkout>, SourceError>),
}

/// When one subject was last read and last confirmed.
#[derive(Debug, Default)]
struct Slot {
    /// The last answer that held.
    as_of: Option<Timestamp>,
    /// The last answer of any kind.
    tried_at: Option<Timestamp>,
}

impl Slot {
    fn due(&self, every: Timestamp) -> Timestamp {
        self.tried_at.map_or(0, |tried| tried + every)
    }

    fn fresh(&self, now: Timestamp, every: Timestamp) -> bool {
        self.as_of
            .is_some_and(|as_of| now <= as_of + FRESH_PERIODS * every)
    }
}

fn active(run: &GithubRun) -> bool {
    run.status != "completed"
}

#[derive(Debug)]
struct Tracked {
    run: GithubRun,
    /// Its jobs are read: it was seen unfinished. A run first seen finished is history.
    follow: bool,
    jobs: Vec<GithubJob>,
    jobs_slot: Slot,
    /// When it was learned to have ended.
    done_at: Option<Timestamp>,
    final_reads: u8,
    /// Its jobs were read after it ended: nothing more is asked about it.
    settled: bool,
}

impl Tracked {
    fn jobs_every(&self) -> Timestamp {
        match self.run.status.as_str() {
            "in_progress" | "completed" => JOBS_RUNNING_EVERY,
            _ => JOBS_WAITING_EVERY,
        }
    }

    fn jobs_due(&self) -> Option<Timestamp> {
        if !self.follow || self.settled {
            return None;
        }
        Some(match (self.done_at, self.jobs_slot.tried_at) {
            // Ended since its jobs were last read: read them now.
            (Some(done), Some(tried)) if tried < done => done,
            (Some(done), None) => done,
            _ => self.jobs_slot.due(self.jobs_every()),
        })
    }

    fn jobs_read(&mut self) {
        if self.done_at.is_some() {
            self.final_reads += 1;
            self.settled = self.final_reads >= FINAL_READS
                || self.jobs.iter().all(|job| job.status == "completed");
        }
    }

    fn jobs_fresh(&self, now: Timestamp) -> bool {
        self.settled || !self.follow || self.jobs_slot.fresh(now, self.jobs_every())
    }
}

#[derive(Debug, Default)]
struct Watched {
    slot: Slot,
    mark: Option<String>,
    runs: BTreeMap<u64, Tracked>,
    limits_slot: Slot,
    limits: Option<Limits>,
    /// Read at the next round, whatever its period (`Engine::nudge`).
    nudged: bool,
    /// The source's words when it will not list this repository's runs.
    unavailable: Option<String>,
}

impl Watched {
    fn every(&self) -> Timestamp {
        if self.runs.values().any(|tracked| active(&tracked.run)) {
            RUNS_ACTIVE_EVERY
        } else {
            RUNS_IDLE_EVERY
        }
    }

    fn fresh(&self, now: Timestamp) -> bool {
        self.unavailable.is_none() && self.slot.fresh(now, self.every())
    }

    fn upsert(&mut self, run: GithubRun, now: Timestamp) -> bool {
        let unfinished = active(&run);
        let Some(tracked) = self.runs.get_mut(&run.id) else {
            self.runs.insert(
                run.id,
                Tracked {
                    run,
                    follow: unfinished,
                    jobs: Vec::new(),
                    jobs_slot: Slot::default(),
                    done_at: (!unfinished).then_some(now),
                    final_reads: 0,
                    settled: false,
                },
            );
            return true;
        };
        // An answer older than what is known says nothing new; a finished run runs again only as a new attempt.
        let known = &tracked.run;
        if (run.attempt, run.updated_at, !unfinished)
            < (known.attempt, known.updated_at, !active(known))
        {
            return false;
        }
        if unfinished {
            tracked.follow = true;
            tracked.done_at = None;
            tracked.final_reads = 0;
            tracked.settled = false;
        } else if tracked.done_at.is_none() {
            tracked.done_at = Some(now);
        }
        let changed = tracked.run != run;
        tracked.run = run;
        changed
    }

    /// Keeps the newest `DONE_KEPT` finished runs.
    fn forget_old(&mut self) {
        let mut done: Vec<(Timestamp, u64)> = self
            .runs
            .iter()
            .filter(|(_, tracked)| !active(&tracked.run) && tracked.jobs_due().is_none())
            .map(|(id, tracked)| (tracked.run.updated_at, *id))
            .collect();
        if done.len() <= DONE_KEPT {
            return;
        }
        done.sort_unstable();
        for (_, id) in &done[..done.len() - DONE_KEPT] {
            self.runs.remove(id);
        }
    }
}

/// The whole of GitHub answering or not: what a failure of the source, not of one read, holds back.
#[derive(Debug, Default)]
struct Gate {
    failures: u32,
    retry_at: Timestamp,
    trouble: Option<SourceError>,
}

impl Gate {
    /// Whether `error` is the source's (it holds every read back) rather than one read's.
    fn take(&mut self, now: Timestamp, error: &SourceError) -> bool {
        match error.code.as_str() {
            "rate_limited" => {
                self.retry_at = error.retry_at.unwrap_or(now + RETRY_MAX / 5);
            }
            "missing" | "unauthenticated" | "offline" => {
                let wait = RETRY_FIRST
                    .saturating_mul(1 << self.failures.min(16))
                    .min(RETRY_MAX);
                self.failures += 1;
                self.retry_at = now + wait;
            }
            _ => return false,
        }
        self.trouble = Some(error.clone());
        true
    }

    fn worked(&mut self) {
        *self = Gate::default();
    }
}

#[derive(Debug, Default)]
pub struct Engine {
    repos: BTreeMap<String, Watched>,
    github: Gate,
    pools_slot: Slot,
    pools: Vec<LocalPool>,
    local_slot: Slot,
    local_runs: Vec<LocalRun>,
    /// A local check's folder to its checkout; none while it is not read yet.
    checkouts: HashMap<String, Option<Checkout>>,
    claims: Claims,
    observed: Observed,
    /// This computer's operating system, for a local check's job.
    os: Option<Os>,
}

impl Engine {
    pub fn new(os: Os) -> Engine {
        Engine {
            os: Some(os),
            ..Engine::default()
        }
    }

    /// Starts reading `repo`; one already read keeps what is known of it.
    pub fn watch(&mut self, repo: &str) {
        self.repos.entry(repo.to_owned()).or_default();
    }

    pub fn unwatch(&mut self, repo: &str) {
        self.repos.remove(repo);
    }

    /// Something just changed in `repo` (a run was started from here): it is read at the next round.
    pub fn nudge(&mut self, repo: &str) {
        self.repos.entry(repo.to_owned()).or_default().nudged = true;
    }

    /// The hub asked GitHub to run `run`'s failed jobs again for its run `claim`: the run is the new attempt's from
    /// now on and reads unfinished until GitHub shows that attempt, so its old end is never taken for the new one.
    pub fn rerun(&mut self, repo: &str, run: u64, claim: Claim) {
        self.claims.rebind(repo, run, claim);
        let watched = self.repos.entry(repo.to_owned()).or_default();
        watched.nudged = true;
        if let Some(tracked) = watched.runs.get_mut(&run) {
            tracked.run.attempt += 1;
            tracked.run.status = "queued".to_owned();
            tracked.run.conclusion = None;
            tracked.follow = true;
            tracked.done_at = None;
            tracked.final_reads = 0;
            tracked.settled = false;
        }
    }

    /// The repositories to follow, as main says: those of the open sessions' checkouts. One a start of the hub's
    /// still waits on (a dispatch expected, a claimed run unfinished) stays followed.
    pub fn follow(&mut self, repos: &[RepoId]) {
        for repo in repos {
            self.watch(repo);
        }
        let claims = &self.claims;
        self.repos.retain(|repo, watched| {
            repos.contains(repo)
                || claims.expects(repo)
                || watched
                    .runs
                    .iter()
                    .any(|(id, tracked)| active(&tracked.run) && claims.claimed(repo, *id))
        });
    }

    /// A paired computer's pool changed: the pools are read at the next round.
    pub fn reread_pools(&mut self) {
        self.pools_slot.tried_at = None;
    }

    /// What kept failing may work again (gh signed in, the network came back): the wait after a failure ends now.
    /// A wait GitHub asked for is kept.
    pub fn retry_now(&mut self) {
        if self
            .github
            .trouble
            .as_ref()
            .is_some_and(|trouble| trouble.code != "rate_limited")
        {
            self.github.retry_at = 0;
        }
    }

    pub fn claims(&mut self) -> &mut Claims {
        &mut self.claims
    }

    /// Why GitHub's facts are not read right now, when they are not.
    pub fn trouble(&self) -> Option<&SourceError> {
        self.github.trouble.as_ref()
    }

    /// Everything wanted, with when each is due.
    fn wanted(&self, now: Timestamp) -> Vec<(Timestamp, Ask)> {
        let mut wanted = vec![
            (self.pools_slot.due(LOCAL_EVERY), Ask::Pools),
            (
                self.local_slot.due(LOCAL_EVERY),
                Ask::LocalRuns {
                    since: now.saturating_sub(HISTORY),
                },
            ),
        ];
        for run in &self.local_runs {
            if !self.checkouts.contains_key(&run.cwd)
                && !wanted
                    .iter()
                    .any(|(_, ask)| matches!(ask, Ask::Checkout { cwd } if *cwd == run.cwd))
            {
                wanted.push((
                    0,
                    Ask::Checkout {
                        cwd: run.cwd.clone(),
                    },
                ));
            }
        }
        for (repo, watched) in &self.repos {
            wanted.push((
                if watched.nudged {
                    0
                } else {
                    watched.slot.due(watched.every())
                },
                Ask::Runs {
                    repo: repo.clone(),
                    // Never further back than the last read, so an unchanged answer has nothing untold.
                    since: watched.slot.as_of.map_or_else(
                        || now.saturating_sub(HISTORY),
                        |as_of| as_of.saturating_sub(SKEW),
                    ),
                    mark: watched.mark.clone(),
                },
            ));
            wanted.push((
                watched.limits_slot.due(LIMITS_EVERY),
                Ask::Limits { repo: repo.clone() },
            ));
            for (id, tracked) in &watched.runs {
                if let Some(due) = tracked.jobs_due() {
                    wanted.push((
                        due,
                        Ask::Jobs {
                            repo: repo.clone(),
                            run: *id,
                        },
                    ));
                }
            }
        }
        wanted
    }

    /// When a read may go out: its own due time, and a GitHub read not before the wait after a failure.
    fn allowed(&self, due: Timestamp, ask: &Ask) -> Timestamp {
        match ask {
            Ask::Runs { .. } | Ask::Jobs { .. } | Ask::Limits { .. } => {
                due.max(self.github.retry_at)
            }
            Ask::Pools | Ask::LocalRuns { .. } | Ask::Checkout { .. } => due,
        }
    }

    /// The reads to make now, the longest overdue first: a wait after a failure holds every GitHub read alike, and
    /// what was due earliest still goes first when it ends.
    pub fn plan(&mut self, now: Timestamp) -> Vec<Ask> {
        let mut due: Vec<(Timestamp, usize, Ask)> = self
            .wanted(now)
            .into_iter()
            .enumerate()
            .filter(|(_, (at, ask))| self.allowed(*at, ask) <= now)
            .map(|(order, (at, ask))| (at, order, ask))
            .collect();
        due.sort_by_key(|(at, order, _)| (*at, *order));
        due.truncate(ROUND_MAX);
        due.into_iter().map(|(.., ask)| ask).collect()
    }

    /// When `plan` next has something to read.
    pub fn next(&self) -> Timestamp {
        self.wanted(0)
            .into_iter()
            .map(|(at, ask)| self.allowed(at, &ask))
            .min()
            .unwrap_or(Timestamp::MAX)
    }

    /// Takes the answer to `ask`; true when a fact changed.
    pub fn apply(&mut self, now: Timestamp, ask: &Ask, got: Got) -> bool {
        match (ask, got) {
            (Ask::Pools, Got::Pools(answer)) => {
                self.pools_slot.tried_at = Some(now);
                let Ok(pools) = answer else { return false };
                self.pools_slot.as_of = Some(now);
                let changed = self.pools != pools;
                self.pools = pools;
                changed
            }
            (Ask::LocalRuns { .. }, Got::LocalRuns(answer)) => {
                self.local_slot.tried_at = Some(now);
                let Ok(runs) = answer else { return false };
                self.local_slot.as_of = Some(now);
                let changed = self.local_runs != runs;
                self.checkouts
                    .retain(|cwd, _| runs.iter().any(|run| run.cwd == *cwd));
                self.local_runs = runs;
                changed
            }
            (Ask::Checkout { cwd }, Got::Checkout(answer)) => {
                // A folder that cannot be read is no checkout: asked once, not at every round.
                self.checkouts.insert(cwd.clone(), answer.ok().flatten());
                true
            }
            (Ask::Runs { repo, .. }, Got::Runs(answer)) => self.runs_read(now, repo, answer),
            (Ask::Jobs { repo, run }, Got::Jobs(answer)) => {
                let sent = sent(&answer);
                let answer = self.heard(now, answer);
                let Some(tracked) = self
                    .repos
                    .get_mut(repo)
                    .and_then(|watched| watched.runs.get_mut(run))
                else {
                    return false;
                };
                if sent {
                    tracked.jobs_slot.tried_at = Some(now);
                }
                let Some(jobs) = answer else { return false };
                tracked.jobs_slot.as_of = Some(now);
                let changed = tracked.jobs != jobs;
                tracked.jobs = jobs;
                tracked.jobs_read();
                changed
            }
            (Ask::Limits { repo }, Got::Limits(answer)) => {
                let sent = sent(&answer);
                let answer = self.heard(now, answer);
                let Some(watched) = self.repos.get_mut(repo) else {
                    return false;
                };
                if sent {
                    watched.limits_slot.tried_at = Some(now);
                }
                let Some(value) = answer else { return false };
                watched.limits_slot.as_of = Some(now);
                let limits = value.as_deref().and_then(Limits::parse);
                let changed = watched.limits != limits;
                watched.limits = limits;
                changed
            }
            _ => false,
        }
    }

    /// A GitHub answer's value, the gate told how the source fares.
    fn heard<T>(&mut self, now: Timestamp, answer: Result<T, SourceError>) -> Option<T> {
        match answer {
            Ok(value) => {
                self.github.worked();
                Some(value)
            }
            Err(error) => {
                self.github.take(now, &error);
                None
            }
        }
    }

    fn runs_read(
        &mut self,
        now: Timestamp,
        repo: &str,
        answer: Result<Read<Vec<GithubRun>>, SourceError>,
    ) -> bool {
        let sent = sent(&answer);
        let of_source = match &answer {
            Ok(_) => {
                self.github.worked();
                false
            }
            Err(error) => self.github.take(now, error),
        };
        let Some(watched) = self.repos.get_mut(repo) else {
            return false;
        };
        if sent {
            watched.slot.tried_at = Some(now);
        }
        watched.nudged = false;
        let read = match answer {
            Ok(read) => read,
            Err(error) => {
                // The read's own failure: this repository cannot be listed (gone, or not this account's to read).
                let words = (!of_source).then_some(error.message);
                let changed = words.is_some() && watched.unavailable != words;
                if changed {
                    watched.unavailable = words;
                }
                return changed;
            }
        };
        watched.slot.as_of = Some(now);
        let mut changed = watched.unavailable.take().is_some();
        if let Read::Fresh { value, mark } = read {
            watched.mark = mark;
            // The answer names every unfinished run: one it leaves out is gone.
            let before = watched.runs.len();
            watched.runs.retain(|id, tracked| {
                !active(&tracked.run) || value.iter().any(|run| run.id == *id)
            });
            changed |= watched.runs.len() != before;
            self.claims.see_github(repo, &value, now);
            for run in value {
                changed |= watched.upsert(run, now);
            }
            watched.forget_old();
            let repos = &self.repos;
            self.claims.keep_github(|repo, run| {
                repos
                    .get(repo)
                    .is_some_and(|watched| watched.runs.contains_key(&run))
            });
        }
        changed
    }

    /// When a run of GitHub's was last confirmed as it is told, and whether that is current: what an answer about
    /// it may be given on (§9.3: never green from old data).
    pub fn confirmed(&self, repo: &str, run: u64, now: Timestamp) -> Option<(Timestamp, bool)> {
        let watched = self.repos.get(repo)?;
        let tracked = watched.runs.get(&run)?;
        let as_of = match (watched.slot.as_of?, tracked.jobs_slot.as_of) {
            (runs, Some(jobs)) if tracked.follow && !tracked.settled => runs.min(jobs),
            (runs, _) => runs,
        };
        Some((as_of, watched.fresh(now) && tracked.jobs_fresh(now)))
    }

    /// GitHub's run behind a run id of the hub's, or behind `gh-<id>`.
    pub fn github_of(&self, run: &str) -> Option<(RepoId, u64)> {
        if let Some(found) = self.claims.github_of(run) {
            return Some(found);
        }
        let id: u64 = run.strip_prefix("gh-")?.parse().ok()?;
        self.repos
            .iter()
            .find(|(_, watched)| watched.runs.contains_key(&id))
            .map(|(repo, _)| (repo.clone(), id))
    }

    /// The run `id` once it ended and what it ran is final: a GitHub run's jobs were read after its end.
    pub fn final_run(&mut self, id: &str, now: Timestamp) -> Option<Run> {
        let run = self.runs(now).into_iter().find(|run| run.id == id)?;
        run.verdict?;
        if let Some((repo, github)) = self.github_of(id)
            && let Some(tracked) = self
                .repos
                .get(&repo)
                .and_then(|watched| watched.runs.get(&github))
            && tracked.follow
            && !tracked.settled
        {
            return None;
        }
        Some(run)
    }

    /// Capacity: GitHub's hosted runners once a repository is watched, then every computer.
    pub fn pools(&mut self, now: Timestamp) -> Vec<Pool> {
        let mut pools = Vec::new();
        if !self.repos.is_empty() {
            let limits = self
                .repos
                .values()
                .filter_map(|watched| watched.limits)
                .reduce(Limits::widest)
                .unwrap_or_default();
            let live = self.repos.values().all(|watched| {
                watched.fresh(now)
                    && watched
                        .runs
                        .values()
                        .filter(|tracked| active(&tracked.run))
                        .all(|tracked| tracked.jobs_fresh(now))
            });
            let as_of = self
                .repos
                .values()
                .map(|watched| watched.slot.as_of.unwrap_or(0))
                .min()
                .unwrap_or(0);
            let jobs = self
                .repos
                .values()
                .flat_map(|watched| watched.runs.values())
                .filter(|tracked| active(&tracked.run))
                .flat_map(|tracked| &tracked.jobs);
            pools.extend(pools::hosted(
                limits,
                &mut self.observed,
                jobs,
                as_of,
                live,
                now,
            ));
        }
        let local_live = self.pools_slot.fresh(now, LOCAL_EVERY);
        pools.extend(self.pools.iter().map(|pool| {
            let live = if pool.device == "local" {
                local_live
            } else {
                local_live && now <= pool.as_of + PAIRED_FRESH
            };
            pools::device(pool, live)
        }));
        pools
    }

    /// Every run known, GitHub's newest first and then the local checks.
    pub fn runs(&mut self, now: Timestamp) -> Vec<Run> {
        let mut runs = Vec::new();
        for (repo, watched) in &self.repos {
            let mut tracked: Vec<&Tracked> = watched.runs.values().collect();
            tracked
                .sort_by_key(|tracked| std::cmp::Reverse((tracked.run.created_at, tracked.run.id)));
            for tracked in tracked {
                let claim = self.claims.of_github(repo, &tracked.run, now).cloned();
                runs.push(github_run(repo, tracked, claim));
            }
        }
        let os = self.os.unwrap_or(Os::Linux);
        for run in &self.local_runs {
            let checkout = self.checkouts.get(&run.cwd).and_then(Option::as_ref);
            runs.push(local_run(run, checkout, self.claims.of_local(run), os));
        }
        runs
    }
}

/// GitHub answered this read, with its rows or with a refusal of its own. A source that could not ask (the quota
/// spent, gh missing, signed out or offline) leaves the read where it stood in line: the gate's wait holds it, the
/// longest overdue goes first when the wait ends, and `retry_now` lets it go at once.
fn sent<T>(answer: &Result<T, SourceError>) -> bool {
    !matches!(
        answer,
        Err(error) if matches!(error.code.as_str(), "rate_limited" | "missing" | "unauthenticated" | "offline")
    )
}

fn verdict_of(conclusion: Option<&str>) -> RunVerdict {
    match conclusion {
        Some("success" | "neutral" | "skipped") => RunVerdict::Green,
        Some("cancelled") => RunVerdict::Cancelled,
        // A word this code has never seen is not green.
        _ => RunVerdict::Red,
    }
}

fn job_state(job: &GithubJob) -> JobState {
    match (job.status.as_str(), job.conclusion.as_deref()) {
        ("completed", Some("success" | "neutral")) => JobState::Passed,
        ("completed", Some("cancelled")) => JobState::Cancelled,
        ("completed", _) => JobState::Failed,
        ("in_progress", _) => JobState::Running,
        _ => JobState::Queued,
    }
}

/// A run of GitHub's in the contract's shape. One nobody claimed is a person's, on the `branch` lane, with no digest:
/// who started it and what it may be reused on are the hub's own records, never read off the run.
fn github_run(repo: &str, tracked: &Tracked, claim: Option<Claim>) -> Run {
    let run = &tracked.run;
    let jobs = tracked
        .jobs
        .iter()
        // A skipped job never ran, and one with no runner yet takes no pool.
        .filter(|job| job.conclusion.as_deref() != Some("skipped"))
        .filter_map(|job| {
            let (pool, os) = pools::pool_of(job)?;
            Some(Job {
                id: job.id.to_string(),
                name: job.name.clone(),
                os,
                pool,
                state: job_state(job),
                queued_at: job.created_at,
                started_at: job.started_at,
                ended_at: job.completed_at,
                billed_min: None,
            })
        })
        .collect();
    let claimed = claim.is_some();
    let claim = claim.unwrap_or_else(|| Claim {
        run_id: format!("gh-{}", run.id),
        origin: Origin::Person,
        lane: Lane::Branch,
        gate: None,
        digest: String::new(),
    });
    Run {
        id: claim.run_id,
        repo: repo.to_owned(),
        git_ref: run.branch.clone(),
        sha: run.sha.clone(),
        lane: claim.lane,
        trigger: match run.event.as_str() {
            "push" => Trigger::Push,
            "pull_request" | "pull_request_target" => Trigger::PullRequest,
            "merge_group" => Trigger::Queue,
            _ if claimed && claim.lane == Lane::Land => Trigger::Queue,
            _ => Trigger::Dispatch,
        },
        origin: claim.origin,
        gate: claim.gate,
        jobs,
        verdict: (!active(run)).then(|| verdict_of(run.conclusion.as_deref())),
        reused_from: None,
        superseded_by: None,
        digest: claim.digest,
    }
}

/// A local check as a run of one job on this computer's pool.
fn local_run(run: &LocalRun, checkout: Option<&Checkout>, claim: Option<Claim>, os: Os) -> Run {
    let state = match run.state.as_str() {
        "starting" | "waiting" => JobState::Queued,
        "running" => JobState::Running,
        "passed" => JobState::Passed,
        "cancelled" => JobState::Cancelled,
        _ => JobState::Failed,
    };
    let claim = claim.unwrap_or_else(|| Claim {
        run_id: format!("local-{}", run.id),
        origin: Origin::Person,
        lane: Lane::Local,
        gate: None,
        digest: run.digest.clone(),
    });
    Run {
        id: claim.run_id,
        repo: checkout.map_or_else(String::new, |checkout| checkout.repo.clone()),
        git_ref: checkout.map_or_else(String::new, |checkout| checkout.branch.clone()),
        sha: run.head.clone().unwrap_or_default(),
        lane: claim.lane,
        trigger: Trigger::Local,
        origin: claim.origin,
        gate: claim.gate,
        jobs: vec![Job {
            id: format!("local-{}", run.id),
            name: run.argv.join(" "),
            os,
            pool: pools::device_id(&run.device),
            state,
            queued_at: run.started,
            started_at: (state != JobState::Queued).then_some(run.started),
            ended_at: run.ended,
            billed_min: None,
        }],
        verdict: match state {
            JobState::Passed => Some(RunVerdict::Green),
            JobState::Failed => Some(RunVerdict::Red),
            JobState::Cancelled => Some(RunVerdict::Cancelled),
            _ => None,
        },
        reused_from: None,
        superseded_by: None,
        digest: claim.digest,
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The engine on the hub's sources and clock.
pub struct Poller {
    github: Arc<dyn GithubSource>,
    local: Arc<dyn LocalSource>,
    /// Where `runners` go; none over fakes.
    tools: Option<Arc<Tools>>,
    /// Where a paired computer's pool goes; none over fakes.
    paired: Option<PairedPools>,
    snapshot: watch::Sender<Arc<Snapshot>>,
    engine: Mutex<Engine>,
    /// Something is wanted before the next round is due.
    wake: Arc<Notify>,
    /// Grows after every round that changed a fact.
    changes: watch::Sender<u64>,
}

impl Poller {
    /// Over the sources given (fakes in a test): what main tells of runners and paired pools has nowhere to go.
    pub fn new(
        github: Arc<dyn GithubSource>,
        local: Arc<dyn LocalSource>,
        snapshot: watch::Sender<Arc<Snapshot>>,
    ) -> Arc<Poller> {
        Poller::build(github, local, None, None, snapshot)
    }

    /// Over the real sources: the person's gh and git as main hands them over, this computer's `ompdesk heavy`
    /// (the binary beside the core's own), its processes and its check journals.
    pub fn real(snapshot: watch::Sender<Arc<Snapshot>>) -> Arc<Poller> {
        let tools = Arc::new(Tools::default());
        let api = Arc::new(GhCli {
            tools: Arc::clone(&tools),
        });
        let github = Arc::new(GhSource::new(api, Some(Arc::clone(&tools))));
        let binary = if cfg!(windows) {
            "ompdesk.exe"
        } else {
            "ompdesk"
        };
        let bin = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(binary)))
            .unwrap_or_else(|| PathBuf::from(binary));
        // `heavy status` judges the volumes of its folder and the temp folder: the person's home and its volume.
        let cwd = ["HOME", "USERPROFILE"]
            .iter()
            .find_map(std::env::var_os)
            .map_or_else(std::env::temp_dir, PathBuf::from);
        let paired = PairedPools::default();
        let journals =
            local::store_root(&|name| std::env::var(name).ok()).map(|root| Journals { root });
        let local = Arc::new(HeavyLocal::new(
            Arc::new(HeavyCli { bin, cwd }),
            paired.clone(),
            journals,
            local::this_os(),
        ));
        Poller::build(github, local, Some(tools), Some(paired), snapshot)
    }

    fn build(
        github: Arc<dyn GithubSource>,
        local: Arc<dyn LocalSource>,
        tools: Option<Arc<Tools>>,
        paired: Option<PairedPools>,
        snapshot: watch::Sender<Arc<Snapshot>>,
    ) -> Arc<Poller> {
        Arc::new(Poller {
            github,
            local,
            tools,
            paired,
            snapshot,
            engine: Mutex::new(Engine::new(self::local::this_os())),
            wake: Arc::new(Notify::new()),
            changes: watch::Sender::new(0),
        })
    }

    pub fn github(&self) -> Arc<dyn GithubSource> {
        Arc::clone(&self.github)
    }

    pub fn local(&self) -> Arc<dyn LocalSource> {
        Arc::clone(&self.local)
    }

    /// Starts the rounds. They end when the handle is aborted or once the poller is dropped (within a minute: the
    /// task holds it only while a round runs).
    pub fn start(self: &Arc<Poller>) -> AbortHandle {
        let poller = Arc::downgrade(self);
        let wake = Arc::clone(&self.wake);
        tokio::spawn(async move {
            loop {
                let wait = {
                    let Some(poller) = poller.upgrade() else {
                        return;
                    };
                    poller.round().await;
                    locked(&poller.engine)
                        .next()
                        .saturating_sub(clock::now_ms())
                        .clamp(250, RETELL_EVERY)
                };
                tokio::select! {
                    () = clock::sleep(Duration::from_millis(wait)) => {}
                    () = wake.notified() => {}
                }
            }
        })
        .abort_handle()
    }

    /// Reads `repo`'s runs from now on.
    pub fn watch(&self, repo: &str) {
        locked(&self.engine).watch(repo);
        self.wake.notify_one();
    }

    pub fn unwatch(&self, repo: &str) {
        locked(&self.engine).unwatch(repo);
        self.wake.notify_one();
    }

    /// A dispatch is about to be sent for `expected.claim` (call this first, then dispatch): its repository is read
    /// at once and followed until its run ends.
    pub fn expect(&self, expected: Expected) {
        let mut engine = locked(&self.engine);
        engine.nudge(&expected.repo);
        engine.claims().expect(expected);
        drop(engine);
        self.wake.notify_one();
    }

    /// A run was started or changed from here (a dispatch went out, a cancel, a rerun): read `repo` now.
    pub fn nudge(&self, repo: &str) {
        locked(&self.engine).nudge(repo);
        self.wake.notify_one();
    }

    /// The hub reruns GitHub's run `run` for its run `claim` (`Engine::rerun`): read `repo` now.
    pub fn rerun(&self, repo: &str, run: u64, claim: Claim) {
        locked(&self.engine).rerun(repo, run, claim);
        self.wake.notify_one();
    }

    /// A local check the hub started itself, by its journal's id.
    pub fn claim_local(&self, journal: &str, claim: Claim) {
        locked(&self.engine).claims().claim_local(journal, claim);
    }

    /// What main knows and the hub cannot read itself (`checks.facts`).
    pub fn told(&self, fact: MainFact) {
        let mut engine = locked(&self.engine);
        match fact {
            MainFact::Repos { repos } => engine.follow(&repos),
            MainFact::DevicePool { pool } => {
                if let Some(paired) = &self.paired {
                    paired.set(pool);
                    engine.reread_pools();
                }
            }
            MainFact::DeviceOffline { device } => {
                if let Some(paired) = &self.paired {
                    paired.offline(&device);
                    engine.reread_pools();
                }
            }
            MainFact::Sessions { tags } => engine.claims().set_tags(tags.into_iter().collect()),
            // The hub's own count (`Snapshot.adoption`); nothing the poller reads.
            MainFact::Polls { .. } => {}
        }
        drop(engine);
        self.wake.notify_one();
    }

    /// How gh and git run from now on (`checks.runners`): what failed for want of them is tried again now.
    pub fn runners(&self, runners: Runners) {
        if let Some(tools) = &self.tools {
            tools.set(runners);
        }
        self.retry_now();
    }

    /// gh signed in, the network came back, the computer woke: try again now.
    pub fn retry_now(&self) {
        locked(&self.engine).retry_now();
        self.wake.notify_one();
    }

    /// Why GitHub's facts are not read right now, when they are not.
    pub fn trouble(&self) -> Option<SourceError> {
        locked(&self.engine).trouble().cloned()
    }

    /// When a run of GitHub's was last confirmed, and whether that is current.
    pub fn confirmed(&self, repo: &str, run: u64) -> Option<(Timestamp, bool)> {
        locked(&self.engine).confirmed(repo, run, clock::now_ms())
    }

    /// GitHub's run behind a run id of the hub's, or behind `gh-<id>`: what a cancel or a rerun names.
    pub fn github_of(&self, run: &str) -> Option<(RepoId, u64)> {
        locked(&self.engine).github_of(run)
    }

    /// Grows after every round that changed a fact: what a wait for any change of a run selects on.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Ends once the run `id` ended and what it ran is final (a GitHub run's jobs read after its end). It asks
    /// nothing of its own: the rounds wake it. A run that never shows never ends it, so a caller selects it against
    /// its own timeout and cancel.
    pub async fn ended(&self, id: &str) -> Run {
        let mut changes = self.changes.subscribe();
        loop {
            if let Some(run) = locked(&self.engine).final_run(id, clock::now_ms()) {
                return run;
            }
            if changes.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }

    async fn read(&self, ask: &Ask) -> Got {
        match ask {
            Ask::Runs { repo, since, mark } => {
                Got::Runs(self.github.runs(repo, *since, mark.as_deref()).await)
            }
            Ask::Jobs { repo, run } => Got::Jobs(self.github.jobs(repo, *run).await),
            Ask::Limits { repo } => {
                Got::Limits(self.github.variable(repo, pools::LIMITS_VARIABLE).await)
            }
            Ask::Pools => Got::Pools(self.local.pools().await),
            Ask::LocalRuns { since } => Got::LocalRuns(self.local.runs(*since).await),
            Ask::Checkout { cwd } => Got::Checkout(self.github.checkout(cwd).await),
        }
    }

    /// One round: everything due is read, a few at a time, and the snapshot told when a fact changed.
    pub async fn round(&self) {
        let asks = locked(&self.engine).plan(clock::now_ms());
        let mut changed = false;
        for few in asks.chunks(AT_ONCE) {
            let answers =
                crate::care::join_all(few.iter().map(|ask| self.read(ask)).collect()).await;
            let now = clock::now_ms();
            let mut engine = locked(&self.engine);
            for (ask, got) in few.iter().zip(answers) {
                changed |= engine.apply(now, ask, got);
            }
        }
        if changed {
            self.changes.send_modify(|count| *count += 1);
        }
        self.tell(changed);
    }

    /// Writes the engine's pools and runs into the hub's snapshot: at a change, when a pool's state turned, and at
    /// least every `RETELL_EVERY`.
    fn tell(&self, changed: bool) {
        let now = clock::now_ms();
        let (pools, runs) = {
            let mut engine = locked(&self.engine);
            (engine.pools(now), engine.runs(now))
        };
        self.snapshot.send_if_modified(|current| {
            let states = |pools: &[Pool]| -> Vec<(String, PoolState)> {
                pools
                    .iter()
                    .map(|pool| (pool.id.clone(), pool.state))
                    .collect()
            };
            if !changed
                && states(&current.pools) == states(&pools)
                && current.runs == runs
                && now < current.as_of + RETELL_EVERY
            {
                return false;
            }
            let mut next = Snapshot::clone(current);
            next.as_of = now;
            next.pools = pools;
            next.runs = runs;
            *current = Arc::new(next);
            true
        });
    }
}

/// `status`: the snapshot as `origin` asked to see it. No GitHub request: the scope's repository, when the request
/// names none, is read from the caller's folder with git.
pub async fn status(
    github: &dyn GithubSource,
    snapshot: &watch::Sender<Arc<Snapshot>>,
    origin: Origin,
    request: StatusRequest,
) -> Result<Snapshot, Fault> {
    let whole = Arc::clone(&snapshot.borrow());
    let keep: Box<dyn Fn(&Run) -> bool + Send> = match request.scope {
        StatusScope::All => return Ok(Snapshot::clone(&whole)),
        StatusScope::Mine => Box::new(move |run| same_asker(&run.origin, &origin)),
        StatusScope::Repo => {
            let repo = match (request.repo, request.cwd) {
                (Some(repo), _) => Some(repo),
                (None, Some(cwd)) => github
                    .checkout(&cwd)
                    .await
                    .map_err(|error| Fault::new("checks_source", error.message))?
                    .map(|checkout| checkout.repo),
                (None, None) => None,
            };
            let Some(repo) = repo else {
                return Err(Fault::new(
                    "no_repo",
                    "no GitHub repository for this folder: name one",
                ));
            };
            Box::new(move |run| run.repo == repo)
        }
    };
    let mut view = Snapshot::clone(&whole);
    view.runs.retain(&*keep);
    let kept = |id: &str| view.runs.iter().any(|run| run.id == id);
    let decisions = view
        .decisions
        .iter()
        .filter(|decision| kept(&decision.run))
        .cloned()
        .collect();
    let answers = view
        .answers
        .iter()
        .filter(|answer| kept(&answer.run_id))
        .cloned()
        .collect();
    let gates = view
        .gates
        .iter()
        .filter(|gate| gate.run.as_deref().is_some_and(kept))
        .cloned()
        .collect();
    view.decisions = decisions;
    view.answers = answers;
    view.gates = gates;
    Ok(view)
}

/// The same asker: a session is itself whatever goal it works on now.
fn same_asker(a: &Origin, b: &Origin) -> bool {
    match (a, b) {
        (
            Origin::Session {
                session: a_session,
                device: a_device,
                ..
            },
            Origin::Session {
                session: b_session,
                device: b_device,
                ..
            },
        ) => a_session == b_session && a_device == b_device,
        _ => a == b,
    }
}

#[cfg(test)]
mod tests;
