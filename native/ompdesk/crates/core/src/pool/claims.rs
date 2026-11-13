//! What an agent's answer holds while its attachments go in (`ompdesk_session_answer` with `attachments`, main's
//! `TargetAnswer`): the question or the plan is CLAIMED in the tick that finds it open, and until the claim is released
//! or the answer lands, every other answer to it (the person's card, another agent, a paired device viewing the tab) is
//! refused as `being_answered`. The rule lives here once; the window dispatcher, a device viewing a window's tab and
//! `routeSideChannel` all ask the pool.
//!
//! A plan is identified by its file AND its generation (`Entry::plan_generation`, bumped for every proposal): stock
//! rewrites the same plan file for a revised proposal, so the path alone would let a stale approval reach the revision.

use serde_json::Value;

use super::state::{Ctx, R};
use crate::server::Fault;

pub(super) const ASK_HELD: &str = "An agent is answering this question right now";
pub(super) const PLAN_HELD: &str = "An agent is answering this plan right now";

fn claim_value(claim: Option<u64>) -> Value {
    claim.map_or(Value::Null, Value::from)
}

impl Ctx {
    /// Whether `id` is a question `tab`'s omp still waits on (raised, and not yet answered or cancelled).
    pub(super) fn is_request_open(&self, tab: &str, id: &str) -> bool {
        self.with(|pool| {
            let Some(entry) = pool.entry(tab) else {
                return false;
            };
            pool.request_owners.get(&id.to_string()) == Some(&entry.seq)
        })
    }

    /// Take the question; None when it is not open or already taken.
    pub(super) fn claim_request(&self, tab: &str, id: &str) -> Value {
        claim_value(self.with(|pool| {
            let open = pool
                .entry(tab)
                .is_some_and(|entry| pool.request_owners.get(&id.to_string()) == Some(&entry.seq));
            if !open || pool.claims.contains_key(id) {
                return None;
            }
            pool.claim_serial += 1;
            let claim = pool.claim_serial;
            pool.claims.insert(id.to_owned(), claim);
            Some(claim)
        }))
    }

    /// Give a claimed question back unanswered: it stays open for anyone.
    pub(super) fn release_request(&self, id: &str, claim: u64) {
        self.with(|pool| {
            if pool.claims.get(id) == Some(&claim) {
                pool.claims.remove(id);
            }
        });
    }

    /// Refuses an answer to a claimed question unless it is the holder's (`claim`).
    pub(super) fn guard_ask(&self, id: &str, claim: Option<u64>) -> R<()> {
        let held = self.with(|pool| pool.claims.get(id).copied());
        match held {
            Some(held) if Some(held) != claim => Err(Fault::new("being_answered", ASK_HELD)),
            _ => Ok(()),
        }
    }

    /// Take the plan `tab` waits on when it is the proposal at `file` of `generation`; None otherwise or when held.
    pub(super) fn claim_plan(&self, tab: &str, file: &str, generation: u64) -> Value {
        claim_value(self.with(|pool| {
            let plan = pool.entry(tab).filter(|entry| {
                entry.plan_generation == generation
                    && entry
                        .plan_proposal
                        .as_ref()
                        .is_some_and(|(_, path)| path == file)
            })?;
            let generation = plan.plan_generation;
            if pool.plan_claims.contains_key(tab) {
                return None;
            }
            pool.claim_serial += 1;
            let claim = pool.claim_serial;
            pool.plan_claims.insert(tab.to_owned(), (generation, claim));
            Some(claim)
        }))
    }

    /// Whether the plan `claim` took is still the pending one (a revision is another generation).
    pub(super) fn plan_still_claimed(&self, tab: &str, claim: u64) -> bool {
        self.with(|pool| {
            let Some((generation, held)) = pool.plan_claims.get(tab).copied() else {
                return false;
            };
            held == claim
                && pool.entry(tab).is_some_and(|entry| {
                    entry.plan_proposal.is_some() && entry.plan_generation == generation
                })
        })
    }

    pub(super) fn release_plan(&self, tab: &str, claim: u64) {
        self.with(|pool| {
            if pool.plan_claims.get(tab).map(|(_, held)| *held) == Some(claim) {
                pool.plan_claims.remove(tab);
            }
        });
    }

    /// Refuses an approve or reject of a plan an agent's approval holds; `own` is the claiming step's own approval.
    pub(super) fn guard_plan(&self, tab: &str, own: bool) -> R<()> {
        if !own && self.with(|pool| pool.plan_claims.contains_key(tab)) {
            return Err(Fault::new("being_answered", PLAN_HELD));
        }
        Ok(())
    }
}
