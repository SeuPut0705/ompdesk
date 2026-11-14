//! Local-handler-first RPC over the native pool's original source. Stock and bridge operations use that source's
//! existing lane. The authenticated application dispatcher owns caller/tab admission and invokes this binding.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::pool::application::Sidecar;
use crate::server::Fault;

pub mod composer;
pub mod delivery;
pub mod modes;
pub mod policy;
pub mod protocol;
pub mod provider_files;
pub mod provider_yaml;
pub mod providers;
pub mod queue;
pub mod session;
pub mod settings;
pub mod transcript;

use protocol::{RpcCommand, RpcResponse};
use session::Session;

#[derive(Clone, Copy)]
pub enum Area {
    Composer,
    Queue,
    Modes,
    Settings,
    Transcript,
}

pub struct CommandTable(HashMap<&'static str, Area>);

impl CommandTable {
    pub fn new(areas: &[(&str, Area, &[&'static str])]) -> Result<Self, Fault> {
        let mut commands = HashMap::new();
        for (area, handler, names) in areas {
            for &name in *names {
                if commands.insert(name, *handler).is_some() {
                    return Err(Fault::new("duplicate_local_command", format!("Local RPC command \"{name}\" is defined twice ({area})")));
                }
            }
        }
        Ok(Self(commands))
    }

    pub fn builtin() -> Result<Self, Fault> {
        Self::new(&[
            ("composer", Area::Composer, composer::COMMANDS),
            ("queue", Area::Queue, queue::COMMANDS),
            ("modes", Area::Modes, modes::COMMANDS),
            ("settings", Area::Settings, settings::COMMANDS),
            ("transcript", Area::Transcript, transcript::COMMANDS),
        ])
    }
}

struct Spawn<S: Sidecar<Error = Fault> + ?Sized> {
    generation: u64,
    session: Session<S>,
    queue: queue::Queue,
    transcript: transcript::Transcript,
}

/// Attached to the canonical source by the actual native PoolHost, not looked up through a second tab registry.
/// Each spawn replaces only its local projection/cache state. Authority and source ownership remain Base's.
pub struct Commands<S: Sidecar<Error = Fault> + ?Sized> {
    source: Arc<S>,
    version: Arc<str>,
    table: CommandTable,
    spawn: Mutex<Arc<Spawn<S>>>,
    next: AtomicU64,
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> Commands<S> {
    pub fn new(source: Arc<S>, version: Arc<str>) -> Result<Self, Fault> {
        let spawn = Arc::new(Self::spawn(Arc::clone(&source), Arc::clone(&version)));
        Ok(Self { source, version, table: CommandTable::builtin()?, spawn: Mutex::new(spawn), next: AtomicU64::new(0) })
    }

    fn spawn(source: Arc<S>, version: Arc<str>) -> Spawn<S> {
        Spawn { generation: source.generation(), session: Session::new(source, version), queue: queue::Queue::new(), transcript: transcript::Transcript::default() }
    }

    fn current(&self) -> Arc<Spawn<S>> {
        let mut spawn = self.spawn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if spawn.generation != self.source.generation() {
            *spawn = Arc::new(Self::spawn(Arc::clone(&self.source), Arc::clone(&self.version)));
        }
        Arc::clone(&spawn)
    }

    /// Runs before the same source's queue_update reaches the pool and its windows. Sharing this Queue with command
    /// reads preserves chip ids through events, edits and moves, and resets them only for a new omp generation.
    pub fn project_frame(&self, frame: &mut Value) {
        if frame["type"] == "queue_update" {
            *frame = self.current().queue.project_queue_update(std::mem::take(frame));
        }
    }

    pub async fn command(&self, mut command: RpcCommand) -> Result<Value, Fault> {
        let spawn = self.current();
        let sequence = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        command.id = Some(format!("gui-{sequence}"));
        let Some(area) = self.table.0.get(command.kind.as_str()) else {
            let command = serde_json::to_value(command).map_err(|error| Fault::new("invalid_params", error.to_string()))?;
            return spawn.session.raw_stock(command).await;
        };
        // A hit is consumed regardless of its result. In particular a bridge or local error must never cause this
        // command to be sent to stock, which may interpret an unknown slash command as a model prompt.
        let result = match area {
            Area::Composer => composer::handle(&command, &spawn.session).await,
            Area::Queue => spawn.queue.handle(&command, &spawn.session).await,
            Area::Modes => modes::handle(&command, &spawn.session).await,
            Area::Settings => settings::handle(&command, &spawn.session).await,
            Area::Transcript => spawn.transcript.handle(&command, &spawn.session).await,
        };
        self.source.before_response();
        serde_json::to_value(RpcResponse::local(&command, result)).map_err(|error| Fault::new("internal", error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_registration_refuses_startup_and_stock_members_are_not_local_commands() {
        let error = CommandTable::new(&[("first", Area::Modes, &["same"]), ("second", Area::Settings, &["same"])]).err().unwrap();
        assert_eq!(error.message, "Local RPC command \"same\" is defined twice (second)");
        let table = CommandTable::builtin().unwrap();
        for stock in ["constructor", "get_messages", "btw", "btw_cancel", "get_btw_history"] { assert!(!table.0.contains_key(stock)); }
    }
}
