use std::collections::VecDeque;
use std::sync::Arc;

pub const LEASE_MS: u64 = 120_000;
pub const REVOKE_TIMEOUT_MS: u64 = 10_000;
pub const RETRY_MS: u64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Stop,
    Closed,
    Lease,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Closed => "closed",
            Self::Lease => "lease",
        }
    }
}

#[derive(Clone, Copy)]
pub struct Timing {
    pub lease_ms: u64,
    pub revoke_timeout_ms: u64,
    pub retry_ms: u64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            lease_ms: LEASE_MS,
            revoke_timeout_ms: REVOKE_TIMEOUT_MS,
            retry_ms: RETRY_MS,
        }
    }
}

pub struct Lease<T> {
    pub target: T,
    pub since: i64,
}

pub struct Attempt<T> {
    pub lease: Arc<Lease<T>>,
    pub reason: Reason,
}

pub enum Effect<T> {
    Grant {
        lease: Arc<Lease<T>>,
        request: String,
        waited: bool,
    },
    Revoke(Arc<Attempt<T>>),
    StopWaiter(T),
}

enum Phase<T> {
    Active(u64),
    Revoking {
        attempt: Arc<Attempt<T>>,
        until: u64,
        failed: bool,
    },
    Failed {
        reason: Reason,
        retry_at: u64,
    },
}

struct Held<T> {
    lease: Arc<Lease<T>>,
    phase: Phase<T>,
}

struct Waiter<T> {
    target: T,
    requests: Vec<String>,
}

/// The same FIFO and confirmed-revoke contract as src/main/desktop-slot.ts.
/// Arc identity fences a late answer from an earlier ownership of the same execution.
pub struct Policy<T> {
    holder: Option<Held<T>>,
    queue: VecDeque<Waiter<T>>,
    timing: Timing,
}

impl<T: Clone + Eq> Policy<T> {
    pub fn new(timing: Timing) -> Self {
        Self {
            holder: None,
            queue: VecDeque::new(),
            timing,
        }
    }

    pub fn holder(&self) -> Option<&Arc<Lease<T>>> {
        self.holder.as_ref().map(|holder| &holder.lease)
    }

    pub fn failed(&self) -> bool {
        self.holder
            .as_ref()
            .is_some_and(|holder| match holder.phase {
                Phase::Active(_) => false,
                Phase::Revoking { failed, .. } => failed,
                Phase::Failed { .. } => true,
            })
    }

    pub fn queue(&self) -> impl Iterator<Item = &T> {
        self.queue.iter().map(|waiter| &waiter.target)
    }

    pub fn contains(&self, target: &T) -> bool {
        self.holder().is_some_and(|lease| &lease.target == target)
            || self.queue.iter().any(|waiter| &waiter.target == target)
    }

    pub fn deadline(&self) -> Option<u64> {
        self.holder.as_ref().map(|holder| match holder.phase {
            Phase::Active(until) | Phase::Revoking { until, .. } => until,
            Phase::Failed { retry_at, .. } => retry_at,
        })
    }

    pub fn revoking(&self, lease: &Arc<Lease<T>>) -> bool {
        self.holder.as_ref().is_some_and(|held| {
            Arc::ptr_eq(&held.lease, lease) && matches!(held.phase, Phase::Revoking { .. })
        })
    }

    pub fn acquire(
        &mut self,
        target: T,
        request: String,
        now: u64,
        wall: i64,
        effects: &mut Vec<Effect<T>>,
    ) -> bool {
        if let Some(holder) = &mut self.holder {
            if holder.lease.target == target && matches!(holder.phase, Phase::Active(_)) {
                holder.phase = Phase::Active(now.saturating_add(self.timing.lease_ms));
                effects.push(Effect::Grant {
                    lease: Arc::clone(&holder.lease),
                    request,
                    waited: false,
                });
                return false;
            }
            if let Some(waiter) = self.queue.iter_mut().find(|waiter| waiter.target == target) {
                waiter.requests.push(request);
            } else {
                self.queue.push_back(Waiter {
                    target,
                    requests: vec![request],
                });
            }
        } else {
            let lease = self.hold(target, now, wall);
            effects.push(Effect::Grant {
                lease,
                request,
                waited: false,
            });
        }
        true
    }

    pub fn touch(&mut self, target: &T, now: u64) {
        if let Some(holder) = &mut self.holder
            && &holder.lease.target == target
            && matches!(holder.phase, Phase::Active(_))
        {
            holder.phase = Phase::Active(now.saturating_add(self.timing.lease_ms));
        }
    }

    pub fn release(
        &mut self,
        target: &T,
        now: u64,
        wall: i64,
        effects: &mut Vec<Effect<T>>,
    ) -> bool {
        if let Some(holder) = &self.holder
            && &holder.lease.target == target
        {
            if matches!(holder.phase, Phase::Revoking { .. }) {
                return false;
            }
            self.advance(now, wall, effects);
            return true;
        }
        self.drop_waiter(target)
    }

    pub fn depart(
        &mut self,
        target: &T,
        reason: Reason,
        now: u64,
        effects: &mut Vec<Effect<T>>,
    ) -> bool {
        if self.holder().is_some_and(|holder| &holder.target == target) {
            self.start(reason, now, effects);
            return false;
        }
        let removed = self.drop_waiter(target);
        if removed && reason == Reason::Stop {
            effects.push(Effect::StopWaiter(target.clone()));
        }
        removed
    }

    pub fn exited(
        &mut self,
        target: &T,
        now: u64,
        wall: i64,
        effects: &mut Vec<Effect<T>>,
    ) -> bool {
        if self.holder().is_some_and(|holder| &holder.target == target) {
            self.advance(now, wall, effects);
            return true;
        }
        self.drop_waiter(target)
    }

    pub fn retry(&mut self, now: u64, effects: &mut Vec<Effect<T>>) {
        if let Some(Held {
            phase: Phase::Failed { reason, .. },
            ..
        }) = &self.holder
        {
            self.start(*reason, now, effects);
        }
    }

    pub fn tick(&mut self, now: u64, effects: &mut Vec<Effect<T>>) -> bool {
        let Some(holder) = &mut self.holder else {
            return false;
        };
        match &holder.phase {
            Phase::Active(until) if now >= *until => {
                self.start(Reason::Lease, now, effects);
                false
            }
            Phase::Revoking { attempt, until, .. } if now >= *until => {
                holder.phase = Phase::Failed {
                    reason: attempt.reason,
                    retry_at: now.saturating_add(self.timing.retry_ms),
                };
                true
            }
            Phase::Failed { reason, retry_at } if now >= *retry_at => {
                let reason = *reason;
                self.start(reason, now, effects);
                false
            }
            Phase::Active(_) | Phase::Revoking { .. } | Phase::Failed { .. } => false,
        }
    }

    pub fn answered(
        &mut self,
        attempt: &Arc<Attempt<T>>,
        confirmed: bool,
        now: u64,
        wall: i64,
        effects: &mut Vec<Effect<T>>,
    ) -> bool {
        let Some(holder) = &mut self.holder else {
            return false;
        };
        if !Arc::ptr_eq(&holder.lease, &attempt.lease) {
            return false;
        }
        if confirmed {
            self.advance(now, wall, effects);
            return true;
        }
        if matches!(&holder.phase, Phase::Revoking { attempt: current, .. } if Arc::ptr_eq(current, attempt))
        {
            holder.phase = Phase::Failed {
                reason: attempt.reason,
                retry_at: now.saturating_add(self.timing.retry_ms),
            };
            return true;
        }
        false
    }

    pub fn confirmed(
        &mut self,
        lease: &Arc<Lease<T>>,
        now: u64,
        wall: i64,
        effects: &mut Vec<Effect<T>>,
    ) -> bool {
        if self
            .holder()
            .is_some_and(|current| Arc::ptr_eq(current, lease))
        {
            self.advance(now, wall, effects);
            return true;
        }
        false
    }

    fn start(&mut self, reason: Reason, now: u64, effects: &mut Vec<Effect<T>>) {
        let Some(holder) = &mut self.holder else {
            return;
        };
        if matches!(holder.phase, Phase::Revoking { .. }) {
            return;
        }
        let failed = matches!(holder.phase, Phase::Failed { .. });
        let attempt = Arc::new(Attempt {
            lease: Arc::clone(&holder.lease),
            reason,
        });
        holder.phase = Phase::Revoking {
            attempt: Arc::clone(&attempt),
            until: now.saturating_add(self.timing.revoke_timeout_ms),
            failed,
        };
        effects.push(Effect::Revoke(attempt));
    }

    fn hold(&mut self, target: T, now: u64, wall: i64) -> Arc<Lease<T>> {
        let lease = Arc::new(Lease {
            target,
            since: wall,
        });
        self.holder = Some(Held {
            lease: Arc::clone(&lease),
            phase: Phase::Active(now.saturating_add(self.timing.lease_ms)),
        });
        lease
    }

    fn advance(&mut self, now: u64, wall: i64, effects: &mut Vec<Effect<T>>) {
        self.holder = None;
        if let Some(waiter) = self.queue.pop_front() {
            let lease = self.hold(waiter.target, now, wall);
            effects.extend(waiter.requests.into_iter().map(|request| Effect::Grant {
                lease: Arc::clone(&lease),
                request,
                waited: true,
            }));
        }
    }

    fn drop_waiter(&mut self, target: &T) -> bool {
        let Some(index) = self
            .queue
            .iter()
            .position(|waiter| &waiter.target == target)
        else {
            return false;
        };
        self.queue.remove(index);
        true
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
