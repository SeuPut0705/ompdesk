//! Direct native effects for the lifecycle. Base supplies authenticated window/pool hooks;
//! stock commands stay on the captured canonical sidecar, git stays in the existing native git service.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{Effect, Host, Snapshot, Spawn, UiEvent, Window, Work, Worktree};
use crate::git::session_lifecycle::Service as SessionGit;
use crate::pool::application::Sidecar;
use crate::server::Fault;

pub trait Hooks: Send + Sync + 'static {
    type Source: Sidecar<Error = Fault> + ?Sized + 'static;
    fn windows(&self) -> Vec<Window>;
    fn send(&self, window: Window, event: UiEvent);
    fn branch_prefix(&self) -> Option<String>;
    fn connected(&self, source: &Arc<Self::Source>) -> bool;
    fn create(&self, spawn: &Spawn, source: &Arc<Self::Source>, params: Option<Value>) -> Work<Value>;
    fn bind_if_live(&self, spawn: &Spawn, source: &Arc<Self::Source>, binding: Value) -> Work<bool>;
    fn release(&self, spawn: &Spawn, source: &Arc<Self::Source>) -> Work<()>;
}

pub struct NativeHost<H: Hooks> { hooks: Arc<H>, git: Arc<SessionGit> }

impl<H: Hooks> NativeHost<H> {
    pub fn new(hooks: Arc<H>, git: Arc<SessionGit>) -> Arc<Self> { Arc::new(Self { hooks, git }) }
}

impl<H: Hooks> Host for NativeHost<H> {
    type Source = H::Source;
    fn windows(&self) -> Vec<Window> { self.hooks.windows() }
    fn send(&self, window: Window, event: UiEvent) { self.hooks.send(window, event); }
    fn connected(&self, source: &Arc<Self::Source>) -> bool { self.hooks.connected(source) }
    fn settings(&self, source: &Arc<Self::Source>) -> Work<Value> {
        source.bridge("worktree_lifecycle_settings".into(), None, None)
    }
    fn create(&self, spawn: &Spawn, source: &Arc<Self::Source>, params: Option<Value>) -> Work<Value> {
        self.hooks.create(spawn, source, params)
    }
    fn branch_prefix(&self) -> Option<String> { self.hooks.branch_prefix() }
    fn bind(&self, spawn: &Spawn, source: &Arc<Self::Source>, binding: Value) -> Work<bool> {
        self.hooks.bind_if_live(spawn, source, binding)
    }
    fn inspect<'a>(&'a self, worktree: &'a Worktree) -> Effect<'a, Snapshot> {
        Box::pin(self.git.inspect(worktree))
    }
    fn remove<'a>(&'a self, worktree: &'a Worktree, moved: bool) -> Effect<'a, ()> {
        Box::pin(self.git.remove(worktree, moved))
    }
    fn stop_turn(&self, source: &Arc<Self::Source>) -> Work<()> {
        let stopped = source.stock(json!({"type":"abort"}));
        Box::pin(async move {
            let response = stopped.await?;
            if response["success"] == true { Ok(()) }
            else { Err(Fault::new("abort_failed", response["error"].as_str().unwrap_or("omp could not stop its turn"))) }
        })
    }
    fn release(&self, spawn: &Spawn, source: &Arc<Self::Source>) -> Work<()> {
        self.hooks.release(spawn, source)
    }
}
