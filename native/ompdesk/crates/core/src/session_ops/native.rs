use std::path::PathBuf;
use std::sync::Arc;

use ompdesk_app_contract::Owner;

use crate::application::session_access::SessionAccess;
use crate::application::session_authority::ReadyStoredClaim;
use crate::application::sessions::SessionIndex;
use crate::pool::application::native::{Host as PoolHost, Service as Pool};
use crate::remote::application_host::{Host as HostedHost, HostServices, SessionNotices};
use crate::run::{Exec, Runner};
use crate::server::{Fault, Scope};

use super::runtime::Runtime;
use super::{Captured, Effect, Holder, Host, Release, Target, stored_rename};

/// Trusted native assembly only. Root routes whole remote mutations to their execution host first.
pub struct Config<P: PoolHost, R: HostedHost> {
    pub access: Arc<SessionAccess>,
    pub pool: Arc<Pool<P>>,
    pub hosted: Arc<HostServices<R>>,
    pub index: Arc<SessionIndex>,
    pub rename_runner: Runner,
    pub rename_cwd: PathBuf,
}

pub struct NativeHost<P: PoolHost, R: HostedHost> {
    access: Arc<SessionAccess>,
    pool: Arc<Pool<P>>,
    hosted: Arc<HostServices<R>>,
    index: Arc<SessionIndex>,
    rename_runner: Runner,
    rename_cwd: PathBuf,
}

impl<P: PoolHost, R: HostedHost> NativeHost<P, R> {
    pub fn new(config: Config<P, R>) -> Self {
        Self {
            access: config.access,
            pool: config.pool,
            hosted: config.hosted,
            index: config.index,
            rename_runner: config.rename_runner,
            rename_cwd: config.rename_cwd,
        }
    }
}

impl<P: PoolHost, R: HostedHost> Host for NativeHost<P, R> {
    type Runtime = Runtime<P, R>;
    type Notices = SessionNotices;

    fn authorize(&self, owner: &Owner, target: Target) -> Result<Target, Fault> {
        self.access.local_target(owner, target)
    }

    fn capture(&self, owner: &Owner, target: &Target) -> Effect<Captured<Self::Runtime, Self::Notices>> {
        let owner = owner.clone();
        let target = target.clone();
        let access = Arc::clone(&self.access);
        let hosted = Arc::clone(&self.hosted);
        let pool = Arc::clone(&self.pool);
        Box::pin(async move {
            let target = access.local_target(&owner, target)?;
            let capture = hosted.capture_session(&target.path).await?;
            access.local_target(&owner, target.clone())?;
            let mut holders: Vec<_> = capture.holders.into_iter().map(|holder| Holder {
                runtime: Runtime::Hosted {
                    service: Arc::clone(&hosted),
                    ticket: Arc::new(holder.runtime),
                },
                hosted: true,
                activity: holder.activity,
                state: holder.state,
            }).collect();
            // The canonical pool has one runner per saved path; hosted views are excluded by capture_session.
            // A hosted runner is that same pool owner, not a second runtime to close again through a tab lookup.
            if holders.is_empty() {
                if let Some(selected) = pool.session_target(&owner, &target.path, None).await? {
                    let runtime = pool.session_runtime(&owner, &selected).await?;
                    access.local_target(&owner, target.clone())?;
                    holders.push(Holder {
                        runtime: Runtime::Local { pool, owner, target: selected },
                        hosted: false,
                        activity: runtime.activity,
                        state: runtime.state,
                    });
                }
            }
            Ok(Captured { holders, notices: capture.notices })
        })
    }

    fn release(&self, holder: &Holder<Self::Runtime>) -> Effect<Release> {
        holder.runtime.release()
    }

    fn stop(&self, holder: &Holder<Self::Runtime>) -> Effect<()> {
        holder.runtime.stop()
    }

    fn rename_live(&self, holder: &Holder<Self::Runtime>, name: &str) -> Effect<()> {
        holder.runtime.rename(name)
    }

    fn rename_stored(
        &self, owner: &Owner, target: &Target, name: &str, claim: ReadyStoredClaim, scope: Scope,
    ) -> Effect<()> {
        let admitted = self.access.local_target(owner, target.clone());
        let runner = self.rename_runner.clone();
        let scratch = self.rename_cwd.clone();
        let name = name.to_owned();
        Box::pin(async move {
            let target = admitted?;
            let _claim = claim;
            // Exec retains this same Scope until the actual installed omp child exits, even if its future drops.
            // Scope in turn retains the sole canonical stored claim; no unregistered tab or second holder is made.
            let exec = Exec::new(runner, scope, "session_rename");
            stored_rename::rename(exec, &scratch, std::path::Path::new(&target.path), &name).await
        })
    }

    fn note_name(&self, holder: &Holder<Self::Runtime>, name: &str) -> Effect<()> {
        holder.runtime.note_name(name)
    }

    fn delete_stored(&self, owner: &Owner, target: &Target, scope: Scope) -> Effect<()> {
        let admitted = self.access.local_target(owner, target.clone());
        let index = Arc::clone(&self.index);
        Box::pin(async move {
            let target = admitted?;
            index.delete_stored(std::path::Path::new(&target.path), scope).await
        })
    }

    fn move_stored(
        &self, owner: &Owner, target: &Target, cwd: PathBuf, claim: ReadyStoredClaim, scope: Scope,
    ) -> Effect<String> {
        let admitted = self.access.local_target(owner, target.clone());
        let index = Arc::clone(&self.index);
        Box::pin(async move {
            let target = admitted?;
            let _claim = claim;
            let moved = index.move_stored(std::path::Path::new(&target.path), &cwd, scope).await?;
            index.invalidate_paths(std::slice::from_ref(&moved));
            Ok(moved.to_string_lossy().into_owned())
        })
    }

    fn invalidate(&self, target: &Target) -> Effect<()> {
        let path = PathBuf::from(&target.path);
        let index = Arc::clone(&self.index);
        Box::pin(async move {
            index.invalidate_paths(std::slice::from_ref(&path));
            index.notify_mutation();
            Ok(())
        })
    }

    fn notify_deleted(&self, target: &Target, notices: Self::Notices) -> Effect<()> {
        let path = target.path.clone();
        let hosted = Arc::clone(&self.hosted);
        Box::pin(async move { hosted.notify_session_deleted(&path, notices) })
    }
}
