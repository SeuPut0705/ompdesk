use std::path::Path;
use std::sync::Arc;

use ompdesk_app_contract::Owner;

use super::callers::Callers;
use super::sessions::SessionIndex;
use crate::server::Fault;
use crate::session_ops::Target;

/// Local execution-host boundary. Remote mutations must reach their host before this adapter is entered.
pub struct SessionAccess {
    callers: Arc<Callers>,
    index: Arc<SessionIndex>,
}

impl SessionAccess {
    pub fn new(callers: Arc<Callers>, index: Arc<SessionIndex>) -> Self {
        Self { callers, index }
    }

    pub fn local_target(&self, owner: &Owner, target: Target) -> Result<Target, Fault> {
        self.callers.admit_owner(owner, || {
            if target.device.is_some() {
                return Err(Fault::new(
                    "session_execution_host",
                    "The session mutation must run on its execution host",
                ));
            }
            let path = self.index.validate_target(Path::new(&target.path))?;
            Ok(Target {
                path: path.to_string_lossy().into_owned(),
                device: None,
            })
        })
    }
}
