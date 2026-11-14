//! Local-handler-first RPC over the native pool's original source. Stock and bridge operations use that source's
//! existing lane. The authenticated application dispatcher owns caller/tab admission and invokes this binding.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::Value;

use crate::pool::application::Sidecar;
use crate::server::Fault;

pub mod archive;
pub mod authoring;
pub mod composer;
pub mod delivery;
pub mod extensions;
pub mod live;
pub mod metadata;
pub mod modes;
pub mod policy;
pub mod protocol;
pub mod provider_files;
pub mod provider_input;
pub mod provider_service;
pub mod provider_yaml;
pub mod providers;
pub mod queue;
pub mod session;
pub mod settings;
pub mod stock_commands;
pub mod transcript;

use protocol::{RpcCommand, RpcResponse};
use session::Session;

/// Host-owned resolved version and pre-rendered canonical templates. Neither is taken from RPC command data.
pub struct Config {
    pub version: Arc<str>,
    pub templates: Arc<[authoring::Template]>,
    pub stock: Arc<crate::stock::native::Service>,
}

static METADATA: LazyLock<metadata::Metadata> = LazyLock::new(metadata::Metadata::default);
static ARCHIVES: LazyLock<archive::Archives> = LazyLock::new(archive::Archives::default);

#[derive(Clone, Copy)]
pub enum Area {
    Composer,
    Queue,
    Modes,
    Settings,
    Transcript,
    Metadata,
    Extensions,
    Authoring,
    Live,
    Stock,
    Archive,
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
            ("metadata", Area::Metadata, metadata::COMMANDS),
            ("extensions", Area::Extensions, extensions::COMMANDS),
            ("authoring", Area::Authoring, authoring::COMMANDS),
            ("live", Area::Live, live::COMMANDS),
            ("stock", Area::Stock, stock_commands::COMMANDS),
            ("archive", Area::Archive, archive::COMMANDS),
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
    config: Config,
    table: CommandTable,
    spawn: Mutex<Arc<Spawn<S>>>,
    next: AtomicU64,
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> Commands<S> {
    pub fn new(source: Arc<S>, config: Config) -> Result<Self, Fault> {
        let generation = source.generation();
        Self::from_captured(source, config, generation)
    }

    /// Native admission supplies the generation captured with the authenticated source in the same hub step.
    pub fn from_captured(source: Arc<S>, config: Config, generation: u64) -> Result<Self, Fault> {
        let spawn = Arc::new(Self::spawn(Arc::clone(&source), Arc::clone(&config.version), generation));
        Ok(Self { source, config, table: CommandTable::builtin()?, spawn: Mutex::new(spawn), next: AtomicU64::new(0) })
    }

    fn spawn(source: Arc<S>, version: Arc<str>, generation: u64) -> Spawn<S> {
        Spawn { generation, session: Session::from_captured(source, version, generation), queue: queue::Queue::new(), transcript: transcript::Transcript::default() }
    }

    fn captured(&self, generation: u64) -> Arc<Spawn<S>> {
        let mut spawn = self.spawn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if spawn.generation == generation { return Arc::clone(&spawn); }
        let selected = Arc::new(Self::spawn(Arc::clone(&self.source), Arc::clone(&self.config.version), generation));
        if spawn.generation < generation { *spawn = Arc::clone(&selected); }
        selected
    }

    /// Runs before the same source's queue_update reaches the pool and its windows. Sharing this Queue with command
    /// reads preserves chip ids through events, edits and moves, and resets them only for a new omp generation.
    pub fn project_frame(&self, frame: &mut Value) {
        if frame["type"] == "queue_update" {
            *frame = self.captured(self.source.generation()).queue.project_queue_update(std::mem::take(frame));
        }
    }

    /// Capture before returning the future, not when an executor first polls it after another lifecycle command.
    pub fn command(&self, command: RpcCommand) -> crate::pool::application::EffectFuture<'_, Result<Value, Fault>> {
        self.command_for_generation(self.source.generation(), command)
    }

    pub fn command_for_generation(&self, generation: u64, command: RpcCommand) -> crate::pool::application::EffectFuture<'_, Result<Value, Fault>> {
        let cwd = Arc::from(self.source.facts()["cwd"].as_str().unwrap_or_default());
        self.command_with_captured_cwd(generation, cwd, command)
    }

    /// The caller supplies only the native selected cwd, never a page's command field or a late facts lookup.
    pub fn command_with_captured_cwd(&self, generation: u64, cwd: Arc<str>, command: RpcCommand) -> crate::pool::application::EffectFuture<'_, Result<Value, Fault>> {
        let spawn = self.captured(generation);
        let session = spawn.session.clone().with_captured_cwd(cwd);
        Box::pin(self.execute(command, spawn, session))
    }

    async fn execute(&self, mut command: RpcCommand, spawn: Arc<Spawn<S>>, session: Session<S>) -> Result<Value, Fault> {
        let sequence = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        command.id = Some(format!("gui-{sequence}"));
        let Some(area) = self.table.0.get(command.kind.as_str()) else {
            let command = serde_json::to_value(command).map_err(|error| Fault::new("invalid_params", error.to_string()))?;
            return session.raw_stock(command).await;
        };
        // A hit is consumed regardless of its result. In particular a bridge or local error must never cause this
        // command to be sent to stock, which may interpret an unknown slash command as a model prompt.
        let result = match area {
            Area::Composer => composer::handle(&command, &session).await,
            Area::Queue => spawn.queue.handle(&command, &session).await,
            Area::Modes => modes::handle(&command, &session).await,
            Area::Settings => settings::handle(&command, &session).await,
            Area::Transcript => spawn.transcript.handle(&command, &session).await,
            Area::Metadata => METADATA.handle(&command).await,
            Area::Extensions => extensions::handle(&command, &session).await,
            Area::Authoring => authoring::handle(&command, &session, &self.config.templates).await,
            Area::Live => live::handle(&command, &session).await,
            Area::Stock => stock_commands::handle(&command, &self.config.stock).await,
            Area::Archive => ARCHIVES.handle(&command, &session).await,
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
