use ompdesk_app_contract::NativeCaller;

use super::{Callers, State};
use crate::server::Fault;
use crate::worktree_lifecycle::Window;

fn id(caller: &NativeCaller) -> Option<i64> {
    match caller {
        NativeCaller::Desktop { win_id, .. } => i64::try_from(*win_id).ok(),
        NativeCaller::Web { window_id, .. } => Some(*window_id),
    }
}

pub(super) fn page(state: &State, window: Window) -> Option<&NativeCaller> {
    state.pages.iter().find_map(|(caller, owner)| {
        (owner.id() == window.incarnation
            && id(caller) == Some(window.id)
            && state.owners.contains_key(owner))
        .then_some(caller)
    })
}

impl Callers {
    pub fn execution_window(&self, owner: &super::Owner) -> Result<Option<Window>, Fault> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .executions
            .get(owner)
            .map(|record| record.window)
            .ok_or_else(|| {
                Fault::new(
                    "tab_stale",
                    "The captured execution is no longer registered",
                )
            })
    }

    pub fn window(&self, caller: &NativeCaller) -> Result<Window, Fault> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let owner = state
            .pages
            .get(caller)
            .filter(|owner| state.owners.contains_key(*owner))
            .ok_or_else(|| Fault::new("caller_closed", "The page is no longer admitted"))?;
        Ok(Window {
            id: id(caller)
                .ok_or_else(|| Fault::new("window_id", "The native window ID is out of range"))?,
            incarnation: owner.id(),
        })
    }

    pub fn focus_page(&self, caller: &NativeCaller) -> Result<(), Fault> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state
            .pages
            .get(caller)
            .is_some_and(|owner| state.owners.contains_key(owner))
        {
            return Err(Fault::new(
                "caller_closed",
                "The page is no longer admitted",
            ));
        }
        state.focused = Some(caller.clone());
        Ok(())
    }

    pub fn windows(&self) -> Vec<Window> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut pages: Vec<_> = state
            .pages
            .iter()
            .filter_map(|(caller, owner)| {
                if !state.owners.contains_key(owner) {
                    return None;
                }
                Some((
                    state.focused.as_ref() == Some(caller),
                    owner.id(),
                    Window {
                        id: id(caller)?,
                        incarnation: owner.id(),
                    },
                ))
            })
            .collect();
        pages.sort_unstable_by_key(|(focused, incarnation, _)| {
            (std::cmp::Reverse(*focused), std::cmp::Reverse(*incarnation))
        });
        pages.into_iter().map(|(_, _, window)| window).collect()
    }

    pub fn with_window<T>(
        &self,
        window: Window,
        effect: impl FnOnce(&NativeCaller) -> T,
    ) -> Option<T> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        page(&state, window).map(effect)
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
