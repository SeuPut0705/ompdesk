//! The six GUI worktree commands. Location stays in stock; git, disk and process effects
//! use the existing native engines. Only Base constructs this service and its shared stores.

use std::sync::Arc;

use ompdesk_app_contract::Owner;

use crate::local_dispatch::{
    protocol::{CommandResult, RpcCommand},
    session::Session,
};
use crate::pool::application::native::{Host, Service as NativePool};
use crate::run::Runner;
use crate::server::Scope;

use super::RemovalClaims;

pub(super) use super::claims;
mod checkout;
mod orphans;
pub mod prepare;
mod privacy;
pub mod saved;

enum Command {
    Create,
    Remove,
    ListOrphans,
    RemoveOrphan,
    ListSaved,
    RestoreSaved,
}

impl Command {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "worktree_create" => Some(Self::Create),
            "worktree_remove" => Some(Self::Remove),
            "get_orphan_worktrees" => Some(Self::ListOrphans),
            "remove_orphan_worktree" => Some(Self::RemoveOrphan),
            "get_saved_worktrees" => Some(Self::ListSaved),
            "restore_saved_worktree" => Some(Self::RestoreSaved),
            _ => None,
        }
    }
}

pub fn handles(name: &str) -> bool {
    Command::parse(name).is_some()
}

pub struct Config {
    pub git: Runner,
    pub preparation: prepare::Config,
    pub saved: Arc<saved::SavedStore>,
    /// This exact instance is also injected into every pool and host-open admission.
    pub claims: Arc<RemovalClaims>,
}

pub struct Service<H: Host> {
    pool: Arc<NativePool<H>>,
    config: Config,
}

impl<H: Host> Service<H> {
    pub fn new(pool: Arc<NativePool<H>>, config: Config) -> Arc<Self> {
        Arc::new(Self { pool, config })
    }

    /// `owner` and `session` are captured by the authenticated dispatcher after whole-command
    /// execution-host routing, never reconstructed from the page's parameters.
    pub async fn execute(
        &self,
        owner: &Owner,
        session: &Session<H::Sidecar>,
        scope: Scope,
        command: &RpcCommand,
    ) -> CommandResult {
        let params = &command.params;
        let Some(kind) = Command::parse(&command.kind) else {
            return Ok(None);
        };
        let result = match kind {
            Command::Create => {
                checkout::create(
                    session,
                    self.config.git.clone(),
                    &self.config.preparation,
                    scope,
                    params,
                )
                .await?
            }
            Command::Remove => {
                checkout::remove(session, self.config.git.clone(), scope, params).await?
            }
            Command::ListOrphans => {
                orphans::list(&self.pool, owner, session, self.config.git.clone(), scope).await?
            }
            Command::RemoveOrphan => {
                orphans::remove(
                    Arc::clone(&self.pool),
                    owner.clone(),
                    session.clone(),
                    self.config.git.clone(),
                    scope,
                    Arc::clone(&self.config.saved),
                    Arc::clone(&self.config.claims),
                    command.string("path").unwrap_or("").to_owned(),
                )
                .await?
            }
            Command::ListSaved => {
                saved::list_for_repo(
                    &self.config.saved,
                    self.config.git.clone(),
                    scope,
                    &session.cwd(),
                )
                .await?
            }
            Command::RestoreSaved => {
                saved::restore(
                    &self.config.saved,
                    self.config.git.clone(),
                    &self.config.preparation,
                    scope,
                    &session.cwd(),
                    command.string("savedId").unwrap_or(""),
                )
                .await?
            }
        };
        Ok(Some(result))
    }
}

#[cfg(test)]
mod test_support {
    pub use crate::git::session_lifecycle::test_support::{runner, sh};

    pub fn repo(name: &str) -> std::path::PathBuf {
        let path = crate::fs::disk::make_temp_dir(&format!("ompdesk-manual-{name}-")).unwrap();
        crate::git::session_lifecycle::test_support::repo_at(&path);
        path
    }
}
