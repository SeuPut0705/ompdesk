use serde_json::{Map, Value, json};

use crate::pool::application::Sidecar;
use crate::server::Fault;

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "get_settings_schema", "get_settings", "set_setting", "get_available_models", "get_providers", "logout",
    "get_provider_accounts", "redeem_reset_pass", "get_usage", "get_model_roles", "set_model_role",
    "get_model_role_metadata", "get_model_setup_facts", "get_session_spend", "get_compaction_points",
    "compaction_limits", "get_recent_models", "set_output_style", "set_idle_compaction_draft", "history_record",
];

pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(command: &RpcCommand, session: &Session<S>) -> CommandResult {
    let params = &command.params;
    let mut original = command.fields();
    original["type"] = json!(command.kind);
    if let Some(id) = &command.id { original["id"] = json!(id); }
    let (method, args) = match command.kind.as_str() {
        "get_settings_schema" => ("settings_schema", Value::Null),
        "get_settings" => ("settings_get", selected(command, &["paths"])),
        "set_setting" => ("settings_set", selected(command, &["path", "value"])),
        "get_available_models" => ("models_catalog", json!({"forceRefresh": command.is_true("forceRefresh")})),
        "get_providers" => ("providers", json!({"forceRefresh": command.is_true("forceRefresh")})),
        "logout" => {
            let provider = required_text(command, "providerId")?;
            if command.is_true("all") {
                ("provider_logout", json!({"providerId":provider}))
            } else {
                let credential = required_integer(command, "credentialId")?;
                return session.stock(json!({"type":"logout","providerId":provider,"credentialId":credential})).await.map(Some);
            }
        }
        "get_provider_accounts" => {
            let provider = required_text(command, "providerId")?;
            let (stock, usage) = tokio::join!(
                session.stock(json!({"type":"get_logout_accounts","providerId":provider})),
                session.bridge("provider_accounts", json!({"providerId":provider,"refresh":command.is_true("refresh")})),
            );
            let stock = stock?;
            let (usage, error) = match usage { Ok(usage) => (Some(usage), None), Err(error) => (None, Some(error_text(error))) };
            return Ok(Some(merge_accounts(provider, &stock["accounts"], usage.as_ref(), error.as_deref())));
        }
        "redeem_reset_pass" => {
            let mut args = json!({"providerId":required_text(command,"providerId")?,"credentialId":required_integer(command,"credentialId")?});
            if params.contains_key("creditId") { args["creditId"] = json!(required_text(command,"creditId")?); }
            ("reset_pass_redeem", args)
        }
        "get_usage" => ("usage", json!({"refresh": command.is_true("refresh")})),
        "get_model_roles" => ("model_roles", json!({"compact": command.is_true("compact")})),
        "set_model_role" => {
            let mut args = selected(command, &["role"]);
            args["modelId"] = params.get("modelId").cloned().unwrap_or(Value::Null);
            ("model_role_set", args)
        }
        "get_model_role_metadata" => ("model_role_metadata", Value::Null),
        "get_model_setup_facts" => ("model_setup_facts", Value::Null),
        "get_session_spend" => ("session_spend", Value::Null),
        "get_compaction_points" => ("compaction_points", selected(command, &["selector"])),
        "compaction_limits" => ("compaction_limits", original),
        "get_recent_models" => ("recent_models", Value::Null),
        "set_output_style" => ("output_style_set", json!({"style": command.string("style").ok_or_else(|| invalid("style"))?})),
        "set_idle_compaction_draft" => {
            let empty = params.get("empty").and_then(Value::as_bool).ok_or_else(|| invalid("empty"))?;
            let (recap, armed) = tokio::join!(session.bridge("recap_draft", json!({"empty":empty})), session.bridge("idle_compaction_draft", json!({"empty":empty})));
            let _ = recap;
            return armed.map(Some);
        }
        "history_record" => ("history_record", original),
        _ => return Err(CommandError::Other(format!("Unknown settings RPC command {}", command.kind))),
    };
    session.bridge(method, args).await.map(Some)
}

fn error_text(error: CommandError) -> String {
    match error { CommandError::Local { message, .. } | CommandError::Other(message) => message }
}
fn invalid(field: &str) -> CommandError { CommandError::Other(format!("Invalid {field}")) }
fn required_text<'a>(command: &'a RpcCommand, field: &str) -> Result<&'a str, CommandError> {
    command.string(field).filter(|value| !value.is_empty()).ok_or_else(|| invalid(field))
}
fn required_integer(command: &RpcCommand, field: &str) -> Result<Value, CommandError> {
    command.params.get(field).filter(|value| value.as_f64().is_some_and(|value| value.is_finite() && value.fract() == 0.0)).cloned().ok_or_else(|| invalid(field))
}
fn selected(command: &RpcCommand, fields: &[&str]) -> Value {
    Value::Object(fields.iter().filter_map(|field| command.params.get(*field).map(|value| ((*field).into(), value.clone()))).collect())
}

pub fn merge_accounts(provider: &str, stock: &Value, usage: Option<&Value>, usage_error: Option<&str>) -> Value {
    let pools = usage.and_then(|usage| usage.get("credentialProvider"));
    let rows: Vec<_> = stock.as_array().into_iter().flatten().map(|account| {
        let quota = usage.and_then(|usage| usage["accounts"].as_array()).and_then(|rows| rows.iter().rev().find(|row| row["credentialId"] == account["credentialId"]));
        let mut out = Map::new();
        for key in ["credentialId", "label", "detail", "type"] {
            if let Some(value) = account.get(key) { out.insert(key.into(), value.clone()); }
        }
        let pinned = usage.and_then(|usage| usage.get("pinnedCredentialId"));
        out.insert("inUse".into(), json!(pinned.is_some() && pinned == account.get("credentialId")));
        out.insert("state".into(), quota.and_then(|quota| quota.get("state")).cloned().unwrap_or(json!("unknown")));
        out.insert("limits".into(), quota.and_then(|quota| quota.get("limits")).cloned().unwrap_or(json!([])));
        for key in ["remainingFraction", "fetchedAt", "resetPasses", "credits"] {
            if let Some(value) = quota.and_then(|quota| quota.get(key)) { out.insert(key.into(), value.clone()); }
        }
        if quota.is_some_and(|quota| quota["state"] == "depleted") {
            if let Some(value) = quota.and_then(|quota| quota.get("resetsAt")) { out.insert("limitedUntil".into(), value.clone()); }
        }
        if pools.is_some() {
            out.insert("identityKey".into(), quota.and_then(|quota| quota.get("identityKey")).cloned().unwrap_or(Value::Null));
        }
        Value::Object(out)
    }).collect();
    let mut out = json!({"providerId":provider,"accounts":rows});
    if let Some(error) = usage_error.filter(|error| !error.is_empty()) { out["usageError"] = json!(error); }
    if let Some(pools) = pools { out["credentialProvider"] = pools.clone(); }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stock_active_fallback_is_not_an_actual_pin_and_usage_failure_keeps_accounts() {
        let stock = json!([{"credentialId":1,"label":"A","detail":"","type":"oauth","active":true}]);
        assert_eq!(merge_accounts("provider", &stock, None, Some("quota unavailable")), json!({"providerId":"provider","accounts":[{"credentialId":1,"label":"A","detail":"","type":"oauth","inUse":false,"state":"unknown","limits":[]}],"usageError":"quota unavailable"}));
        let usage = json!({"pinnedCredentialId":1,"credentialProvider":"shared","accounts":[{"credentialId":1,"state":"depleted","remainingFraction":0,"resetsAt":100,"limits":[{"id":"five_hour"}],"credits":{"kind":"balance","amount":5},"resetPasses":{"count":2}}]});
        let merged = merge_accounts("provider", &stock, Some(&usage), None);
        assert_eq!(merged["accounts"][0]["inUse"], true);
        assert_eq!(merged["accounts"][0]["identityKey"], Value::Null);
        assert_eq!(merged["accounts"][0]["limitedUntil"], 100);
        assert_eq!(merged["accounts"][0]["credits"], usage["accounts"][0]["credits"]);
        assert_eq!(merged["accounts"][0]["resetPasses"], usage["accounts"][0]["resetPasses"]);
    }
}
