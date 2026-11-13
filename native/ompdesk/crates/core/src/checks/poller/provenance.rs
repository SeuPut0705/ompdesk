//! Who started a run (`docs/design/check-control.md` §4): OMPdesk's own record, never read from a run's title, its
//! actor or anything else a caller could write. `origin` reaches the hub as main's word with every `start`; whoever
//! starts a run for it leaves a claim here, and the poller binds the claim to the run GitHub or the journal then
//! shows. A run nobody claimed was started by a person (a push, a click, a terminal): shown, never governed.

use std::collections::{HashMap, HashSet};

use crate::checks::contract::{GateId, InputsDigest, Lane, Origin, RunId, Timestamp};
use crate::checks::sources::{GithubRun, LocalRun};

/// GitHub's clock and this computer's may differ by this much.
const SKEW_MS: u64 = 120_000;
/// A dispatch whose run did not show within this long started none: its claim is dropped, so it never takes a
/// later run that is someone else's.
const EXPECT_FOR_MS: u64 = 600_000;

/// What the hub knows of a run it started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    /// The hub's id for the run, as `start` answered it.
    pub run_id: RunId,
    pub origin: Origin,
    pub lane: Lane,
    pub gate: Option<GateId>,
    pub digest: InputsDigest,
}

/// A dispatch just sent: GitHub answers it with no run id, so the run is known by what was dispatched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expected {
    pub repo: String,
    /// The workflow's file name (`ci.yml`).
    pub workflow: String,
    pub git_ref: String,
    /// When the dispatch was sent, on this computer's clock.
    pub after: Timestamp,
    pub claim: Claim,
}

#[derive(Debug, Default)]
pub struct Claims {
    github: HashMap<(String, u64), Claim>,
    /// Runs GitHub showed while nothing was expected of them: a person's, for good.
    nobodys: HashSet<(String, u64)>,
    expected: Vec<Expected>,
    /// By the journal's run id.
    local: HashMap<String, Claim>,
    /// A session's process tag (`OMP_GUI_SESSION_TAG`), as main maps it to the session.
    tags: HashMap<String, Origin>,
}

impl Claims {
    /// A dispatch is about to be sent for `expected.claim` (call this first, then dispatch: a run that shows before
    /// it is expected is taken for a person's). The first dispatched run of that workflow on that ref GitHub then
    /// shows is its; two dispatches of one workflow on one ref bind in the order they were sent.
    pub fn expect(&mut self, expected: Expected) {
        self.expected.push(expected);
    }

    /// A local check the hub started itself, by its journal's id.
    pub fn claim_local(&mut self, journal: &str, claim: Claim) {
        self.local.insert(journal.to_owned(), claim);
    }

    /// Main's word for which session each process tag belongs to, replacing the last.
    pub fn set_tags(&mut self, tags: HashMap<String, Origin>) {
        self.tags = tags;
    }

    /// The claim on a run GitHub shows. It is decided once, at the run's first sight: a dispatch that waits for
    /// such a run takes it, and a run nothing waited for stays unclaimed whatever is dispatched later.
    pub fn of_github(&mut self, repo: &str, run: &GithubRun, now: Timestamp) -> Option<&Claim> {
        self.expected
            .retain(|expected| now < expected.after + EXPECT_FOR_MS);
        let key = (repo.to_owned(), run.id);
        if !self.github.contains_key(&key) && !self.nobodys.contains(&key) {
            let waiting = (run.event == "workflow_dispatch")
                .then(|| {
                    self.expected.iter().position(|expected| {
                        expected.repo == repo
                            && expected.workflow == run.workflow
                            && expected.git_ref == run.branch
                            && run.created_at + SKEW_MS >= expected.after
                    })
                })
                .flatten();
            match waiting {
                Some(at) => {
                    let expected = self.expected.remove(at);
                    self.github.insert(key.clone(), expected.claim);
                }
                None => {
                    self.nobodys.insert(key.clone());
                }
            }
        }
        self.github.get(&key)
    }

    /// Decides the claims of the runs of one read of GitHub's list, oldest first: GitHub lists newest first, and two
    /// dispatches of one workflow on one ref that show in the same read must bind in the order they were sent.
    pub fn see_github(&mut self, repo: &str, runs: &[GithubRun], now: Timestamp) {
        let mut order: Vec<&GithubRun> = runs.iter().collect();
        order.sort_by_key(|run| (run.created_at, run.id));
        for run in order {
            self.of_github(repo, run, now);
        }
    }

    /// The claim on a local check: the hub's own start, else the session whose process tag the journal names.
    pub fn of_local(&self, run: &LocalRun) -> Option<Claim> {
        if let Some(claim) = self.local.get(&run.id) {
            return Some(claim.clone());
        }
        let origin = self.tags.get(run.session_tag.as_deref()?)?;
        Some(Claim {
            run_id: format!("local-{}", run.id),
            origin: origin.clone(),
            lane: Lane::Local,
            gate: None,
            digest: run.digest.clone(),
        })
    }

    /// Forgets what was decided of runs no longer known.
    pub fn keep_github(&mut self, known: impl Fn(&str, u64) -> bool) {
        self.github.retain(|(repo, run), _| known(repo, *run));
        self.nobodys.retain(|(repo, run)| known(repo, *run));
    }

    /// GitHub's run `run` runs again for the hub's new run (a rerun of its failed jobs, admitted as its own entry):
    /// from now on it is that run's.
    pub fn rebind(&mut self, repo: &str, run: u64, claim: Claim) {
        let key = (repo.to_owned(), run);
        self.nobodys.remove(&key);
        self.github.insert(key, claim);
    }

    /// A dispatch to `repo` still waits for its run.
    pub fn expects(&self, repo: &str) -> bool {
        self.expected.iter().any(|expected| expected.repo == repo)
    }

    /// The hub started GitHub's run `run` of `repo`.
    pub fn claimed(&self, repo: &str, run: u64) -> bool {
        self.github.contains_key(&(repo.to_owned(), run))
    }

    /// GitHub's run the hub's run id was bound to.
    pub fn github_of(&self, run_id: &str) -> Option<(String, u64)> {
        self.github
            .iter()
            .find(|(_, claim)| claim.run_id == run_id)
            .map(|(key, _)| key.clone())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn session(name: &str) -> Origin {
        Origin::Session {
            session: name.to_owned(),
            device: "local".to_owned(),
            goal: None,
        }
    }

    pub(crate) fn claim(run_id: &str, origin: Origin) -> Claim {
        Claim {
            run_id: run_id.to_owned(),
            origin,
            lane: Lane::Release,
            gate: Some("gate-mac".to_owned()),
            digest: "d1".to_owned(),
        }
    }

    pub(crate) fn dispatched(
        id: u64,
        workflow: &str,
        branch: &str,
        created_at: Timestamp,
    ) -> GithubRun {
        GithubRun {
            id,
            workflow: workflow.to_owned(),
            title: "ci [batch ]".to_owned(),
            branch: branch.to_owned(),
            sha: "0deaba0197f44aa752650f05a51164555".to_owned(),
            event: "workflow_dispatch".to_owned(),
            status: "queued".to_owned(),
            conclusion: None,
            attempt: 1,
            actor: "SeuPut0705".to_owned(),
            created_at,
            updated_at: created_at,
        }
    }

    const T0: Timestamp = 1_794_596_700_000;
    const REPO: &str = "SeuPut0705/ompdesk";

    fn expected(run_id: &str, origin: Origin, after: Timestamp) -> Expected {
        Expected {
            repo: REPO.to_owned(),
            workflow: "ci.yml".to_owned(),
            git_ref: "omp/agent/checks-poller".to_owned(),
            after,
            claim: claim(run_id, origin),
        }
    }

    #[test]
    fn a_dispatch_claims_the_first_new_run_of_its_workflow_and_ref_and_keeps_it() {
        let mut claims = Claims::default();
        claims.expect(expected("run-1", session("a"), T0));
        // Another workflow, another ref, a push, a run from before the dispatch: none of them is it.
        for other in [
            dispatched(1, "release.yml", "omp/agent/checks-poller", T0 + 2_000),
            dispatched(2, "ci.yml", "main", T0 + 2_000),
            GithubRun {
                event: "push".to_owned(),
                ..dispatched(3, "ci.yml", "omp/agent/checks-poller", T0 + 2_000)
            },
            dispatched(4, "ci.yml", "omp/agent/checks-poller", T0 - SKEW_MS - 1),
        ] {
            assert_eq!(
                claims.of_github(REPO, &other, T0 + 3_000),
                None,
                "{}",
                other.id
            );
        }
        // GitHub's clock a little behind this computer's is still after the dispatch.
        let run = dispatched(5, "ci.yml", "omp/agent/checks-poller", T0 - 30_000);
        assert_eq!(
            claims
                .of_github(REPO, &run, T0 + 3_000)
                .map(|claim| claim.run_id.as_str()),
            Some("run-1")
        );
        // It stays that run's, and no second run takes it.
        let later = dispatched(6, "ci.yml", "omp/agent/checks-poller", T0 + 4_000);
        assert_eq!(claims.of_github(REPO, &later, T0 + 5_000), None);
        assert_eq!(
            claims
                .of_github(REPO, &run, T0 + 3_600_000)
                .map(|claim| &claim.origin),
            Some(&session("a"))
        );
    }

    #[test]
    fn a_runs_own_words_claim_nothing() {
        let mut claims = Claims::default();
        // A title and an actor are what a caller writes: nothing is expected, so nothing is bound.
        let run = GithubRun {
            title: "ci [session a] run-1".to_owned(),
            actor: "session-a".to_owned(),
            ..dispatched(7, "ci.yml", "omp/agent/checks-poller", T0)
        };
        assert_eq!(claims.of_github(REPO, &run, T0), None);
    }

    #[test]
    fn two_dispatches_of_one_workflow_bind_in_the_order_sent() {
        let mut claims = Claims::default();
        claims.expect(expected("run-1", session("a"), T0));
        claims.expect(expected("run-2", session("b"), T0 + 500));
        let first = dispatched(8, "ci.yml", "omp/agent/checks-poller", T0 + 1_000);
        let second = dispatched(9, "ci.yml", "omp/agent/checks-poller", T0 + 1_500);
        assert_eq!(
            claims.of_github(REPO, &first, T0 + 2_000).unwrap().run_id,
            "run-1"
        );
        assert_eq!(
            claims.of_github(REPO, &second, T0 + 2_000).unwrap().run_id,
            "run-2"
        );
    }

    #[test]
    fn a_dispatch_that_started_nothing_takes_no_later_run() {
        let mut claims = Claims::default();
        claims.expect(expected("run-1", session("a"), T0));
        let late = dispatched(10, "ci.yml", "omp/agent/checks-poller", T0 + EXPECT_FOR_MS);
        assert_eq!(claims.of_github(REPO, &late, T0 + EXPECT_FOR_MS), None);
    }

    #[test]
    fn a_local_check_is_the_hubs_own_start_or_its_tags_session_or_nobodys() {
        let run = |id: &str, tag: Option<&str>| LocalRun {
            id: id.to_owned(),
            device: "local".to_owned(),
            cwd: "/w".to_owned(),
            argv: vec!["bun".to_owned(), "test".to_owned()],
            state: "running".to_owned(),
            started: T0,
            ended: None,
            head: None,
            digest: "d9".to_owned(),
            failed: Vec::new(),
            flaky: Vec::new(),
            saved_ms: 0,
            session_tag: tag.map(str::to_owned),
        };
        let mut claims = Claims::default();
        claims.claim_local("j1", claim("run-1", session("a")));
        claims.set_tags(HashMap::from([("tag-b".to_owned(), session("b"))]));
        assert_eq!(
            claims.of_local(&run("j1", Some("tag-b"))).unwrap().run_id,
            "run-1"
        );
        let tagged = claims.of_local(&run("j2", Some("tag-b"))).unwrap();
        assert_eq!(
            (
                tagged.run_id.as_str(),
                &tagged.origin,
                tagged.lane,
                tagged.digest.as_str()
            ),
            ("local-j2", &session("b"), Lane::Local, "d9")
        );
        assert_eq!(claims.of_local(&run("j3", Some("tag-of-no-session"))), None);
        assert_eq!(claims.of_local(&run("j4", None)), None);
    }
}
