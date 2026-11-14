//! Session mutation ordering. Base supplies the one application authority and concrete native effects.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

pub mod live;
pub mod native;
pub(crate) mod runtime;
pub(crate) mod stored_rename;

use ompdesk_app_contract::Owner;

use crate::application::session_authority::{AdmissionRefusal, Persistence, ReadyStoredClaim, SessionAuthority};
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

    fn authorize(&self, owner: &Owner, target: Target) -> Result<Target, Fault>;
    fn capture(&self, owner: &Owner, target: &Target) -> Effect<Captured<Self::Runtime, Self::Notices>>;
    /// Rechecks the captured holder's incarnation and busy/compaction under its pool's atomic release operation.
    fn release(&self, holder: &Holder<Self::Runtime>) -> Effect<Release>;
    /// Starts the native abort operation now and resolves only when that captured run is idle or fails.
    fn stop(&self, holder: &Holder<Self::Runtime>) -> Effect<()>;
    fn rename_live(&self, holder: &Holder<Self::Runtime>, name: &str) -> Effect<()>;
    fn rename_stored(
        &self, owner: &Owner, target: &Target, name: &str, claim: ReadyStoredClaim, scope: Scope,
    ) -> Effect<()>;
    fn note_name(&self, holder: &Holder<Self::Runtime>, name: &str) -> Effect<()>;
    fn delete_stored(&self, owner: &Owner, target: &Target, scope: Scope) -> Effect<()>;
    fn move_stored(
        &self, owner: &Owner, target: &Target, cwd: PathBuf, claim: ReadyStoredClaim, scope: Scope,
    ) -> Effect<String>;
    fn invalidate(&self, target: &Target) -> Effect<()>;
    fn notify_deleted(&self, target: &Target, notices: Self::Notices) -> Effect<()>;
}

pub struct Config<H: Host> {
    pub host: Arc<H>,
    /// The exact Base-owned Arc also used for acquire, restore, the index and hosted opens.
    pub authority: Arc<SessionAuthority>,
    pub now_ms: fn() -> f64,
}

pub struct Coordinator<H: Host> {
    host: Arc<H>,
    authority: Arc<SessionAuthority>,
    now_ms: fn() -> f64,
}

impl<H: Host> Coordinator<H> {
    pub fn new(config: Config<H>) -> Self {
        Self {
            host: config.host,
            authority: config.authority,
            now_ms: config.now_ms,
        }
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
        let coordinator = Self {
            host: Arc::clone(&self.host),
            authority: Arc::clone(&self.authority),
            now_ms: self.now_ms,
        };
        let owner = owner.clone();
        // The domain task owns this exact Scope until result-dependent commit and cleanup finish. Dropping a
        // caller's answer detaches its JoinHandle; it must not drop the work after a storage effect was admitted.
        tokio::spawn(async move {
            match mutation {
                Mutation::Delete => coordinator.delete(&owner, target, scope).await,
                Mutation::Stop => coordinator.stop(&owner, target, scope).await,
                Mutation::Rename(name) => coordinator.rename(&owner, target, &name, scope).await,
                Mutation::Move(cwd) => coordinator.move_session(&owner, target, cwd, scope).await,
            }
        }).await.map_err(|_| Error::Effect(Fault::new("session_operation", "Session operation task failed")))?
    }

    async fn delete(&self, owner: &Owner, target: Target, scope: Scope) -> Result<Output, Error> {
        let guard = self.authority
            .begin_delete_scoped(Path::new(&target.path), target.device.as_deref(), &scope)
            .ready().await;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        let captured = self.host.capture(owner, &target).await?;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        if captured.holders.iter().any(|holder| holder.activity != Activity::Idle) {
            return Err(running());
        }
        let mut exits = Vec::new();
        let mut failure = None;
        for holder in &captured.holders {
            if scope.cancelled() {
                failure = Some(Fault::cancelled());
                break;
            }
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
        self.host.delete_stored(owner, &target, scope.clone()).await?;
        match guard.commit((self.now_ms)()) {
            Persistence::MemoryOnly | Persistence::Durable => {}
            Persistence::Queued(error) | Persistence::Failed(error) => {
                eprintln!("ompdesk-core: [deleted-sessions] not saved: {}", error.message);
            }
        }
        // Both effects are owed once storage and the in-memory tombstone committed. Failure of either is reported,
        // but does not prevent the other from learning that this session is gone.
        let invalidated = self.host.invalidate(&target).await;
        let notified = self.host.notify_deleted(&target, captured.notices).await;
        invalidated?;
        notified?;
        Ok(Output::Done)
    }

    async fn stop(&self, owner: &Owner, target: Target, scope: Scope) -> Result<Output, Error> {
        let captured = self.host.capture(owner, &target).await?;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        let mut stopping = Vec::new();
        for holder in &captured.holders {
            if holder.activity != Activity::Idle {
                stopping.push(self.host.stop(holder));
            }
        }
        let mut failure = None;
        for effect in stopping {
            if let Err(error) = effect.await {
                failure.get_or_insert(error);
            }
        }
        match failure {
            Some(error) => Err(error.into()),
            None => Ok(Output::Done),
        }
    }

    async fn rename(&self, owner: &Owner, target: Target, name: &str, scope: Scope) -> Result<Output, Error> {
        let name = js_trim(name);
        if name.is_empty() {
            return Err(Error::Rejected {
                code: "session_name_empty",
                message: "Session name cannot be empty",
            });
        }
        let claim = self.authority
            .claim_stored(Path::new(&target.path), target.device.as_deref(), &scope)
            .ready().await.map_err(admission_error)?;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        let captured = self.host.capture(owner, &target).await?;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        let live = captured.holders.iter()
            .filter(|holder| holder.state != RuntimeState::Dormant)
            .min_by_key(|holder| !holder.hosted);
        let mut notification_failure = None;
        if let Some(holder) = live {
            if holder.state != RuntimeState::Ready {
                return Err(Error::Rejected {
                    code: "session_starting",
                    message: "Session is still starting",
                });
            }
            self.host.rename_live(holder, name).await?;
        } else {
            self.host.rename_stored(owner, &target, name, claim, scope.clone()).await?;
            for holder in &captured.holders {
                if let Err(error) = self.host.note_name(holder, name).await {
                    notification_failure.get_or_insert(error);
                }
            }
        }
        let invalidated = self.host.invalidate(&target).await;
        if let Some(error) = notification_failure {
            return Err(error.into());
        }
        invalidated?;
        Ok(Output::Done)
    }

    async fn move_session(
        &self, owner: &Owner, target: Target, cwd: PathBuf, scope: Scope,
    ) -> Result<Output, Error> {
        let claim = self.authority
            .claim_stored(Path::new(&target.path), target.device.as_deref(), &scope)
            .ready().await.map_err(admission_error)?;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        let captured = self.host.capture(owner, &target).await?;
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        if !captured.holders.is_empty() {
            return Err(Error::Rejected {
                code: "session_open_in_tab",
                message: "Session is open in a tab",
            });
        }
        let moved = self.host.move_stored(owner, &target, cwd, claim, scope.clone()).await?;
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

fn admission_error(refusal: AdmissionRefusal) -> Error {
    match refusal {
        AdmissionRefusal::Deleted => Error::Rejected {
            code: "session_deleted",
            message: "Session has been deleted",
        },
        AdmissionRefusal::Deleting | AdmissionRefusal::Mutating => Error::Rejected {
            code: "session_busy",
            message: "Session is being changed",
        },
    }
}

#[cfg(test)]
mod cancellation_tests;

#[cfg(test)]
mod drop_tests;
