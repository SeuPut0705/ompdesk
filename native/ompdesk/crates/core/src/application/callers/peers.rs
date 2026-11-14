use super::executions::Life;
use super::{Callers, Owner, Principal, State};
use crate::remote::requests::RemoteRequests;
use crate::server::Fault;

impl Callers {
    /// Completes the authenticated native link handoff before any hosted operation is admitted.
    pub fn bind_peer_connection(
        &self,
        owner: &Owner,
        connection: RemoteRequests,
    ) -> Result<(), Fault> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(Principal::Peer {
            device,
            connection: id,
        }) = state.owners.get(owner)
        else {
            return Err(closed());
        };
        if state.stopped || !connection.is_online() || connection.link_id() != Some(*id) {
            return Err(closed());
        }
        let device = device.clone();
        let State {
            owners,
            peer_links,
            requests,
            ..
        } = &mut *state;
        for (previous, _) in owners.extract_if(|other, principal| {
            other != owner && matches!(principal, Principal::Peer { device: other_device, .. } if other_device == &device)
        }) {
            peer_links.remove(&previous);
            for request in requests.values().filter(|request| request.owner == previous) {
                request.cancel.cancel();
            }
        }
        state.peer_links.insert(owner.clone(), connection);
        Ok(())
    }

    /// The effect only captures/enqueues work; it must neither await nor reenter Callers.
    pub fn admit_peer_connection<T>(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        peer(&state, owner, connection)?;
        connection.admit_online(effect)
    }

    /// A reconnect controls the original execution, never a replacement selected by an rtab name.
    pub fn admit_peer_execution<T>(
        &self,
        owner: &Owner,
        connection: &RemoteRequests,
        execution: &Owner,
        effect: impl FnOnce() -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let device = peer(&state, owner, connection)?;
        let record = state.executions.get(execution).ok_or_else(closed)?;
        if !matches!(&record.facts.creator, Principal::Peer { device: original, .. } if original == device)
            || !matches!(record.life, Life::Bound { .. })
            || state.active_tabs.get(&record.facts.tab) != Some(execution)
        {
            return Err(closed());
        }
        connection.admit_online(effect)
    }
}

fn peer<'a>(
    state: &'a State,
    owner: &Owner,
    connection: &RemoteRequests,
) -> Result<&'a str, Fault> {
    if state.stopped || !connection.is_online() {
        return Err(closed());
    }
    let Some(Principal::Peer {
        device,
        connection: id,
    }) = state.owners.get(owner)
    else {
        return Err(closed());
    };
    if connection.link_id() != Some(*id)
        || !state
            .peer_links
            .get(owner)
            .is_some_and(|current| current.same_connection(connection))
    {
        return Err(closed());
    }
    Ok(device)
}

fn closed() -> Fault {
    Fault::new(
        "peer_closed",
        "The authenticated peer connection is no longer admitted",
    )
}

#[cfg(test)]
mod tests;
