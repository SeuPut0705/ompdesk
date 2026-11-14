//! Who started a run (`docs/design/check-control.md` §4): OMPdesk's own record, never read from a run's title, its
//! actor or anything else a caller could write. `origin` reaches the hub as main's word with every `start`; whoever
//! starts a run for it leaves a claim here, and the poller binds the claim to the run GitHub or the journal then
//! shows. A run nobody claimed was started by a person (a push, a click, a terminal): shown, never governed.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::checks::contract::{GateId, InputsDigest, Lane, Origin, RunId, Timestamp};
use crate::checks::sources::{GithubRun, LocalRun};

/// What the hub knows of a run it started.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    /// The hub's id for the run, as `start` answered it.
    pub run_id: RunId,
    pub origin: Origin,
    pub lane: Lane,
    pub gate: Option<GateId>,
    pub digest: InputsDigest,
}

/// An authoritative dispatch receipt. Workflow/ref/timing and a run's own words cannot establish ownership.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubBinding {
    pub repo: String,
    pub run: u64,
    pub attempt: u32,
    pub claim: Claim,
}

#[derive(Debug, Default)]
pub struct Claims {
    github: HashMap<(String, u64), GithubBinding>,
    /// By the journal's run id.
    local: HashMap<String, Claim>,
    /// A session's process tag (`OMP_GUI_SESSION_TAG`), as main maps it to the session.
    tags: HashMap<String, Origin>,
}

impl Claims {
    pub fn bind(&mut self, binding: GithubBinding) {
        let key = (binding.repo.clone(), binding.run);
        if self
            .github
            .get(&key)
            .is_none_or(|known| known.attempt <= binding.attempt)
        {
            self.github.insert(key, binding);
        }
    }

    /// A local check the hub started itself, by its journal's id.
    pub fn claim_local(&mut self, journal: &str, claim: Claim) {
        self.local.insert(journal.to_owned(), claim);
    }

    /// Main's word for which session each process tag belongs to, replacing the last.
    pub fn set_tags(&mut self, tags: HashMap<String, Origin>) {
        self.tags = tags;
    }

    /// Only an exact run id returned by a write (or its persisted receipt) can establish ownership.
    pub fn of_github(&self, repo: &str, run: &GithubRun, _now: Timestamp) -> Option<&Claim> {
        self.github
            .get(&(repo.to_owned(), run.id))
            .filter(|binding| binding.attempt == run.attempt)
            .map(|binding| &binding.claim)
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

    /// A receipt whose run is not in the list yet keeps its repository followed.
    pub fn unseen(&self, repo: &str, known: impl Fn(u64) -> bool) -> bool {
        self.github.keys().any(|(of, id)| of == repo && !known(*id))
    }

    /// The hub started GitHub's run `run` of `repo`.
    pub fn claimed(&self, repo: &str, run: u64) -> bool {
        self.github.contains_key(&(repo.to_owned(), run))
    }

    /// GitHub's run the hub's run id was bound to.
    pub fn github_of(&self, run_id: &str) -> Option<(String, u64)> {
        self.github
            .iter()
            .find(|(_, binding)| binding.claim.run_id == run_id)
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

    #[test]
    fn only_the_authoritative_receipt_claims_a_run_regardless_of_list_order_or_clock() {
        let mut claims = Claims::default();
        claims.bind(GithubBinding {
            repo: REPO.into(),
            run: 5,
            attempt: 1,
            claim: claim("run-1", session("a")),
        });
        for id in [9, 4, 1, 6] {
            let foreign = dispatched(id, "ci.yml", "omp/agent/checks-poller", T0);
            assert_eq!(claims.of_github(REPO, &foreign, T0), None);
        }
        let ours = dispatched(5, "ci.yml", "omp/agent/checks-poller", T0 - 30_000);
        assert_eq!(claims.of_github(REPO, &ours, T0).unwrap().run_id, "run-1");
        assert_eq!(claims.of_github("other/repo", &ours, T0), None);
    }

    #[test]
    fn a_runs_own_words_claim_nothing() {
        let claims = Claims::default();
        // A title and an actor are what a caller writes: nothing is expected, so nothing is bound.
        let run = GithubRun {
            title: "ci [session a] run-1".to_owned(),
            actor: "session-a".to_owned(),
            ..dispatched(7, "ci.yml", "omp/agent/checks-poller", T0)
        };
        assert_eq!(claims.of_github(REPO, &run, T0), None);
    }

    #[test]
    fn two_dispatch_receipts_are_not_swapped_when_newest_run_is_seen_first() {
        let mut claims = Claims::default();
        for (run, id, who) in [(8, "run-1", "a"), (9, "run-2", "b")] {
            claims.bind(GithubBinding {
                repo: REPO.into(),
                run,
                attempt: 1,
                claim: claim(id, session(who)),
            });
        }
        for (run, id) in [(9, "run-2"), (8, "run-1")] {
            assert_eq!(
                claims
                    .of_github(
                        REPO,
                        &dispatched(run, "ci.yml", "omp/agent/checks-poller", T0),
                        T0
                    )
                    .unwrap()
                    .run_id,
                id
            );
        }
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

    #[test]
    fn a_foreign_dispatch_in_the_same_poll_window_never_takes_a_hub_claim() {
        let mut claims = Claims::default();
        claims.bind(GithubBinding {
            repo: REPO.into(),
            run: 91,
            attempt: 1,
            claim: claim("ours", session("a")),
        });
        let person = dispatched(90, "ci.yml", "omp/agent/checks-poller", T0 - 1);
        assert_eq!(claims.of_github(REPO, &person, T0 + 1_000), None);
        assert!(!claims.claimed(REPO, person.id));
    }
}

#[cfg(test)]
mod attempt_tests {
    use super::tests::{claim, dispatched, session};
    use super::*;

    #[test]
    fn raw_later_attempts_never_inherit_a_prior_attempts_claim_and_restore_order_cannot_swap_it() {
        let mut claims = Claims::default();
        for attempt in [2, 1] {
            claims.bind(GithubBinding {
                repo: "o/app".into(),
                run: 77,
                attempt,
                claim: claim(&format!("ours-{attempt}"), session("a")),
            });
        }
        let mut run = dispatched(77, "ci.yml", "feat", 1);
        assert!(claims.of_github("o/app", &run, 1).is_none());
        run.attempt = 2;
        assert_eq!(claims.of_github("o/app", &run, 1).unwrap().run_id, "ours-2");
        run.attempt = 3;
        assert!(claims.of_github("o/app", &run, 1).is_none());
    }
}
