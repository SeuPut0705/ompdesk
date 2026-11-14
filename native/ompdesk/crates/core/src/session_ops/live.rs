use std::sync::Arc;

use ompdesk_app_contract::Owner;
use serde_json::{Value, json};

use crate::agentctl::service::host::node_resolve;
use crate::fs::order::js_trim;
use crate::local_dispatch::protocol::CommandError;
use crate::local_dispatch::session::Session;
use crate::pool::application::native::{Host as PoolHost, Service as Pool};
use crate::server::{Fault, Scope};

use super::{Coordinator, Host, Mutation, Target};

/// Base routes remote tab.command to the actual execution host before constructing this captured local source.
/// A live session need not have a file.
pub struct LiveSource<'a, P: PoolHost> {
    pub pool: &'a Pool<P>,
    pub owner: &'a Owner,
    pub tab: &'a str,
    pub execution_host: Option<&'a str>,
    pub session_file: Option<&'a str>,
    pub session: &'a Session<P::Sidecar>,
}

impl<P: PoolHost> LiveSource<'_, P> {
    fn current(&self, scope: &Scope) -> Result<(), CommandError> {
        if scope.cancelled() {
            return Err(Fault::cancelled().into());
        }
        if self.execution_host.is_some() {
            return Err(Fault::new(
                "execution_host_mismatch",
                "The session operation must run on its execution host",
            ).into());
        }
        let actual = self.pool.source(self.owner, self.tab)?;
        if !Arc::ptr_eq(&actual, &self.session.source) {
            return Err(Fault::new("tab_stale", "The tab's sidecar has changed").into());
        }
        Ok(())
    }
}

impl<H: Host> Coordinator<H> {
    pub async fn rename_from_live<P: PoolHost>(
        &self,
        source: &LiveSource<'_, P>,
        name: &str,
        session_path: Option<&str>,
        scope: Scope,
    ) -> Result<Value, CommandError> {
        source.current(&scope)?;
        let name = js_trim(name);
        if name.is_empty() {
            return Err(CommandError::Other("Session name cannot be empty".to_owned()));
        }
        let target = session_path.map(node_resolve);
        let current_file = source.session_file.map(node_resolve);
        if target.is_none() || target == current_file {
            // Session's canonical wrapper must use the actual Lane's captured-generation APIs.
            source.session.stock(json!({"type":"set_session_name","name":name})).await?;
            return Ok(Value::Null);
        }
        let target = target.ok_or_else(|| CommandError::Other("Invalid session path".to_owned()))?;
        self.execute(
            source.owner,
            Target {
                path: target,
                device: source.execution_host.map(str::to_owned),
            },
            Mutation::Rename(name.to_owned()),
            scope,
        ).await.map_err(command_error)?;
        Ok(Value::Null)
    }
}

pub async fn move_live<P: PoolHost>(
    source: &LiveSource<'_, P>,
    raw: &str,
    scope: Scope,
) -> Result<Value, CommandError> {
    let target = js_trim(raw);
    if target.is_empty() {
        return Err(CommandError::Other("path must be a non-empty string".to_owned()));
    }
    if raw.contains(['\r', '\n', '\0']) {
        return Err(CommandError::Other("path must not contain line breaks or NUL".to_owned()));
    }
    source.current(&scope)?;
    let (state, before) = tokio::join!(
        source.session.stock(json!({"type":"get_state"})),
        source.session.bridge("workspace.directories", json!({})),
    );
    let state = state?;
    let before = before?;
    if state["isStreaming"] == true {
        return Err(CommandError::local("busy", "Cannot move while streaming.".to_owned()));
    }
    let previous = primary_directory(&before)
        .map(str::to_owned)
        .unwrap_or_else(|| source.session.cwd());
    source.current(&scope)?;
    let resolved = source.session.bridge("workspace.resolve_path", json!({"path":target})).await?;
    let target = resolved["path"].as_str()
        .ok_or_else(|| CommandError::Other("Move failed: no resolved directory".to_owned()))?;
    let metadata_path = target.to_owned();
    let metadata = tokio::task::spawn_blocking(move || crate::fs::disk::stat(&metadata_path)).await
        .map_err(|_| CommandError::Other(format!("Directory does not exist: {target}")))?
        .map_err(|_| CommandError::Other(format!("Directory does not exist: {target}")))?;
    if !metadata.is_dir() {
        return Err(CommandError::Other(format!("Not a directory: {target}")));
    }
    source.current(&scope)?;
    source.session.slash("move", Some(target)).await?;
    source.current(&scope)?;
    let after = source.session.bridge("workspace.directories", json!({})).await?;
    let cwd = primary_directory(&after)
        .ok_or_else(|| CommandError::Other("Move failed: the session reported no working directory".to_owned()))?;
    if cwd == previous && node_resolve(target) != previous {
        return Err(CommandError::Other(format!("Move failed: the session is still in {previous}")));
    }
    Ok(json!({"cwd":cwd}))
}

fn primary_directory(value: &Value) -> Option<&str> {
    value["directories"].as_array()?.iter()
        .find(|directory| directory["primary"] == true)?["path"].as_str()
}

fn command_error(error: super::Error) -> CommandError {
    match error {
        super::Error::Rejected { code, message } => CommandError::local(code, message.to_owned()),
        super::Error::Effect(error) => error.into(),
    }
}
