use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, MutexGuard};

use crate::server::{Fault, Scope};
use crate::stock::native::Service as Stock;

use super::protocol::CommandError;
use super::provider_files::{ProviderFiles, Snapshot};
use super::provider_input;
use super::providers::ProviderPolicy;

type Result<T, E = CommandError> = std::result::Result<T, E>;
const STOCK_TIMEOUT: Duration = Duration::from_secs(30);

/// One canonical instance per execution machine, injected into that machine's admitted Settings/host routes.
/// The application supplies the resolved agent directory and its existing direct Stock service, never RPC data.
/// This is distinct from the raw-text editor: installed stock owns both option vocabularies and file validation.
pub struct Service {
    files: ProviderFiles,
    stock: Arc<Stock>,
    mutation: Mutex<()>,
}

impl Service {
    pub fn new(agent_dir: PathBuf, stock: Arc<Stock>) -> Self {
        Self { files: ProviderFiles::new(agent_dir), stock, mutation: Mutex::new(()) }
    }

    async fn policy(&self, scope: &Scope) -> Result<ProviderPolicy> {
        ProviderPolicy::new(self.stock.request("catalog.roster", &json!({}), STOCK_TIMEOUT, scope.clone()).await?)
    }

    async fn normalize(&self, raw: &Value, scope: &Scope) -> Result<Value> {
        let empty = Value::Object(Map::new());
        let raw = if raw.is_null() { &empty } else { raw };
        let reply = self.stock.request("models.validate", &json!({"config":raw}), STOCK_TIMEOUT, scope.clone()).await?;
        if let Some(error) = reply.get("error").and_then(Value::as_str).filter(|error| !error.is_empty()) {
            return Err(CommandError::Other(error.to_owned()));
        }
        reply.get("config").filter(|config| config.is_object()).cloned()
            .ok_or_else(|| CommandError::Other("Installed omp returned no normalized models configuration".into()))
    }

    async fn read(&self, scope: &Scope) -> Result<(Snapshot, Value)> {
        if scope.cancelled() { return Err(Fault::cancelled().into()); }
        let snapshot = self.files.read()?;
        let normalized = if snapshot.exists() { self.normalize(&snapshot.raw, scope).await? } else { json!({}) };
        Ok((snapshot, normalized))
    }

    async fn lock(&self, scope: &Scope) -> Result<MutexGuard<'_, ()>> {
        tokio::select! {
            biased;
            () = scope.on_cancel() => Err(Fault::cancelled().into()),
            guard = self.mutation.lock() => Ok(guard),
        }
    }

    async fn save(&self, snapshot: Snapshot, raw: Value, scope: &Scope) -> Result<()> {
        let normalized = self.normalize(&raw, scope).await?;
        self.files.save(snapshot, &normalized, scope)
    }

    pub async fn list(&self, scope: Scope) -> Result<Value> {
        let policy = self.policy(&scope).await?;
        let (_, normalized) = self.read(&scope).await?;
        Ok(json!({"providers":policy.list(&normalized["providers"]), "options":policy.options()}))
    }

    pub async fn upsert(&self, input: Value, scope: Scope) -> Result<()> {
        self.write_provider(input, false, scope).await.map(|_| ())
    }

    /// Used by the canonical local-engine service; the insert check and write share the same mutation turn as UI
    /// edits. Detecting an engine cannot overwrite a provider the person added while stock schema loading awaited.
    pub async fn insert(&self, input: Value, scope: Scope) -> Result<bool> {
        self.write_provider(input, true, scope).await
    }

    async fn write_provider(&self, input: Value, only_if_absent: bool, scope: Scope) -> Result<bool> {
        let input = provider_input::provider(input)?;
        let id = input["id"].as_str().expect("validated provider id");
        let _guard = self.lock(&scope).await?;
        let policy = self.policy(&scope).await?;
        // Check built-in ids before reading a potentially invalid file, as the existing coordinator does.
        policy.check_custom_id(id)?;
        let (snapshot, normalized) = self.read(&scope).await?;
        let Some(entry) = policy.upsert(normalized["providers"].get(id), &input, only_if_absent)? else { return Ok(false); };
        let mut raw = snapshot.raw.clone();
        providers_mut(&mut raw).insert(id.to_owned(), entry);
        self.save(snapshot, raw, &scope).await?;
        Ok(true)
    }

    pub async fn delete(&self, id: &str, scope: Scope) -> Result<()> {
        let _guard = self.lock(&scope).await?;
        self.policy(&scope).await?.can_delete(id)?;
        let (snapshot, normalized) = self.read(&scope).await?;
        if normalized["providers"].get(id).is_none() { return Ok(()); }
        let mut raw = snapshot.raw.clone();
        providers_mut(&mut raw).remove(id);
        self.save(snapshot, raw, &scope).await
    }

    pub async fn set_override(&self, provider: &str, model_id: &str, input: Value, scope: Scope) -> Result<()> {
        let input = provider_input::model_override(input)?;
        let _guard = self.lock(&scope).await?;
        let policy = self.policy(&scope).await?;
        let (snapshot, _) = self.read(&scope).await?;
        let entry = policy.override_model(snapshot.raw["providers"].get(provider), model_id, &input);
        let mut raw = snapshot.raw.clone();
        let providers = providers_mut(&mut raw);
        match entry {
            Some(entry) => { providers.insert(provider.to_owned(), entry); }
            None => { providers.remove(provider); }
        }
        self.save(snapshot, raw, &scope).await
    }
}

fn providers_mut(raw: &mut Value) -> &mut Map<String, Value> {
    if !raw.is_object() { *raw = json!({}); }
    let root = raw.as_object_mut().expect("object initialized");
    let providers = root.entry("providers").or_insert_with(|| json!({}));
    if !providers.is_object() { *providers = json!({}); }
    providers.as_object_mut().expect("object initialized")
}
