use super::*;

struct Rig {
    policy: Policy<&'static str>,
    effects: Vec<Effect<&'static str>>,
    now: u64,
}

impl Rig {
    fn new() -> Self {
        Self {
            policy: Policy::new(Timing::default()),
            effects: Vec::new(),
            now: 0,
        }
    }
    fn acquire(&mut self, tab: &'static str, request: &str) {
        self.policy.acquire(
            tab,
            request.into(),
            self.now,
            1_000 + self.now as i64,
            &mut self.effects,
        );
    }
    fn holder(&self) -> Option<&'static str> {
        self.policy.holder().map(|lease| lease.target)
    }
    fn queue(&self) -> Vec<&'static str> {
        self.policy.queue().copied().collect()
    }
    fn grants(&self) -> Vec<(&'static str, &str, bool)> {
        self.effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Grant {
                    lease,
                    request,
                    waited,
                } => Some((lease.target, request.as_str(), *waited)),
                Effect::Revoke(_) | Effect::StopWaiter(_) => None,
            })
            .collect()
    }
    fn attempt(&self) -> Arc<Attempt<&'static str>> {
        self.effects
            .iter()
            .rev()
            .find_map(|effect| match effect {
                Effect::Revoke(attempt) => Some(Arc::clone(attempt)),
                Effect::Grant { .. } | Effect::StopWaiter(_) => None,
            })
            .unwrap()
    }
    fn stop(&mut self, tab: &'static str) {
        self.policy
            .depart(&tab, Reason::Stop, self.now, &mut self.effects);
    }
    fn answer(&mut self, attempt: &Arc<Attempt<&'static str>>, confirmed: bool) {
        self.policy.answered(
            attempt,
            confirmed,
            self.now,
            1_000 + self.now as i64,
            &mut self.effects,
        );
    }
    fn release(&mut self, tab: &'static str) {
        self.policy
            .release(&tab, self.now, 1_000 + self.now as i64, &mut self.effects);
    }
    fn advance(&mut self, ms: u64) {
        self.now += ms;
        self.policy.tick(self.now, &mut self.effects);
    }
}

#[test]
fn grants_fifo_all_requests_and_only_waited_grants_are_stale() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.acquire("b", "b1");
    rig.acquire("c", "c1");
    rig.acquire("b", "b2");
    assert_eq!(rig.queue(), ["b", "c"]);
    assert_eq!(rig.grants(), [("a", "a1", false)]);
    assert_eq!(rig.policy.holder().unwrap().since, 1_000);
    rig.stop("a");
    assert_eq!(rig.holder(), Some("a"));
    rig.answer(&rig.attempt(), true);
    assert_eq!(rig.holder(), Some("b"));
    assert_eq!(rig.queue(), ["c"]);
    assert_eq!(
        rig.grants(),
        [("a", "a1", false), ("b", "b1", true), ("b", "b2", true)]
    );
    rig.release("b");
    assert_eq!(rig.holder(), Some("c"));
}

#[test]
fn own_runs_and_touch_rearm_only_the_active_holders_lease() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.acquire("b", "b1");
    rig.advance(LEASE_MS - 1);
    rig.acquire("a", "a2");
    rig.advance(LEASE_MS - 1);
    rig.policy.touch(&"a", rig.now);
    rig.policy.touch(&"b", rig.now);
    rig.advance(LEASE_MS - 1);
    assert!(
        rig.effects
            .iter()
            .all(|effect| !matches!(effect, Effect::Revoke(_)))
    );
    rig.advance(1);
    assert_eq!(rig.attempt().reason, Reason::Lease);
    rig.answer(&rig.attempt(), true);
    assert_eq!(rig.holder(), Some("b"));
    assert_eq!(rig.policy.deadline(), Some(rig.now + LEASE_MS));
}

#[test]
fn release_and_confirmed_death_do_not_require_a_revoke() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.acquire("b", "b1");
    rig.acquire("c", "c1");
    rig.release("b");
    rig.release("unknown");
    assert_eq!(rig.queue(), ["c"]);
    rig.release("a");
    assert_eq!(rig.holder(), Some("c"));
    rig.policy.exited(&"c", rig.now, 1_000, &mut rig.effects);
    assert_eq!(rig.holder(), None);
    assert_eq!(rig.policy.deadline(), None);
    assert!(
        rig.effects
            .iter()
            .all(|effect| !matches!(effect, Effect::Revoke(_)))
    );
}

#[test]
fn failed_and_silent_revokes_never_grant_and_retry_until_confirmed() {
    for silent in [false, true] {
        let mut rig = Rig::new();
        rig.acquire("a", "a1");
        rig.acquire("b", "b1");
        rig.stop("a");
        let first = rig.attempt();
        if silent {
            rig.advance(REVOKE_TIMEOUT_MS - 1);
            assert!(!rig.policy.failed());
            rig.advance(1);
        } else {
            rig.answer(&first, false);
        }
        assert!(rig.policy.failed());
        rig.acquire("a", "a2");
        rig.policy.touch(&"a", rig.now);
        assert_eq!(rig.queue(), ["b", "a"]);
        assert_eq!(rig.grants(), [("a", "a1", false)]);
        rig.advance(RETRY_MS);
        let retry = rig.attempt();
        assert!(!Arc::ptr_eq(&first, &retry));
        assert!(rig.policy.failed());
        rig.answer(&retry, true);
        assert_eq!(rig.holder(), Some("b"));
        assert_eq!(rig.grants().last(), Some(&("b", "b1", true)));
    }
}

#[test]
fn duplicate_stop_and_release_do_not_bypass_pending_revoke() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.acquire("b", "b1");
    rig.stop("a");
    let first = rig.attempt();
    rig.stop("a");
    rig.release("a");
    assert!(Arc::ptr_eq(&first, &rig.attempt()));
    assert!(rig.policy.revoking(&first.lease));
    assert_eq!(rig.holder(), Some("a"));
    rig.acquire("c", "c1");
    rig.acquire("a", "a2");
    assert_eq!(rig.queue(), ["b", "c", "a"]);
    rig.answer(&first, true);
    assert_eq!(rig.holder(), Some("b"));
}

#[test]
fn late_confirmation_counts_but_never_frees_a_later_ownership() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.acquire("b", "b1");
    rig.stop("a");
    let old = rig.attempt();
    rig.advance(REVOKE_TIMEOUT_MS);
    assert!(rig.policy.failed());
    rig.answer(&old, true);
    assert_eq!(rig.holder(), Some("b"));
    rig.release("b");
    rig.acquire("a", "a2");
    let current = Arc::clone(rig.policy.holder().unwrap());
    rig.answer(&old, true);
    assert!(Arc::ptr_eq(&current, rig.policy.holder().unwrap()));
    assert_eq!(
        rig.grants()
            .iter()
            .filter(|(_, request, _)| *request == "a2")
            .count(),
        1
    );
}

#[test]
fn old_failed_reply_does_not_end_the_new_revoke_attempt() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.stop("a");
    let old = rig.attempt();
    rig.advance(REVOKE_TIMEOUT_MS);
    rig.policy.retry(rig.now, &mut rig.effects);
    let retry = rig.attempt();
    rig.answer(&old, false);
    assert!(rig.policy.revoking(&retry.lease));
    rig.answer(&retry, true);
    assert_eq!(rig.holder(), None);
}

#[test]
fn killed_or_exited_receipt_is_bound_to_its_original_lease() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.acquire("b", "b1");
    let first = Arc::clone(rig.policy.holder().unwrap());
    rig.stop("a");
    rig.answer(&rig.attempt(), false);
    assert_eq!(rig.holder(), Some("a"));
    rig.policy
        .confirmed(&first, rig.now, 1_000, &mut rig.effects);
    assert_eq!(rig.holder(), Some("b"));
    rig.release("b");
    rig.acquire("a", "a2");
    rig.policy
        .confirmed(&first, rig.now, 1_000, &mut rig.effects);
    assert_eq!(rig.holder(), Some("a"));
}

#[test]
fn closing_and_stopping_waiters_preserve_the_other_fifo_entries() {
    let mut rig = Rig::new();
    rig.acquire("a", "a1");
    rig.acquire("b", "b1");
    rig.acquire("c", "c1");
    rig.policy
        .depart(&"b", Reason::Closed, rig.now, &mut rig.effects);
    assert_eq!(rig.queue(), ["c"]);
    assert!(
        rig.effects
            .iter()
            .all(|effect| !matches!(effect, Effect::StopWaiter(_)))
    );
    rig.stop("c");
    assert!(
        rig.effects
            .iter()
            .any(|effect| matches!(effect, Effect::StopWaiter("c")))
    );
    assert!(rig.queue().is_empty());
    rig.stop("unknown");
    assert_eq!(rig.holder(), Some("a"));
}
