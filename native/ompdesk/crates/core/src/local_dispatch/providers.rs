use serde_json::{Map, Value, json};

use crate::agentctl::service::js::trim;

use super::protocol::CommandError;

type R<T> = Result<T, CommandError>;

/// Vocabulary is read from installed stock `catalog.roster`, never an OMPdesk copy of the provider catalog.
#[derive(Clone)]
pub struct ProviderPolicy {
    options: Value,
}

impl ProviderPolicy {
    pub fn new(options: Value) -> R<Self> {
        for key in ["builtinProviders", "apis", "auth", "discovery", "thinkingModes", "efforts"] {
            if !options.get(key).is_some_and(|value| value.as_array().is_some_and(|rows| !rows.is_empty() && rows.iter().all(Value::is_string))) {
                return Err(CommandError::Other("Installed omp cannot determine models.yml provider roster or option vocabularies".into()));
            }
        }
        Ok(Self { options })
    }

    pub fn options(&self) -> &Value { &self.options }

    fn contains(&self, vocabulary: &str, value: &Value) -> bool {
        value.is_string() && self.options[vocabulary].as_array().is_some_and(|rows| rows.contains(value))
    }

    pub fn list(&self, providers: &Value) -> Vec<Value> {
        providers.as_object().into_iter().flatten().map(|(id, value)| self.view(id, value)).collect()
    }

    pub fn view(&self, id: &str, raw: &Value) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.insert("api".into(), if self.contains("apis", &raw["api"]) { raw["api"].clone() } else { json!("openai-completions") });
        out.insert("baseUrl".into(), raw.get("baseUrl").filter(|value| value.is_string()).cloned().unwrap_or(json!("")));
        let key = raw["apiKey"].as_str().filter(|key| !key.is_empty());
        out.insert("hasApiKey".into(), json!(key.is_some()));
        if let Some(key) = key {
            let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            out.insert("apiKeyPreview".into(), json!(format!("•••{tail}")));
        }
        if self.contains("auth", &raw["auth"]) { out.insert("auth".into(), raw["auth"].clone()); }
        for field in ["authHeader", "disableStrictTools"] { copy_bool(&mut out, raw, field); }
        if let Some(headers) = strings(&raw["headers"]) { out.insert("headers".into(), headers); }
        if self.contains("discovery", &raw["discovery"]["type"]) {
            let mut discovery = json!({"type": raw["discovery"]["type"]});
            if raw["discovery"]["timeoutMs"].is_number() { discovery["timeoutMs"] = raw["discovery"]["timeoutMs"].clone(); }
            out.insert("discovery".into(), discovery);
        }
        if raw["transport"] == "pi-native" { out.insert("transport".into(), json!("pi-native")); }
        if nonempty_object(&raw["compat"]["extraBody"]) { out.insert("extraBody".into(), raw["compat"]["extraBody"].clone()); }
        let models: Vec<_> = raw["models"].as_array().into_iter().flatten().filter_map(|model| self.model_view(model)).collect();
        out.insert("models".into(), Value::Array(models));
        out.insert("builtin".into(), json!(self.contains("builtinProviders", &json!(id))));
        if let Some(overrides) = raw["modelOverrides"].as_object() {
            let projected: Map<String, Value> = overrides.iter().filter_map(|(id, entry)| self.override_view(entry).map(|view| (id.clone(), view))).collect();
            if !projected.is_empty() { out.insert("modelOverrides".into(), Value::Object(projected)); }
        }
        Value::Object(out)
    }

    fn model_view(&self, model: &Value) -> Option<Value> {
        model.as_object()?;
        let id = model["id"].as_str().filter(|id| !id.is_empty())?;
        let mut view = Map::new();
        view.insert("id".into(), json!(id));
        for field in ["name", "baseUrl"] { copy_text(&mut view, model, field); }
        if self.contains("apis", &model["api"]) { view.insert("api".into(), model["api"].clone()); }
        if model["reasoning"] == true { view.insert("reasoning".into(), json!(true)); }
        if let Some(thinking) = self.thinking_view(&model["thinking"]) { view.insert("thinking".into(), thinking); }
        if let Some(input) = model["input"].as_array() {
            let input: Vec<_> = input.iter().filter(|value| *value == "text" || *value == "image").cloned().collect();
            if !input.is_empty() { view.insert("input".into(), Value::Array(input)); }
        }
        for field in ["supportsTools", "omitMaxOutputTokens"] { copy_bool(&mut view, model, field); }
        let mut cost = Map::new();
        for field in ["input", "output", "cacheRead", "cacheWrite"] { copy_number(&mut cost, &model["cost"], field); }
        if !cost.is_empty() { view.insert("cost".into(), Value::Object(cost)); }
        for field in ["premiumMultiplier", "contextWindow", "maxTokens"] { copy_number(&mut view, model, field); }
        if let Some(headers) = strings(&model["headers"]) { view.insert("headers".into(), headers); }
        Some(Value::Object(view))
    }

    fn thinking_view(&self, raw: &Value) -> Option<Value> {
        if !self.contains("thinkingModes", &raw["mode"]) || !raw["efforts"].as_array().is_some_and(|efforts| !efforts.is_empty()) { return None; }
        let mut view = json!({"mode": raw["mode"], "efforts": raw["efforts"]});
        if self.contains("efforts", &raw["defaultLevel"]) { view["defaultLevel"] = raw["defaultLevel"].clone(); }
        if raw["supportsDisplay"].is_boolean() { view["supportsDisplay"] = raw["supportsDisplay"].clone(); }
        Some(view)
    }

    fn override_view(&self, raw: &Value) -> Option<Value> {
        raw.as_object()?;
        let mut view = Map::new();
        copy_text(&mut view, raw, "name");
        if self.contains("apis", &raw["api"]) { view.insert("api".into(), raw["api"].clone()); }
        copy_bool(&mut view, raw, "reasoning");
        if let Some(thinking) = self.thinking_view(&raw["thinking"]) {
            let mut projected = json!({"mode": thinking["mode"], "efforts": thinking["efforts"]});
            if let Some(map) = raw["thinking"]["effortMap"].as_object() {
                let map: Map<_, _> = map.iter().filter(|(effort, wire)| self.contains("efforts", &json!(effort)) && wire.as_str().is_some_and(|wire| !wire.is_empty())).map(|(key, value)| (key.clone(), value.clone())).collect();
                if !map.is_empty() { projected["effortMap"] = Value::Object(map); }
            }
            view.insert("thinking".into(), projected);
        }
        for field in ["contextWindow", "maxTokens"] { copy_number(&mut view, raw, field); }
        if raw["compat"]["requiresReasoningContentForToolCalls"].is_boolean() { view.insert("replayReasoning".into(), raw["compat"]["requiresReasoningContentForToolCalls"].clone()); }
        Some(Value::Object(view))
    }

    pub fn check_custom_id(&self, id: &str) -> R<()> {
        if self.contains("builtinProviders", &json!(id)) {
            Err(CommandError::local("provider_id_builtin", format!("\"{id}\" is a built-in provider id; choose a distinct custom id.")))
        } else { Ok(()) }
    }

    /// Returns None for insert-only when the person already owns this id. Unrendered fields stay in `before`.
    pub fn upsert(&self, before: Option<&Value>, input: &Value, only_if_absent: bool) -> R<Option<Value>> {
        let id = input["id"].as_str().ok_or_else(|| CommandError::Other("Invalid provider id".into()))?;
        self.check_custom_id(id)?;
        if only_if_absent && before.is_some() { return Ok(None); }
        let mut entry = object(before.unwrap_or(&Value::Null));
        for field in ["baseUrl", "api"] { entry.insert(field.into(), input.get(field).cloned().unwrap_or(Value::Null)); }
        if input["clearApiKey"] == true { entry.remove("apiKey"); }
        else if let Some(key) = input["apiKey"].as_str().map(trim).filter(|key| !key.is_empty()) { entry.insert("apiKey".into(), json!(key)); }
        for field in ["auth", "authHeader", "discovery", "disableStrictTools", "transport"] { set_or_delete(&mut entry, field, input.get(field)); }
        set_or_delete(&mut entry, "headers", input.get("headers").filter(|value| nonempty_object(value)));
        let mut compat = object(entry.get("compat").unwrap_or(&Value::Null));
        set_or_delete(&mut compat, "extraBody", input.get("extraBody").filter(|value| nonempty_object(value)));
        set_object(&mut entry, "compat", compat);
        let old_models = entry.get("models").and_then(Value::as_array);
        let models = input["models"].as_array().ok_or_else(|| CommandError::Other("Invalid provider models".into()))?;
        entry.insert("models".into(), Value::Array(models.iter().map(|input| {
            let old = old_models.and_then(|rows| rows.iter().find(|row| row["id"] == input["id"]));
            merge_model(old, input)
        }).collect()));
        Ok(Some(Value::Object(entry)))
    }

    pub fn can_delete(&self, id: &str) -> R<()> {
        if self.contains("builtinProviders", &json!(id)) {
            Err(CommandError::local("provider_builtin_delete", format!("\"{id}\" is a built-in provider and cannot be removed from the GUI.")))
        } else { Ok(()) }
    }

    /// Built-in providers accept overrides. Removing the last rendered field never deletes unknown fields.
    pub fn override_model(&self, before: Option<&Value>, model_id: &str, input: &Value) -> Option<Value> {
        let mut provider = object(before.unwrap_or(&Value::Null));
        let mut overrides = object(provider.get("modelOverrides").unwrap_or(&Value::Null));
        if input.is_null() { overrides.remove(model_id); }
        else {
            let mut entry = object(overrides.get(model_id).unwrap_or(&Value::Null));
            for field in ["name", "api", "reasoning", "contextWindow", "maxTokens"] { set_or_delete(&mut entry, field, input.get(field)); }
            if let Some(input_thinking) = input.get("thinking").filter(|value| value.is_object()) {
                let mut thinking = object(entry.get("thinking").unwrap_or(&Value::Null));
                for field in ["levels", "minLevel", "maxLevel"] { thinking.remove(field); }
                for field in ["mode", "efforts"] { set_or_delete(&mut thinking, field, input_thinking.get(field)); }
                set_or_delete(&mut thinking, "effortMap", input_thinking.get("effortMap").filter(|value| nonempty_object(value)));
                entry.insert("thinking".into(), Value::Object(thinking));
            } else { entry.remove("thinking"); }
            let mut compat = object(entry.get("compat").unwrap_or(&Value::Null));
            set_or_delete(&mut compat, "requiresReasoningContentForToolCalls", input.get("replayReasoning"));
            set_object(&mut entry, "compat", compat);
            set_object(&mut overrides, model_id, entry);
        }
        set_object(&mut provider, "modelOverrides", overrides);
        (!provider.is_empty()).then_some(Value::Object(provider))
    }
}

fn object(value: &Value) -> Map<String, Value> { value.as_object().cloned().unwrap_or_default() }
fn nonempty_object(value: &Value) -> bool { value.as_object().is_some_and(|value| !value.is_empty()) }
fn set_or_delete(object: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    match value.filter(|value| !value.is_null() && *value != "") {
        Some(value) => { object.insert(key.into(), value.clone()); }
        None => { object.remove(key); }
    }
}
fn set_object(parent: &mut Map<String, Value>, key: &str, value: Map<String, Value>) {
    if value.is_empty() { parent.remove(key); } else { parent.insert(key.into(), Value::Object(value)); }
}
fn copy_text(out: &mut Map<String, Value>, raw: &Value, field: &str) {
    if let Some(value) = raw.get(field).filter(|value| value.as_str().is_some_and(|text| !text.is_empty())) { out.insert(field.into(), value.clone()); }
}
fn copy_bool(out: &mut Map<String, Value>, raw: &Value, field: &str) {
    if let Some(value) = raw.get(field).filter(|value| value.is_boolean()) { out.insert(field.into(), value.clone()); }
}
fn copy_number(out: &mut Map<String, Value>, raw: &Value, field: &str) {
    if let Some(value) = raw.get(field).filter(|value| value.is_number()) { out.insert(field.into(), value.clone()); }
}
fn strings(value: &Value) -> Option<Value> {
    let filtered: Map<String, Value> = value.as_object()?.iter().filter(|(_, value)| value.is_string()).map(|(key, value)| (key.clone(), value.clone())).collect();
    (!filtered.is_empty()).then_some(Value::Object(filtered))
}
fn merge_model(before: Option<&Value>, input: &Value) -> Value {
    let mut model = object(before.unwrap_or(&Value::Null));
    model.insert("id".into(), input["id"].clone());
    for field in ["name", "api", "baseUrl", "reasoning", "supportsTools", "premiumMultiplier", "contextWindow", "maxTokens", "omitMaxOutputTokens"] { set_or_delete(&mut model, field, input.get(field)); }
    if let Some(input_thinking) = input.get("thinking").filter(|value| value.is_object()) {
        let mut thinking = object(model.get("thinking").unwrap_or(&Value::Null));
        for field in ["levels", "minLevel", "maxLevel"] { thinking.remove(field); }
        thinking.extend(object(input_thinking));
        model.insert("thinking".into(), Value::Object(thinking));
    } else { model.remove("thinking"); }
    set_or_delete(&mut model, "input", input.get("input").filter(|value| value.as_array().is_some_and(|rows| !rows.is_empty())));
    for field in ["cost", "headers"] { set_or_delete(&mut model, field, input.get(field).filter(|value| nonempty_object(value))); }
    Value::Object(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> ProviderPolicy {
        ProviderPolicy::new(json!({"builtinProviders":["builtin"],"apis":["openai-completions"],"auth":["none","oauth"],"discovery":["openai-models-list"],"thinkingModes":["effort"],"efforts":["low","high"]})).unwrap()
    }

    #[test]
    fn an_edit_keeps_hidden_config_and_secret_but_the_list_never_exposes_the_key() {
        let policy = policy();
        let before = json!({"apiKey":"sk-original-secret","remoteCompaction":{"enabled":true},"compat":{"supportsStore":true,"extraBody":{"seed":42}},"models":[{"id":"m","compactionModel":"compact","thinking":{"mode":"effort","efforts":["low","high"],"effortMap":{"low":"low"},"requiresEffort":true}}]});
        let input = json!({"id":"custom","api":"openai-completions","baseUrl":"https://example.invalid/v2","extraBody":{"temperature":0.5},"models":[{"id":"m","name":"Renamed","thinking":{"mode":"effort","efforts":["low"]}}]});
        let saved = policy.upsert(Some(&before), &input, false).unwrap().unwrap();
        assert_eq!(saved["apiKey"], "sk-original-secret");
        assert_eq!(saved["remoteCompaction"], before["remoteCompaction"]);
        assert_eq!(saved["compat"], json!({"supportsStore":true,"extraBody":{"temperature":0.5}}));
        assert_eq!(saved["models"][0]["compactionModel"], "compact");
        assert_eq!(saved["models"][0]["thinking"], json!({"mode":"effort","efforts":["low"],"effortMap":{"low":"low"},"requiresEffort":true}));
        let view = policy.view("custom", &saved);
        assert!(view.get("apiKey").is_none());
        assert_eq!(view["apiKeyPreview"], "•••cret");
        assert_eq!(view["models"][0]["name"], "Renamed");
    }

    #[test]
    fn builtin_mutations_are_refused_but_per_model_overrides_preserve_unrendered_fields() {
        let policy = policy();
        assert!(matches!(policy.upsert(None, &json!({"id":"builtin"}), false), Err(CommandError::Local {code, ..}) if code == "provider_id_builtin"));
        assert!(matches!(policy.can_delete("builtin"), Err(CommandError::Local {code, ..}) if code == "provider_builtin_delete"));
        let before = json!({"modelOverrides":{"m":{"maxTokens":100,"compat":{"unknown":true},"thinking":{"levels":["low","high"],"requiresEffort":true}}}});
        let updated = policy.override_model(Some(&before), "m", &json!({"thinking":{"mode":"effort","efforts":["low"]},"replayReasoning":false})).unwrap();
        assert_eq!(updated["modelOverrides"]["m"], json!({"compat":{"unknown":true,"requiresReasoningContentForToolCalls":false},"thinking":{"mode":"effort","efforts":["low"],"requiresEffort":true}}));
        assert!(policy.upsert(Some(&json!({})), &json!({"id":"custom"}), true).unwrap().is_none());
        assert!(policy.override_model(Some(&updated), "m", &Value::Null).is_none());
    }
}
