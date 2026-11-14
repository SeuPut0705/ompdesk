use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::pool::application::Sidecar;
use crate::server::Fault;

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "get_state", "eval", "abort_eval", "set_ultrafast_mode", "abort_maintenance", "bash", "retry",
    "restore_interrupted", "clear_context", "fresh", "shake_context", "set_force_tool", "get_force_tool",
    "set_prewalk", "get_active_tools", "get_context_report", "get_context_inspect", "get_context_entry",
    "get_jobs", "cancel_job", "preview_share_session", "share_session", "cycle_model", "set_thinking_level",
];

const BUSY: &str = "Session is busy (streaming or foreground execution in flight)";

fn invalid(message: impl Into<String>) -> CommandError { CommandError::Other(message.into()) }

fn required_string<'a>(command: &'a RpcCommand, key: &str, nonempty: bool) -> Result<&'a str, CommandError> {
    let value = command.string(key).ok_or_else(|| invalid(format!("{key} must be a string")))?;
    if nonempty && value.is_empty() { return Err(invalid(format!("{key} must be a non-empty string"))); }
    Ok(value)
}

fn optional_bool(command: &RpcCommand, key: &str) -> Result<Option<bool>, CommandError> {
    command.params.get(key).map(|value| value.as_bool().ok_or_else(|| invalid(format!("{key} must be a boolean")))).transpose()
}

fn optional_string<'a>(command: &'a RpcCommand, key: &str) -> Result<Option<&'a str>, CommandError> {
    command.params.get(key).map(|value| value.as_str().ok_or_else(|| invalid(format!("{key} must be a string")))).transpose()
}

async fn state_read<S: Sidecar<Error = Fault> + ?Sized + 'static>(session: &Session<S>, method: &str) -> Option<Value> {
    if !session.bridge_connected() { return None; }
    tokio::time::timeout(Duration::from_secs(2), session.bridge(method, json!({}))).await.ok()?.ok()
}

fn extra_or(extras: &Value, key: &str, fallback: Value) -> Value {
    extras.get(key).filter(|value| !value.is_null()).cloned().unwrap_or(fallback)
}

async fn get_state<S: Sidecar<Error = Fault> + ?Sized + 'static>(command: &RpcCommand, session: &Session<S>) -> Result<Value, CommandError> {
    let (whole, levels, extras, choice) = tokio::join!(
        session.stock(json!({"type":"get_state"})),
        session.stock(json!({"type":"get_available_thinking_levels"})),
        state_read(session, "composer.state"),
        state_read(session, "model_choice"),
    );
    let mut whole = whole?;
    let state = whole.as_object_mut().ok_or_else(|| invalid("get_state did not return an object"))?;
    if command.is_true("brief") { state.remove("systemPrompt"); state.remove("dumpTools"); }
    let extras = extras.unwrap_or(Value::Null);
    let thinking = state.get("thinkingLevel").cloned().unwrap_or(Value::Null);
    state.insert("cwd".into(), extra_or(&extras, "cwd", json!(session.cwd())));
    state.insert("autoRetryEnabled".into(), extra_or(&extras, "autoRetryEnabled", json!(true)));
    state.insert("thinkingConfigured".into(), extra_or(&extras, "thinkingConfigured", thinking));
    let levels = levels.ok().and_then(|value| value.get("levels").and_then(Value::as_array).cloned()).unwrap_or_default();
    state.insert("availableThinkingLevels".into(), Value::Array(levels.into_iter().filter(|level| level != "off").collect()));
    for key in ["planModeEnabled", "prewalkArmed", "agentsPaused", "ultrafastSupported", "ultrafastEnabled"] {
        state.insert(key.into(), extra_or(&extras, key, json!(false)));
    }
    if let Some(value) = extras.get("agentsPausedAt") { state.insert("agentsPausedAt".into(), value.clone()); }
    if let Some(chosen) = choice.as_ref().and_then(|value| value.get("chosen")).filter(|value| !value.is_null() && *value != &Value::Bool(false)) {
        state.insert("chosenModel".into(), chosen.clone());
    }
    Ok(whole)
}

fn job_rows(rows: Value) -> Value {
    let rows = rows.as_array().into_iter().flatten().map(|row| {
        if row["kind"] == "agent" { return row.clone(); }
        let job = &row["job"];
        let mut result = Map::new();
        for key in ["id", "type", "status", "label", "startTime", "agentId", "cancellationPending", "resultPreview", "errorPreview", "previewTruncated"] {
            if let Some(value) = job.get(key) { result.insert(key.into(), value.clone()); }
        }
        if let Some(value) = job.get("endTime") { result.insert("endedAt".into(), value.clone()); }
        let mut projected = Map::new();
        projected.insert("kind".into(), json!("job"));
        projected.insert("job".into(), Value::Object(result));
        for key in ["depth", "cancellable"] { if let Some(value) = row.get(key) { projected.insert(key.into(), value.clone()); } }
        Value::Object(projected)
    }).collect::<Vec<_>>();
    json!({"rows":rows})
}

/// Called after the host has run `omp plugin list --json`. A failed or invalid listing is null.
pub async fn reload_plugins<S: Sidecar<Error = Fault> + ?Sized + 'static>(session: &Session<S>, plugins: &Value) -> CommandResult {
    session.slash("reload-plugins", None).await?;
    let (commands, skills) = tokio::join!(session.stock(json!({"type":"get_available_commands"})), session.bridge("composer.skill_count", json!({})));
    let commands = commands?;
    let skills = skills?;
    let count: usize = plugins.as_object().into_iter().flat_map(|object| object.values()).filter_map(Value::as_array).map(Vec::len).sum();
    Ok(Some(json!({"plugins":count,"skills":skills["skills"],"commands":commands["commands"].as_array().map_or(0, Vec::len)})))
}

pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(command: &RpcCommand, session: &Session<S>) -> CommandResult {
    let value = match command.kind.as_str() {
        "get_state" => get_state(command, session).await?,
        "eval" => {
            let code = required_string(command, "code", false)?;
            let language = optional_string(command, "language")?.unwrap_or("python");
            if !["python", "js", "ruby", "julia"].contains(&language) { return Err(invalid("language must be python, js, ruby, or julia")); }
            let excluded = optional_bool(command, "excluded")?.unwrap_or(false);
            if language != "python" { return Err(invalid(format!("Interactive eval supports only \"python\" today (got \"{language}\"); other backends are agent-tool-only"))); }
            let result = session.bridge("composer.eval", json!({"code":code,"excluded":excluded})).await?;
            let mut data = Map::new();
            data.insert("language".into(), json!(language));
            data.insert("code".into(), json!(code));
            if let Some(result) = result.as_object() { data.extend(result.clone()); }
            data.insert("excluded".into(), json!(excluded));
            Value::Object(data)
        }
        "abort_eval" => { session.bridge("composer.abort_eval", json!({})).await?; return Ok(None); }
        "set_ultrafast_mode" => {
            let enabled = optional_bool(command, "enabled")?.ok_or_else(|| invalid("enabled must be a boolean"))?;
            session.bridge("composer.set_ultrafast", json!({"enabled":enabled})).await?
        }
        "abort_maintenance" => session.bridge("composer.abort_maintenance", json!({})).await?,
        "bash" => {
            let line = required_string(command, "command", false)?;
            if optional_bool(command, "excluded")?.unwrap_or(false) {
                session.bridge("composer.bash_excluded", json!({"command":line})).await?
            } else { session.stock(json!({"type":"bash","command":line})).await? }
        }
        "retry" => json!({"retried":session.slash("retry", None).await?["agentInvoked"] == true}),
        "restore_interrupted" => session.bridge("composer.restore_interrupted", json!({})).await?,
        "clear_context" => {
            let result = session.bridge("composer.clear_context", json!({})).await?;
            if result.is_null() || result == false { return Err(CommandError::local("busy", BUSY)); }
            json!({"cleared":true,"droppedCount":result["droppedCount"]})
        }
        "fresh" => {
            let state = session.stock(json!({"type":"get_state"})).await?;
            if state["isStreaming"] == true { return Err(CommandError::local("busy", BUSY)); }
            session.slash("fresh", None).await?;
            json!({})
        }
        "shake_context" => {
            let mode = required_string(command, "mode", false)?;
            if !["elide", "images", "thinking"].contains(&mode) { return Err(invalid("mode must be elide, images, or thinking")); }
            session.slash("shake", Some(mode)).await?;
            json!({})
        }
        "set_force_tool" => {
            let tool = optional_string(command, "tool")?;
            let clear = optional_bool(command, "clear")?.unwrap_or(false);
            if clear == tool.is_some() { return Err(invalid("set_force_tool takes exactly one of tool or clear.")); }
            let params = if clear { json!({"clear":true}) } else { json!({"tool":tool}) };
            session.bridge("composer.set_force_tool", params).await?
        }
        "get_force_tool" => session.bridge("composer.get_force_tool", json!({})).await?,
        "set_prewalk" => {
            let enabled = optional_bool(command, "enabled")?.ok_or_else(|| invalid("enabled must be a boolean"))?;
            if !enabled { session.bridge("composer.disarm_prewalk", json!({})).await? } else {
                session.slash("prewalk", None).await?;
                let armed = session.bridge("composer.prewalk_armed", json!({})).await?;
                if armed["armed"] != true { return Err(invalid("Prewalk was not armed; omp reported the reason in the session.")); }
                json!({"enabled":true})
            }
        }
        "get_active_tools" => {
            let (state, extras) = tokio::join!(session.stock(json!({"type":"get_state"})), session.bridge("composer.tool_extras", json!({})));
            let state = state?;
            let extras = extras?;
            let mut tools = Vec::new();
            for tool in state["dumpTools"].as_array().into_iter().flatten() {
                let mut entry = Map::new();
                for key in ["name", "description"] { if let Some(value) = tool.get(key) { entry.insert(key.into(), value.clone()); } }
                let source = tool["name"].as_str().and_then(|name| extras["sources"].get(name)).filter(|source| !source.is_null()).cloned().unwrap_or(json!("extension"));
                entry.insert("source".into(), source);
                tools.push(Value::Object(entry));
            }
            tools.extend(extras["mounted"].as_array().into_iter().flatten().cloned());
            json!({"tools":tools})
        }
        "get_context_report" => session.bridge("composer.context_report", json!({})).await?,
        "get_context_inspect" => session.bridge("context.inspect", json!({"entries":optional_bool(command, "entries")?.unwrap_or(true)})).await?,
        "get_context_entry" => session.bridge("context.entry", json!({"id":required_string(command, "entryId", true)?})).await?,
        "get_jobs" => job_rows(session.bridge("composer.jobs", json!({})).await?),
        "cancel_job" => session.bridge("composer.cancel_job", json!({"id":required_string(command, "jobId", true)?})).await?,
        "preview_share_session" => session.bridge("composer.share_preview", json!({})).await?,
        "share_session" => {
            let mut params = Map::new();
            if let Some(id) = optional_string(command, "snapshotId")? { params.insert("snapshotId".into(), json!(id)); }
            session.bridge("composer.share", Value::Object(params)).await?
        }
        "cycle_model" => {
            let direction = optional_string(command, "direction")?;
            if !matches!(direction, None | Some("forward") | Some("backward")) { return Err(invalid("direction must be forward or backward")); }
            if direction == Some("backward") { session.bridge("composer.cycle_model_backward", json!({})).await? }
            else { session.stock(json!({"type":"cycle_model"})).await? }
        }
        "set_thinking_level" => {
            let level = required_string(command, "level", true)?;
            session.stock(json!({"type":"set_thinking_level","level":level})).await?;
            let (state, extras) = tokio::join!(session.stock(json!({"type":"get_state"})), state_read(session, "composer.state"));
            let state = state?;
            let thinking = state.get("thinkingLevel").cloned().unwrap_or(Value::Null);
            let configured = extras.as_ref().and_then(|value| value.get("thinkingConfigured")).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| if level == "auto" { json!("auto") } else { thinking.clone() });
            json!({"thinkingLevel":thinking,"thinkingConfigured":configured})
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
