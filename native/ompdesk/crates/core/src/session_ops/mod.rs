//! Session mutation ordering. Base supplies the one application authority and concrete native effects.

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub(crate) mod stored_rename;

use ompdesk_app_contract::Owner;

use crate::fs::order::js_trim;
use crate::server::{Fault, Scope};

pub type Effect<T> = Pin<Box<dyn Future<Output = Result<T, Fault>> + Send + 'static>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub path: String,
    pub device: Option<String>,
}

pub enum Mutation {
    Stop,
    Delete,
    Rename(String),
    Move(PathBuf),
}

#[derive(Debug, PartialEq)]
pub enum Output {
    Done,
    Moved(String),
}

#[derive(Debug, PartialEq)]
pub enum Error {
    /// Domain refusals retain the explicit LocalCommandError code at the RPC boundary.
    Rejected { code: &'static str, message: &'static str },
    /// Transport, storage and exact-exit failures are never converted into a successful RPC answer.
    Effect(Fault),
}

impl From<Fault> for Error {
    fn from(error: Fault) -> Self {
        Self::Effect(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    Idle,
    Running,
    Compacting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeState {
    Ready,
    /// Includes an unready live child, even if its displayed status says error or exited.
    Starting,
    Dormant,
}

pub struct Holder<R> {
    pub runtime: R,
    pub hosted: bool,
    pub activity: Activity,
    pub state: RuntimeState,
}

pub struct Captured<R, N> {
    pub holders: Vec<Holder<R>>,
    pub notices: N,
}

/// A release can fail after closing something. Its receipts must still be joined before the guard is dropped.
pub struct Release {
    pub exits: Vec<Effect<()>>,
    pub failure: Option<Fault>,
}

/// Primitive native effects, not a callback that runs mutation policy in Node. The concrete adapter binds the
/// existing pool, exact runtime handles, stock worker, session index and authenticated remote transport.
pub trait Host: Send + Sync + 'static {
    type Runtime: Send + Sync + 'static;
    type Notices: Send + 'static;
    type DeleteGuard: Send + 'static;

    fn authorize(&self, owner: &Owner, target: Target) -> Result<Target, Fault>;
    fn begin_delete(&self, target: &Target) -> Self::DeleteGuard;
    fn capture(&self, target: &Target) -> Effect<Captured<Self::Runtime, Self::Notices>>;
    /// Rechecks the captured holder's incarnation and busy/compaction under its pool's atomic release operation.
    fn release(&self, holder: &Holder<Self::Runtime>) -> Effect<Release>;
    fn when_idle(&self, holder: &Holder<Self::Runtime>, timeout: Duration) -> Effect<()>;
    fn stop(&self, holder: &Holder<Self::Runtime>) -> Effect<()>;
    fn rename_live(&self, holder: &Holder<Self::Runtime>, name: &str) -> Effect<()>;
    fn rename_stored(&self, target: &Target, name: &str, scope: Scope) -> Effect<()>;
    fn note_name(&self, holder: &Holder<Self::Runtime>, name: &str) -> Effect<()>;
    fn delete_stored(&self, target: &Target, scope: Scope) -> Effect<()>;
    fn move_stored(&self, target: &Target, cwd: PathBuf, scope: Scope) -> Effect<String>;
    /// The tombstone's in-memory commit is authoritative. A retained-save error is reported separately, not returned
    /// as a failed storage delete or allowed to skip invalidation and notices.
    fn remember_deleted(&self, target: &Target);
    fn invalidate(&self, target: &Target) -> Effect<()>;
    fn notify_deleted(&self, target: &Target, notices: Self::Notices) -> Effect<()>;
}

pub struct Coordinator<H: Host> {
    host: Arc<H>,
}

impl<H: Host> Coordinator<H> {
    pub fn new(host: Arc<H>) -> Self {
        Self { host }
    }

    pub async fn execute(
        &self,
        owner: &Owner,
        target: Target,
        mutation: Mutation,
        scope: Scope,
    ) -> Result<Output, Error> {
        let target = self.host.authorize(owner, target)?;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        match mutation {
            Mutation::Delete => self.delete(target, scope).await,
            Mutation::Stop => self.stop(target).await,
            Mutation::Rename(name) => self.rename(target, &name, scope).await,
            Mutation::Move(cwd) => self.move_session(target, cwd, scope).await,
        }
    }

    async fn delete(&self, target: Target, scope: Scope) -> Result<Output, Error> {
        let _guard = self.host.begin_delete(&target);
        let captured = self.host.capture(&target).await?;
        if captured.holders.iter().any(|holder| holder.activity != Activity::Idle) {
            return Err(running());
        }
        let mut exits = Vec::new();
        let mut failure = None;
        for holder in &captured.holders {
            match self.host.release(holder).await {
                Ok(released) => {
                    exits.extend(released.exits);
                    if released.failure.is_some() {
                        failure = released.failure;
                        break;
                    }
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        for exit in exits {
            if let Err(error) = exit.await {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(error.into());
        }
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        self.host.delete_stored(&target, scope).await?;
        self.host.remember_deleted(&target);
        // Both effects are owed once storage and the in-memory tombstone committed. Failure of either is reported,
        // but does not prevent the other from learning that this session is gone.
        let invalidated = self.host.invalidate(&target).await;
        let notified = self.host.notify_deleted(&target, captured.notices).await;
        invalidated?;
        notified?;
        Ok(Output::Done)
    }

    async fn stop(&self, target: Target) -> Result<Output, Error> {
        let captured = self.host.capture(&target).await?;
        let mut stopping = Vec::new();
        let mut idle = Vec::new();
        for holder in &captured.holders {
            if holder.activity != Activity::Idle {
                idle.push(self.host.when_idle(holder, Duration::from_secs(60)));
                stopping.push(self.host.stop(holder));
            }
        }
        let mut failure = None;
        for effect in stopping.into_iter().chain(idle) {
            if let Err(error) = effect.await {
                failure.get_or_insert(error);
            }
        }
        match failure {
            Some(error) => Err(error.into()),
            None => Ok(Output::Done),
        }
    }

    async fn rename(&self, target: Target, name: &str, scope: Scope) -> Result<Output, Error> {
        let name = js_trim(name);
        if name.is_empty() {
            return Err(Error::Rejected {
                code: "session_name_empty",
                message: "Session name cannot be empty",
            });
        }
        let captured = self.host.capture(&target).await?;
        let live = captured.holders.iter()
            .filter(|holder| holder.state != RuntimeState::Dormant)
            .min_by_key(|holder| !holder.hosted);
        if let Some(holder) = live {
            if holder.state != RuntimeState::Ready {
                return Err(Error::Rejected {
                    code: "session_starting",
                    message: "Session is still starting",
                });
            }
            self.host.rename_live(holder, name).await?;
        } else {
            self.host.rename_stored(&target, name, scope).await?;
            for holder in &captured.holders {
                self.host.note_name(holder, name).await?;
            }
        }
        self.host.invalidate(&target).await?;
        Ok(Output::Done)
    }

    async fn move_session(&self, target: Target, cwd: PathBuf, scope: Scope) -> Result<Output, Error> {
        let captured = self.host.capture(&target).await?;
        if !captured.holders.is_empty() {
            return Err(Error::Rejected {
                code: "session_open_in_tab",
                message: "Session is open in a tab",
            });
        }
        let moved = self.host.move_stored(&target, cwd, scope).await?;
        self.host.invalidate(&target).await?;
        Ok(Output::Moved(moved))
    }
}

fn running() -> Error {
    Error::Rejected {
        code: "session_running",
        message: "Session is currently running",
    }
}
