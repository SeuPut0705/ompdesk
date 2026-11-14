//! The registry's execution identities are not pool claims. The existing Ctx still decides acquisition and release.
//! Endpoint revocation removes presentation authority, not the identity of a running execution host.

use std::num::NonZeroUsize;

use super::{Callers, NativeCaller, Owner, Principal, State};
use crate::server::Fault;

#[derive(Clone, Debug)]
pub struct Execution {
    pub owner: Owner,
    pub tab: String,
    pub window: i64,
    /// Attribution of the original authenticated acquisition, not an execution-host selector or a new grant.
    pub creator: Principal,
}

pub struct Reservation {
    owner: Owner,
}

#[derive(Clone, Copy)]
enum Life {
    Provisional(NonZeroUsize),
    Bound { pending: usize },
    Retiring,
}

pub(super) struct Record {
    facts: Execution,
    life: Life,
}

impl Callers {
    /// Base calls this before Ctx::acquire; its result grants no permission to acquire or control a tab.
    /// The native PoolHost owns the returned token until its actual acquire future settles or is dropped.
    pub fn reserve_execution(
        &self,
        caller: &Owner,
        tab: &str,
        window: i64,
    ) -> Result<Reservation, Fault> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let creator = state.owners.get(caller).cloned().ok_or_else(closed)?;
        let actual_window = match &creator {
            Principal::Page(NativeCaller::Desktop { win_id, .. }) => Some(
                i64::try_from(*win_id)
                    .map_err(|_| Fault::new("caller_window", "Invalid native window identity"))?,
            ),
            Principal::Page(NativeCaller::Web { window_id, .. }) => Some(*window_id),
            Principal::Peer { .. } => None,
        };
        if actual_window.is_some_and(|actual| actual != window) {
            return Err(Fault::new(
                "caller_window",
                "The window does not belong to this caller",
            ));
        }
        if let Some(owner) = state.active_tabs.get(tab).cloned() {
            let record = state
                .executions
                .get_mut(&owner)
                .expect("active execution identity");
            record.life = match record.life {
                Life::Provisional(pending) => Life::Provisional(
                    NonZeroUsize::new(pending.get().checked_add(1).ok_or_else(exhausted)?).unwrap(),
                ),
                Life::Bound { pending } => Life::Bound {
                    pending: pending.checked_add(1).ok_or_else(exhausted)?,
                },
                Life::Retiring => unreachable!("retiring execution is not active"),
            };
            return Ok(Reservation { owner });
        }
        let owner = self.issuer.admit_authenticated().ok_or_else(exhausted)?;
        state.active_tabs.insert(tab.to_owned(), owner.clone());
        state.executions.insert(
            owner.clone(),
            Record {
                facts: Execution {
                    owner: owner.clone(),
                    tab: tab.to_owned(),
                    window,
                    creator,
                },
                life: Life::Provisional(NonZeroUsize::new(1).unwrap()),
            },
        );
        Ok(Reservation { owner })
    }

    pub fn finish_execution_reservation(&self, reservation: Reservation, acquired: bool) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(record) = state.executions.get_mut(&reservation.owner) else {
            return;
        };
        let remove = match record.life {
            Life::Retiring => false,
            Life::Bound { pending } => {
                record.life = Life::Bound {
                    pending: pending.checked_sub(1).expect("reserved execution identity"),
                };
                false
            }
            Life::Provisional(pending) => {
                let remaining = pending.get() - 1;
                if acquired {
                    record.life = Life::Bound { pending: remaining };
                    false
                } else if let Some(remaining) = NonZeroUsize::new(remaining) {
                    record.life = Life::Provisional(remaining);
                    false
                } else {
                    true
                }
            }
        };
        if remove {
            remove_record(&mut state, &reservation.owner);
        }
    }

    /// Called synchronously by the actual successful Sidecar factory. A cancelled acquire cannot orphan its
    /// already-created handle; disposal keeps this identity until that exact handle's exit receipt resolves.
    pub fn keep_execution(&self, owner: &Owner) -> Result<(), Fault> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return Err(closed());
        }
        let record = state.executions.get_mut(owner).ok_or_else(closed)?;
        record.life = match record.life {
            Life::Provisional(pending) => Life::Bound {
                pending: pending.get(),
            },
            Life::Bound { pending } => Life::Bound { pending },
            Life::Retiring => return Err(closed()),
        };
        Ok(())
    }

    /// Resolves an existing reservation for the engine's spawn_owner ask. It never mints from ask/page metadata.
    pub fn execution_owner(&self, tab: &str) -> Result<Owner, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return Err(closed());
        }
        state.active_tabs.get(tab).cloned().ok_or_else(closed)
    }

    /// Metadata only, not authorization. A target's execution host remains the pool/remote target's own fact.
    pub fn execution_facts(&self, owner: &Owner) -> Option<Execution> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .executions
            .get(owner)
            .map(|record| record.facts.clone())
    }

    /// Called at Application::dispose, before awaiting its captured exit receipt. A later acquisition of the same
    /// tab gets a new identity; the old receipt can never remove that replacement.
    pub fn retire_execution(&self, owner: &Owner) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(record) = state.executions.get_mut(owner) else {
            return false;
        };
        record.life = Life::Retiring;
        let tab = record.facts.tab.clone();
        if state.active_tabs.get(&tab) == Some(owner) {
            state.active_tabs.remove(&tab);
        }
        true
    }

    /// Base calls this only after the exact disposed handle's real exit receipt, never a pre-release snapshot.
    pub fn finish_execution_retirement(&self, owner: &Owner) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state
            .executions
            .get(owner)
            .is_some_and(|record| matches!(record.life, Life::Retiring))
        {
            return false;
        }
        remove_record(&mut state, owner);
        true
    }
}

fn remove_record(state: &mut State, owner: &Owner) {
    if let Some(record) = state.executions.remove(owner)
        && state.active_tabs.get(&record.facts.tab) == Some(owner)
    {
        state.active_tabs.remove(&record.facts.tab);
    }
}
fn closed() -> Fault {
    Fault::new(
        "caller_closed",
        "The native acquisition is no longer admitted",
    )
}
fn exhausted() -> Fault {
    Fault::new(
        "owner_exhausted",
        "Application owner identities are exhausted",
    )
}

#[cfg(test)]
mod tests;
