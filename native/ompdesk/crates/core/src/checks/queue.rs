//! The merge queue of check control (lane `land`, `docs/design/check-control.md` §5 policy 3). It is OMPdesk's own:
//! GitHub's is not offered to a repository a user owns, and it does not combine builds.
//!
//! This file is the queue's rules for one base branch of one repository. It runs no git, asks GitHub nothing and reads
//! no clock: each method takes what happened and answers what is to be done (`Effect`), and whoever runs the queue
//! does it and reports back through the next method. So the rules are the same in a test, in the model
//! (`formal/checks-queue`, read `skill://checks-queue-verify` before changing this file) and against a real remote.
//!
//! The rules:
//! - Branches wait in a line, each pinned to the commit it was queued with. A batch is the oldest waiting entry and
//!   the later ones of its goal, oldest first, at most `batch_size`; it forms when it is full or its oldest entry
//!   has waited `window_ms`. One batch (the flight) is worked on at a time.
//! - A trial builds a prefix of the flight on the base tip the queue last read, as one commit on a branch of the
//!   queue's own, and has the check run on exactly that commit. Green: the base is fast-forwarded to that commit, so
//!   what lands is what was tested. The base is never forced.
//! - Red: the queue bisects over prefixes. What it learned is kept per base tip and entries (`memo`): it lands the
//!   longest prefix known green, fails the first entry once it alone is known red on the tip, and otherwise tests the
//!   middle of the shortest prefix known red. A combination known red is never built again.
//! - The base moved (someone pushed, or the queue's own push was refused): nothing known holds on the new tip, the
//!   trial under way is dropped and the flight starts over on it.
//! - A result is taken only for the commit under test now; one that arrives for a trial dropped meanwhile is ignored.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::contract::{
    BatchId, GoalId, Lane, Origin, QueueEntry, QueueState, RepoId, Sha, Timestamp,
};
use super::hub::{self, QueueHost};

#[path = "queue_run.rs"]
pub mod run;

pub use run::{GitHands, Hands, Landing, Queues, github_url};

/// The merge queues the hub holds (`Hub.queue`): a lane per base branch of a repository, each built, tested and
/// landed through `hands`, its runs started and its entries' results told through `host`.
pub fn open(host: Arc<dyn QueueHost>, hands: Arc<dyn Hands>) -> Arc<dyn hub::LandQueue> {
    run::open_with(host, hands, Tuning::default())
}

/// Where a batch starts from (Trunk's defaults, the design's §5): its size, and how long its oldest entry waits for
/// company.
pub const BATCH_SIZE: usize = 4;
pub const BATCH_WINDOW_MS: u64 = 5 * 60 * 1000;

/// The queue's own branches on the remote: `omp/queue/<candidate>`, one per trial.
pub const QUEUE_BRANCH_PREFIX: &str = "omp/queue/";

/// How many failed and withdrawn entries the queue still shows.
const ENDED_KEPT: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub batch_size: usize,
    pub window_ms: u64,
}

impl Default for Tuning {
    fn default() -> Tuning {
        Tuning {
            batch_size: BATCH_SIZE,
            window_ms: BATCH_WINDOW_MS,
        }
    }
}

/// A branch asked to land, at the commit it has now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ask {
    pub branch: String,
    pub pr: Option<u64>,
    /// What lands, in a line (the pull request's title, else the subject of the branch's newest commit).
    pub title: String,
    pub sha: Sha,
    pub goal: Option<GoalId>,
    pub origin: Origin,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u64>,
    pub title: String,
    pub sha: Sha,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<GoalId>,
    pub origin: Origin,
    pub queued_at: Timestamp,
}

/// One branch of a build, merged in this order onto the tip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub branch: String,
    pub sha: Sha,
}

/// How an entry's time in the queue ended, for whoever queued it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Told {
    /// The base holds it: `commit` is the tested commit the base was moved to.
    Landed { commit: Sha },
    /// `commit`: the commit whose check failed with this entry alone on the tip; none when no run says it (it did
    /// not build, or the base takes no push of the queue's).
    Failed { why: String, commit: Option<Sha> },
}

/// What the queue asks of whoever runs it. A candidate is one trial's name; its branch is
/// `QUEUE_BRANCH_PREFIX` + the name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Merge `parts` in order onto `tip` as one commit on the candidate's branch, then `built`.
    Build {
        candidate: String,
        tip: Sha,
        parts: Vec<Part>,
    },
    /// Have the check run on the candidate's branch at `commit`, then `verdict` (or `lost`).
    Test {
        candidate: String,
        commit: Sha,
    },
    /// Push `commit` to the base as a fast-forward, never forced, then `landed`, `moved` or `refused`.
    Land {
        candidate: String,
        commit: Sha,
    },
    /// The candidate is over: cancel its run and delete its branch.
    Drop {
        candidate: String,
    },
    Tell {
        entry: Entry,
        told: Told,
    },
}

/// A build that could not be made: the part at `at` (from 1) could not be put onto the tip and the parts before it
/// (a conflict, a commit the remote does not have), `why` in git's terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unbuilt {
    pub at: usize,
    pub why: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The commit that holds the entry is being pushed to the base.
    Landing,
    Unknown,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Refusal::Landing => "it is landing now: the commit that holds it is being pushed",
            Refusal::Unknown => "no such entry in the queue",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum Outcome {
    /// `commit` on `candidate`'s branch passed the check.
    Green { commit: Sha, candidate: String },
    /// `commit`: the run that said so; none when it did not build.
    Red {
        why: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<Sha>,
    },
}

/// What the check said of these entries built in this order on the tip the queue holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Known {
    shas: Vec<Sha>,
    outcome: Outcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum Stage {
    Build,
    Test { commit: Sha },
    Land { commit: Sha },
}

/// What the queue waits for: the first `len` entries of the flight as `candidate`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trial {
    candidate: String,
    len: usize,
    stage: Stage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ended {
    entry: Entry,
    state: QueueState,
}

enum Next {
    Land {
        len: usize,
        commit: Sha,
        candidate: String,
    },
    Fail {
        why: String,
        commit: Option<Sha>,
    },
    Test {
        len: usize,
    },
}

/// The queue of one base branch. Everything in it is saved as it is (`Serialize`): `resume` asks again for what a
/// restart interrupted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandQueue {
    pub repo: RepoId,
    pub base: String,
    /// Part of every name the queue makes, so two computers' queues of one repository never share a branch.
    name: String,
    tuning: Tuning,
    /// The base tip the queue last read.
    tip: Sha,
    /// Waiting, oldest first.
    line: Vec<Entry>,
    /// The batch being worked on, in order.
    flight: Vec<Entry>,
    batch: Option<BatchId>,
    /// Every entry is about `tip`.
    memo: Vec<Known>,
    trial: Option<Trial>,
    ended: Vec<Ended>,
    seq: u64,
}

impl LandQueue {
    pub fn new(repo: RepoId, base: String, name: String, tip: Sha, tuning: Tuning) -> LandQueue {
        LandQueue {
            repo,
            base,
            name,
            tuning,
            tip,
            line: Vec::new(),
            flight: Vec::new(),
            batch: None,
            memo: Vec::new(),
            trial: None,
            ended: Vec::new(),
            seq: 0,
        }
    }

    pub fn tip(&self) -> &str {
        &self.tip
    }

    /// Nothing waits and nothing is worked on.
    pub fn is_empty(&self) -> bool {
        self.line.is_empty() && self.flight.is_empty()
    }

    fn fresh(&mut self, kind: char) -> String {
        self.seq += 1;
        format!("{}-{kind}{}", self.name, self.seq)
    }

    /// How many entries of the flight the push under way holds.
    fn landing(&self) -> usize {
        match &self.trial {
            Some(Trial {
                len,
                stage: Stage::Land { .. },
                ..
            }) => *len,
            _ => 0,
        }
    }

    fn known(&self, shas: &[Sha]) -> Option<&Outcome> {
        self.memo
            .iter()
            .find(|known| known.shas == shas)
            .map(|known| &known.outcome)
    }

    fn learn(&mut self, shas: Vec<Sha>, outcome: Outcome) {
        self.memo.retain(|known| known.shas != shas);
        self.memo.push(Known { shas, outcome });
    }

    /// Nothing known holds any more: the branches of what was green go too.
    fn forget(&mut self, out: &mut Vec<Effect>) {
        for known in self.memo.drain(..) {
            if let Outcome::Green { candidate, .. } = known.outcome {
                out.push(Effect::Drop { candidate });
            }
        }
    }

    /// Drops a build or a test under way; its answer, when it comes, is for no trial.
    fn abort(&mut self, out: &mut Vec<Effect>) {
        if let Some(trial) = self.trial.take() {
            out.push(Effect::Drop {
                candidate: trial.candidate,
            });
        }
    }

    fn end(&mut self, entry: Entry, state: QueueState) {
        self.ended.push(Ended { entry, state });
        let extra = self.ended.len().saturating_sub(ENDED_KEPT);
        self.ended.drain(..extra);
    }

    fn fail(&mut self, entry: Entry, why: String, commit: Option<Sha>, out: &mut Vec<Effect>) {
        self.end(entry.clone(), QueueState::Failed);
        out.push(Effect::Tell {
            entry,
            told: Told::Failed { why, commit },
        });
    }

    /// The next batch, when one is due: the oldest waiting entry and the later ones of its goal, oldest first.
    fn form(&mut self, now: Timestamp) -> bool {
        let Some(head) = self.line.first() else {
            return false;
        };
        let goal = head.goal.clone();
        let waited = now.saturating_sub(head.queued_at);
        let group = self.line.iter().filter(|entry| entry.goal == goal).count();
        if group < self.tuning.batch_size && waited < self.tuning.window_ms {
            return false;
        }
        let mut left = self.tuning.batch_size;
        let (taken, rest): (Vec<Entry>, Vec<Entry>) = std::mem::take(&mut self.line)
            .into_iter()
            .partition(|entry| {
                let take = left > 0 && entry.goal == goal;
                left -= usize::from(take);
                take
            });
        self.flight = taken;
        self.line = rest;
        self.batch = Some(self.fresh('b'));
        true
    }

    /// What to do with the flight, from what is known: land the longest prefix known green; else fail the first entry
    /// when it alone is known red; else test the whole flight, or the middle of the shortest prefix known red.
    fn next(&self) -> Next {
        let shas: Vec<Sha> = self.flight.iter().map(|entry| entry.sha.clone()).collect();
        let mut green = None;
        let mut red = None;
        for len in 1..=shas.len() {
            match self.known(&shas[..len]) {
                Some(Outcome::Green { commit, candidate }) => {
                    green = Some((len, commit.clone(), candidate.clone()));
                }
                Some(Outcome::Red { why, commit }) if red.is_none() => {
                    red = Some((len, why.clone(), commit.clone()));
                }
                _ => {}
            }
        }
        if let Some((len, commit, candidate)) = green {
            return Next::Land {
                len,
                commit,
                candidate,
            };
        }
        match red {
            Some((1, why, commit)) => Next::Fail { why, commit },
            Some((len, ..)) => Next::Test { len: len / 2 },
            None => Next::Test { len: shas.len() },
        }
    }

    /// Takes every step that needs no answer, until the queue waits for one or has nothing to do.
    fn advance(&mut self, now: Timestamp, out: &mut Vec<Effect>) {
        while self.trial.is_none() {
            if self.flight.is_empty() {
                self.batch = None;
                if !self.form(now) {
                    return;
                }
            }
            match self.next() {
                Next::Land {
                    len,
                    commit,
                    candidate,
                } => {
                    out.push(Effect::Land {
                        candidate: candidate.clone(),
                        commit: commit.clone(),
                    });
                    self.trial = Some(Trial {
                        candidate,
                        len,
                        stage: Stage::Land { commit },
                    });
                }
                Next::Fail { why, commit } => {
                    let entry = self.flight.remove(0);
                    self.fail(entry, why, commit, out);
                }
                Next::Test { len } => {
                    let candidate = self.fresh('c');
                    out.push(Effect::Build {
                        candidate: candidate.clone(),
                        tip: self.tip.clone(),
                        parts: self.flight[..len]
                            .iter()
                            .map(|entry| Part {
                                branch: entry.branch.clone(),
                                sha: entry.sha.clone(),
                            })
                            .collect(),
                    });
                    self.trial = Some(Trial {
                        candidate,
                        len,
                        stage: Stage::Build,
                    });
                }
            }
        }
    }

    /// Takes an entry out of the flight. A trial whose commit holds it is dropped; one that does not goes on.
    fn leave_flight(&mut self, index: usize, out: &mut Vec<Effect>) -> Result<Entry, Refusal> {
        if index < self.landing() {
            return Err(Refusal::Landing);
        }
        let entry = self.flight.remove(index);
        if self.trial.as_ref().is_some_and(|trial| index < trial.len) {
            self.abort(out);
        }
        Ok(entry)
    }

    /// A branch joins the line; the id is the entry's from now on. A branch already waiting keeps its place and takes
    /// the new commit; one in the flight leaves it and waits again, since its old commit is what is being tested.
    pub fn enqueue(&mut self, ask: Ask, now: Timestamp) -> Result<(String, Vec<Effect>), Refusal> {
        let mut out = Vec::new();
        if let Some(entry) = self
            .line
            .iter_mut()
            .find(|entry| entry.branch == ask.branch)
        {
            (entry.pr, entry.title, entry.sha, entry.goal, entry.origin) =
                (ask.pr, ask.title, ask.sha, ask.goal, ask.origin);
            let id = entry.id.clone();
            self.advance(now, &mut out);
            return Ok((id, out));
        }
        if let Some(index) = self
            .flight
            .iter()
            .position(|entry| entry.branch == ask.branch)
        {
            self.leave_flight(index, &mut out)?;
        }
        let id = self.fresh('e');
        self.line.push(Entry {
            id: id.clone(),
            branch: ask.branch,
            pr: ask.pr,
            title: ask.title,
            sha: ask.sha,
            goal: ask.goal,
            origin: ask.origin,
            queued_at: now,
        });
        self.advance(now, &mut out);
        Ok((id, out))
    }

    /// An entry is withdrawn. Refused while the commit that holds it is being pushed.
    pub fn remove(&mut self, id: &str, now: Timestamp) -> Result<Vec<Effect>, Refusal> {
        let mut out = Vec::new();
        let entry = if let Some(index) = self.line.iter().position(|entry| entry.id == id) {
            self.line.remove(index)
        } else if let Some(index) = self.flight.iter().position(|entry| entry.id == id) {
            self.leave_flight(index, &mut out)?
        } else {
            return Err(Refusal::Unknown);
        };
        self.end(entry, QueueState::Removed);
        self.advance(now, &mut out);
        Ok(out)
    }

    /// Time passed: a batch whose oldest entry waited long enough forms.
    pub fn tick(&mut self, now: Timestamp) -> Vec<Effect> {
        let mut out = Vec::new();
        self.advance(now, &mut out);
        out
    }

    /// When `tick` next has something to do, if only time is missing.
    pub fn next_wake(&self) -> Option<Timestamp> {
        if self.trial.is_some() || !self.flight.is_empty() {
            return None;
        }
        self.line
            .first()
            .map(|head| head.queued_at.saturating_add(self.tuning.window_ms))
    }

    /// The answer to `Build`. A build that could not be made is a red result for the prefix that ends at its part.
    pub fn built(
        &mut self,
        candidate: &str,
        result: Result<Sha, Unbuilt>,
        now: Timestamp,
    ) -> Vec<Effect> {
        let mut out = Vec::new();
        let Some(trial) = self
            .trial
            .as_mut()
            .filter(|trial| trial.candidate == candidate && trial.stage == Stage::Build)
        else {
            return out;
        };
        match result {
            Ok(commit) => {
                out.push(Effect::Test {
                    candidate: trial.candidate.clone(),
                    commit: commit.clone(),
                });
                trial.stage = Stage::Test { commit };
            }
            Err(unbuilt) => {
                let at = unbuilt.at.clamp(1, trial.len);
                let why = format!(
                    "{} could not be built onto {} with the entries before it: {}",
                    self.flight[at - 1].branch,
                    self.base,
                    unbuilt.why
                );
                let shas = self.flight[..at]
                    .iter()
                    .map(|entry| entry.sha.clone())
                    .collect();
                self.learn(shas, Outcome::Red { why, commit: None });
                self.abort(&mut out);
                self.advance(now, &mut out);
            }
        }
        out
    }

    /// The check's result for `commit`. Taken only when that commit is under test now.
    pub fn verdict(&mut self, commit: &str, green: bool, why: &str, now: Timestamp) -> Vec<Effect> {
        let mut out = Vec::new();
        let Some(trial) = self.trial.take_if(
            |trial| matches!(&trial.stage, Stage::Test { commit: tested } if tested == commit),
        ) else {
            return out;
        };
        let shas = self.flight[..trial.len]
            .iter()
            .map(|entry| entry.sha.clone())
            .collect();
        if green {
            self.learn(
                shas,
                Outcome::Green {
                    commit: commit.to_owned(),
                    candidate: trial.candidate,
                },
            );
        } else {
            self.learn(
                shas,
                Outcome::Red {
                    why: why.to_owned(),
                    commit: Some(commit.to_owned()),
                },
            );
            out.push(Effect::Drop {
                candidate: trial.candidate,
            });
        }
        self.advance(now, &mut out);
        out
    }

    /// A build or a run ended without an answer (cancelled, the runner lost): the same prefix is tried again.
    pub fn lost(&mut self, candidate: &str, now: Timestamp) -> Vec<Effect> {
        let mut out = Vec::new();
        let waits = self.trial.as_ref().is_some_and(|trial| {
            trial.candidate == candidate && !matches!(trial.stage, Stage::Land { .. })
        });
        if waits {
            self.abort(&mut out);
            self.advance(now, &mut out);
        }
        out
    }

    fn landing_trial(&mut self, candidate: &str) -> Option<(usize, Sha)> {
        let trial = self.trial.take_if(|trial| {
            trial.candidate == candidate && matches!(trial.stage, Stage::Land { .. })
        })?;
        match trial.stage {
            Stage::Land { commit } => Some((trial.len, commit)),
            _ => None,
        }
    }

    /// The answer to `Land` when the base holds the commit; `tip` is the base's tip as read then. What was known
    /// about longer combinations is carried onto the new tip only when the base is exactly that commit.
    pub fn landed(&mut self, candidate: &str, tip: Sha, now: Timestamp) -> Vec<Effect> {
        let mut out = Vec::new();
        let Some((len, commit)) = self.landing_trial(candidate) else {
            return out;
        };
        let done: Vec<Entry> = self.flight.drain(..len).collect();
        let exact = tip == commit;
        for known in std::mem::take(&mut self.memo) {
            match known.outcome {
                Outcome::Green { candidate, .. } => out.push(Effect::Drop { candidate }),
                Outcome::Red { .. } => {
                    let carried = exact
                        && known.shas.len() > len
                        && known.shas[..len]
                            .iter()
                            .eq(done.iter().map(|entry| &entry.sha));
                    if carried {
                        self.memo.push(Known {
                            shas: known.shas[len..].to_vec(),
                            outcome: known.outcome,
                        });
                    }
                }
            }
        }
        self.tip = tip;
        for entry in done {
            out.push(Effect::Tell {
                entry,
                told: Told::Landed {
                    commit: commit.clone(),
                },
            });
        }
        self.advance(now, &mut out);
        out
    }

    /// The answer to `Land` when the push was not a fast-forward: the base moved to `tip`.
    pub fn moved(&mut self, candidate: &str, tip: Sha, now: Timestamp) -> Vec<Effect> {
        let mut out = Vec::new();
        if self.landing_trial(candidate).is_none() {
            return out;
        }
        self.forget(&mut out);
        self.tip = tip;
        self.advance(now, &mut out);
        out
    }

    /// The answer to `Land` when the remote does not take the queue's push at all (a protected branch, no permission):
    /// nothing queued for this base can land, so every entry fails with the remote's words.
    pub fn refused(&mut self, candidate: &str, why: &str) -> Vec<Effect> {
        let mut out = Vec::new();
        if self.landing_trial(candidate).is_none() {
            return out;
        }
        self.forget(&mut out);
        self.batch = None;
        let why = format!("{} does not take the queue's push: {why}", self.base);
        let entries: Vec<Entry> = self.flight.drain(..).chain(self.line.drain(..)).collect();
        for entry in entries {
            self.fail(entry, why.clone(), None, &mut out);
        }
        out
    }

    /// The base's tip as someone read it. While the queue's own push is under way that push's answer decides, since
    /// the new tip may be that very push.
    pub fn base_read(&mut self, tip: Sha, now: Timestamp) -> Vec<Effect> {
        let mut out = Vec::new();
        if tip == self.tip || self.landing() > 0 {
            return out;
        }
        self.abort(&mut out);
        self.forget(&mut out);
        self.tip = tip;
        self.advance(now, &mut out);
        out
    }

    /// What a restart interrupted, asked again. Each is safe to do twice: a build of the same parts on the same tip, a
    /// run for a commit that has one, a push of a commit the base already holds.
    pub fn resume(&self) -> Vec<Effect> {
        let Some(trial) = &self.trial else {
            return Vec::new();
        };
        let candidate = trial.candidate.clone();
        vec![match &trial.stage {
            Stage::Build => Effect::Build {
                candidate,
                tip: self.tip.clone(),
                parts: self.flight[..trial.len]
                    .iter()
                    .map(|entry| Part {
                        branch: entry.branch.clone(),
                        sha: entry.sha.clone(),
                    })
                    .collect(),
            },
            Stage::Test { commit } => Effect::Test {
                candidate,
                commit: commit.clone(),
            },
            Stage::Land { commit } => Effect::Land {
                candidate,
                commit: commit.clone(),
            },
        }]
    }

    /// The queue as the page shows it: the flight, then the line, then what failed or was withdrawn of late.
    pub fn entries(&self) -> Vec<QueueEntry> {
        let landing = self.landing();
        let row = |entry: &Entry, position: usize, batch: Option<&BatchId>, state| QueueEntry {
            id: entry.id.clone(),
            repo: self.repo.clone(),
            base: self.base.clone(),
            branch: entry.branch.clone(),
            pr: entry.pr,
            title: entry.title.clone(),
            sha: entry.sha.clone(),
            lane: Lane::Land,
            position: position as u32,
            batch: batch.cloned(),
            state,
        };
        let flight = self.flight.iter().enumerate().map(|(index, entry)| {
            let state = if index < landing {
                QueueState::Landing
            } else {
                QueueState::Testing
            };
            row(entry, index + 1, self.batch.as_ref(), state)
        });
        let line = self.line.iter().enumerate().map(|(index, entry)| {
            row(
                entry,
                self.flight.len() + index + 1,
                None,
                QueueState::Waiting,
            )
        });
        let ended = self
            .ended
            .iter()
            .map(|ended| row(&ended.entry, 0, None, ended.state));
        flight.chain(line).chain(ended).collect()
    }
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
