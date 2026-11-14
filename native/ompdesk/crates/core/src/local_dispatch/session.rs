use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::Mutex;

use serde_json::{Value, json};

use crate::pool::application::Sidecar;
use crate::server::Fault;

use super::protocol::{CommandError, RpcCommand};

pub struct Session<S: Sidecar<Error = Fault> + ?Sized> {
    pub source: Arc<S>,
    pub version: Arc<str>,
    generation: u64,
    slash: Arc<Mutex<Option<HashSet<String>>>>,
}

impl<S: Sidecar<Error = Fault> + ?Sized> Clone for Session<S> {
    fn clone(&self) -> Self {
        Self { source: Arc::clone(&self.source), version: Arc::clone(&self.version), generation: self.generation, slash: Arc::clone(&self.slash) }
    }
}

impl<S: Sidecar<Error = Fault> + ?Sized + 'static> Session<S> {
    pub fn new(source: Arc<S>, version: Arc<str>) -> Self {
        let generation = source.generation();
        Self { source, version, generation, slash: Arc::default() }
    }

    fn ensure_current(&self) -> Result<(), Fault> {
        if self.source.generation() == self.generation {
            Ok(())
        } else {
            Err(Fault::new("sidecar_disconnected", "Sidecar disconnected"))
        }
    }

    pub async fn raw_stock(&self, command: Value) -> Result<Value, Fault> {
        self.ensure_current()?;
        self.source.stock(command).await
    }

    pub fn cwd(&self) -> String {
        self.source.facts()["cwd"].as_str().unwrap_or_default().to_owned()
    }

    pub fn bridge_connected(&self) -> bool {
        self.source.bridge_connected()
    }

    pub async fn bridge(&self, method: &str, params: Value) -> Result<Value, CommandError> {
        self.ensure_current()?;
        self.source.bridge(method.to_owned(), Some(params), None).await.map_err(Into::into)
    }

    pub async fn stock(&self, command: Value) -> Result<Value, CommandError> {
        let response = self.raw_stock(command).await?;
        if response["success"] == true {
            Ok(response.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(CommandError::Other(response["error"].as_str().unwrap_or("RPC command failed").to_owned()))
        }
    }

    pub async fn forward(&self, method: &str, command: &RpcCommand) -> Result<Value, CommandError> {
        self.bridge(method, command.fields()).await
    }

    pub async fn slash(&self, name: &str, args: Option<&str>) -> Result<Value, CommandError> {
        let commands = {
            let mut cached = self.slash.lock().await;
            if cached.is_none() {
                let answer = self.stock(json!({"type":"get_available_commands"})).await?;
                let mut commands = HashSet::new();
                for row in answer["commands"].as_array().into_iter().flatten() {
                    if row["source"] != "builtin" { continue; }
                    if let Some(name) = row["name"].as_str() {
                        commands.insert(name.to_owned());
                        for alias in row["aliases"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                            commands.insert(alias.to_owned());
                        }
                    }
                }
                *cached = Some(commands);
            }
            cached.as_ref().is_some_and(|commands| commands.contains(name))
        };
        if !commands {
            return Err(CommandError::local("unsupported", format!("omp {} has no /{name} command", self.version)));
        }
        let message = match args.filter(|args| !args.is_empty()) {
            Some(args) => format!("/{name} {args}"),
            None => format!("/{name}"),
        };
        let result = self.stock(json!({"type":"prompt","message":message})).await?;
        Ok(json!({"agentInvoked": result["agentInvoked"] == true}))
    }
}
