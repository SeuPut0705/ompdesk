use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::protocol::CommandError;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    id: String,
    api: String,
    base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    clear_api_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_header: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    discovery: Option<Discovery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disable_strict_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra_body: Option<BTreeMap<String, Value>>,
    models: Vec<Model>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<f64>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Thinking {
    mode: String,
    efforts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_display: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cost {
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_read: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_write: Option<f64>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Thinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost: Option<Cost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    premium_multiplier: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_window: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    omit_max_output_tokens: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<BTreeMap<String, String>>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Override {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<OverrideThinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_window: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replay_reasoning: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverrideThinking {
    mode: String,
    efforts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort_map: Option<BTreeMap<String, String>>,
}

fn invalid() -> CommandError { CommandError::Other("Invalid provider configuration".into()) }

// Transport-only validation, matching remote/app-protocol.ts. Installed stock still validates every protocol,
// auth, discovery and thinking option. Unknown object fields are stripped, not promoted into config privileges.
pub fn provider(value: Value) -> Result<Value, CommandError> {
    reject_nulls(&value, &["apiKey", "clearApiKey", "auth", "authHeader", "headers", "discovery", "disableStrictTools", "transport", "extraBody"])?;
    if let Some(discovery) = value.get("discovery") { reject_nulls(discovery, &["timeoutMs"])?; }
    for model in value["models"].as_array().into_iter().flatten() {
        reject_nulls(model, &["name", "api", "baseUrl", "reasoning", "thinking", "input", "supportsTools", "cost", "premiumMultiplier", "contextWindow", "maxTokens", "omitMaxOutputTokens", "headers"])?;
        if let Some(thinking) = model.get("thinking") { reject_nulls(thinking, &["defaultLevel", "supportsDisplay"])?; }
        if let Some(cost) = model.get("cost") { reject_nulls(cost, &["input", "output", "cacheRead", "cacheWrite"])?; }
    }
    let parsed: Provider = serde_json::from_value(value).map_err(|_| invalid())?;
    if parsed.id.is_empty() || parsed.id.encode_utf16().count() > 200 || parsed.models.iter().any(|model| model.id.is_empty() || model.input.as_ref().is_some_and(|input| input.iter().any(|kind| kind != "text" && kind != "image")))
        || parsed.transport.as_ref().is_some_and(|transport| transport != "pi-native") { return Err(invalid()); }
    serde_json::to_value(parsed).map_err(|_|invalid())
}

pub fn model_override(value: Value) -> Result<Value, CommandError> {
    if value.is_null() { return Ok(value); }
    reject_nulls(&value, &["name", "api", "reasoning", "thinking", "contextWindow", "maxTokens", "replayReasoning"])?;
    if let Some(thinking) = value.get("thinking") { reject_nulls(thinking, &["effortMap"])?; }
    let parsed: Override = serde_json::from_value(value).map_err(|_|invalid())?;
    if parsed.thinking.as_ref().is_some_and(|thinking|thinking.efforts.is_empty()) { return Err(invalid()); }
    serde_json::to_value(parsed).map_err(|_|invalid())
}

fn reject_nulls(value: &Value, fields: &[&str]) -> Result<(), CommandError> {
    if fields.iter().any(|field| value.get(*field).is_some_and(Value::is_null)) { Err(invalid()) } else { Ok(()) }
}
