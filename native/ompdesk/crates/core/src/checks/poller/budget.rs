//! What the poller may spend (`docs/design/check-control.md` §4, §9.2): its own allowance of about 2 000 requests an
//! hour out of the account's 5 000, spread evenly so a busy hour slows every read a little rather than stopping all
//! of them at its end, and a step back whenever the account's shared quota runs low. The other 3 000 are the
//! person's and their sessions' own `gh`; the poller sees what they left in every answer's headers, a `304` included.

use super::wire::Rate;
use crate::checks::contract::Timestamp as Ms;

/// Requests an hour at full pace.
pub const PER_HOUR: u64 = 2_000;
/// Requests that may go out at once after a quiet spell (the first round over a busy repository).
const BURST: u64 = 60;
/// Under this share of the account's quota the poller spends at a quarter of its pace.
const SLOW_UNDER_PERCENT: u64 = 25;
const SLOW_FACTOR: u64 = 4;
/// Under this share it spends nothing until the quota is given back: what is left is the person's.
const STOP_UNDER_PERCENT: u64 = 5;

const HOUR: Ms = 3_600_000;

/// Why nothing may be asked right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Held {
    /// The account's quota is nearly spent; `until` is when GitHub gives it back.
    Quota {
        remaining: u32,
        limit: u32,
        until: Ms,
    },
    /// GitHub asked for a pause (`retry-after`, a secondary limit) or keeps failing.
    Pause { until: Ms },
}

impl Held {
    pub fn until(&self) -> Ms {
        match self {
            Held::Quota { until, .. } | Held::Pause { until } => *until,
        }
    }
}

/// A token bucket kept as one time: `spent_until` is when the allowance taken so far is paid off. A request is
/// allowed while that lies less than `BURST` requests ahead, and pushes it one request's share further.
#[derive(Debug, Default)]
pub struct Budget {
    spent_until: Ms,
    /// What the last request was charged, given back when it turns out to have cost nothing.
    last_share: Ms,
    rate: Option<Rate>,
    pause_until: Ms,
}

impl Budget {
    /// The quota as last read, forgotten once its window ended.
    fn rate(&self, now: Ms) -> Option<Rate> {
        self.rate.filter(|rate| now < rate.reset_at)
    }

    fn under(rate: Rate, percent: u64) -> bool {
        u64::from(rate.remaining) * 100 < u64::from(rate.limit) * percent
    }

    /// One request's share of the hour at the present pace.
    fn share(&self, now: Ms) -> Ms {
        let slow = self
            .rate(now)
            .is_some_and(|rate| Budget::under(rate, SLOW_UNDER_PERCENT));
        HOUR / PER_HOUR * if slow { SLOW_FACTOR } else { 1 }
    }

    /// Why nothing may be asked now, when that is so.
    pub fn held(&self, now: Ms) -> Option<Held> {
        if let Some(rate) = self.rate(now)
            && Budget::under(rate, STOP_UNDER_PERCENT)
        {
            return Some(Held::Quota {
                remaining: rate.remaining,
                limit: rate.limit,
                until: rate.reset_at.max(self.pause_until),
            });
        }
        (now < self.pause_until).then_some(Held::Pause {
            until: self.pause_until,
        })
    }

    /// Takes one request's allowance; false when none is left right now.
    pub fn take(&mut self, now: Ms) -> bool {
        if self.held(now).is_some() {
            return false;
        }
        let share = self.share(now);
        let ahead = self.spent_until.saturating_sub(now);
        if ahead + share > BURST * share {
            return false;
        }
        self.spent_until = self.spent_until.max(now) + share;
        self.last_share = share;
        true
    }

    /// Gives back the allowance of a request that cost nothing: a `304`, or one that never left this computer.
    pub fn refund(&mut self) {
        self.spent_until = self.spent_until.saturating_sub(self.last_share);
    }

    /// When the next request may go out: `now` when one may, else when the allowance or the hold allows it.
    pub fn next(&self, now: Ms) -> Ms {
        if let Some(held) = self.held(now) {
            return held.until();
        }
        let share = self.share(now);
        (self.spent_until + share)
            .saturating_sub(BURST * share)
            .max(now)
    }

    /// What an answer's headers said of the account's quota.
    pub fn observe(&mut self, rate: Rate) {
        self.rate = Some(rate);
    }

    /// Nothing goes out before `until`.
    pub fn pause(&mut self, until: Ms) {
        self.pause_until = self.pause_until.max(until);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: Ms = 1_794_590_000_000;

    fn rate(remaining: u32, reset_at: Ms) -> Rate {
        Rate {
            limit: 5_000,
            remaining,
            reset_at,
        }
    }

    /// Asks as often as allowed for `span`, a request every `step`; answers how many went out.
    fn spend(budget: &mut Budget, from: Ms, span: Ms, step: Ms) -> u64 {
        (from..from + span)
            .step_by(step as usize)
            .filter(|now| budget.take(*now))
            .count() as u64
    }

    #[test]
    fn a_busy_hour_spends_the_allowance_and_no_more() {
        let mut budget = Budget::default();
        // A request wanted every 100 ms: 36 000 an hour.
        let first = spend(&mut budget, T0, HOUR, 100);
        // The burst at once, then one request per share: the hour's last share falls on the next hour's start.
        assert_eq!(first, PER_HOUR + BURST - 1);
        // No quiet spell before the second hour, so no burst in it.
        let second = spend(&mut budget, T0 + HOUR, HOUR, 100);
        assert_eq!(second, PER_HOUR);
    }

    #[test]
    fn the_allowance_is_spread_over_the_hour() {
        let mut budget = Budget::default();
        spend(&mut budget, T0, HOUR, 100);
        // Any minute of a spent hour still lets a minute's share through: nothing waits for the hour to end.
        for minute in 0..60 {
            let sent = spend(&mut budget, T0 + HOUR + minute * 60_000, 60_000, 100);
            assert!((33..=34).contains(&sent), "minute {minute}: {sent}");
        }
    }

    #[test]
    fn a_request_that_cost_nothing_is_given_back() {
        let mut budget = Budget::default();
        for _ in 0..10 * (PER_HOUR + BURST) {
            assert!(budget.take(T0));
            budget.refund();
        }
        // The allowance is whole: a full burst still goes out, and then no more.
        assert_eq!(
            (0..2 * BURST).filter(|_| budget.take(T0)).count() as u64,
            BURST
        );
        assert_eq!(budget.next(T0), T0 + HOUR / PER_HOUR);
    }

    #[test]
    fn a_low_shared_quota_slows_the_poller_to_a_quarter() {
        let mut budget = Budget::default();
        let reset = T0 + 3 * HOUR;
        budget.observe(rate(1_249, reset));
        spend(&mut budget, T0, HOUR, 100);
        assert_eq!(
            spend(&mut budget, T0 + HOUR, HOUR, 100),
            PER_HOUR / SLOW_FACTOR
        );
        // At a quarter of the quota and above, full pace.
        let mut budget = Budget::default();
        budget.observe(rate(1_250, reset));
        spend(&mut budget, T0, HOUR, 100);
        assert_eq!(spend(&mut budget, T0 + HOUR, HOUR, 100), PER_HOUR);
    }

    #[test]
    fn a_nearly_spent_quota_stops_the_poller_until_github_gives_it_back() {
        let mut budget = Budget::default();
        let reset = T0 + 20 * 60_000;
        budget.observe(rate(249, reset));
        assert!(!budget.take(T0));
        assert_eq!(
            budget.held(T0),
            Some(Held::Quota {
                remaining: 249,
                limit: 5_000,
                until: reset
            })
        );
        assert_eq!(budget.next(T0), reset);
        assert!(!budget.take(reset - 1));
        // The window ended: the old reading says nothing of the new one.
        assert_eq!(budget.held(reset), None);
        assert!(budget.take(reset));

        let mut budget = Budget::default();
        budget.observe(rate(250, reset));
        assert!(budget.take(T0));
    }

    #[test]
    fn a_pause_holds_everything_until_it_ends_and_never_shortens() {
        let mut budget = Budget::default();
        budget.pause(T0 + 60_000);
        budget.pause(T0 + 1_000);
        assert_eq!(
            budget.held(T0 + 59_999),
            Some(Held::Pause { until: T0 + 60_000 })
        );
        assert!(!budget.take(T0 + 59_999));
        assert_eq!(budget.next(T0), T0 + 60_000);
        assert!(budget.take(T0 + 60_000));
    }
}
