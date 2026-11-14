use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::Notify;

use ompdesk_app_contract::{NativeCaller, Owner, OwnerIssuer, RequestId};

use crate::server::{Cancellation, Fault, Gone, Scope};

mod executions;
pub use executions::{Execution, Reservation};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    Page(NativeCaller),
    Peer { device: String, connection: u64 },
}

#[derive(Clone)]
pub struct Admitted {
    pub owner: Owner,
    pub principal: Principal,
}

struct Request {
    owner: Owner,
    cancel: Cancellation,
}

#[derive(Default)]
struct State {
    owners: HashMap<Owner, Principal>,
    pages: HashMap<NativeCaller, Owner>,
    requests: HashMap<RequestId, Request>,
    executions: HashMap<Owner, executions::Record>,
    active_tabs: HashMap<String, Owner>,
    stopped: bool,
}

/// Native admission only. Page JSON cannot construct an owner or replace its authenticated principal.
pub struct Callers {
    generation: u64,
    issuer: OwnerIssuer,
    state: Mutex<State>,
    finished: Notify,
}

impl Callers {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            issuer: OwnerIssuer::new(generation),
            state: Mutex::new(State::default()),
            finished: Notify::new(),
        }
    }

    /// Called by the authenticated page transport, never an IPC method accepting page arguments.
    pub fn admit_page(&self, caller: NativeCaller) -> Result<Admitted, Fault> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return Err(Fault::new("app_closed", "The application generation ended"));
        }
        if let Some(previous) = state.pages.remove(&caller) {
            Self::revoke_locked(&mut state, &previous);
        }
        let owner = self.issuer.admit_authenticated().ok_or_else(|| {
            Fault::new(
                "owner_exhausted",
                "Application owner identities are exhausted",
            )
        })?;
        let principal = Principal::Page(caller.clone());
        state.pages.insert(caller, owner.clone());
        state.owners.insert(owner.clone(), principal.clone());
        Ok(Admitted { owner, principal })
    }

    /// Called only after the remote transport has verified its stored pin and completed its handshake.
    pub fn admit_peer(&self, device: String, connection: u64) -> Result<Admitted, Fault> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return Err(Fault::new("app_closed", "The application generation ended"));
        }
        let owner = self.issuer.admit_authenticated().ok_or_else(|| {
            Fault::new(
                "owner_exhausted",
                "Application owner identities are exhausted",
            )
        })?;
        let principal = Principal::Peer { device, connection };
        state.owners.insert(owner.clone(), principal.clone());
        Ok(Admitted { owner, principal })
    }

    pub fn page(&self, caller: &NativeCaller) -> Result<Admitted, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let owner = state
            .pages
            .get(caller)
            .ok_or_else(|| Fault::new("caller_closed", "The page is no longer admitted"))?;
        let principal = state
            .owners
            .get(owner)
            .ok_or_else(|| Fault::new("caller_closed", "The page is no longer admitted"))?;
        Ok(Admitted {
            owner: owner.clone(),
            principal: principal.clone(),
        })
    }

    pub fn principal(&self, owner: &Owner) -> Result<Principal, Fault> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .owners
            .get(owner)
            .cloned()
            .ok_or_else(|| Fault::new("caller_closed", "The caller is no longer admitted"))
    }

    /// Reject a revoked owner, old app generation or request identity that is already in flight.
    pub fn begin(&self, owner: &Owner, id: RequestId) -> Result<(Scope, Gone), Fault> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if id.generation != self.generation || !state.owners.contains_key(owner) {
            return Err(Fault::new(
                "caller_closed",
                "The caller is no longer admitted",
            ));
        }
        if state.requests.contains_key(&id) {
            return Err(Fault::new(
                "request_open",
                "The request identity is already in flight",
            ));
        }
        let (scope, gone) = Scope::watched();
        state.requests.insert(
            id,
            Request {
                owner: owner.clone(),
                cancel: scope.cancellation(),
            },
        );
        Ok((scope, gone))
    }

    pub fn finish(&self, owner: &Owner, id: RequestId) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state
            .requests
            .get(&id)
            .is_some_and(|request| &request.owner == owner)
        {
            return false;
        }
        state.requests.remove(&id);
        self.finished.notify_waiters();
        true
    }

    pub fn cancel(&self, owner: &Owner, id: RequestId) -> bool {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(request) = state
            .requests
            .get(&id)
            .filter(|request| &request.owner == owner)
        else {
            return false;
        };
        request.cancel.cancel();
        true
    }

    pub async fn joined(&self, owner: Option<&Owner>) {
        loop {
            let changed = self.finished.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let pending = self
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .requests
                .values()
                .any(|request| owner.is_none_or(|owner| &request.owner == owner));
            if !pending {
                return;
            }
            changed.await;
        }
    }

    pub fn close_page(&self, caller: &NativeCaller) -> Option<Admitted> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let owner = state.pages.remove(caller)?;
        let principal = Self::revoke_locked(&mut state, &owner)?;
        Some(Admitted { owner, principal })
    }

    pub fn revoke(&self, owner: &Owner) -> Option<Principal> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let principal = Self::revoke_locked(&mut state, owner)?;
        if let Principal::Page(caller) = &principal {
            state.pages.remove(caller);
        }
        Some(principal)
    }

    fn revoke_locked(state: &mut State, owner: &Owner) -> Option<Principal> {
        let principal = state.owners.remove(owner)?;
        for request in state
            .requests
            .values()
            .filter(|request| &request.owner == owner)
        {
            request.cancel.cancel();
        }
        // Keep in-flight entries until their supervised effects have joined and finish removes them.
        Some(principal)
    }

    pub fn stop(&self) -> Vec<Admitted> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.stopped = true;
        state.pages.clear();
        for request in state.requests.values() {
            request.cancel.cancel();
        }
        state
            .owners
            .drain()
            .map(|(owner, principal)| Admitted { owner, principal })
            .collect()
    }
}

#[cfg(test)]
#[path = "callers_tests.rs"]
mod tests;
