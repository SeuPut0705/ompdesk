use std::sync::Arc;

use serde_json::Value;

use crate::pool::application::Sidecar;
use crate::pool::application::native::{
    ExecutionTarget, Host, Service as NativePool, SessionRelease, SessionRuntime, SessionTarget,
};
use crate::server::Fault;

/// A presentation retains its execution; a saved-session effect additionally retains its exact captured run.
/// Neither state can be constructed from page fields or deserialized network data.
pub struct Target<S: Sidecar + ?Sized>(Kind<S>);

enum Kind<S: Sidecar + ?Sized> {
    Live(ExecutionTarget<S>),
    Frozen {
        execution: ExecutionTarget<S>,
        session: SessionTarget<S>,
    },
}

impl<S: Sidecar + ?Sized> Clone for Target<S> {
    fn clone(&self) -> Self {
        Self(match &self.0 {
            Kind::Live(execution) => Kind::Live(execution.clone()),
            Kind::Frozen { execution, session } => Kind::Frozen {
                execution: execution.clone(),
                session: session.clone(),
            },
        })
    }
}

impl<S: Sidecar + ?Sized> Target<S> {
    pub fn live(execution: ExecutionTarget<S>) -> Self {
        Self(Kind::Live(execution))
    }

    pub fn execution(&self) -> &ExecutionTarget<S> {
        match &self.0 {
            Kind::Live(execution) | Kind::Frozen { execution, .. } => execution,
        }
    }

    fn frozen(&self) -> Result<(&ExecutionTarget<S>, &SessionTarget<S>), Fault> {
        match &self.0 {
            Kind::Frozen { execution, session } => Ok((execution, session)),
            Kind::Live(_) => Err(Fault::new(
                "session_target_live",
                "The saved-session operation requires a frozen execution target",
            )),
        }
    }
}

pub struct HostedTargets<P: Host> {
    pool: Arc<NativePool<P>>,
}

impl<P: Host> HostedTargets<P> {
    pub fn new(pool: Arc<NativePool<P>>) -> Self {
        Self { pool }
    }

    pub async fn capture_session_target(
        &self,
        target: &Target<P::Sidecar>,
        expected_path: &str,
    ) -> Result<Target<P::Sidecar>, Fault> {
        match &target.0 {
            Kind::Live(execution) => {
                // The existing hub admission validates this original owner/source/incarnation and captures its
                // current run and file atomically. It does not resolve a presentation name or replacement tab.
                let selected = self.pool.execution_selected(execution).await?;
                if selected.tab != execution.tab()
                    || !Arc::ptr_eq(&selected.sidecar, execution.source())
                    || selected.session_file.as_deref() != Some(expected_path)
                {
                    return Err(path_changed());
                }
                let session = SessionTarget {
                    tab: selected.tab,
                    window: selected.window,
                    device: selected.device,
                    session_file: selected.session_file.ok_or_else(path_changed)?,
                    incarnation: execution.incarnation(),
                    generation: selected.generation,
                    sidecar: selected.sidecar,
                };
                // Recheck that exact capture after the await. This never fetches a new run: the pool's same-hub
                // check rejects a changed file, incarnation, source or generation instead of refreshing it.
                self.pool.session_runtime(execution.owner(), &session).await?;
                Ok(Target(Kind::Frozen { execution: execution.clone(), session }))
            }
            Kind::Frozen { execution, session } => {
                if session.session_file != expected_path {
                    return Err(path_changed());
                }
                self.pool.session_runtime(execution.owner(), session).await?;
                Ok(target.clone())
            }
        }
    }

    pub async fn runtime(&self, target: &Target<P::Sidecar>) -> Result<SessionRuntime, Fault> {
        let (execution, session) = target.frozen()?;
        self.pool.session_runtime(execution.owner(), session).await
    }

    pub async fn stop(&self, target: &Target<P::Sidecar>) -> Result<(), Fault> {
        let (execution, session) = target.frozen()?;
        self.pool.stop_session(execution.owner(), session).await
    }

    /// Return the original RPC response. Its caller owns the one canonical stock_data decoding boundary.
    pub async fn command(&self, target: &Target<P::Sidecar>, command: Value) -> Result<Value, Fault> {
        let (execution, session) = target.frozen()?;
        self.pool.command_for_session(execution.owner(), session, command).await
    }

    pub async fn name(&self, target: &Target<P::Sidecar>, title: &str) -> Result<(), Fault> {
        let (execution, session) = target.frozen()?;
        self.pool.note_name_for_session(execution.owner(), session, title).await
    }

    pub async fn close_session(&self, target: &Target<P::Sidecar>) -> Result<SessionRelease, Fault> {
        let (execution, session) = target.frozen()?;
        self.pool.close_session_tab(execution.owner(), session).await
    }

    pub async fn close(&self, target: &Target<P::Sidecar>) -> Result<(), Fault> {
        match &target.0 {
            Kind::Live(execution) => self.pool.release_peer_execution(execution).await,
            Kind::Frozen { .. } => match self.close_session(target).await? {
                SessionRelease::Busy => Err(Fault::new("session_running", "The hosted session is running")),
                SessionRelease::Released(result) => result,
            },
        }
    }
}

fn path_changed() -> Fault {
    Fault::new("session_changed", "The captured execution does not own the expected session")
}

#[cfg(test)]
#[path = "hosted_targets_tests.rs"]
mod tests;
