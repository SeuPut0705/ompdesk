//! Direct native effects for the lifecycle. Base supplies authenticated window/pool hooks;
//! stock commands stay on the captured canonical sidecar, git stays in the existing native git service.

use std::sync::Arc;

use serde_json::Value;

use super::{Effect, Host, Snapshot, Spawn, UiEvent, Window, Work, Worktree};
use crate::git::session_lifecycle::Service as SessionGit;
use crate::pool::application::Sidecar;
use crate::server::Fault;

/// Constructed when the real start gate executes, not when its pre-spawn callback is installed.
/// Root retains this same wrapper for Lifecycle::released, which also checks the captured Owner.
pub struct Captured<S: ?Sized> { pub source: Arc<S>, pub generation: u64 }

pub trait Hooks: Send + Sync + 'static {
    type Source: Sidecar<Error = Fault> + ?Sized + 'static;
    fn windows(&self) -> Vec<Window>;
    fn send(&self, window: Window, event: UiEvent);
    fn branch_prefix(&self) -> Option<String>;
    /// The owner, raw source identity and captured generation are admitted and queued in one hub step.
    fn create(&self, spawn: &Spawn, source: &Captured<Self::Source>, params: Option<Value>) -> Work<Value>;
    fn bind_if_live(&self, spawn: &Spawn, source: &Captured<Self::Source>, binding: Value) -> Work<bool>;
    /// These exit effects capture a fresh current run at native admission, not the creation generation.
    fn refresh(&self, spawn: &Spawn, source: &Captured<Self::Source>) -> Work<Value>;
    fn stop_turn(&self, spawn: &Spawn, source: &Captured<Self::Source>) -> Work<()>;
    /// Releases only this raw source under the captured Owner and returns its exact disposal receipt.
    fn release(&self, spawn: &Spawn, source: &Captured<Self::Source>) -> Work<()>;
}

pub struct NativeHost<H: Hooks> { hooks: Arc<H>, git: Arc<SessionGit> }

impl<H: Hooks> NativeHost<H> {
    pub fn new(hooks: Arc<H>, git: Arc<SessionGit>) -> Arc<Self> { Arc::new(Self { hooks, git }) }
}

impl<H: Hooks> Host for NativeHost<H> {
    type Source = Captured<H::Source>;
    fn windows(&self) -> Vec<Window> { self.hooks.windows() }
    fn send(&self, window: Window, event: UiEvent) { self.hooks.send(window, event); }
    fn connected(&self, captured: &Arc<Self::Source>) -> bool {
        captured.source.generation() == captured.generation && captured.source.bridge_connected()
    }
    fn settings(&self, captured: &Arc<Self::Source>) -> Work<Value> {
        captured.source.bridge_for_generation(captured.generation,
            "worktree_lifecycle_settings".into(), None, None)
    }
    fn refresh(&self, spawn: &Spawn, captured: &Arc<Self::Source>) -> Work<Value> {
        self.hooks.refresh(spawn, captured)
    }
    fn create(&self, spawn: &Spawn, captured: &Arc<Self::Source>, params: Option<Value>) -> Work<Value> {
        self.hooks.create(spawn, captured, params)
    }
    fn branch_prefix(&self) -> Option<String> { self.hooks.branch_prefix() }
    fn bind(&self, spawn: &Spawn, captured: &Arc<Self::Source>, binding: Value) -> Work<bool> {
        self.hooks.bind_if_live(spawn, captured, binding)
    }
    fn inspect<'a>(&'a self, worktree: &'a Worktree) -> Effect<'a, Snapshot> {
        Box::pin(self.git.inspect(worktree))
    }
    fn remove<'a>(&'a self, worktree: &'a Worktree, moved: bool) -> Effect<'a, ()> {
        Box::pin(self.git.remove(worktree, moved))
    }
    fn stop_turn(&self, spawn: &Spawn, captured: &Arc<Self::Source>) -> Work<()> {
        self.hooks.stop_turn(spawn, captured)
    }
    fn release(&self, spawn: &Spawn, captured: &Arc<Self::Source>) -> Work<()> {
        self.hooks.release(spawn, captured)
    }
}
