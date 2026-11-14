use std::sync::Arc;

use serde_json::{Value, json};

use super::runtime_log::{RuntimeErrorSource, RuntimeLogReport, Writer};
use crate::remote::application_host::{Host, HostServices};

/// Reads the existing hosted execution state; the canonical ownership service still owns every tag decision.
pub struct SessionOwnershipHost<H: Host> {
    hosted: Arc<HostServices<H>>,
    log: Arc<Writer>,
}

impl<H: Host> SessionOwnershipHost<H> {
    pub fn new(hosted: Arc<HostServices<H>>, log: Arc<Writer>) -> Arc<Self> {
        Arc::new(Self { hosted, log })
    }
}

impl<H: Host> crate::session_ownership::Host for SessionOwnershipHost<H> {
    fn hosted_held(&self, session_path: &str) -> bool {
        match self.hosted.holds_session(session_path) {
            Ok(held) => held,
            Err(error) => {
                self.log(
                    "Hosted session ownership could not be read; retaining its processes",
                    json!({"sessionPath": session_path, "code": error.code, "error": error.message}),
                );
                true
            }
        }
    }

    fn log(&self, message: &str, details: Value) {
        let mut report = RuntimeLogReport::new(RuntimeErrorSource::SessionProcesses, message);
        report.details = Some(details);
        self.log.write(&report, None, None);
    }
}

#[cfg(test)]
#[path = "session_ownership_host_tests.rs"]
mod tests;
