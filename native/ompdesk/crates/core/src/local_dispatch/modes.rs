use serde_json::{json, Map, Value};

use crate::pool::application::Sidecar;
use crate::server::Fault;
use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "get_plan_mode", "set_plan_mode", "plan_approval", "get_goal", "set_goal", "guided_goal",
    "set_agents_paused", "get_delegation", "set_delegation", "tan", "omfg",
    "auto_mode_decide", "auto_mode_prefetch", "auto_mode_undo", "auto_mode_end",
    "regenerate_session_title", "get_next_prompt", "set_next_prompt_draft", "refresh_next_prompt",
    "cancel_next_prompt", "set_next_prompt_children", "complete_inline", "judge_preview_check",
    "judge_available", "get_advisor_stats", "prompt_origin_set", "typed_prompt", "desktop_slot_bridge",
    "get_directories", "add_directory", "remove_directory", "agent_control_confirm",
    "agent_control_attachment", "agent_control_note", "agent_control_worker", "agent_control_turn",
    "agent_control_judge", "agent_control_mail", "agent_control_sent", "get_checkout_peers",
];

fn invalid() -> CommandError { CommandError::Other("Invalid command parameters".into()) }
fn text<'a>(v: &'a Value, min: usize, max: usize) -> Result<&'a str, CommandError> {
    let s = v.as_str().ok_or_else(invalid)?;
    let n = s.encode_utf16().count();
    if n < min || n > max { return Err(invalid()); }
    Ok(s)
}
fn bool_value(v: &Value) -> Result<bool, CommandError> { v.as_bool().ok_or_else(invalid) }
fn project(result: &Value) -> Value {
    let state = &result["state"];
    let goal = &state["goal"];
    if goal.is_null() { return json!({"enabled":false}); }
    let mut out = Map::new();
    for (from, to) in [(state, "enabled"), (goal, "status"), (goal, "objective"), (goal, "tokenBudget"), (goal, "tokensUsed"), (goal, "timeUsedSeconds"), (state, "mode")] {
        if let Some(value) = from.get(to) { out.insert(to.into(), value.clone()); }
    }
    Value::Object(out)
}
async fn with_limit<S: Sidecar<Error=Fault> + ?Sized + 'static>(session: &Session<S>, mut state: Value) -> Value {
    if !matches!(state["status"].as_str(), Some(s) if !s.is_empty() && s != "complete" && s != "dropped") { return state; }
    if let Ok(limit) = session.bridge("modes.goal_time_limit", json!({})).await {
        if let Some(value) = limit.get("timeLimitSeconds") { state["timeLimitSeconds"] = value.clone(); }
    }
    state
}
async fn start_turn<S: Sidecar<Error=Fault> + ?Sized + 'static>(session: &Session<S>, objective: &str) -> Result<(), CommandError> {
    let state = session.stock(json!({"type":"get_state"})).await?;
    if state["isStreaming"] != true {
        session.stock(json!({"type":"prompt","message":objective,"streamingBehavior":"followUp"})).await?;
    }
    Ok(())
}
async fn set_goal<S: Sidecar<Error=Fault> + ?Sized + 'static>(c: &RpcCommand, s: &Session<S>) -> Result<Value, CommandError> {
    if let Some(action @ ("pause" | "resume" | "drop")) = c.string("action") {
        if action == "resume" { let _ = s.bridge("modes.goal_resume_time_limit", json!({})).await; }
        let result = s.stock(json!({"type":"goal","op":action})).await?;
        return Ok(with_limit(s, project(&result)).await);
    }
    let objective = c.string("objective").unwrap_or("").trim();
    let budget = c.params.get("tokenBudget");
    let limit = c.params.get("timeLimitMinutes").filter(|v| v.is_number() || v.is_null());
    if !objective.is_empty() {
        let current = s.stock(json!({"type":"goal","op":"get"})).await?;
        let result = if current["state"]["enabled"] == true {
            let mut params = json!({"objective":objective});
            if let Some(b) = budget.filter(|b| b.is_number()) { params["tokenBudget"] = b.clone(); }
            let replaced = s.bridge("modes.goal_replace", params).await?;
            if let Some(l) = limit { s.bridge("modes.goal_set_time_limit", json!({"minutes":l})).await?; }
            replaced
        } else {
            if current["state"]["goal"]["status"] == "paused" { return Err(CommandError::Other("Resume the current goal first, or drop it before setting a new objective.".into())); }
            let mut request = json!({"type":"goal","op":"create","objective":objective});
            if let Some(b) = budget.filter(|b| b.is_number()) { request["token_budget"] = b.clone(); }
            let created = s.stock(request).await?;
            if let Some(l) = limit.filter(|l| !l.is_null()) { s.bridge("modes.goal_set_time_limit", json!({"minutes":l})).await?; }
            created
        };
        start_turn(s, objective).await?;
        return Ok(with_limit(s, project(&result)).await);
    }
    if budget.is_some() || limit.is_some() {
        let result = if let Some(b) = budget { Some(s.bridge("modes.goal_set_budget", json!({"tokenBudget":b})).await?) } else { None };
        if let Some(l) = limit { s.bridge("modes.goal_set_time_limit", json!({"minutes":l})).await?; }
        let result = match result { Some(v) => v, None => s.stock(json!({"type":"goal","op":"get"})).await? };
        return Ok(with_limit(s, project(&result)).await);
    }
    Err(CommandError::Other("set_goal requires an objective, a tokenBudget, a timeLimitMinutes, or an action.".into()))
}

pub async fn handle<S: Sidecar<Error=Fault> + ?Sized + 'static>(c: &RpcCommand, s: &Session<S>) -> CommandResult {
    let p = Value::Object(c.params.clone());
    let result = match c.kind.as_str() {
        "get_plan_mode" | "set_plan_mode" | "plan_approval" | "guided_goal" | "set_agents_paused" | "get_delegation" | "set_delegation" | "tan" | "omfg" => s.forward(&format!("modes.{}", c.kind), c).await?,
        "get_goal" => { let r = s.stock(json!({"type":"goal","op":"get"})).await?; with_limit(s, project(&r)).await },
        "set_goal" => set_goal(c, s).await?,
        "auto_mode_decide" => {
            let decision = match s.bridge("modes.auto_mode_decide", json!({"message":c.string("message").unwrap_or("")})).await {
                Ok(v) => v,
                Err(_) => return Ok(Some(json!({"mode":"none","reason":"unavailable","latencyMs":0}))),
            };
            let applied = match decision["mode"].as_str() {
                Some("plan") => s.bridge("modes.set_plan_mode", json!({"enabled":true,"auto":true})).await,
                Some("goal") if decision["objective"].as_str().is_some_and(|v| !v.is_empty()) => s.stock(json!({"type":"goal","op":"create","objective":decision["objective"]})).await,
                _ => Ok(Value::Null),
            };
            if applied.is_err() {
                let mut fallback = json!({"mode":"none","reason":"error","latencyMs":decision.get("latencyMs").cloned().unwrap_or(json!(0))});
                if decision["model"].as_str().is_some_and(|v| !v.is_empty()) { fallback["model"] = decision["model"].clone(); }
                fallback
            } else { decision }
        },
        "auto_mode_prefetch" => s.bridge("modes.auto_mode_prefetch", json!({"message":c.string("message").unwrap_or("")})).await.unwrap_or(json!({"prefetched":false})),
        "auto_mode_undo" | "auto_mode_end" => {
            let mode = if c.string("mode") == Some("goal") { "goal" } else { "plan" };
            if c.kind == "auto_mode_undo" { s.bridge("modes.auto_mode_undo", json!({"mode":mode})).await?; }
            if mode == "goal" { s.stock(json!({"type":"goal","op":"drop"})).await?; }
            else if c.kind == "auto_mode_end" { s.bridge("modes.set_plan_mode", json!({"enabled":false})).await?; }
            json!({"mode":mode})
        },
        "regenerate_session_title" => s.bridge("regenerate_title", json!({})).await?,
        "get_next_prompt" => s.bridge("next_prompt_state", json!({})).await?,
        "set_next_prompt_draft" => s.bridge("next_prompt_draft", json!({"empty":bool_value(&p["empty"])?})).await?,
        "refresh_next_prompt" | "cancel_next_prompt" => {
            let (key, allowed, method): (_, &[_], _) = if c.kind == "refresh_next_prompt" { ("reason", &["bash", "switch", "refresh"], "next_prompt_refresh") } else { ("scope", &["suggest", "inline", "all"], "next_prompt_cancel") };
            let value = p[key].as_str().filter(|v| allowed.contains(v)).ok_or_else(invalid)?;
            let mut params = Map::new(); params.insert(key.into(), json!(value));
            s.bridge(method, Value::Object(params)).await?
        },
        "set_next_prompt_children" => {
            let children = p["children"].as_array().filter(|a| a.len() <= 20).ok_or_else(invalid)?;
            let mut clean = Vec::with_capacity(children.len());
            for child in children { let title = text(&child["title"], 0, 200)?; let mut item = json!({"title":title}); if let Some(w) = child.get("waiting") { item["waiting"] = json!(bool_value(w)?); } clean.push(item); }
            s.bridge("next_prompt_children", json!({"children":clean})).await?
        },
        "complete_inline" => s.bridge("next_prompt_inline", json!({"draft":text(&p["draft"],0,800)?,"requestId":text(&p["requestId"],1,64)?})).await?,
        "judge_preview_check" => { let r = s.bridge("judge_assist.preview_check", json!({"image":p.get("image")})).await.unwrap_or(Value::Null); let problem = match r["problem"].as_str() { Some("error") => json!("error"), Some("blank") => json!("blank"), _ => Value::Null }; json!({"problem":problem,"judged":r["judged"] == true}) },
        "judge_available" => { let r = s.bridge("judge_assist.available", json!({})).await.unwrap_or(Value::Null); json!({"available":r["available"] == true}) },
        "get_advisor_stats" => s.bridge("advisor_stats", json!({})).await?,
        "prompt_origin_set" => s.bridge("prompt_origin_set", json!({"origin":{"deviceId":text(&p["origin"]["deviceId"],1,256)?,"name":text(&p["origin"]["name"],1,256)?},"text":text(&p["text"],0,usize::MAX)?})).await?,
        "typed_prompt" => s.bridge("typed_prompt", json!({"text":text(&p["text"],0,usize::MAX)?,"steer":bool_value(&p["steer"])?})).await?,
        "desktop_slot_bridge" => { let method = c.string("method").filter(|v| ["desktop_slot.grant","desktop_slot.revoke"].contains(v)).ok_or_else(|| CommandError::local("invalid_method", format!("{} is not a desktop slot method.", c.string("method").unwrap_or("undefined"))))?; s.bridge(method, p.get("params").cloned().unwrap_or(Value::Null)).await? },
        "get_directories" => s.bridge("workspace.directories", json!({})).await?,
        "add_directory" | "remove_directory" => { let raw = c.string("path").ok_or_else(|| CommandError::Other("path must be a non-empty string".into()))?; if raw.trim().is_empty() { return Err(CommandError::Other("path must be a non-empty string".into())); } if raw.contains(['\r','\n','\0']) { return Err(CommandError::Other("path must not contain line breaks or NUL".into())); } s.bridge(if c.kind == "add_directory" { "workspace.add_directory" } else { "workspace.remove_directory" }, json!({"path":raw.trim()})).await? },
        "agent_control_confirm" => { let r = s.bridge("agent_control.confirm", json!({"title":text(&p["title"],1,200)?,"message":text(&p["message"],1,2000)?})).await?; json!({"approved":r["approved"] == true}) },
        "agent_control_attachment" => { let path = p.get("path"); let image = p.get("image"); let params = match (path,image) { (Some(v),None) => { let path = text(v,0,usize::MAX)?.trim(); if path.is_empty() || path.encode_utf16().count() > 4096 { return Err(invalid()); } json!({"path":path}) }, (None,Some(v)) if v.as_u64().is_some_and(|n| n >= 1) => json!({"image":v}), _ => return Err(invalid()) }; s.bridge("agent_control.attachment",params).await? },
        "agent_control_note" | "agent_control_worker" => { let (key,max,method) = if c.kind == "agent_control_note" { ("text",500,"agent_control.note") } else { ("from",200,"agent_control.worker") }; let v = text(&p[key],1,max)?; let mut params = Map::new(); params.insert(key.into(), json!(v)); s.bridge(method,Value::Object(params)).await?; json!({}) },
        "agent_control_turn" => { let r = s.bridge("agent_control.turn",json!({})).await?; json!({"person":r["person"] == true}) },
        "agent_control_judge" => s.bridge("agent_control.judge",json!({"system":text(&p["system"],1,20000)?,"user":text(&p["user"],1,200000)?})).await?,
        "agent_control_sent" => { let marks = p["marks"].as_array().filter(|a| !a.is_empty() && a.len() <= 100).ok_or_else(invalid)?; for mark in marks { text(mark,1,200)?; } s.bridge("agent_control.sent",json!({"marks":marks})).await? },
        "agent_control_mail" => {
            let content = if p["content"].is_string() {
                json!(text(&p["content"], 1, 200000)?)
            } else {
                let blocks = p["content"].as_array().filter(|a| !a.is_empty()).ok_or_else(invalid)?;
                let mut clean = Vec::with_capacity(blocks.len());
                for block in blocks {
                    clean.push(match block["type"].as_str() {
                        Some("text") => json!({"type":"text","text":text(&block["text"],0,200000)?}),
                        Some("image") => json!({"type":"image","data":text(&block["data"],1,13981016)?,"mimeType":text(&block["mimeType"],1,100)?}),
                        _ => return Err(invalid()),
                    });
                }
                Value::Array(clean)
            };
            if !p["details"].is_object() { return Err(invalid()); }
            let trigger = bool_value(&p["triggerTurn"])?;
            let mut mail = json!({"content":content,"details":p["details"],"triggerTurn":trigger});
            if let Some(deliver) = p.get("deliverAs") { if !matches!(deliver.as_str(),Some("followUp" | "aside")) { return Err(invalid()); } mail["deliverAs"] = deliver.clone(); }
            s.bridge("agent_control.mail",mail).await?
        },
        "get_checkout_peers" => s.bridge("checkout_peers.get",json!({})).await?,
        _ => return Ok(None),
    };
    Ok(Some(result))
}
